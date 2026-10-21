"""Fechamento de caixa no app (em paralelo com a planilha "Fechamento de Caixa").

Grava em fin_app.caixa_* (usuário fin_app_rw) e compara com o que o ETL trouxe da planilha.
As fórmulas da conferência ("deve ter") são as da planilha, validadas contra 194 dias de histórico.
"""
import calendar
import datetime as dt
from decimal import Decimal
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from fin import DSN, _conv, q

router = APIRouter(prefix="/api/fin/caixa")

CANAIS = ("Salão", "Delivery")
GAVETA = {"Salão": "CAIXA SALÃO DEVE TER", "Delivery": "CAIXA DELIVERY DEVE TER"}
Dinheiro = Decimal


# ------------------------------------------------------------------ configuração (cadastro de formas)
def config(cur, data=None):
    """Formas de pagamento ativas (+ as usadas no dia, mesmo se arquivadas) e itens da conferência.
    Cada forma é conferida na 'gaveta' do canal ou num grupo (ex.: Máquina cartão = débito + crédito + pix)."""
    formas = cur.execute("""select nome, conferencia, canais, conferir_no_caixa from fin_app.formas_pagamento f
                            where ativo or exists (select 1 from fin_app.caixa_formas c
                                                   where c.forma = f.nome and c.data = %s and c.valor > 0)
                            order by ordem, nome""", (data,)).fetchall()
    grupos = []
    for f in formas:
        if f["conferencia"] != "gaveta" and f["conferir_no_caixa"] and f["conferencia"] not in grupos:
            grupos.append(f["conferencia"])
    dica_gaveta = "troco + " + " + ".join(f["nome"].lower() for f in formas if f["conferencia"] == "gaveta") \
        + " − equipe paga em dinheiro − diversos"
    # gaveta: quem fecha o canal confere; os grupos (cartão, apps) somam os dois canais: o admin confere
    itens = [{"item": GAVETA[c], "rotulo": f"Gaveta do {c.lower()}", "dica": dica_gaveta, "quem": "caixa", "canal": c} for c in CANAIS]
    itens += [{"item": f"{g.upper()} DEVE TER", "rotulo": g, "quem": "admin",
               "dica": " + ".join(f["nome"].lower() for f in formas if f["conferencia"] == g)} for g in grupos]
    return {"formas": [dict(f) for f in formas], "itens": itens}


# ------------------------------------------------------------------ regras da planilha
def _f(x):
    return float(x or 0)


def calcula(canais: dict, cfg: dict) -> dict:
    """Totais por canal e 'deve ter' da conferência, como na planilha (validado em 194 dias)."""
    tot = {}
    for c in CANAIS:
        k = canais.get(c) or {}
        formas = k.get("formas") or {}
        equipe = round(sum(_f(e["valor"]) for e in k.get("equipe") or []), 2)
        # só o que foi pago em dinheiro sai da gaveta (PIX e "pagar outro dia" não; a planilha não tem forma = dinheiro)
        em_dinheiro = round(sum(_f(e["valor"]) for e in k.get("equipe") or [] if (e.get("forma") or "dinheiro") == "dinheiro"), 2)
        tot[c] = {"total": round(sum(_f(v) for v in formas.values()), 2), "equipe": equipe, "equipe_dinheiro": em_dinheiro}
    def valor(c, nome):
        return _f(((canais.get(c) or {}).get("formas") or {}).get(nome))
    deve = {}
    for c in CANAIS:
        k = canais.get(c) or {}
        dinheiro = sum(valor(c, f["nome"]) for f in cfg["formas"] if f["conferencia"] == "gaveta")
        deve[GAVETA[c]] = round(_f(k.get("troco_inicial")) + dinheiro - tot[c]["equipe_dinheiro"] - _f(k.get("diversos")), 2)
    for it in cfg["itens"][len(CANAIS):]:
        deve[it["item"]] = round(sum(valor(c, f["nome"]) for c in CANAIS for f in cfg["formas"]
                                     if f["conferencia"] == it["rotulo"]), 2)
    return {"canais": tot, "total_dia": round(sum(t["total"] for t in tot.values()), 2), "deve_ter": deve}


# ------------------------------------------------------------------ leitura
def _app(cur, data):
    dia = cur.execute("select * from fin_app.caixa_dia where data = %s", (data,)).fetchone()
    if not dia:
        return None
    canais = {}
    for k in cur.execute("select * from fin_app.caixa_canal where data = %s", (data,)).fetchall():
        canais[k["canal"]] = {kk: _conv(k[kk]) for kk in ("responsavel", "troco_inicial", "fechamento_dinheiro",
                                                          "diversos", "observacao", "status", "fechado_em", "fechado_por")}
        canais[k["canal"]]["formas"] = {}
        canais[k["canal"]]["equipe"] = []
    for r in cur.execute("select canal, forma, valor from fin_app.caixa_formas where data = %s", (data,)).fetchall():
        canais[r["canal"]]["formas"][r["forma"]] = _conv(r["valor"])
    for r in cur.execute("""select canal, linha, nome, valor, forma, pago_em, pago_por_nome from fin_app.caixa_equipe
                            where data = %s order by linha""", (data,)).fetchall():
        canais[r["canal"]]["equipe"].append({"linha": r["linha"], "nome": r["nome"], "valor": _conv(r["valor"]), "forma": r["forma"],
                                             "pago_em": _conv(r["pago_em"]), "pago_por_nome": r["pago_por_nome"]})
    conf = {r["item"]: _conv(r["valor_real"]) for r in
            cur.execute("select item, valor_real from fin_app.caixa_conferencia where data = %s", (data,)).fetchall()}
    return {"status": dia["status"], "motivo": dia["motivo"], "fechado_em": _conv(dia["fechado_em"]),
            "conferido_em": _conv(dia["conferido_em"]), "conferido_nome": dia["conferido_nome"],
            "atualizado_em": _conv(dia["atualizado_em"]), "canais": canais, "conferencia": conf}


def _planilha(cur, data):
    dias = cur.execute("select * from fin_app.v_planilha_caixa where data = %s", (data,)).fetchall()
    if not dias:
        return None
    # a planilha chama algumas formas por outro nome (ex.: "Crédito" = "Crédito Pag Seguro"): traz com o nome do app
    do_app = {r["nome_planilha"]: r["nome"] for r in
              cur.execute("select nome, nome_planilha from fin_app.formas_pagamento where nome_planilha is not null").fetchall()}
    canais = {d["canal"]: {"responsavel": d["responsavel"], "troco_inicial": _conv(d["troco_inicial"]),
                           "fechamento_dinheiro": _conv(d["fechamento_dinheiro"]), "diversos": _conv(d["diversos"]),
                           "pagamento_equipe": _conv(d["pagamento_equipe"]), "observacao": d["observacao"],
                           "total": _conv(d["soma_formas"]), "formas": {}, "equipe": []} for d in dias}
    for r in cur.execute("select canal, forma, valor from fin_app.v_planilha_formas where data = %s", (data,)).fetchall():
        f = do_app.get(r["forma"], r["forma"])
        canais[r["canal"]]["formas"][f] = round(canais[r["canal"]]["formas"].get(f, 0) + _conv(r["valor"]), 2)
    for r in cur.execute("select canal, nome, valor from fin_app.v_planilha_equipe where data = %s order by linha",
                         (data,)).fetchall():
        canais[r["canal"]]["equipe"].append({"nome": r["nome"], "valor": _conv(r["valor"])})
    conf = {r["item"]: {"deve_ter": _conv(r["deve_ter"]), "valor_real": _conv(r["valor_real"]),
                        "diferenca": _conv(r["diferenca"])}
            for r in cur.execute("select * from fin_app.v_planilha_conferencia where data = %s", (data,)).fetchall()}
    return {"canais": canais, "conferencia": conf, "nomes": {v: k for k, v in do_app.items()}}


def _sugestao_troco(cur, data):
    """Troco inicial do dia = o do último fechamento anterior (app, senão planilha)."""
    out = {}
    for c in CANAIS:
        r = cur.execute("""select troco_inicial from (
                               select data, troco_inicial, 1 as pri from fin_app.caixa_canal where canal = %(c)s and data < %(d)s
                               union all
                               select data, troco_inicial, 2 from fin_app.v_planilha_caixa where canal = %(c)s and data < %(d)s
                           ) x order by data desc, pri limit 1""", {"c": c, "d": data}).fetchone()
        out[c] = _conv(r["troco_inicial"]) if r else 300.0
    return out


@router.get("/dia/{data}")
def dia(data: dt.date):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        app, plan = _app(cur, data), _planilha(cur, data)
        nao_abriu = cur.execute("select motivo from fin_app.v_dias_fechados where data = %s", (data,)).fetchone()
        troco = _sugestao_troco(cur, data)
        cfg = config(cur, data)
        pessoas = cur.execute("""select nome, papeis, diaria_padrao from fin_app.pessoas
                                 where ativo and mesclada_em is null and papeis && array['motoboy','free_lance','responsavel_caixa','funcionario']
                                 order by lower(nome)""").fetchall()
    def nomes(*papeis):
        return list(dict.fromkeys(p["nome"] for p in pessoas if set(p["papeis"]) & set(papeis)))
    return {"data": data.isoformat(), "app": app, "planilha": plan,
            "calc_app": calcula(app["canais"], cfg) if app else None,
            "calc_planilha": calcula(plan["canais"], cfg) if plan else None,
            "planilha_nao_abriu": nao_abriu["motivo"] if nao_abriu else None,
            "troco_sugerido": troco,
            "equipe": {"Salão": nomes("free_lance", "funcionario"), "Delivery": nomes("motoboy")},
            "diarias": {p["nome"]: _conv(p["diaria_padrao"]) for p in pessoas if p["diaria_padrao"]},
            "responsaveis": nomes("responsavel_caixa"),
            # "Equipe" = quem aparece em Cadastros → Equipe (responsáveis de caixa, free lances e motoboys).
            "equipe_geral": [n for n in nomes("free_lance", "motoboy") if n not in nomes("responsavel_caixa")],
            "formas": cfg["formas"], "itens": cfg["itens"]}


@router.get("/mes")
def mes(mes: str = Query(..., pattern=r"^\d{4}-\d{2}$")):
    a, m = map(int, mes.split("-"))
    ini, fim = dt.date(a, m, 1), dt.date(a, m, calendar.monthrange(a, m)[1])
    p = {"ini": ini, "fim": fim}
    app = {r["data"]: r for r in q("""
        select d.data, d.status, coalesce(sum(f.valor), 0) as total
        from fin_app.caixa_dia d left join fin_app.caixa_formas f using (data)
        where d.data between %(ini)s and %(fim)s group by d.data, d.status""", p)}
    plan = {r["data"]: r["total"] for r in q("""
        select data, sum(soma_formas) as total from fin_app.v_planilha_caixa
        where data between %(ini)s and %(fim)s group by data""", p)}
    fech = {r["data"]: r["motivo"] for r in q(
        "select data, motivo from fin_app.v_dias_fechados where data between %(ini)s and %(fim)s", p)}
    dias = []
    d = ini
    while d <= fim:
        k = d.isoformat()
        a_ = app.get(k)
        pt = plan.get(k)
        dias.append({"data": k, "status": a_["status"] if a_ else None, "total_app": a_["total"] if a_ else None,
                     "total_planilha": pt, "planilha_nao_abriu": fech.get(k),
                     "diverge": bool(a_ and a_["status"] != "nao_abriu" and pt is not None
                                     and abs(a_["total"] - pt) > 0.009)})
        d += dt.timedelta(days=1)
    return {"mes": mes, "dias": dias}


# ------------------------------------------------------------------ escrita
class Equipe(BaseModel):
    nome: str = Field(min_length=1, max_length=80)
    valor: Dinheiro = Field(ge=0, max_digits=14, decimal_places=2)
    # dinheiro = saiu da gaveta; pix = PIX a fazer; pendente = pagar outro dia (falta de troco, vem buscar depois)
    forma: Literal["dinheiro", "pix", "pendente"] = "dinheiro"


class Canal(BaseModel):
    responsavel: str | None = Field(None, max_length=80)
    troco_inicial: Dinheiro = Field(0, ge=0, max_digits=14, decimal_places=2)
    fechamento_dinheiro: Dinheiro | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    diversos: Dinheiro = Field(0, ge=0, max_digits=14, decimal_places=2)
    observacao: str | None = Field(None, max_length=1000)
    formas: dict[str, Dinheiro] = {}
    equipe: list[Equipe] = Field(default_factory=list, max_length=40)


class Fechamento(BaseModel):
    status: Literal["rascunho", "fechado", "nao_abriu"]
    motivo: str | None = Field(None, max_length=200)
    canais: dict[Literal[CANAIS], Canal] = {}
    conferencia: dict[str, Dinheiro | None] = {}


class FechamentoCanal(BaseModel):
    status: Literal["rascunho", "fechado"]
    canal: Canal
    gaveta_real: Dinheiro | None = None        # valor real contado na gaveta (conferência do canal)


def _status_do_dia(cur, data):
    """O dia fica fechado quando os dois canais estão fechados."""
    n = cur.execute("select count(*) filter (where status = 'fechado') as f from fin_app.caixa_canal where data = %s",
                    (data,)).fetchone()["f"]
    fechado = n == len(CANAIS)
    cur.execute("""update fin_app.caixa_dia set status = %s, fechado_em = case when %s then coalesce(fechado_em, now()) end,
                     conferido_em = case when %s then conferido_em end, conferido_por = case when %s then conferido_por end,
                     conferido_nome = case when %s then conferido_nome end, atualizado_em = now()
                   where data = %s""", ("fechado" if fechado else "rascunho", fechado, fechado, fechado, fechado, data))


@router.put("/dia/{data}/canal/{nome}")
def salvar_canal(data: dt.date, nome: Literal[CANAIS], f: FechamentoCanal, req: Request):
    """Salva ou fecha um canal sem mexer no outro (salão e delivery fecham em computadores e horários diferentes)."""
    c = f.canal
    if data > dt.date.today():
        raise HTTPException(422, "Não dá para fechar um dia que ainda não chegou")
    if any(v < 0 for v in c.formas.values()):
        raise HTTPException(422, "Valores negativos não são aceitos")
    if f.status == "fechado":
        if not (c.responsavel or "").strip():
            raise HTTPException(422, f"Para fechar, escolha o responsável do {nome.lower()}")
        cadastro = {r["nome"] for r in q("""select nome from fin_app.pessoas where ativo and mesclada_em is null
                       and papeis && array['responsavel_caixa','free_lance','motoboy','funcionario','socio']""")}
        resp = {r["nome"] for r in q("""select nome from fin_app.pessoas where ativo and mesclada_em is null
                       and papeis && array['responsavel_caixa','free_lance','motoboy']""")}
        if c.responsavel.strip() not in resp:
            raise HTTPException(422, f"Responsável fora do cadastro da equipe: {c.responsavel}. Cadastre em Cadastros → Equipe.")
        sem = sorted({e.nome.strip() for e in c.equipe if e.nome.strip() not in cadastro})
        if sem:
            raise HTTPException(422, f"Fora do cadastro da equipe: {', '.join(sem)}. Escolha a pessoa da lista ou cadastre em Cadastros → Equipe.")
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        cfg = config(cur, data)
        invalidas = set(c.formas) - {fo["nome"] for fo in cfg["formas"]}
        if invalidas:
            raise HTTPException(422, f"Forma de pagamento fora do cadastro: {', '.join(sorted(invalidas))}")
        gaveta = [fo["nome"] for fo in cfg["formas"] if fo["conferencia"] == "gaveta"]
        if gaveta and c.fechamento_dinheiro is not None:   # dinheiro de venda = fechamento − troco
            c.formas[gaveta[0]] = max(c.fechamento_dinheiro - c.troco_inicial, Decimal(0))
        cur.execute("""insert into fin_app.caixa_dia (data, status) values (%s, 'rascunho')
                       on conflict (data) do nothing""", (data,))
        dia_ = cur.execute("select status from fin_app.caixa_dia where data = %s for update", (data,)).fetchone()
        if dia_["status"] == "nao_abriu":
            raise HTTPException(409, "Este dia está marcado como “não abriu”. Reabra para lançar.")
        atual = cur.execute("select status from fin_app.caixa_canal where data = %s and canal = %s", (data, nome)).fetchone()
        if atual and atual["status"] == "fechado":
            raise HTTPException(409, f"O caixa do {nome.lower()} já está fechado. Peça para o administrador reabrir.")
        pagos = {(r["nome"], r["valor"], r["forma"]): (r["pago_em"], r["pago_por_nome"]) for r in cur.execute(
            """select nome, valor, forma, pago_em, pago_por_nome from fin_app.caixa_equipe
               where data = %s and canal = %s and pago_em is not null""", (data, nome)).fetchall()}
        cur.execute("delete from fin_app.caixa_canal where data = %s and canal = %s", (data, nome))   # formas e equipe caem junto
        quem = req.state.usuario["nome"] if getattr(req.state, "usuario", None) else None
        cur.execute("""insert into fin_app.caixa_canal (data, canal, responsavel, troco_inicial, fechamento_dinheiro, diversos,
                           observacao, status, fechado_em, fechado_por)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, case when %s = 'fechado' then now() end, %s)""",
                    (data, nome, c.responsavel, c.troco_inicial, c.fechamento_dinheiro, c.diversos, c.observacao,
                     f.status, f.status, quem if f.status == "fechado" else None))
        cur.executemany("insert into fin_app.caixa_formas values (%s, %s, %s, %s)",
                        [(data, nome, fo, v) for fo, v in c.formas.items() if v])
        cur.executemany("""insert into fin_app.caixa_equipe (data, canal, linha, nome, valor, forma, pago_em, pago_por_nome)
                           values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                        [(data, nome, i + 1, e.nome.strip(), e.valor, e.forma,
                          *(pagos.get((e.nome.strip(), e.valor, e.forma), (None, None)) if e.forma != "dinheiro" else (None, None)))
                         for i, e in enumerate(c.equipe)])
        cur.execute("delete from fin_app.caixa_conferencia where data = %s and item = %s", (data, GAVETA[nome]))
        if f.gaveta_real is not None:
            cur.execute("insert into fin_app.caixa_conferencia values (%s, %s, %s)", (data, GAVETA[nome], f.gaveta_real))
        _status_do_dia(cur, data)
        cur.execute("insert into fin_app.caixa_historico (data, acao, dados) values (%s, %s, %s)",
                    (data, f"{f.status}:{nome}", Jsonb(f.model_dump(mode="json"))))
    return dia(data)


@router.post("/dia/{data}/canal/{nome}/reabrir")
def reabrir_canal(data: dt.date, nome: Literal[CANAIS]):
    """Só o admin (caminho termina em /reabrir). Reabre um canal; o dia volta a rascunho e perde a conferência."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        r = cur.execute("""update fin_app.caixa_canal set status = 'rascunho', fechado_em = null, fechado_por = null
                           where data = %s and canal = %s and status = 'fechado' returning data""", (data, nome)).fetchone()
        if not r:
            raise HTTPException(404, f"O caixa do {nome.lower()} não está fechado")
        _status_do_dia(cur, data)
        cur.execute("insert into fin_app.caixa_historico (data, acao, dados) values (%s, %s, '{}')", (data, f"reabrir:{nome}"))
    return dia(data)


@router.put("/dia/{data}")
def salvar(data: dt.date, f: Fechamento):
    """Dia inteiro: só para marcar "não abriu" (salvar e fechar são por canal, em salvar_canal)."""
    if f.status != "nao_abriu":
        raise HTTPException(422, "Salve e feche cada canal separadamente (salão e delivery)")
    if data > dt.date.today():
        raise HTTPException(422, "Não dá para fechar um dia que ainda não chegou")
    if f.status == "nao_abriu" and not (f.motivo or "").strip():
        raise HTTPException(422, "Informe o motivo de não ter aberto")
    if f.status == "fechado":
        faltando = [c for c in CANAIS if c not in f.canais or not (f.canais[c].responsavel or "").strip()]
        if faltando:
            raise HTTPException(422, f"Para fechar, preencha o responsável de: {', '.join(faltando)}")
        equipe = {r["nome"] for r in q("""select nome from fin_app.pessoas where ativo
                     and papeis && array['responsavel_caixa','free_lance','motoboy']""")}
        fora = [f"{c} ({f.canais[c].responsavel})" for c in CANAIS if f.canais[c].responsavel.strip() not in equipe]
        if fora:
            raise HTTPException(422, f"Responsável fora do cadastro da equipe: {', '.join(fora)}. Cadastre em Cadastros → Equipe.")
        # free lances e motoboys também vêm do cadastro (nome digitado à mão criava pessoas duplicadas)
        cadastro = {r["nome"] for r in q("""select nome from fin_app.pessoas where ativo and mesclada_em is null
                       and papeis && array['responsavel_caixa','free_lance','motoboy','funcionario','socio']""")}
        sem = sorted({e.nome.strip() for c in f.canais.values() for e in c.equipe if e.nome.strip() not in cadastro})
        if sem:
            raise HTTPException(422, f"Fora do cadastro da equipe: {', '.join(sem)}. Escolha a pessoa da lista ou cadastre em Cadastros → Equipe.")
        if any(v < 0 for c in f.canais.values() for v in c.formas.values()):
            raise HTTPException(422, "Valores negativos não são aceitos")
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        cfg = config(cur, data)
        validas = {f["nome"] for f in cfg["formas"]}
        itens = {i["item"] for i in cfg["itens"]}
        invalidas = {fo for c in f.canais.values() for fo in c.formas} - validas
        if invalidas or set(f.conferencia) - itens:
            raise HTTPException(422, f"Forma de pagamento ou item fora do cadastro: {', '.join(sorted(invalidas or set(f.conferencia) - itens))}")
        # Dinheiro (vendas) = dinheiro contado na gaveta − troco inicial, como na planilha: o troco não é faturamento
        gaveta = [fo["nome"] for fo in cfg["formas"] if fo["conferencia"] == "gaveta"]
        for c in f.canais.values():
            if gaveta and c.fechamento_dinheiro is not None:
                c.formas[gaveta[0]] = max(c.fechamento_dinheiro - c.troco_inicial, Decimal(0))
        atual = cur.execute("select status from fin_app.caixa_dia where data = %s for update", (data,)).fetchone()
        if atual and atual["status"] == "fechado":
            raise HTTPException(409, "Este dia já está fechado. Reabra para alterar.")
        cur.execute("""insert into fin_app.caixa_dia (data, status, motivo, fechado_em)
                       values (%(d)s, %(s)s, %(m)s, case when %(s)s = 'fechado' then now() end)
                       on conflict (data) do update set status = excluded.status, motivo = excluded.motivo,
                         fechado_em = excluded.fechado_em, atualizado_em = now()""",
                    {"d": data, "s": f.status, "m": f.motivo if f.status == "nao_abriu" else None})
        # Pagamentos de PIX/pendentes já marcados como pagos sobrevivem a um reabrir + salvar de novo
        pagos = {(r["canal"], r["nome"], r["valor"], r["forma"]): (r["pago_em"], r["pago_por_nome"]) for r in cur.execute(
            "select canal, nome, valor, forma, pago_em, pago_por_nome from fin_app.caixa_equipe where data = %s and pago_em is not null",
            (data,)).fetchall()}
        # Regrava os detalhes do dia (formas e equipe caem junto, por cascata).
        cur.execute("delete from fin_app.caixa_conferencia where data = %s", (data,))
        cur.execute("delete from fin_app.caixa_canal where data = %s", (data,))
        if f.status != "nao_abriu":
            for nome, c in f.canais.items():
                cur.execute("""insert into fin_app.caixa_canal (data, canal, responsavel, troco_inicial,
                                   fechamento_dinheiro, diversos, observacao)
                               values (%s, %s, %s, %s, %s, %s, %s)""",
                            (data, nome, c.responsavel, c.troco_inicial, c.fechamento_dinheiro, c.diversos, c.observacao))
                cur.executemany("insert into fin_app.caixa_formas values (%s, %s, %s, %s)",
                                [(data, nome, fo, v) for fo, v in c.formas.items() if v])
                cur.executemany("""insert into fin_app.caixa_equipe (data, canal, linha, nome, valor, forma, pago_em, pago_por_nome)
                                   values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                                [(data, nome, i + 1, e.nome.strip(), e.valor, e.forma,
                                  *(pagos.get((nome, e.nome.strip(), e.valor, e.forma), (None, None)) if e.forma != "dinheiro" else (None, None)))
                                 for i, e in enumerate(c.equipe)])
            cur.executemany("insert into fin_app.caixa_conferencia values (%s, %s, %s)",
                            [(data, it, v) for it, v in f.conferencia.items()])
        cur.execute("insert into fin_app.caixa_historico (data, acao, dados) values (%s, %s, %s)",
                    (data, f.status, Jsonb(f.model_dump(mode="json"))))
    return dia(data)


class Pago(BaseModel):
    pago: bool = True


@router.post("/dia/{data}/equipe/{canal}/{linha}/pago")
def equipe_pago(data: dt.date, canal: Literal[CANAIS], linha: int, b: Pago, req: Request):
    """O admin marca que fez o PIX / pagou depois o motoboy ou free lance (sai da Lista de tarefas)."""
    u = req.state.usuario
    r = q("""update fin_app.caixa_equipe set pago_em = case when %s then now() end, pago_por_nome = case when %s then %s end
             where data = %s and canal = %s and linha = %s and forma <> 'dinheiro' returning linha""",
          (b.pago, b.pago, u["nome"], data, canal, linha))
    if not r:
        raise HTTPException(404, "Pagamento não encontrado (ou foi pago em dinheiro)")
    return dia(data)


class Conferir(BaseModel):
    conferencia: dict[str, Dinheiro | None] = {}   # valor real: gavetas, cartão, pix direto e apps (relatórios)


@router.post("/dia/{data}/conferir")
def conferir(data: dt.date, req: Request, b: Conferir | None = None):
    """O admin confere o dia: digita o valor real de cartão / pix direto / apps e marca como conferido."""
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        r = cur.execute("""update fin_app.caixa_dia set conferido_em = now(), conferido_por = %s, conferido_nome = %s
                           where data = %s and status = 'fechado' returning data""", (u["id"], u["nome"], data)).fetchone()
        if not r:
            raise HTTPException(409, "Só dá para conferir depois que salão e delivery estiverem fechados")
        admin = {i["item"] for i in config(cur, data)["itens"]}   # apps + gaveta (o admin pode lançar/corrigir o valor real)
        valores = {k: v for k, v in (b.conferencia if b else {}).items() if k in admin}
        if valores:
            cur.execute("delete from fin_app.caixa_conferencia where data = %s and item = any(%s)", (data, list(valores)))
            cur.executemany("insert into fin_app.caixa_conferencia values (%s, %s, %s)",
                            [(data, k, v) for k, v in valores.items() if v is not None])
        cur.execute("insert into fin_app.caixa_historico (data, acao, dados) values (%s, 'conferir', %s)",
                    (data, Jsonb({k: _conv(v) for k, v in valores.items()})))
    return dia(data)


@router.post("/dia/{data}/reabrir")
def reabrir(data: dt.date):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.execute("""update fin_app.caixa_dia set status = 'rascunho', fechado_em = null, atualizado_em = now(),
                                     conferido_em = null, conferido_por = null, conferido_nome = null
                              where data = %s and status in ('fechado', 'nao_abriu') returning data""", (data,))
        if not cur.fetchone():
            raise HTTPException(404, "Não há fechamento para reabrir neste dia")
        conn.execute("update fin_app.caixa_canal set status = 'rascunho', fechado_em = null, fechado_por = null where data = %s", (data,))
        conn.execute("insert into fin_app.caixa_historico (data, acao, dados) values (%s, 'reabrir', '{}')", (data,))
    return dia(data)
