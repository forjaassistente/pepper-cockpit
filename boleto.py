"""Leitura de boletos (PDF ou foto) para o cadastro de lançamentos.

1. Extrai as palavras COM POSIÇÃO de cada página (texto do PDF; OCR Tesseract quando é imagem
   ou PDF escaneado). As posições vão normalizadas (0–1) para a tela desenhar caixas clicáveis.
2. Decodifica a linha digitável (47 dígitos bancário / 48 arrecadação): valor e vencimento exatos.
3. Se houver ANTHROPIC_API_KEY, o Claude sugere fornecedor, competência, descrição e categoria,
   apontando de quais palavras tirou cada dado.
O arquivo original e as páginas renderizadas ficam em ANEXOS_DIR/<id>/.
"""
import base64
import datetime as dt
import hashlib
import io
import json
import logging
import os
import re
import uuid

import anthropic
import pdfplumber
import psycopg
import pytesseract
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from fin import DSN, q

register_heif_opener()
Image.MAX_IMAGE_PIXELS = 60_000_000

log = logging.getLogger("boleto")
router = APIRouter(prefix="/api/fin/anexos")

ANEXOS_DIR = os.environ.get("ANEXOS_DIR", "/data/anexos")
MAX_BYTES = 15 * 1024 * 1024
MAX_PAGINAS = 3
MODELO = "claude-opus-5-5"


# ------------------------------------------------------------------ extração de palavras
def _ocr(img: Image.Image, pagina: int):
    cinza = ImageOps.autocontrast(img.convert("L"))
    d = pytesseract.image_to_data(cinza, lang="por", config="--psm 3", output_type=pytesseract.Output.DICT)
    W, H = img.size
    out = []
    for i, t in enumerate(d["text"]):
        t = (t or "").strip()
        if not t or float(d["conf"][i]) < 30:
            continue
        out.append({"p": pagina, "t": t, "x": d["left"][i] / W, "y": d["top"][i] / H,
                    "w": d["width"][i] / W, "h": d["height"][i] / H,
                    "l": f"{d['block_num'][i]}.{d['par_num'][i]}.{d['line_num'][i]}"})
    return out


def _paginas(conteudo: bytes, mime: str):
    """Devolve [(imagem PIL para exibir, palavras, origem)] por página."""
    if mime == "application/pdf":
        res = []
        with pdfplumber.open(io.BytesIO(conteudo)) as pdf:
            for n, page in enumerate(pdf.pages[:MAX_PAGINAS], start=1):
                img = page.to_image(resolution=150).original.convert("RGB")
                W, H = float(page.width), float(page.height)
                palavras = [{"p": n, "t": w["text"], "x": w["x0"] / W, "y": w["top"] / H,
                             "w": (w["x1"] - w["x0"]) / W, "h": (w["bottom"] - w["top"]) / H,
                             "l": str(round(w["top"]))}
                            for w in page.extract_words(use_text_flow=True) if w["text"].strip()]
                if len(palavras) < 5:  # PDF escaneado: sem camada de texto
                    res.append((img, _ocr(page.to_image(resolution=300).original, n), "ocr"))
                else:
                    res.append((img, palavras, "pdf"))
        if not res:
            raise HTTPException(422, "PDF sem páginas")
        return res
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(conteudo))).convert("RGB")
    if max(img.size) > 2400:
        img.thumbnail((2400, 2400))
    return [(img, _ocr(img, 1), "ocr")]


def _mime(conteudo: bytes, nome: str) -> str:
    if conteudo[:5] == b"%PDF-":
        return "application/pdf"
    try:
        with Image.open(io.BytesIO(conteudo)) as im:
            fmt = (im.format or "").upper()
    except Exception:
        raise HTTPException(415, "Envie um PDF ou uma foto (JPG, PNG ou HEIC)")
    return {"JPEG": "image/jpeg", "PNG": "image/png", "HEIF": "image/heic", "WEBP": "image/webp"}.get(fmt, "image/" + fmt.lower())


# ------------------------------------------------------------------ linha digitável
def _mod10(num: str) -> int:
    soma, peso = 0, 2
    for c in reversed(num):
        p = int(c) * peso
        soma += p // 10 + p % 10
        peso = 1 if peso == 2 else 2
    return (10 - soma % 10) % 10


def _dv_barras_bancario(barras: str) -> int:
    corpo = barras[:4] + barras[5:]
    soma, peso = 0, 2
    for c in reversed(corpo):
        soma += int(c) * peso
        peso = 2 if peso == 9 else peso + 1
    r = 11 - soma % 11
    return 1 if r in (0, 10, 11) else r


def _fator_para_data(fator: int):
    """Fator de vencimento (dias desde 07/10/1997). Em 22/02/2025 o fator voltou a 1000,
    então o mesmo fator vale a cada 9000 dias: escolhe a data mais próxima de hoje."""
    if fator < 1000:
        return None
    base = dt.date(1997, 10, 7) + dt.timedelta(days=fator)
    hoje = dt.date.today()
    return min((base + dt.timedelta(days=9000 * k) for k in range(3)), key=lambda d: abs((d - hoje).days))


def linha_digitavel(texto: str):
    for bruto in re.findall(r"\d[\d.\s]{42,70}\d", texto):
        dig = re.sub(r"\D", "", bruto)
        for n in (47, 48):
            for i in range(0, len(dig) - n + 1):
                r = _decodifica(dig[i:i + n])
                if r:
                    return r
    return None


def _decodifica(d: str):
    if len(d) == 47:
        campos = [(d[0:9], d[9]), (d[10:20], d[20]), (d[21:31], d[31])]
        if any(_mod10(c) != int(v) for c, v in campos):
            return None
        barras = d[0:4] + d[32] + d[33:47] + d[4:9] + d[10:20] + d[21:31]
        if _dv_barras_bancario(barras) != int(d[32]):
            return None
        fator, valor = int(d[33:37]), int(d[37:47]) / 100
        venc = _fator_para_data(fator)
        return {"tipo": "bancario", "linha": d, "banco": d[0:3],
                "valor": valor or None, "vencimento": venc.isoformat() if venc else None}
    if len(d) == 48 and d[0] == "8":
        blocos = [d[i:i + 12] for i in range(0, 48, 12)]
        barras = "".join(b[:11] for b in blocos)
        if barras[2] in "67":  # módulo 10
            if any(_mod10(b[:11]) != int(b[11]) for b in blocos):
                return None
        valor = int(barras[4:15]) / 100 if barras[2] in "68" else None
        return {"tipo": "arrecadacao", "linha": d, "banco": None, "valor": valor or None, "vencimento": None}
    return None


# ------------------------------------------------------------------ sugestão do Claude
_SCHEMA = {
    "type": "object",
    "properties": {
        "tipo": {"type": "string", "enum": ["pagar", "receber"]},
        "fornecedor": {"type": "object", "properties": {
            "texto": {"type": "string"}, "palavras": {"type": "array", "items": {"type": "string"}}},
            "required": ["texto", "palavras"], "additionalProperties": False},
        "contato_existente": {"type": "string"},
        "vencimento": {"type": "object", "properties": {
            "data": {"type": "string"}, "palavras": {"type": "array", "items": {"type": "string"}}},
            "required": ["data", "palavras"], "additionalProperties": False},
        "competencia": {"type": "object", "properties": {
            "data": {"type": "string"}, "palavras": {"type": "array", "items": {"type": "string"}}},
            "required": ["data", "palavras"], "additionalProperties": False},
        "valor": {"type": "object", "properties": {
            "numero": {"type": "number"}, "palavras": {"type": "array", "items": {"type": "string"}}},
            "required": ["numero", "palavras"], "additionalProperties": False},
        "descricao": {"type": "object", "properties": {
            "texto": {"type": "string"}, "palavras": {"type": "array", "items": {"type": "string"}}},
            "required": ["texto", "palavras"], "additionalProperties": False},
        "categoria_id": {"type": "string"},
        "observacao": {"type": "string"},
    },
    "required": ["tipo", "fornecedor", "contato_existente", "vencimento", "competencia", "valor",
                 "descricao", "categoria_id", "observacao"],
    "additionalProperties": False,
}


def _nome_empresa():
    import empresa          # import tardio: empresa.py usa boleto.ANEXOS_DIR
    return empresa.nome()


def _sistema():
    """Prompt fixo (contatos e categorias reais do Nibo), em cache entre leituras."""
    contatos = [r["contato"] for r in q("select contato from fin_app.v_contatos order by 1")]
    cats = q("select id, categoria, tipo, grupo, subgrupo from fin_app.v_categorias where ativo order by ordem, grupo, categoria")
    linhas_cat = "\n".join(f"{c['id']} | {c['tipo']} | {c['grupo']} > {c['subgrupo'] or '-'} > {c['categoria']}" for c in cats)
    return (
        f"Você lê boletos e documentos de cobrança do restaurante {_nome_empresa()} para preencher um "
        "lançamento financeiro. Você recebe as imagens das páginas e a lista de palavras extraídas, "
        "cada uma com um id (ex.: p1w12). Para cada campo, informe o valor e os ids das palavras de "
        "onde ele saiu, para a tela destacar no documento.\n\n"
        "Regras:\n"
        "- fornecedor: quem está cobrando (beneficiário/cedente), não o pagador. Se ele corresponder a "
        "um contato da lista abaixo, ponha o nome exato da lista em contato_existente; senão, deixe vazio.\n"
        "- vencimento e competencia no formato AAAA-MM-DD. Competência é o mês de referência do serviço "
        "(ex.: 'referente a 09/2026' vira 2026-09-01); se o documento não indicar, deixe vazio.\n"
        "- valor: valor do documento em reais, como número (ex.: 1234.56). Ignore juros e multa.\n"
        "- descricao: curta, o que está sendo cobrado (ex.: 'Mensalidade software de gestão - out/2026').\n"
        "- categoria_id: o id da categoria mais adequada da lista abaixo, do mesmo tipo do lançamento; "
        "vazio se nenhuma servir.\n"
        "- tipo: 'pagar' para boletos e cobranças recebidas; 'receber' só se o restaurante for o beneficiário.\n"
        "- Campo que não aparece no documento: texto/data vazios, número 0 e lista de palavras vazia. "
        "Use apenas ids que existem na lista de palavras.\n"
        "- observacao: uma frase curta se algo merecer conferência (ex.: dois valores diferentes); senão vazio.\n\n"
        f"Contatos cadastrados no Nibo:\n" + "\n".join(contatos) + "\n\n"
        f"Categorias (id | tipo | grupo > subgrupo > categoria):\n{linhas_cat}\n"
    )


def sugerir(imagens, palavras):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None, {"status": "sem_chave"}
    conteudo = []
    for img in imagens:
        buf = io.BytesIO()
        im = img.copy()
        im.thumbnail((1600, 1600))
        im.save(buf, "JPEG", quality=85)
        conteudo.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                     "data": base64.standard_b64encode(buf.getvalue()).decode()}})
    lista = "\n".join(f"{w['id']}: {w['t']}" for w in palavras[:2500])
    conteudo.append({"type": "text", "text": f"Palavras extraídas (id: texto):\n{lista}\n\nPreencha os campos do lançamento."})
    try:
        client = anthropic.Anthropic(timeout=90.0)
        resp = client.beta.messages.create(
            model=MODELO,
            max_tokens=4000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA}},
            system=[{"type": "text", "text": _sistema(), "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": conteudo}],
        )
    except anthropic.APIStatusError as e:
        log.warning("Claude: HTTP %s %s", e.status_code, e.message)
        return None, {"status": "erro", "erro": f"API do Claude respondeu {e.status_code}"}
    except anthropic.APIConnectionError:
        return None, {"status": "erro", "erro": "Sem conexão com a API do Claude"}
    if resp.stop_reason == "refusal":
        return None, {"status": "erro", "erro": "O Claude não processou este documento"}
    texto = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        sug = json.loads(texto)
    except json.JSONDecodeError:
        return None, {"status": "erro", "erro": "Resposta da IA incompleta"}
    ids = {w["id"] for w in palavras}
    for campo in ("fornecedor", "vencimento", "competencia", "valor", "descricao"):
        sug[campo]["palavras"] = [i for i in sug[campo]["palavras"] if i in ids]
    u = resp.usage
    return sug, {"status": "ok", "modelo": resp.model,
                 "tokens": {"entrada": u.input_tokens, "cache": u.cache_read_input_tokens or 0, "saida": u.output_tokens}}


# ------------------------------------------------------------------ endpoints
def _pasta(aid) -> str:
    return os.path.join(ANEXOS_DIR, str(uuid.UUID(str(aid))))


def _resposta(row):
    ex = row["extracao"]
    return {"id": str(row["id"]), "nome": row["nome"], "mime": row["mime"], "lancamento_id": _s(row["lancamento_id"]),
            "paginas": [{"n": p["n"], "url": f"/api/fin/anexos/{row['id']}/pagina/{p['n']}",
                         "largura": p["largura"], "altura": p["altura"], "origem": p["origem"]} for p in ex["paginas"]],
            "palavras": ex["palavras"], "linha": ex["linha"], "sugestao": ex["sugestao"], "ia": ex["ia"],
            "arquivo": f"/api/fin/anexos/{row['id']}/arquivo"}


def _s(v):
    return str(v) if v else None


def processar(conteudo: bytes, nome: str, documento_id=None):
    """Lê o arquivo (texto/OCR + linha digitável + sugestão da IA) e grava como anexo.
    Usado no upload direto do leitor e ao abrir um documento da caixa de entrada."""
    if len(conteudo) > MAX_BYTES:
        raise HTTPException(413, "Arquivo maior que 15 MB")
    if not conteudo:
        raise HTTPException(422, "Arquivo vazio")
    mime = _mime(conteudo, nome or "")
    try:
        paginas = _paginas(conteudo, mime)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("falha lendo arquivo")
        raise HTTPException(422, f"Não consegui ler o arquivo ({type(e).__name__})")

    aid = uuid.uuid4()
    pasta = _pasta(aid)
    os.makedirs(pasta, exist_ok=True)
    ext = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic"}.get(mime, "bin")
    with open(os.path.join(pasta, f"original.{ext}"), "wb") as f:
        f.write(conteudo)

    palavras, meta = [], []
    for n, (img, ws, origem) in enumerate(paginas, start=1):
        exib = img.copy()
        exib.thumbnail((1400, 2000))
        exib.save(os.path.join(pasta, f"pagina-{n}.png"), optimize=True)
        meta.append({"n": n, "largura": exib.width, "altura": exib.height, "origem": origem})
        for w in ws:
            w["id"] = f"p{n}w{len(palavras)}"
            palavras.append({k: (round(v, 5) if isinstance(v, float) else v) for k, v in w.items()})

    linha = linha_digitavel(" ".join(w["t"] for w in palavras))
    if linha:  # marca as palavras que compõem a linha digitável
        alvo = linha["linha"]
        linha["palavras"] = [w["id"] for w in palavras
                             if len(re.sub(r"\D", "", w["t"])) >= 5 and re.sub(r"\D", "", w["t"]) in alvo]
    sugestao, ia = sugerir([p[0] for p in paginas], palavras)

    extracao = {"paginas": meta, "palavras": palavras, "linha": linha, "sugestao": sugestao, "ia": ia}
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        row = conn.execute("""insert into fin_app.anexos (id, nome, mime, tamanho, sha256, paginas, extracao, documento_id)
                              values (%s, %s, %s, %s, %s, %s, %s, %s) returning *""",
                           (aid, (nome or "boleto")[:200], mime, len(conteudo),
                            hashlib.sha256(conteudo).hexdigest(), len(meta), Jsonb(extracao), documento_id)).fetchone()
    return _resposta(row)


@router.post("")
def enviar(arquivo: UploadFile = File(...)):
    return processar(arquivo.file.read(MAX_BYTES + 1), arquivo.filename or "")


def _row(aid: uuid.UUID):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        row = conn.execute("select * from fin_app.anexos where id = %s", (aid,)).fetchone()
    if not row:
        raise HTTPException(404, "Anexo não encontrado")
    return row


@router.get("/{aid}")
def obter(aid: uuid.UUID):
    return _resposta(_row(aid))


@router.get("/{aid}/pagina/{n}")
def pagina(aid: uuid.UUID, n: int):
    caminho = os.path.join(_pasta(aid), f"pagina-{int(n)}.png")
    if not os.path.isfile(caminho):
        raise HTTPException(404, "Página não encontrada")
    return FileResponse(caminho, media_type="image/png")


@router.get("/{aid}/arquivo")
def arquivo(aid: uuid.UUID):
    row = _row(aid)
    pasta = _pasta(aid)
    nome = next((f for f in os.listdir(pasta) if f.startswith("original.")), None)
    if not nome:
        raise HTTPException(404, "Arquivo não encontrado")
    return FileResponse(os.path.join(pasta, nome), media_type=row["mime"], filename=row["nome"],
                        content_disposition_type="inline")
