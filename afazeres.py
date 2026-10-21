"""Afazeres de cada pessoa logada.

- Automáticos (calculados na hora, somem quando a coisa é feita), cada um com o link para onde fazer:
  admin: conferir fechamentos de caixa, conciliar notas de compra, documentos novos na Caixa de entrada;
  responsável de caixa: fechar o caixa (hoje e dias que ficaram para trás);
  quem tem habilitação de estoque: contar o estoque do setor quando há lista do dia (ou continuar a contagem).
- Manuais (fin_app.tarefas): para si mesmo; o admin também atribui a qualquer login da equipe.
Fica em /api/portal/* (qualquer login); cada um só vê e mexe no que é seu (o admin, também no que atribuiu).
"""
import calendar
import datetime as dt
import uuid
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

import checklists
import estoque
from fin import DSN, q

router = APIRouter(prefix="/api/portal/afazeres")
DIAS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]
SETOR_ROT = {"salao": "Salão", "cozinha": "Cozinha"}


def _dia(d: dt.date, hoje: dt.date) -> str:
    return "hoje" if d == hoje else "ontem" if d == hoje - dt.timedelta(days=1) else f"{DIAS[d.weekday()]} {d:%d/%m}"


def automaticos(cur, u: dict) -> list[dict]:
    hoje = estoque._hoje(cur)
    out = []
    if u["perfil"] == "admin":
        for r in cur.execute("""select d.data, d.fechado_em,
                                       (select string_agg(distinct c.responsavel, ', ') from fin_app.caixa_canal c
                                         where c.data = d.data and c.responsavel is not null) as quem
                                from fin_app.caixa_dia d where d.status = 'fechado' and d.conferido_em is null
                                order by d.data""").fetchall():
            out.append({"tipo": "caixa_conferir", "titulo": f"Conferir o fechamento de caixa de {_dia(r['data'], hoje)}",
                        "detalhe": f"Fechado{' por ' + r['quem'] if r['quem'] else ''}", "link": f"#/caixa?d={r['data']}",
                        "acao": "Conferir", "data": r["data"], "urgente": r["data"] < hoje - dt.timedelta(days=1)})
        for r in cur.execute("""select d.id, d.resumo, d.recebido_em from fin_app.documentos d
                                where d.tipo = 'nota_fiscal' and d.status <> 'arquivado'
                                  and coalesce(d.dados->'nfe'->>'finalidade', '1') = '1'   -- débito/ajuste/devolução não vão ao estoque
                                  and not exists (select 1 from fin_app.compras c where c.documento_id = d.id and c.conciliada_em is not null)
                                order by d.recebido_em limit 20""").fetchall():
            out.append({"tipo": "nota_conciliar", "titulo": "Conciliar nota de compra", "detalhe": r["resumo"],
                        "link": f"#/conciliar?doc={r['id']}", "acao": "Conciliar", "data": r["recebido_em"].date(), "urgente": False})
        # motoboy / free lance que não foi pago em dinheiro no fechamento: PIX a fazer ou pagar outro dia
        for r in cur.execute("""select e.data, e.canal, e.nome, e.valor, e.forma from fin_app.caixa_equipe e
                                join fin_app.caixa_dia d on d.data = e.data and d.status = 'fechado'
                                where e.forma <> 'dinheiro' and e.pago_em is null order by e.data, e.linha""").fetchall():
            valor = f"R$ {r['valor']:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            out.append({"tipo": "pagar_equipe", "titulo": f"{'Fazer PIX' if r['forma'] == 'pix' else 'Pagar'} {valor} para {r['nome']}",
                        "detalhe": f"{r['canal']} · caixa de {_dia(r['data'], hoje)}" + (" · ficou para outro dia" if r["forma"] == "pendente" else ""),
                        "link": f"#/caixa?d={r['data']}", "acao": "Pagar", "data": r["data"], "urgente": r["data"] < hoje - dt.timedelta(days=1)})
        n = cur.execute("""select count(*) as n from fin_app.documentos where status = 'novo' and tipo <> 'nota_fiscal'""").fetchone()["n"]
        if n:
            out.append({"tipo": "inbox", "titulo": f"{n} documento(s) novo(s) na Caixa de entrada", "detalhe": "Boletos, relatórios e outros",
                        "link": "#/inbox", "acao": "Abrir", "data": hoje, "urgente": False})
    if u["perfil"] == "responsavel_caixa":
        inicio = cur.execute("select min(data) as d from fin_app.caixa_dia").fetchone()["d"]   # começa a cobrar quando o app passou a ser usado
        dias = cur.execute("""
            with d as (select generate_series(greatest(%(ini)s::date, %(hoje)s::date - 7), %(hoje)s::date - 1, interval '1 day')::date as data)
            select d.data, a.status from d left join fin_app.caixa_dia a on a.data = d.data
            where coalesce(a.status, '') not in ('fechado', 'nao_abriu')
              and (a.status = 'rascunho' or exists (select 1 from fin_app.v_planilha_caixa p where p.data = d.data))
            order by d.data""", {"ini": inicio, "hoje": hoje}).fetchall() if inicio else []
        def faltam(data):   # salão e delivery fecham separados
            f = {k["canal"] for k in cur.execute("select canal from fin_app.caixa_canal where data = %s and status = 'fechado'",
                                                 (data,)).fetchall()}
            return [c for c in ("Salão", "Delivery") if c not in f]
        for r in dias:
            out.append({"tipo": "caixa_fechar", "titulo": f"Fechar o caixa de {_dia(r['data'], hoje)}",
                        "detalhe": f"Falta fechar: {', '.join(faltam(r['data']))}" if r["status"] == "rascunho" else "O dia ainda não foi fechado no app",
                        "link": f"#/caixa?d={r['data']}", "acao": "Fechar", "data": r["data"], "urgente": True})
        hj = cur.execute("select status from fin_app.caixa_dia where data = %s", (hoje,)).fetchone()
        if not hj or hj["status"] == "rascunho":
            out.append({"tipo": "caixa_fechar", "titulo": "Fechar o caixa de hoje",
                        "detalhe": "No fim do expediente" + (f" · falta: {', '.join(faltam(hoje))}" if hj else ""),
                        "link": f"#/caixa?d={hoje}", "acao": "Fechar", "data": hoje, "urgente": False})
    for setor in u.get("estoque_setores") or []:      # habilitação explícita (o admin conta pela tela de Estoque)
        rot = SETOR_ROT[setor]
        aberta = cur.execute("""select c.id, count(i.id) as total, count(i.quantidade) as contados from fin_app.estoque_contagens c
                                left join fin_app.estoque_contagem_itens i on i.contagem_id = c.id
                                where c.setor = %s and c.status = 'aberta' group by c.id""", (setor,)).fetchone()
        if aberta:
            out.append({"tipo": "estoque", "titulo": f"Terminar a contagem de estoque — {rot}",
                        "detalhe": f"{aberta['contados']} de {aberta['total']} itens contados",
                        "link": f"#/estoque?aba=contagem&id={aberta['id']}", "acao": "Continuar", "data": hoje, "urgente": True})
            continue
        n = len(estoque._devidos(cur, setor))
        if n:
            inv = hoje == estoque.fim_do_mes(hoje)
            out.append({"tipo": "estoque", "titulo": f"{'Inventário do mês' if inv else 'Contar o estoque'} — {rot}",
                        "detalhe": f"{n} {'item' if n == 1 else 'itens'} para contar hoje", "link": "#/estoque?aba=contagem",
                        "acao": "Contar", "data": hoje, "urgente": inv})
    out += checklists.tarefas_do_dia(cur, u)            # checklists de rotina da pessoa
    if u["perfil"] == "admin":
        out += checklists.avisos_admin(cur)             # itens não feitos / checklist não finalizado
    return out


def _manuais(cur, u) -> dict:
    campos = """t.id, t.titulo, t.descricao, t.prazo, t.criado_em, t.concluida_em, t.concluida_por_nome, t.criado_por_nome,
                t.responsavel_id, t.criado_por, t.recorrencia, r.nome as responsavel_nome"""
    base = f"from fin_app.tarefas t join fin_app.usuarios r on r.id = t.responsavel_id"
    # só as em aberto, pela data em que devem ser feitas (sem prazo no fim); as feitas ficam em /realizadas
    minhas = cur.execute(f"""select {campos} {base} where t.responsavel_id = %(u)s and t.concluida_em is null
                             order by t.prazo nulls last, t.criado_em""", {"u": u["id"]}).fetchall()
    equipe = []
    if u["perfil"] == "admin":   # tarefas das outras pessoas
        equipe = cur.execute(f"""select {campos} {base} where t.responsavel_id <> %(u)s and t.concluida_em is null
                                 order by t.prazo nulls last, r.nome, t.criado_em""", {"u": u["id"]}).fetchall()
    return {"minhas": minhas, "equipe": equipe}


@router.get("")
def afazeres(req: Request):
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        auto = automaticos(cur, u)
        man = _manuais(cur, u)
        hoje = estoque._hoje(cur)
    return {"automaticos": auto, **man, "hoje": hoje}


@router.get("/contagem")
def contagem(req: Request):
    """Número para o selo do menu: automáticos + tarefas minhas em aberto."""
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        n = len(automaticos(cur, u))
        n += cur.execute("select count(*) as n from fin_app.tarefas where responsavel_id = %s and concluida_em is null",
                         (u["id"],)).fetchone()["n"]
    return {"n": n}


@router.get("/pessoas")
def pessoas(req: Request):
    """Logins ativos para atribuir tarefa (só o admin atribui a outros)."""
    if req.state.usuario["perfil"] != "admin":
        return []
    return q("select id, nome, perfil from fin_app.usuarios where ativo order by perfil <> 'admin', lower(nome)")


class Tarefa(BaseModel):
    titulo: str = Field(min_length=1, max_length=200)
    descricao: str | None = Field(None, max_length=2000)
    prazo: dt.date | None = None
    responsavel_id: uuid.UUID | None = None
    recorrencia: Literal["diaria", "semanal", "mensal"] | None = None


def proxima_data(prazo: dt.date, rec: str, hoje: dt.date) -> dt.date:
    """Próxima ocorrência de uma tarefa recorrente, mantendo o ritmo (mesmo dia da semana / do mês),
    e nunca no passado: se estava atrasada, pula para a primeira data a partir de hoje."""
    def soma(d):
        if rec == "diaria":
            return d + dt.timedelta(days=1)
        if rec == "semanal":
            return d + dt.timedelta(days=7)
        a, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
        return dt.date(a, m, min(prazo.day, calendar.monthrange(a, m)[1]))   # dia 31 vira o último dia do mês
    d = soma(prazo)
    while d < hoje:
        d = soma(d)
    return d


@router.post("")
def criar(t: Tarefa, req: Request):
    u = req.state.usuario
    resp = t.responsavel_id or u["id"]
    if str(resp) != str(u["id"]) and u["perfil"] != "admin":
        raise HTTPException(403, "Só o administrador atribui tarefas a outras pessoas")
    if not q("select 1 from fin_app.usuarios where id = %s and ativo", (resp,)):
        raise HTTPException(422, "Pessoa não encontrada")
    prazo = t.prazo or (dt.date.today() if t.recorrencia else None)   # recorrente sempre tem data
    return q("""insert into fin_app.tarefas (titulo, descricao, prazo, responsavel_id, criado_por, criado_por_nome, recorrencia, serie_id)
                values (%s, %s, %s, %s, %s, %s, %s, %s) returning id""",
             (t.titulo.strip(), (t.descricao or "").strip() or None, prazo, resp, u["id"], u["nome"],
              t.recorrencia, uuid.uuid4() if t.recorrencia else None))[0]


def _minha(cur, tid, u):
    t = cur.execute("select * from fin_app.tarefas where id = %s", (tid,)).fetchone()
    if not t or (u["perfil"] != "admin" and str(t["responsavel_id"]) != str(u["id"]) and str(t["criado_por"]) != str(u["id"])):
        raise HTTPException(404, "Tarefa não encontrada")
    return t


@router.get("/realizadas")
def realizadas(req: Request, quem: Literal["minhas", "equipe"] = "minhas", dias: int = 90):
    """Histórico das tarefas feitas (mais recentes primeiro)."""
    u = req.state.usuario
    if quem == "equipe" and u["perfil"] != "admin":
        raise HTTPException(403, "Só o administrador vê as tarefas da equipe")
    filtro = "t.responsavel_id = %(u)s" if quem == "minhas" else "t.responsavel_id <> %(u)s"
    return q(f"""select t.id, t.titulo, t.descricao, t.prazo, t.concluida_em, t.concluida_por_nome, t.criado_por_nome,
                        t.responsavel_id, t.criado_por, t.recorrencia, r.nome as responsavel_nome
                 from fin_app.tarefas t join fin_app.usuarios r on r.id = t.responsavel_id
                 where {filtro} and t.concluida_em > now() - make_interval(days => %(d)s)
                 order by t.concluida_em desc limit 300""", {"u": u["id"], "d": max(1, min(dias, 730))})


@router.put("/{tid}")
def editar(tid: uuid.UUID, t: Tarefa, req: Request):
    """Edita a tarefa (quem criou ou o admin). Ligar a repetição numa tarefa comum cria a série."""
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        atual = _minha(cur, tid, u)
        if u["perfil"] != "admin" and str(atual["criado_por"]) != str(u["id"]):
            raise HTTPException(403, "Só quem criou a tarefa (ou o administrador) pode editar")
        resp = t.responsavel_id or atual["responsavel_id"]
        if str(resp) != str(atual["responsavel_id"]) and u["perfil"] != "admin":
            raise HTTPException(403, "Só o administrador passa a tarefa para outra pessoa")
        prazo = t.prazo or (estoque._hoje(cur) if t.recorrencia else None)
        cur.execute("""update fin_app.tarefas set titulo = %s, descricao = %s, prazo = %s, responsavel_id = %s, recorrencia = %s,
                         serie_id = case when %s::text is null then null else coalesce(serie_id, gen_random_uuid()) end
                       where id = %s""",
                    (t.titulo.strip(), (t.descricao or "").strip() or None, prazo, resp, t.recorrencia, t.recorrencia, tid))
    return {"ok": True}


@router.post("/{tid}/concluir")
def concluir(tid: uuid.UUID, req: Request, desfazer: bool = False):
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        t = _minha(cur, tid, u)
        cur.execute("update fin_app.tarefas set concluida_em = %s, concluida_por_nome = %s where id = %s",
                    (None if desfazer else dt.datetime.now(dt.timezone.utc), None if desfazer else u["nome"], tid))
        proxima = None
        if t["recorrencia"] and t["serie_id"]:
            # desfazer apaga a ocorrência seguinte que a conclusão tinha criado (se ainda não foi feita)
            cur.execute("""delete from fin_app.tarefas where serie_id = %s and id <> %s and concluida_em is null
                           and prazo > coalesce(%s, '-infinity'::date)""", (t["serie_id"], tid, t["prazo"]))
            if not desfazer:
                proxima = proxima_data(t["prazo"] or estoque._hoje(cur), t["recorrencia"], estoque._hoje(cur))
                cur.execute("""insert into fin_app.tarefas (titulo, descricao, prazo, responsavel_id, criado_por, criado_por_nome,
                                   recorrencia, serie_id) values (%s, %s, %s, %s, %s, %s, %s, %s)""",
                            (t["titulo"], t["descricao"], proxima, t["responsavel_id"], t["criado_por"], t["criado_por_nome"],
                             t["recorrencia"], t["serie_id"]))
    return {"ok": True, "proxima": proxima}


@router.delete("/{tid}")
def excluir(tid: uuid.UUID, req: Request):
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        t = _minha(cur, tid, u)
        if u["perfil"] != "admin" and str(t["criado_por"]) != str(u["id"]):
            raise HTTPException(403, "Só quem criou a tarefa pode excluir; marque como feita")
        cur.execute("delete from fin_app.tarefas where id = %s", (tid,))
    return {"ok": True}
