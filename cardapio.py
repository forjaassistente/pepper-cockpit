"""Engenharia de cardápio e precificação.

Precificação (mesma conta da planilha ChefBoard):
  CVT %            = cartão + imposto + custo fixo (tudo em % da venda)
  preço sugerido   = CMV ÷ (1 − CVT − lucro desejado)
  preço sugerido no app = preço sugerido ÷ (1 − taxa do app)
  lucro no preço atual  = preço − CMV − preço × CVT   (no app, desconta também a taxa)

Engenharia (Kasavana & Smith), dentro de cada categoria ou no cardápio todo:
  popular  = participação nas vendas ≥ 70% da participação média (0,7 ÷ nº de itens)
  margem alta = margem de contribuição (preço − CMV) ≥ média ponderada pelas vendas
  Estrela (popular, margem alta) · Burro de carga (popular, margem baixa)
  Quebra-cabeça (pouco vendido, margem alta) · Cão (pouco vendido, margem baixa)
"""
import uuid
from datetime import date
from decimal import Decimal

import psycopg
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from fichas import Motor
from fin import DSN, q

router = APIRouter(prefix="/api/cardapio")
CAMPOS_PARAM = ("cartao_pct", "imposto_pct", "custo_fixo_pct", "lucro_desejado_pct", "taxa_app_pct")


def _param():
    return {k: float(v) for k, v in q("select * from fin_app.cardapio_param where id = 1")[0].items() if k in CAMPOS_PARAM}


def _produtos():
    """Produtos ativos com o CMV teórico atual (ficha técnica)."""
    m = Motor()
    ps = q("""select p.id, p.nome, p.preco_venda, p.preco_app, p.lucro_desejado_pct, p.rendimento,
                     c.nome as categoria, c.ordem as cat_ordem
              from fin_app.produtos p left join fin_app.cat_itens c on c.id = p.categoria_id
              where p.ativo order by c.ordem nulls last, c.nome, lower(p.nome)""")
    for p in ps:
        r = m.resumo("produto", p["id"], p["preco_venda"], p["rendimento"])
        p["cmv"] = r["custo_exato"] if r["itens"] else None
        p["incompleta"] = r["incompleta"]
        for k in ("preco_venda", "preco_app", "lucro_desejado_pct"):
            p[k] = float(p[k]) if p[k] is not None else None
    return ps


def precificar(p: dict, par: dict) -> dict:
    cvt = (par["cartao_pct"] + par["imposto_pct"] + par["custo_fixo_pct"]) / 100
    lucro = (p["lucro_desejado_pct"] if p["lucro_desejado_pct"] is not None else par["lucro_desejado_pct"]) / 100
    taxa = par["taxa_app_pct"] / 100
    cmv, preco, app = p["cmv"], p["preco_venda"], p["preco_app"]
    out = {"cvt_pct": round(cvt * 100, 2), "lucro_alvo_pct": round(lucro * 100, 2)}
    if cmv is None:
        return out
    den = 1 - cvt - lucro
    out["sugerido"] = round(cmv / den, 2) if den > 0 else None          # None: custos + lucro ≥ 100% da venda
    out["sugerido_app"] = round(out["sugerido"] / (1 - taxa), 2) if out["sugerido"] and taxa < 1 else None
    if preco:
        out["cmv_pct"] = round(cmv / preco * 100, 1)
        out["mc"] = round(preco - cmv, 2)
        out["lucro"] = round(preco - cmv - preco * cvt, 2)
        out["lucro_pct"] = round(out["lucro"] / preco * 100, 1)
    if app:
        out["lucro_app"] = round(app - cmv - app * (cvt + taxa), 2)
        out["lucro_app_pct"] = round(out["lucro_app"] / app * 100, 1)
    return out


# ------------------------------------------------------------------ parâmetros e precificação
class Param(BaseModel):
    cartao_pct: Decimal = Field(ge=0, le=100, decimal_places=2)
    imposto_pct: Decimal = Field(ge=0, le=100, decimal_places=2)
    custo_fixo_pct: Decimal = Field(ge=0, le=100, decimal_places=2)
    lucro_desejado_pct: Decimal = Field(ge=0, le=100, decimal_places=2)
    taxa_app_pct: Decimal = Field(ge=0, le=100, decimal_places=2)


@router.put("/parametros")
def salvar_param(p: Param):
    with psycopg.connect(**DSN) as conn:
        conn.execute(f"update fin_app.cardapio_param set {', '.join(f'{k} = %({k})s' for k in CAMPOS_PARAM)}, "
                     "atualizado_em = now() where id = 1", p.model_dump())
    return {"ok": True}


@router.get("/precificacao")
def precificacao():
    par = _param()
    ps = _produtos()
    for p in ps:
        p.update(precificar(p, par))
    return {"parametros": par, "produtos": ps}


class PrecoItem(BaseModel):
    produto_id: uuid.UUID
    preco_venda: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    preco_app: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    lucro_desejado_pct: Decimal | None = Field(None, ge=0, le=100, decimal_places=2)


class Precos(BaseModel):
    itens: list[PrecoItem] = Field(max_length=500)


@router.put("/precos")
def salvar_precos(b: Precos):
    """Grava preço de salão, preço no app e lucro desejado (vazio = usa o padrão) dos produtos enviados."""
    with psycopg.connect(**DSN) as conn, conn.transaction():
        for it in b.itens:
            conn.execute("""update fin_app.produtos set preco_venda = %s, preco_app = %s, lucro_desejado_pct = %s
                            where id = %s""", (it.preco_venda, it.preco_app, it.lucro_desejado_pct, it.produto_id))
    return {"ok": True, "gravados": len(b.itens)}


# ------------------------------------------------------------------ vendas por produto (popularidade)
def _mes(s: str) -> date:
    try:
        a, m = map(int, s.split("-")[:2])
        return date(a, m, 1)
    except (ValueError, AttributeError):
        raise HTTPException(422, "Mês inválido (use AAAA-MM)")


@router.get("/vendas")
def vendas(mes: str):
    d = _mes(mes)
    ps = q("""select p.id, p.nome, p.codigo_pdv, c.nome as categoria, v.quantidade, v.origem
              from fin_app.produtos p left join fin_app.cat_itens c on c.id = p.categoria_id
              left join fin_app.vendas_produtos v on v.produto_id = p.id and v.mes = %s
              where p.ativo or v.id is not null order by c.ordem nulls last, c.nome, lower(p.nome)""", (d,))
    meses = q("""select to_char(mes, 'YYYY-MM') as mes, sum(quantidade) as itens, count(*) as produtos
                 from fin_app.vendas_produtos group by mes order by mes desc""")
    return {"mes": d.strftime("%Y-%m"), "produtos": ps, "meses": meses}


class VendaItem(BaseModel):
    produto_id: uuid.UUID
    quantidade: Decimal | None = Field(None, ge=0, max_digits=12, decimal_places=2)


class Vendas(BaseModel):
    mes: str
    itens: list[VendaItem] = Field(max_length=1000)


@router.put("/vendas")
def salvar_vendas(b: Vendas):
    """Grava as quantidades do mês; quantidade vazia apaga o registro do produto naquele mês."""
    d = _mes(b.mes)
    with psycopg.connect(**DSN) as conn, conn.transaction():
        for it in b.itens:
            if it.quantidade is None:
                conn.execute("delete from fin_app.vendas_produtos where produto_id = %s and mes = %s", (it.produto_id, d))
            else:
                conn.execute("""insert into fin_app.vendas_produtos (produto_id, mes, quantidade) values (%s, %s, %s)
                                on conflict (produto_id, mes) do update set quantidade = excluded.quantidade,
                                origem = 'manual', atualizado_em = now()""", (it.produto_id, d, it.quantidade))
    return {"ok": True}


# ------------------------------------------------------------------ importar vendas de um relatório (arquivo ou caixa de entrada)
import csv as _csv
import io as _io
import re as _re

_LIMITE_ARQ = 15 * 1024 * 1024
_ROT_PROD = _re.compile(r"produto|item|descri|nome|prato", _re.I)
_ROT_QTD = _re.compile(r"qtd|quant|qtde|vendid|unid", _re.I)
_ROT_COD = _re.compile(r"c[oó]d|sku|refer|^id$|plu|ean", _re.I)
_DATA_BR = _re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b")
_DATA_ISO = _re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")


def _datas(txt: str) -> list[date]:
    out = []
    for d, m, a in _DATA_BR.findall(txt or ""):
        a = int(a) + (2000 if len(a) == 2 else 0)
        try:
            out.append(date(a, int(m), int(d)))
        except ValueError:
            pass
    for a, m, d in _DATA_ISO.findall(txt or ""):
        try:
            out.append(date(int(a), int(m), int(d)))
        except ValueError:
            pass
    return out


def _periodo(linhas: list[list[str]]) -> dict | None:
    """Período de vendas do relatório: linha "Período: 01/09/2026 a 30/09/2026" ou, sem ela, uma coluna de datas."""
    for l in linhas[:40]:
        txt = " ".join(l)
        ds = _datas(txt)
        if len(ds) >= 2 and _re.search(r"per[ií]odo|de\s.*\sa(t[eé])?\s|in[ií]cio|data", txt, _re.I):
            return {"de": min(ds).isoformat(), "ate": max(ds).isoformat(), "fonte": txt.strip()[:120]}
    largura = max((len(l) for l in linhas), default=0)
    for j in range(largura):
        ds = [d for l in linhas if j < len(l) for d in _datas(l[j])[:1]]
        if len(ds) >= 3:
            return {"de": min(ds).isoformat(), "ate": max(ds).isoformat(), "fonte": "coluna de datas"}
    return None


def _celula(c) -> str:
    if c is None:
        return ""
    if isinstance(c, float) and c.is_integer():
        return str(int(c))
    return str(c).strip()


def _tabela(conteudo: bytes, nome: str) -> list[list[str]]:
    """Linhas de um relatório: Excel (.xlsx/.xls), CSV/TXT ou PDF com tabela."""
    n = (nome or "").lower()
    linhas: list[list[str]] = []
    if conteudo[:4] == b"PK\x03\x04":                       # .xlsx
        import openpyxl
        wb = openpyxl.load_workbook(_io.BytesIO(conteudo), read_only=True, data_only=True)
        for ws in wb.worksheets:
            linhas += [[_celula(c) for c in row] for row in ws.iter_rows(values_only=True)]
    elif conteudo[:4] == b"\xd0\xcf\x11\xe0":              # .xls antigo
        import xlrd
        wb = xlrd.open_workbook(file_contents=conteudo)
        for ws in wb.sheets():
            linhas += [[_celula(c) for c in ws.row_values(i)] for i in range(ws.nrows)]
    elif conteudo[:5] == b"%PDF-":
        import pdfplumber
        with pdfplumber.open(_io.BytesIO(conteudo)) as pdf:
            for pg in pdf.pages[:60]:
                for t in pg.extract_tables() or []:
                    linhas += [[_celula(c) for c in row] for row in t]
                if not pg.extract_tables():                    # relatório em texto: "Produto ..... 12"
                    for l in (pg.extract_text() or "").splitlines():
                        m = _re.match(r"^\s*(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:un|und|x)?\s*(?:R?\$?\s*[\d.,]+)*\s*$", l, _re.I)
                        if m:
                            linhas.append([m.group(1).strip(), m.group(2)])
    else:
        texto = next((conteudo.decode(e) for e in ("utf-8-sig", "latin-1") if _decodifica(conteudo, e)), "")
        # separador: o que mais gera linhas com 2+ colunas (relatórios costumam ter título antes da tabela)
        def tenta(sep):
            ls = list(_csv.reader(_io.StringIO(texto), delimiter=sep))
            return sum(1 for l in ls if len([c for c in l if c.strip()]) >= 2), ls
        linhas = max((tenta(sep) for sep in (";", "\t", ",", "|")), key=lambda x: x[0])[1]
        if not n.endswith((".csv", ".txt")) and len(linhas) < 2:
            raise HTTPException(415, "Envie o relatório em Excel (.xlsx/.xls), CSV ou PDF")
    return [l for l in linhas if any(c.strip() for c in l)][:5000]


def _decodifica(b: bytes, enc: str) -> bool:
    try:
        b.decode(enc)
        return True
    except UnicodeDecodeError:
        return False


def _num(s: str):
    s = (s or "").strip().replace("R$", "").replace(" ", "")
    if not _re.fullmatch(r"-?[\d.,]+", s):
        return None
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _sugestao(linhas: list[list[str]]) -> dict:
    """Adivinha a linha de cabeçalho e as colunas de produto e quantidade."""
    for i, l in enumerate(linhas[:20]):
        prod = next((j for j, c in enumerate(l) if _ROT_PROD.search(c) and not _ROT_QTD.search(c)), None)
        qtd = next((j for j, c in enumerate(l) if _ROT_QTD.search(c) and j != prod), None)
        if prod is not None and qtd is not None:
            cod = next((j for j, c in enumerate(l) if _ROT_COD.search(c) and j not in (prod, qtd)), None)
            return {"cabecalho": i, "produto": prod, "quantidade": qtd, "codigo": cod}
    largura = max((len(l) for l in linhas), default=0)
    texto = [sum(1 for l in linhas if j < len(l) and l[j] and _num(l[j]) is None) for j in range(largura)]
    numero = [sum(1 for l in linhas if j < len(l) and _num(l[j]) is not None) for j in range(largura)]
    prod = max(range(largura), key=lambda j: texto[j], default=0)
    qtd = next((j for j in range(largura) if j != prod and numero[j] >= max(numero) * 0.6), 1 if largura > 1 else 0)
    return {"cabecalho": None, "produto": prod, "quantidade": qtd, "codigo": None}


def _resposta(conteudo: bytes, nome: str) -> dict:
    if not conteudo or len(conteudo) > _LIMITE_ARQ:
        raise HTTPException(422, "Arquivo vazio ou maior que 15 MB")
    try:
        linhas = _tabela(conteudo, nome)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "Não consegui ler esse arquivo. Exporte o relatório em Excel ou CSV e tente de novo.")
    if not linhas:
        raise HTTPException(422, "O arquivo não tem linhas de tabela")
    return {"nome": nome, "linhas": linhas, "sugestao": _sugestao(linhas), "periodo": _periodo(linhas)}


@router.post("/vendas/ler")
def ler_arquivo(arquivo: UploadFile = File(...)):
    return _resposta(arquivo.file.read(_LIMITE_ARQ + 1), arquivo.filename or "")


@router.get("/vendas/documentos")
def documentos_vendas():
    """Relatórios na caixa de entrada que dá para importar (planilhas, CSV e PDFs de relatório)."""
    return q("""select id, nome, tipo, status, resumo, recebido_em from fin_app.documentos
                where tipo = 'relatorio_vendas'
                   or (tipo = 'outro' and lower(nome) ~ '\\.(xlsx|xls|csv|txt)$')
                order by recebido_em desc limit 30""")


@router.get("/vendas/documento/{did}")
def ler_documento(did: uuid.UUID):
    import inbox
    nome = q("select nome from fin_app.documentos where id = %s", (did,))
    if not nome:
        raise HTTPException(404, "Documento não encontrado")
    with open(inbox._arquivo(did), "rb") as f:
        return _resposta(f.read(_LIMITE_ARQ + 1), nome[0]["nome"]) | {"documento_id": str(did)}


class Codigos(BaseModel):
    itens: list[dict] = Field(max_length=1000)    # [{produto_id, codigo}]


@router.put("/vendas/codigos")
def preencher_codigos(b: Codigos):
    """Código do produto no PDV/app lido do relatório: grava só onde o cadastro ainda não tem código."""
    n = 0
    with psycopg.connect(**DSN) as conn, conn.transaction():
        for it in b.itens:
            cod = str(it.get("codigo") or "").strip()[:40]
            try:
                pid = uuid.UUID(str(it.get("produto_id")))
            except ValueError:
                continue
            if cod:
                n += conn.execute("""update fin_app.produtos set codigo_pdv = %s, atualizado_em = now()
                                     where id = %s and coalesce(codigo_pdv, '') = ''""", (cod, pid)).rowcount
    return {"preenchidos": n}


@router.get("/vendas/apelidos")
def apelidos():
    return q("select nome_norm, nome, produto_id, ignorar from fin_app.vendas_apelidos")


class Apelido(BaseModel):
    nome: str = Field(min_length=1, max_length=200)
    nome_norm: str = Field(min_length=1, max_length=200)
    produto_id: uuid.UUID | None = None
    ignorar: bool = False


@router.put("/vendas/apelidos")
def salvar_apelido(a: Apelido):
    """Lembra o que é um nome do relatório: um produto do cadastro ou "não é do cardápio" (ignorar nas próximas importações)."""
    if not a.ignorar and not a.produto_id:
        raise HTTPException(422, "Escolha o produto ou marque para ignorar")
    q("""insert into fin_app.vendas_apelidos (nome_norm, nome, produto_id, ignorar) values (%s, %s, %s, %s)
         on conflict (nome_norm) do update set nome = excluded.nome, produto_id = excluded.produto_id, ignorar = excluded.ignorar
         returning nome_norm""", (a.nome_norm, a.nome.strip(), None if a.ignorar else a.produto_id, a.ignorar))
    return {"ok": True}


# ------------------------------------------------------------------ engenharia
CLASSES = {
    (True, True): "estrela", (True, False): "burro", (False, True): "quebra", (False, False): "cao",
}


def classificar(itens: list[dict]) -> dict:
    """Classifica itens de um grupo (já com qtd e mc). Devolve os limites usados."""
    total = sum(i["qtd"] for i in itens)
    n = len(itens)
    if not n or total <= 0:
        return {"itens": n, "vendidos": 0}
    corte_pop = 0.7 / n * 100
    mc_media = sum(i["mc"] * i["qtd"] for i in itens) / total
    for i in itens:
        i["mix_pct"] = round(i["qtd"] / total * 100, 2)
        i["popular"] = i["mix_pct"] >= corte_pop
        i["margem_alta"] = i["mc"] >= mc_media
        i["classe"] = CLASSES[(i["popular"], i["margem_alta"])]
    return {"itens": n, "vendidos": total, "corte_pop_pct": round(corte_pop, 2), "mc_media": round(mc_media, 2),
            "mc_total": round(sum(i["mc"] * i["qtd"] for i in itens), 2),
            "faturamento": round(sum(i["preco_venda"] * i["qtd"] for i in itens), 2)}


@router.get("/engenharia")
def engenharia(de: str, ate: str, por: str = "categoria"):
    d1, d2 = _mes(de), _mes(ate)
    if d2 < d1:
        d1, d2 = d2, d1
    par = _param()
    qtd = {r["produto_id"]: float(r["qtd"]) for r in q("""select produto_id, sum(quantidade) as qtd from fin_app.vendas_produtos
                                                          where mes between %s and %s group by produto_id""", (d1, d2))}
    analisados, fora = [], []
    for p in _produtos():
        p["qtd"] = qtd.get(p["id"], 0.0)
        if p["cmv"] is None or not p["preco_venda"]:
            fora.append({**p, "motivo": "sem ficha técnica" if p["cmv"] is None else "sem preço de venda"})
            continue
        p.update(precificar(p, par))
        analisados.append(p)
    grupos = {}
    for p in analisados:
        grupos.setdefault(p["categoria"] or "Sem categoria" if por == "categoria" else "Cardápio todo", []).append(p)
    out = []
    for nome, itens in grupos.items():
        vendidos = [i for i in itens if i["qtd"] > 0]
        info = classificar(vendidos)
        for i in itens:
            if i["qtd"] <= 0:
                i.update({"classe": "sem_vendas", "mix_pct": 0})
        out.append({"grupo": nome, **info, "produtos": itens})
    meses = q("select to_char(mes, 'YYYY-MM') as mes from fin_app.vendas_produtos group by mes order by mes desc")
    return {"de": d1.strftime("%Y-%m"), "ate": d2.strftime("%Y-%m"), "por": por, "grupos": out, "fora": fora,
            "meses_com_vendas": [m["mes"] for m in meses]}
