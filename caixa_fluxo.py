"""Fechamento de caixa → fluxo de caixa (só admin: /api/fin/fluxo-caixa fica fora do prefixo do responsável de caixa).

Depois de fechar o dia, o admin confere uma proposta de lançamentos e confirma:
- recebimentos agrupados pelo grupo de conferência da forma (débito + crédito + pix da PagSeguro = 1 lançamento),
  com conta, categoria e prazo vindos do cadastro da forma de pagamento;
- motoboys (1 lançamento com o total), free lances (1 por pessoa) e diversos (saídas do caixa).
Modo teste (empresa.caixa_fluxo_teste): a confirmação só é guardada e comparada com o Nibo, sem entrar no fluxo.
"""
import datetime as dt
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from psycopg.rows import dict_row
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from fin import DSN, _conv, COLS

router = APIRouter(prefix="/api/fin/fluxo-caixa")

# Pagamento da equipe por canal: categoria (nome no plano de contas), contato e se agrupa num lançamento só
EQUIPE = {"Delivery": {"categoria": "Pagamento motoboys", "descricao": "Pagamento Motoboys", "contato": "MOTOBOYS", "agrupa": True},
          "Salão": {"categoria": "Free Lances", "descricao": "Free Lance", "contato": None, "agrupa": False}}


def _dm(d: dt.date) -> str:
    return d.strftime("%d/%m")


def _cat_por_nome(cur, nome, tipo):
    r = cur.execute("select id, categoria from fin_app.v_categorias where categoria = %s and tipo = %s limit 1", (nome, tipo)).fetchone()
    return (r["id"], r["categoria"]) if r else (None, None)


def _pessoa(cur, nome):
    """Pessoa do cadastro com este nome (para ligar o lançamento ao contato); None se não houver."""
    if not nome:
        return None
    r = cur.execute("select id from fin_app.pessoas where ativo and mesclada_em is null and lower(nome) = lower(%s) limit 1", (nome,)).fetchone()
    return r["id"] if r else None


def proposta(cur, data: dt.date) -> list[dict]:
    """O que o fechamento do dia gera, com os padrões do cadastro (antes de o admin conferir)."""
    linhas = []
    formas = cur.execute("""select f.nome, f.conferencia, f.prazo_recebimento, f.descricao_lanc, f.categoria_id, f.conta_id,
                                   c.categoria as categoria_nome, k.conta as conta_nome, f.ordem
                            from fin_app.formas_pagamento f
                            left join fin_app.v_categorias c on c.id = f.categoria_id
                            left join fin_app.v_contas k on k.id = f.conta_id order by f.ordem, f.nome""").fetchall()
    valores = {}
    for r in cur.execute("select forma, sum(valor) as v from fin_app.caixa_formas where data = %s group by forma", (data,)).fetchall():
        valores[r["forma"]] = r["v"]
    grupos = {}
    for f in formas:
        v = valores.get(f["nome"]) or 0
        if not v:
            continue
        g = grupos.setdefault(f["conferencia"], {"forma": f, "valor": Decimal(0), "formas": []})
        g["valor"] += v
        g["formas"].append(f["nome"])
    gaveta = next((f for f in formas if f["conferencia"] == "gaveta"), None)
    for conf, g in grupos.items():
        f = g["forma"]
        prazo = f["prazo_recebimento"]
        venc = data + dt.timedelta(days=prazo if prazo is not None else 7)
        desc = f["descricao_lanc"] or ("Recebimento dinheiro" if conf == "gaveta" else f"Recebimento {conf}")
        detalhe = " + ".join(g["formas"])
        if conf == "gaveta":   # tudo o que entrou em dinheiro; motoboys, free lances e diversos saem nos pagamentos
            k = cur.execute("""select sum(fechamento_dinheiro) as fech, sum(troco_inicial) as troco from fin_app.caixa_canal
                               where data = %s and fechamento_dinheiro is not null""", (data,)).fetchone()
            if k and k["fech"] is not None:
                br = lambda v: f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
                detalhe = (f"fechamento {br(k['fech'])} − troco {br(k['troco'])} · "
                           "sem descontar motoboys/free lances (eles entram nos pagamentos)")
        linhas.append({"chave": f"forma:{conf}", "tipo": "receber", "descricao": f"{desc} {_dm(data)}",
                       "detalhe": detalhe, "contato": None, "contato_id": None,
                       "valor": g["valor"], "categoria_id": f["categoria_id"], "categoria_nome": f["categoria_nome"],
                       "conta_id": f["conta_id"], "conta_nome": f["conta_nome"],
                       "quitado": prazo == 0, "vencimento": venc})
    # equipe: o que saiu da gaveta já está pago (conta do dinheiro); PIX / outro dia fica em aberto até marcar como pago
    conta_din = (gaveta["conta_id"], gaveta["conta_nome"]) if gaveta else (None, None)
    equipe = cur.execute("""select canal, nome, valor, forma, pago_em from fin_app.caixa_equipe where data = %s order by canal, linha""",
                         (data,)).fetchall()
    for canal, cfg in EQUIPE.items():
        cat_id, cat_nome = _cat_por_nome(cur, cfg["categoria"], "pagar")
        rows = [e for e in equipe if e["canal"] == canal and e["valor"]]
        def linha(chave, desc, contato, valor, quitado, pago_em, detalhe):
            pago_data = pago_em.date() if pago_em else data
            return {"chave": chave, "tipo": "pagar", "descricao": desc, "detalhe": detalhe, "contato": contato,
                    "contato_id": _pessoa(cur, contato), "valor": valor, "categoria_id": cat_id, "categoria_nome": cat_nome,
                    "conta_id": conta_din[0] if quitado and not pago_em else None,
                    "conta_nome": conta_din[1] if quitado and not pago_em else None,
                    "quitado": quitado, "vencimento": pago_data if quitado else data}
        if cfg["agrupa"]:
            na_gaveta = [e for e in rows if e["forma"] == "dinheiro"]
            fora = [e for e in rows if e["forma"] != "dinheiro"]
            if na_gaveta:
                linhas.append(linha(f"equipe:{canal}", f"{cfg['descricao']} {_dm(data)}", cfg["contato"],
                                    sum(e["valor"] for e in na_gaveta), True, None, ", ".join(e["nome"] for e in na_gaveta)))
            for e in fora:   # PIX a fazer / pagar outro dia: um por pessoa, em aberto até o admin marcar como pago
                linhas.append(linha(f"equipe:{canal}:{e['nome']}", f"{cfg['descricao']} {_dm(data)} · {e['nome']}", e["nome"],
                                    e["valor"], bool(e["pago_em"]), e["pago_em"],
                                    "PIX a fazer" if e["forma"] == "pix" else "pagar outro dia"))
        else:
            for e in rows:
                quit = e["forma"] == "dinheiro" or bool(e["pago_em"])
                linhas.append(linha(f"equipe:{canal}:{e['nome']}", f"{cfg['descricao']} {_dm(data)} · {e['nome']}", e["nome"],
                                    e["valor"], quit, e["pago_em"] if e["forma"] != "dinheiro" else None,
                                    {"dinheiro": "pago da gaveta", "pix": "PIX a fazer", "pendente": "pagar outro dia"}[e["forma"]]))
    for k in cur.execute("select canal, diversos, observacao from fin_app.caixa_canal where data = %s and diversos > 0 order by canal",
                         (data,)).fetchall():
        linhas.append({"chave": f"diversos:{k['canal']}", "tipo": "pagar", "descricao": f"Diversos do caixa ({k['canal'].lower()}) {_dm(data)}",
                       "detalhe": k["observacao"] or "saídas do caixa", "contato": None, "contato_id": None, "valor": k["diversos"],
                       "categoria_id": None, "categoria_nome": None, "conta_id": conta_din[0], "conta_nome": conta_din[1],
                       "quitado": True, "vencimento": data})
    for i, l in enumerate(linhas):
        l["ordem"] = i
    return linhas


def _nibo(cur, l) -> dict | None:
    """O lançamento do Nibo que corresponde a esta linha (mesmo tipo e categoria, até 3 dias de distância, valor mais próximo)."""
    if not l.get("categoria_id"):
        return None
    ref = l["vencimento"]
    r = cur.execute("""select descricao, valor, coalesce(data_pagamento, vencimento) as data, status, contato
                       from fin_app.v_titulos
                       where origem = 'nibo' and tipo = %(t)s and categoria_id = %(c)s
                         and abs(coalesce(data_pagamento, vencimento) - %(d)s::date) <= 3
                         and (%(p)s::text is null or contato ilike %(p)s or descricao ilike %(p)s)
                       order by abs(valor - %(v)s), abs(coalesce(data_pagamento, vencimento) - %(d)s::date) limit 1""",
                    {"t": l["tipo"], "c": l["categoria_id"], "d": ref, "v": l["valor"],
                     "p": f"%{l['contato'].split()[0]}%" if l.get("contato") and l["chave"].startswith("equipe:Salão") else None}).fetchone()
    if not r:
        return None
    return {**r, "igual": abs(Decimal(r["valor"]) - Decimal(l["valor"])) < Decimal("0.01")}


def _js(l):
    return {k: _conv(v) for k, v in l.items()}


@router.get("/{data}")
def ver(data: dt.date):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        dia = cur.execute("select status, conferido_em from fin_app.caixa_dia where data = %s", (data,)).fetchone()
        teste = cur.execute("select caixa_fluxo_teste from fin_app.empresa where id = 1").fetchone()
        teste = teste["caixa_fluxo_teste"] if teste else True
        salvas = cur.execute("""select f.*, l.status as lanc_status, l.cancelado_em from fin_app.caixa_fluxo f
                                left join fin_app.lancamentos l on l.id = f.lancamento_id
                                where f.data = %s order by f.ordem""", (data,)).fetchall()
        linhas = salvas or (proposta(cur, data) if dia and dia["status"] == "fechado" else [])
        for l in linhas:
            l["nibo"] = _nibo(cur, l)
        opcoes = {"contas": cur.execute("select id, conta from fin_app.v_contas where ativo order by ordem, conta").fetchall(),
                  "categorias": cur.execute("""select id, categoria, tipo, grupo from fin_app.v_categorias where ativo
                                               order by tipo, grupo, categoria""").fetchall()}
    return {"data": data.isoformat(), "fechado": bool(dia and dia["status"] == "fechado"),
            "conferido": bool(dia and dia["conferido_em"]), "teste": teste, "confirmado": bool(salvas),
            "lancado": any(l.get("lancamento_id") for l in salvas),
            "confirmado_em": _conv(salvas[0]["confirmado_em"]) if salvas else None,
            "confirmado_por": salvas[0]["confirmado_por"] if salvas else None,
            "linhas": [_js(l) for l in linhas],
            "opcoes": {k: [_js(x) for x in v] for k, v in opcoes.items()}}


class Linha(BaseModel):
    chave: str = Field(min_length=1, max_length=200)
    tipo: Literal["pagar", "receber"]
    descricao: str = Field(min_length=1, max_length=300)
    contato: str | None = Field(None, max_length=120)
    valor: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    categoria_id: uuid.UUID | None = None
    conta_id: uuid.UUID | None = None
    quitado: bool
    vencimento: dt.date


class Confirmacao(BaseModel):
    linhas: list[Linha] = Field(min_length=1, max_length=100)


@router.post("/{data}")
def confirmar(data: dt.date, b: Confirmacao, req: Request):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        dia = cur.execute("select status from fin_app.caixa_dia where data = %s for update", (data,)).fetchone()
        if not dia or dia["status"] != "fechado":
            raise HTTPException(409, "Feche o caixa do dia antes de lançar no fluxo")
        if cur.execute("select 1 from fin_app.caixa_fluxo where data = %s and lancamento_id is not null", (data,)).fetchone():
            raise HTTPException(409, "Este dia já foi lançado no fluxo. Desfaça o lançamento antes de lançar de novo.")
        teste = cur.execute("select caixa_fluxo_teste from fin_app.empresa where id = 1").fetchone()
        teste = teste["caixa_fluxo_teste"] if teste else True
        if len({l.chave for l in b.linhas}) != len(b.linhas):
            raise HTTPException(422, "Linhas repetidas")
        cur.execute("delete from fin_app.caixa_fluxo where data = %s", (data,))
        quem = req.state.usuario["nome"] if getattr(req.state, "usuario", None) else None
        for i, l in enumerate(b.linhas):
            cat_nome = conta_nome = None
            if l.categoria_id:
                r = cur.execute("select categoria, tipo from fin_app.v_categorias where id = %s", (l.categoria_id,)).fetchone()
                if not r or r["tipo"] != l.tipo:
                    raise HTTPException(422, f"“{l.descricao}”: categoria não é de conta a {l.tipo}")
                cat_nome = r["categoria"]
            elif not teste:
                raise HTTPException(422, f"“{l.descricao}”: escolha a categoria")
            if l.conta_id:
                r = cur.execute("select conta from fin_app.v_contas where id = %s", (l.conta_id,)).fetchone()
                if not r:
                    raise HTTPException(422, f"“{l.descricao}”: conta não encontrada")
                conta_nome = r["conta"]
            elif l.quitado and not teste:
                raise HTTPException(422, f"“{l.descricao}”: escolha a conta em que {'entrou' if l.tipo == 'receber' else 'saiu'} o dinheiro")
            contato_id = _pessoa(cur, l.contato)
            lid = None
            if not teste:
                linha = {"tipo": l.tipo, "vencimento": l.vencimento, "competencia": data, "previsto_para": None,
                         "contato": l.contato, "contato_id": contato_id, "categoria_id": l.categoria_id, "categoria_nome": cat_nome,
                         "conta_id": l.conta_id, "conta_nome": conta_nome, "descricao": l.descricao, "valor": l.valor,
                         "status": "pago" if l.quitado else "aberto", "valor_pago": l.valor if l.quitado else None,
                         "data_pagamento": l.vencimento if l.quitado else None,
                         "grupo_id": None, "parcela": None, "total_parcelas": None, "recorrencia": None}
                lid = cur.execute(f"insert into fin_app.lancamentos ({', '.join(COLS)}) "
                                  f"values ({', '.join('%(' + c + ')s' for c in COLS)}) returning id", linha).fetchone()["id"]
            cur.execute("""insert into fin_app.caixa_fluxo (data, ordem, chave, tipo, descricao, contato, contato_id, valor,
                               categoria_id, categoria_nome, conta_id, conta_nome, quitado, vencimento, lancamento_id, confirmado_por)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (data, i, l.chave, l.tipo, l.descricao, l.contato, contato_id, l.valor, l.categoria_id, cat_nome,
                         l.conta_id, conta_nome, l.quitado, l.vencimento, lid, quem))
    return ver(data)


@router.delete("/{data}")
def desfazer(data: dt.date):
    """Volta para a proposta: cancela os lançamentos gerados (ficam no histórico como cancelados)."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        ids = [r["lancamento_id"] for r in cur.execute(
            "select lancamento_id from fin_app.caixa_fluxo where data = %s and lancamento_id is not null", (data,)).fetchall()]
        if ids:
            cur.execute("update fin_app.lancamentos set cancelado_em = now() where id = any(%s) and cancelado_em is null", (ids,))
        cur.execute("delete from fin_app.caixa_fluxo where data = %s", (data,))
    return ver(data)


class Modo(BaseModel):
    teste: bool


@router.put("/modo/teste")
def modo(m: Modo):
    with psycopg.connect(**DSN) as conn:
        conn.execute("update fin_app.empresa set caixa_fluxo_teste = %s where id = 1", (m.teste,))
    return {"teste": m.teste}
