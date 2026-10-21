"""Conciliação de notas de compra (etapa 2 do estoque).

Cada item da nota é ligado a um insumo com um FATOR de conversão: quantas unidades de compra do insumo vêm em
1 unidade da nota (ex.: "CX 12X1L" → 12 l). Ao salvar:
  - o vínculo fornecedor/código → insumo fica guardado (a próxima nota do mesmo produto já vem conciliada);
  - entra no estoque (estoque_entradas, na unidade de compra do insumo — a mesma da contagem);
  - o preço pago vai para o histórico e o insumo passa a usar o ÚLTIMO preço pago (pela data de emissão).

Origem dos itens: XML da NF-e (pronto), foto/PDF lido pela IA (precisa de ANTHROPIC_API_KEY) ou digitado.
"""
import base64
import datetime as dt
import difflib
import io
import json
import logging
import os
import re
import unicodedata
import uuid
from decimal import Decimal

import anthropic
import psycopg
from fastapi import APIRouter, HTTPException
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

import boleto
import empresa
import inbox
from fin import DSN, q

log = logging.getLogger("compras")
router = APIRouter(prefix="/api/compras")

# ------------------------------------------------------------------ normalização e sugestão
PALAVRAS_VAZIAS = {"de", "da", "do", "das", "dos", "com", "c", "e", "tipo", "tp", "kg", "g", "gr", "un", "und", "unid", "cx",
                   "pct", "pc", "fd", "lt", "l", "ml", "pt", "sc", "bd", "bdj", "emb", "ref", "x", "s", "cong", "resf"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


def _tokens(s: str) -> list[str]:
    return [t for t in norm(s).split() if t not in PALAVRAS_VAZIAS and not re.fullmatch(r"\d+([.,]\d+)?[a-z]*", t) and len(t) > 1]


def _casa(ta: str, tb: str) -> bool:
    return ta == tb or (min(len(ta), len(tb)) >= 3 and (ta.startswith(tb) or tb.startswith(ta)))


def similaridade(descricao: str, nome: str, peso: dict | None = None) -> float:
    """0..1: quanto do nome do insumo aparece na descrição da nota (aceita abreviação: 'muss' ~ 'mussarela').
    Palavras raras entre os insumos pesam mais ('mussarela' > 'queijo', 'fatiada'); a 1ª palavra da nota
    (normalmente o produto) ganha um bônus."""
    a, b = _tokens(descricao), _tokens(nome)
    if not a or not b:
        return 0.0
    w = lambda t: (peso or {}).get(t, 1.0)
    cobertura = sum(w(t) for t in b if any(_casa(ta, t) for ta in a)) / sum(w(t) for t in b)
    texto = difflib.SequenceMatcher(None, " ".join(a), " ".join(b)).ratio()
    bonus = 0.1 if any(_casa(a[0], t) for t in b) else 0.0
    return round(min(1.0, 0.7 * cobertura + 0.2 * texto + bonus), 3)


def pesos_palavras(nomes: list[str]) -> dict:
    """Peso de cada palavra pela raridade entre os nomes dos insumos (IDF)."""
    import math
    df = {}
    for n in nomes:
        for t in set(_tokens(n)):
            df[t] = df.get(t, 0) + 1
    total = max(len(nomes), 1)
    return {t: math.log(1 + total / c) for t, c in df.items()}


UN_NOTA = {"kg": "kg", "kgs": "kg", "g": "g", "gr": "g", "l": "l", "lt": "l", "lts": "l", "litro": "l", "ml": "ml"}
MEDIDA = {"kg": ("kg", 1), "g": ("kg", 0.001), "l": ("l", 1), "ml": ("l", 0.001)}


def fator_sugerido(descricao: str, unidade_nota: str, unidade_insumo: str) -> float | None:
    """Quantas unidades do insumo vêm em 1 unidade da nota, lendo a descrição ('CX 12X1L', 'PC 4KG', 'C/12')."""
    un = UN_NOTA.get(norm(unidade_nota), norm(unidade_nota))
    ui = unidade_insumo
    d = norm(descricao).replace(",", ".")
    if un == ui:
        return 1.0
    if un in MEDIDA and ui in MEDIDA and MEDIDA[un][0] == MEDIDA[ui][0]:      # g → kg, ml → l
        return MEDIDA[un][1] / MEDIDA[ui][1]
    pack = re.search(r"(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|gr|l|lt|ml)\b", d)
    tam = re.search(r"(\d+(?:\.\d+)?)\s*(kg|g|gr|l|lt|ml)\b", d)
    qtd = re.search(r"(?:c\s*/?\s*|com\s+)(\d+)\b|\b(\d+)\s*(?:un|und|unid|unidades)\b", d)
    if ui in MEDIDA:                                    # insumo em kg/l: precisa do peso/volume da embalagem
        if pack:
            n, v, u = int(pack.group(1)), float(pack.group(2)), UN_NOTA.get(pack.group(3), pack.group(3))
        elif tam:
            n, v, u = 1, float(tam.group(1)), UN_NOTA.get(tam.group(2), tam.group(2))
        else:
            return None
        if MEDIDA[u][0] != MEDIDA[ui][0]:
            return None
        return round(n * v * MEDIDA[u][1] / MEDIDA[ui][1], 6)
    if ui == "un":
        if pack:
            return float(pack.group(1))
        if qtd:
            return float(qtd.group(1) or qtd.group(2))
        if un in ("un", "und", "unid", "pc", "pca"):
            return 1.0
    if ui == "dz" and un in ("dz", "duzia"):
        return 1.0
    return None


def _vinculo(cur, cnpj, item) -> dict | None:
    """Vínculo aprendido: código do fornecedor > código de barras > descrição."""
    if item.get("codigo"):
        v = cur.execute("select * from fin_app.insumo_vinculos where emitente_cnpj = %s and codigo = %s",
                        (cnpj, item["codigo"])).fetchone()
        if v:
            return v | {"por": "código do fornecedor"}
    if item.get("ean"):
        v = cur.execute("select * from fin_app.insumo_vinculos where ean = %s and not ignorar order by usos desc limit 1",
                        (item["ean"],)).fetchone()
        if v:
            return v | {"por": "código de barras"}
    v = cur.execute("select * from fin_app.insumo_vinculos where emitente_cnpj = %s and descricao_norm = %s",
                    (cnpj, norm(item["descricao"]))).fetchone()
    return v | {"por": "descrição"} if v else None


# ------------------------------------------------------------------ criar a compra a partir do documento
def _pessoa_do_cnpj(cur, cnpj):
    if not cnpj:
        return None
    r = cur.execute("""select id from fin_app.pessoas where regexp_replace(coalesce(documento, ''), '\\D', '', 'g') = %s
                       order by ativo desc limit 1""", (cnpj,)).fetchone()
    return r["id"] if r else None


# finNFe: só a 1 (normal) é compra de mercadoria; as outras repetem os itens de uma nota antiga com valores
# que não são preço (juros, ajuste de imposto, devolução) e não podem ir para o estoque nem para o custo
FINALIDADES = {"2": "Nota complementar", "3": "Nota de ajuste", "4": "Nota de devolução", "5": "Nota de crédito", "6": "Nota de débito"}
TIPOS_DEBITO = {"04": "multa e juros"}


def finalidade_nao_compra(nfe: dict | None) -> str | None:
    """Rótulo da nota que não é compra de mercadoria (ex.: "Nota de débito · multa e juros"); None se for compra normal."""
    rot = FINALIDADES.get((nfe or {}).get("finalidade") or "1")
    if rot and nfe.get("tipo_debito") in TIPOS_DEBITO:
        rot += " · " + TIPOS_DEBITO[nfe["tipo_debito"]]
    return rot


def marcar_nao_compra(cur, cid, rotulo: str):
    """Itens ficam como "não é insumo" (sem aprender vínculo), sem entrada/preço, e a nota sai das pendências."""
    cur.execute("delete from fin_app.estoque_entradas where compra_id = %s", (cid,))
    cur.execute("delete from fin_app.insumo_precos where compra_id = %s returning insumo_id", (cid,))
    for iid in {r["insumo_id"] for r in cur.fetchall()}:
        cur.execute("""update fin_app.insumos s set custo_unitario = coalesce((select preco from fin_app.insumo_precos p where p.insumo_id = s.id
                         order by data desc, criado_em desc limit 1), custo_unitario), atualizado_em = now() where id = %s""", (iid,))
    cur.execute("update fin_app.compras_itens set insumo_id = null, fator = null, ignorado = true where compra_id = %s", (cid,))
    cur.execute("update fin_app.compras set finalidade = %s, conciliada_em = coalesce(conciliada_em, now()) where id = %s", (rotulo, cid))


def compra_do_documento(cur, did) -> uuid.UUID:
    """Devolve a compra deste documento, criando-a (sem mexer no financeiro) se ainda não existir."""
    d = cur.execute("select * from fin_app.documentos where id = %s", (did,)).fetchone()
    if not d or d["tipo"] != "nota_fiscal":
        raise HTTPException(422, "Este documento não é uma nota fiscal")
    dados = d["dados"] or {}
    nfe = dados.get("nfe")
    chave = (nfe or {}).get("chave") or dados.get("chave")
    r = cur.execute("select id from fin_app.compras where documento_id = %s or (%s::text is not null and chave = %s)",
                    (did, chave, chave)).fetchone()
    if r:
        return r["id"]
    if nfe:
        e = nfe["emitente"]
        cid = cur.execute("""insert into fin_app.compras (documento_id, chave, numero, serie, emissao, emitente_cnpj, emitente_nome,
                                 pessoa_id, valor_produtos, valor_frete, valor_desconto, valor_total, origem)
                             values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'nfe_xml') returning id""",
                          (did, nfe.get("chave"), nfe["numero"], nfe["serie"], nfe["emissao"], e["cnpj"], e["fantasia"] or e["nome"],
                           _pessoa_do_cnpj(cur, e["cnpj"]), nfe["valor_produtos"], nfe["valor_frete"], nfe["valor_desconto"],
                           nfe["valor_total"])).fetchone()["id"]
        cur.executemany("""insert into fin_app.compras_itens (compra_id, n, codigo, ean, descricao, ncm, cfop, unidade, quantidade,
                               valor_unitario, valor_total) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        [(cid, i["n"], i["codigo"], i["ean"], i["descricao"][:300], i["ncm"], i["cfop"], i["unidade"],
                          i["quantidade"], i["valor_unitario"], i["valor_total"]) for i in nfe["itens"]])
        if rot := finalidade_nao_compra(nfe):
            marcar_nao_compra(cur, cid, rot)
        return cid
    vt = dados.get("valor_total")
    vt = Decimal(vt.replace(".", "").replace(",", ".")) if isinstance(vt, str) and vt else None
    return cur.execute("""insert into fin_app.compras (documento_id, chave, emissao, valor_total, origem)
                          values (%s, %s, %s, %s, 'foto') returning id""",
                       (did, chave, d["recebido_em"].date(), vt)).fetchone()["id"]


@router.post("/de-documento/{did}")
def de_documento(did: uuid.UUID):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        return {"id": compra_do_documento(conn.cursor(), did)}


# ------------------------------------------------------------------ tela de conciliação
@router.get("/{cid}")
def detalhe(cid: uuid.UUID):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        c = cur.execute("""select c.*, p.nome as fornecedor_cadastro, d.subtipo as doc_subtipo, d.nome as doc_nome,
                                  exists (select 1 from fin_app.lancamentos l where l.id = any(d.lancamento_ids)) as no_financeiro
                           from fin_app.compras c left join fin_app.pessoas p on p.id = c.pessoa_id
                           left join fin_app.documentos d on d.id = c.documento_id where c.id = %s""", (cid,)).fetchone()
        if not c:
            raise HTTPException(404, "Compra não encontrada")
        insumos = cur.execute("""select s.id, s.nome, s.tipo, s.unidade, s.custo_unitario, s.saida_tipo, s.saida_base, s.saida_rende,
                                        k.nome as categoria
                                 from fin_app.insumos s left join fin_app.cat_itens k on k.id = s.categoria_id
                                 where s.ativo and s.tipo = 'insumo' order by k.ordem nulls last, k.nome, lower(s.nome)""").fetchall()
        por_id = {i["id"]: i for i in insumos}
        peso = pesos_palavras([i["nome"] for i in insumos])
        itens = cur.execute("select * from fin_app.compras_itens where compra_id = %s order by n", (cid,)).fetchall()
        for it in itens:
            it["sugestoes"] = []
            if it["insumo_id"] or it["ignorado"]:
                it["situacao"] = "conciliado" if it["insumo_id"] else "ignorado"
                continue
            v = _vinculo(cur, c["emitente_cnpj"], it)
            if v:
                it["situacao"] = "vinculo"
                it["vinculo_por"] = v["por"]
                it["ignorado"] = v["ignorar"]
                if not v["ignorar"] and v["insumo_id"] in por_id:
                    it["insumo_id"], it["fator"] = v["insumo_id"], v["fator"]
                continue
            ranking = sorted(((similaridade(it["descricao"], i["nome"], peso), i) for i in insumos), key=lambda x: -x[0])
            it["sugestoes"] = [{"insumo_id": i["id"], "nome": i["nome"], "score": s,
                                "fator": fator_sugerido(it["descricao"], it["unidade"] or "", i["unidade"])}
                               for s, i in ranking[:3] if s >= 0.4]
            it["situacao"] = "sugestao" if it["sugestoes"] else "pendente"
            if it["sugestoes"] and it["sugestoes"][0]["score"] >= 0.6:
                it["insumo_id"], it["fator"] = it["sugestoes"][0]["insumo_id"], it["sugestoes"][0]["fator"]
        # fator de quem já veio com insumo mas sem fator (sugestão fraca de conversão)
        for it in itens:
            if it["insumo_id"] and not it.get("fator") and it["insumo_id"] in por_id:
                it["fator"] = fator_sugerido(it["descricao"], it["unidade"] or "", por_id[it["insumo_id"]]["unidade"])
    return {"compra": c, "itens": itens, "insumos": insumos, "ia_disponivel": bool(os.environ.get("ANTHROPIC_API_KEY"))}


class ItemConc(BaseModel):
    n: int | None = None                       # None = item novo digitado (nota em foto)
    descricao: str | None = Field(None, max_length=300)
    quantidade: Decimal | None = Field(None, gt=0, max_digits=15, decimal_places=4)
    unidade: str | None = Field(None, max_length=10)
    valor_total: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    insumo_id: uuid.UUID | None = None
    fator: Decimal | None = Field(None, gt=0, max_digits=14, decimal_places=6)
    ignorar: bool = False
    remover: bool = False                      # tirar um item digitado errado


class Conciliacao(BaseModel):
    itens: list[ItemConc] = Field(max_length=500)
    emissao: dt.date | None = None             # nota em foto: data e fornecedor digitados/lidos
    emitente_nome: str | None = Field(None, max_length=200)
    emitente_cnpj: str | None = Field(None, max_length=20)
    numero: str | None = Field(None, max_length=20)
    lembrar: bool = True
    atualizar_preco: bool = True


def _upsert_vinculo(cur, cnpj, it, insumo_id, fator, ignorar):
    dn = norm(it["descricao"])
    chave = ("codigo", it["codigo"]) if it.get("codigo") else ("descricao_norm", dn)
    atual = cur.execute(f"""select id from fin_app.insumo_vinculos where emitente_cnpj is not distinct from %s and {chave[0]} = %s
                            {'' if chave[0] == 'codigo' else 'and codigo is null'}""", (cnpj, chave[1])).fetchone()
    if atual:
        cur.execute("""update fin_app.insumo_vinculos set insumo_id = %s, fator = %s, ignorar = %s, ean = coalesce(%s, ean),
                         unidade_nota = %s, usos = usos + 1, atualizado_em = now() where id = %s""",
                    (insumo_id, fator, ignorar, it.get("ean"), it.get("unidade"), atual["id"]))
    else:
        cur.execute("""insert into fin_app.insumo_vinculos (emitente_cnpj, codigo, ean, descricao_norm, unidade_nota, insumo_id, fator, ignorar)
                       values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (cnpj, it.get("codigo"), it.get("ean"), dn, it.get("unidade"), insumo_id, fator, ignorar))


@router.post("/{cid}/conciliar")
def conciliar(cid: uuid.UUID, b: Conciliacao):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        c = cur.execute("select * from fin_app.compras where id = %s for update", (cid,)).fetchone()
        if not c:
            raise HTTPException(404, "Compra não encontrada")
        if c["finalidade"]:
            raise HTTPException(422, f"{c['finalidade']}: não é compra de mercadoria, não entra no estoque nem no preço")
        if c["origem"] != "nfe_xml":   # foto/digitada: cabeçalho vem da tela
            cnpj = re.sub(r"\D", "", b.emitente_cnpj or "") or None
            cur.execute("""update fin_app.compras set emissao = coalesce(%s, emissao), emitente_nome = coalesce(%s, emitente_nome),
                             emitente_cnpj = coalesce(%s, emitente_cnpj), numero = coalesce(%s, numero),
                             pessoa_id = coalesce(pessoa_id, %s) where id = %s""",
                        (b.emissao, b.emitente_nome, cnpj, b.numero, _pessoa_do_cnpj(cur, cnpj), cid))
            c = cur.execute("select * from fin_app.compras where id = %s", (cid,)).fetchone()
        data = c["emissao"] or dt.date.today()
        fornecedor = c["emitente_nome"]
        tocados = set()
        for x in b.itens:
            if x.n is None:                                   # item digitado na tela
                if c["origem"] == "nfe_xml":
                    raise HTTPException(422, "Itens de NF-e em XML vêm da nota e não podem ser digitados")
                if not (x.descricao and x.quantidade and x.valor_total is not None):
                    raise HTTPException(422, "Item digitado precisa de descrição, quantidade e valor total")
                n = cur.execute("select coalesce(max(n), 0) + 1 as n from fin_app.compras_itens where compra_id = %s", (cid,)).fetchone()["n"]
                cur.execute("""insert into fin_app.compras_itens (compra_id, n, descricao, unidade, quantidade, valor_unitario, valor_total)
                               values (%s, %s, %s, %s, %s, %s, %s)""",
                            (cid, n, x.descricao.strip(), (x.unidade or "UN").upper(), x.quantidade,
                             x.valor_total / x.quantidade, x.valor_total))
                x.n = n
            it = cur.execute("select * from fin_app.compras_itens where compra_id = %s and n = %s", (cid, x.n)).fetchone()
            if not it:
                raise HTTPException(404, f"Item {x.n} não está nesta nota")
            if x.remover:
                if c["origem"] == "nfe_xml":
                    raise HTTPException(422, "Itens da NF-e não podem ser removidos; marque como “não é insumo”")
                cur.execute("delete from fin_app.estoque_entradas where compra_id = %s and compra_n = %s", (cid, x.n))
                cur.execute("delete from fin_app.insumo_precos where compra_id = %s and compra_n = %s returning insumo_id", (cid, x.n))
                tocados.update(r["insumo_id"] for r in cur.fetchall())
                cur.execute("delete from fin_app.compras_itens where compra_id = %s and n = %s", (cid, x.n))
                continue
            if c["origem"] != "nfe_xml" and (x.descricao or x.quantidade or x.valor_total is not None):   # edição de item digitado/lido
                cur.execute("""update fin_app.compras_itens set descricao = coalesce(%s, descricao), quantidade = coalesce(%s, quantidade),
                                 unidade = coalesce(%s, unidade), valor_total = coalesce(%s, valor_total),
                                 valor_unitario = coalesce(%s, valor_total) / coalesce(%s, quantidade) where compra_id = %s and n = %s""",
                            (x.descricao, x.quantidade, x.unidade, x.valor_total, x.valor_total, x.quantidade, cid, x.n))
                it = cur.execute("select * from fin_app.compras_itens where compra_id = %s and n = %s", (cid, x.n)).fetchone()
            # refaz entrada e preço deste item (salvar de novo não duplica)
            cur.execute("delete from fin_app.estoque_entradas where compra_id = %s and compra_n = %s", (cid, x.n))
            cur.execute("delete from fin_app.insumo_precos where compra_id = %s and compra_n = %s returning insumo_id", (cid, x.n))
            tocados.update(r["insumo_id"] for r in cur.fetchall())
            if x.ignorar:
                cur.execute("update fin_app.compras_itens set insumo_id = null, fator = null, ignorado = true where compra_id = %s and n = %s", (cid, x.n))
                if b.lembrar:
                    _upsert_vinculo(cur, c["emitente_cnpj"], it, None, None, True)
                continue
            if not x.insumo_id:
                cur.execute("update fin_app.compras_itens set insumo_id = null, fator = null, ignorado = false where compra_id = %s and n = %s", (cid, x.n))
                continue
            if not x.fator:
                raise HTTPException(422, f"Item {x.n} ({it['descricao'][:40]}): informe a conversão")
            ins = cur.execute("select id, nome, unidade from fin_app.insumos where id = %s and tipo = 'insumo'", (x.insumo_id,)).fetchone()
            if not ins:
                raise HTTPException(422, f"Item {x.n}: insumo não encontrado")
            qtd = Decimal(it["quantidade"] or 0) * x.fator
            if qtd <= 0:
                raise HTTPException(422, f"Item {x.n}: quantidade da nota está zerada")
            preco = (Decimal(it["valor_total"] or 0) / qtd).quantize(Decimal("0.0001"))
            cur.execute("update fin_app.compras_itens set insumo_id = %s, fator = %s, ignorado = false where compra_id = %s and n = %s",
                        (x.insumo_id, x.fator, cid, x.n))
            cur.execute("""insert into fin_app.estoque_entradas (insumo_id, data, quantidade, custo_unitario, compra_id, compra_n)
                           values (%s, %s, %s, %s, %s, %s)""", (x.insumo_id, data, qtd, preco, cid, x.n))
            cur.execute("""insert into fin_app.insumo_precos (insumo_id, data, preco, fornecedor, compra_id, compra_n)
                           values (%s, %s, %s, %s, %s, %s)""", (x.insumo_id, data, preco, fornecedor, cid, x.n))
            tocados.add(x.insumo_id)
            if b.lembrar:
                _upsert_vinculo(cur, c["emitente_cnpj"], it, x.insumo_id, x.fator, False)
        if b.atualizar_preco:
            # último preço pago (pela data de emissão; nota antiga lançada depois não sobrescreve a mais nova)
            for iid in tocados:
                ult = cur.execute("""select preco from fin_app.insumo_precos where insumo_id = %s
                                     order by data desc, criado_em desc limit 1""", (iid,)).fetchone()
                if ult:
                    cur.execute("update fin_app.insumos set custo_unitario = %s, atualizado_em = now() where id = %s", (ult["preco"], iid))
        r = cur.execute("""select count(*) as total, count(*) filter (where insumo_id is not null or ignorado) as resolvidos
                           from fin_app.compras_itens where compra_id = %s""", (cid,)).fetchone()
        completa = r["total"] > 0 and r["total"] == r["resolvidos"]
        cur.execute("update fin_app.compras set conciliada_em = case when %s then coalesce(conciliada_em, now()) end where id = %s",
                    (completa, cid))
    return {"ok": True, "itens": r["total"], "conciliados": r["resolvidos"], "completa": completa}


# ------------------------------------------------------------------ leitura de foto/PDF pela IA
_SCHEMA_ITENS = {
    "type": "object",
    "properties": {
        "fornecedor": {"type": "string"}, "cnpj": {"type": "string"}, "numero": {"type": "string"},
        "emissao": {"type": "string"},
        "itens": {"type": "array", "items": {"type": "object", "properties": {
            "descricao": {"type": "string"}, "quantidade": {"type": "number"}, "unidade": {"type": "string"},
            "valor_total": {"type": "number"}}, "required": ["descricao", "quantidade", "unidade", "valor_total"],
            "additionalProperties": False}},
    },
    "required": ["fornecedor", "cnpj", "numero", "emissao", "itens"],
    "additionalProperties": False,
}
_PROMPT_ITENS = (
    "Você lê notas fiscais e notinhas de compra (cupom, nota de feira, pedido) do restaurante {empresa}. "
    "Extraia o fornecedor (nome), o CNPJ do fornecedor (só dígitos; vazio se não houver), o número da nota (vazio se não houver), "
    "a data de emissão (AAAA-MM-DD; vazio se não houver) e TODOS os itens comprados, na ordem em que aparecem. "
    "Para cada item: descrição como está na nota, quantidade (número), unidade como está na nota (KG, UN, CX, PCT, L...) "
    "e valor total do item em reais (número, já com desconto do item se houver). Não invente itens; ignore totais, "
    "impostos e formas de pagamento.")


@router.post("/{cid}/ler-itens")
def ler_itens(cid: uuid.UUID):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(409, "A leitura de fotos pela IA precisa da chave da Anthropic no servidor. Por enquanto, digite os itens.")
    c = q("select * from fin_app.compras where id = %s", (cid,))
    if not c or not c[0]["documento_id"]:
        raise HTTPException(404, "Compra sem documento")
    c = c[0]
    if c["origem"] == "nfe_xml":
        raise HTTPException(422, "Esta nota veio em XML: os itens já estão completos")
    if q("select 1 from fin_app.compras_itens where compra_id = %s and (insumo_id is not null or ignorado)", (cid,)):
        raise HTTPException(409, "Já há itens conciliados nesta nota; corrija-os na tela em vez de ler de novo")
    caminho = inbox._arquivo(c["documento_id"])
    with open(caminho, "rb") as f:
        conteudo = f.read()
    mime = "application/pdf" if conteudo[:5] == b"%PDF-" else "image/jpeg"
    imagens = [p[0] for p in boleto._paginas(conteudo, mime)][:4]
    blocos = []
    for img in imagens:
        buf = io.BytesIO()
        im = img.copy()
        im.thumbnail((1800, 1800))
        im.convert("RGB").save(buf, "JPEG", quality=88)
        blocos.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                   "data": base64.standard_b64encode(buf.getvalue()).decode()}})
    blocos.append({"type": "text", "text": "Extraia o cabeçalho e os itens desta nota de compra."})
    try:
        resp = anthropic.Anthropic(timeout=120.0).beta.messages.create(
            model=boleto.MODELO, max_tokens=8000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SCHEMA_ITENS}},
            system=_PROMPT_ITENS.replace("{empresa}", empresa.nome()), messages=[{"role": "user", "content": blocos}])
    except anthropic.APIStatusError as e:
        log.warning("Claude itens: HTTP %s", e.status_code)
        raise HTTPException(502, f"A IA respondeu com erro ({e.status_code}). Tente de novo ou digite os itens.")
    except anthropic.APIConnectionError:
        raise HTTPException(502, "Sem conexão com a IA. Tente de novo ou digite os itens.")
    if resp.stop_reason in ("refusal", "max_tokens"):
        raise HTTPException(502, "A IA não conseguiu ler esta nota por completo. Digite os itens.")
    texto = next((bl.text for bl in resp.content if bl.type == "text"), "")
    try:
        lido = json.loads(texto)
    except json.JSONDecodeError:
        raise HTTPException(502, "Resposta da IA incompleta. Tente de novo ou digite os itens.")
    itens = [i for i in lido["itens"] if i["descricao"].strip() and i["quantidade"] > 0 and i["valor_total"] >= 0]
    if not itens:
        raise HTTPException(422, "A IA não encontrou itens nesta imagem")
    try:
        emissao = dt.date.fromisoformat(lido["emissao"]) if lido["emissao"] else None
    except ValueError:
        emissao = None
    cnpj = re.sub(r"\D", "", lido["cnpj"]) or None
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        cur.execute("delete from fin_app.compras_itens where compra_id = %s", (cid,))
        cur.executemany("""insert into fin_app.compras_itens (compra_id, n, descricao, unidade, quantidade, valor_unitario, valor_total)
                           values (%s, %s, %s, %s, %s, %s, %s)""",
                        [(cid, k, i["descricao"].strip()[:300], (i["unidade"] or "UN").upper()[:10], i["quantidade"],
                          i["valor_total"] / i["quantidade"], round(i["valor_total"], 2)) for k, i in enumerate(itens, start=1)])
        cur.execute("""update fin_app.compras set emitente_nome = coalesce(nullif(%s, ''), emitente_nome), emitente_cnpj = coalesce(%s, emitente_cnpj),
                         numero = coalesce(nullif(%s, ''), numero), emissao = coalesce(%s, emissao),
                         pessoa_id = coalesce(pessoa_id, %s), valor_produtos = %s where id = %s""",
                    (lido["fornecedor"].strip(), cnpj, lido["numero"].strip(), emissao, _pessoa_do_cnpj(cur, cnpj),
                     round(sum(i["valor_total"] for i in itens), 2), cid))
    return {"ok": True, "itens": len(itens)}


@router.get("")
def listar(pendentes: bool = False):
    return q("""select c.id, c.documento_id, c.numero, c.emissao, c.emitente_nome, c.valor_total, c.origem, c.conciliada_em,
                       count(i.n) as itens, count(i.n) filter (where i.insumo_id is not null or i.ignorado) as conciliados
                from fin_app.compras c left join fin_app.compras_itens i on i.compra_id = c.id
                group by c.id having not %s or c.conciliada_em is null
                order by c.emissao desc nulls last, c.criado_em desc limit 300""", (pendentes,))
