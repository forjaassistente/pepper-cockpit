"""Conferência das notas XML × contas a pagar do Nibo (só leitura).

Para cada parcela (duplicata) do XML — ou o total da nota, quando o XML não traz parcelas — procura uma conta a pagar
do mesmo fornecedor (raiz do CNPJ, que junta matriz e filiais) com o mesmo valor e vencimento próximo.
Cada conta do Nibo só casa com uma parcela.
"""
import datetime as dt
from decimal import Decimal

import psycopg
from psycopg.rows import dict_row
from fastapi import APIRouter

from fin import DSN, _conv
from compras import FINALIDADES

router = APIRouter(prefix="/api/inbox/conferencia-nibo")

PERTO = 5          # dias de diferença aceitos no vencimento
JANELA = 45        # sem parcela no XML: procura até 45 dias depois da emissão


@router.get("")
def conferir(desde: dt.date | None = None):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        notas = cur.execute("""select d.id, d.status, d.dados->'nfe' as nfe from fin_app.documentos d
                               where d.subtipo = 'nfe_xml' and d.dados->'nfe' is not null
                                 and (%s::date is null or (d.dados->'nfe'->>'emissao')::date >= %s)
                               order by d.dados->'nfe'->>'emissao', d.dados->'nfe'->>'numero'""", (desde, desde)).fetchall()
        raizes = sorted({(n["nfe"]["emitente"]["cnpj"] or "")[:8] for n in notas if n["nfe"]["emitente"]["cnpj"]})
        titulos = cur.execute("""select t.id, t.origem, t.vencimento, t.valor, t.status, t.contato, t.descricao, t.data_pagamento,
                                        left(regexp_replace(p.documento, '\\D', '', 'g'), 8) as raiz
                                 from fin_app.v_titulos t join fin_app.pessoas p on p.id = t.contato_id
                                 where t.tipo = 'pagar' and left(regexp_replace(p.documento, '\\D', '', 'g'), 8) = any(%s)
                                   and t.vencimento >= %s""",
                              (raizes, min((dt.date.fromisoformat(n["nfe"]["emissao"]) for n in notas), default=dt.date.today())
                               - dt.timedelta(days=10))).fetchall()
    usados = set()
    esperados = []
    for n in notas:
        nfe = n["nfe"]
        emissao = dt.date.fromisoformat(nfe["emissao"])
        base = {"documento_id": str(n["id"]), "nf": nfe["numero"], "fornecedor": nfe["emitente"]["fantasia"] or nfe["emitente"]["nome"],
                "raiz": (nfe["emitente"]["cnpj"] or "")[:8], "emissao": emissao,
                "debito": FINALIDADES.get(nfe.get("finalidade") or "1")}
        if nfe.get("parcelas"):
            for p in nfe["parcelas"]:
                esperados.append(base | {"parcela": f"{p['numero']}/{len(nfe['parcelas']):03d}", "valor": Decimal(p["valor"]),
                                         "vencimento": dt.date.fromisoformat(p["vencimento"]) if p.get("vencimento") else None})
        else:
            esperados.append(base | {"parcela": None, "valor": Decimal(nfe["valor_total"]), "vencimento": None})

    def candidatos(e):
        return [t for t in titulos if t["raiz"] == e["raiz"] and t["id"] not in usados]

    def dist(e, t):
        ref = e["vencimento"] or e["emissao"]
        return abs((t["vencimento"] - ref).days)

    # passe 1: valor igual e vencimento perto (ou, sem parcela, até JANELA dias depois da emissão)
    def exato(e, t):
        if abs(Decimal(t["valor"]) - e["valor"]) >= Decimal("0.01"):
            return False
        if e["vencimento"]:
            return dist(e, t) <= PERTO
        return e["emissao"] - dt.timedelta(days=2) <= t["vencimento"] <= e["emissao"] + dt.timedelta(days=JANELA)
    regras = [("ok", exato),
              ("data", lambda e, t: abs(Decimal(t["valor"]) - e["valor"]) < Decimal("0.01")),                        # mesmo valor, outra data
              ("valor", lambda e, t: e["vencimento"] and dist(e, t) <= PERTO
                                     and abs(Decimal(t["valor"]) - e["valor"]) <= max(e["valor"] * Decimal("0.10"), Decimal("5")))]  # juros/desconto
    for situacao, regra in regras:
        for e in esperados:
            if e.get("situacao"):
                continue
            achados = sorted((t for t in candidatos(e) if regra(e, t)), key=lambda t: (dist(e, t), abs(Decimal(t["valor"]) - e["valor"])))
            if achados:
                t = achados[0]
                usados.add(t["id"])
                e["situacao"], e["nibo"] = situacao, {k: _conv(t[k]) for k in ("origem", "vencimento", "valor", "status", "contato",
                                                                               "descricao", "data_pagamento")}
    for e in esperados:
        if not e.get("situacao"):
            e["situacao"] = "debito" if e["debito"] else "nao_achei"
            e["nibo"] = None
    inicio = min((e["emissao"] for e in esperados), default=dt.date.today())
    resumo = {s: sum(1 for e in esperados if e["situacao"] == s) for s in ("ok", "valor", "data", "nao_achei", "debito")}
    # contas do Nibo desses fornecedores que não casaram com nenhuma nota (boleto sem XML recebido, nota agrupada…)
    sobras = [{k: _conv(t[k]) for k in ("vencimento", "valor", "status", "contato", "descricao")} for t in titulos
              if t["id"] not in usados and inicio <= t["vencimento"] <= dt.date.today() + dt.timedelta(days=60)]
    return {"resumo": resumo, "itens": [{k: _conv(v) for k, v in e.items() if k != "raiz"} for e in esperados],
            "sobras": sorted(sobras, key=lambda s: (s["contato"] or "", s["vencimento"]))}
