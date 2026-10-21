"""Checklists de rotina (abertura da cozinha, fechamento do salão...).

- O admin monta: nome, dias da semana em que vale, quem faz (logins) e os itens.
- No dia, quem faz marca item por item (salva na hora) e finaliza; se algo ficou sem marcar, precisa dizer o motivo.
- Fechamento depois da meia-noite: o checklist de ontem ainda pode ser feito até o meio-dia de hoje.
- Avisos na Lista de tarefas do admin: checklist finalizado com itens não feitos, ou que não foi finalizado
  (ontem depois do meio-dia, ou dias anteriores). Somem quando o admin marca "Ciente".
Fica em /api/portal/* (qualquer login); a permissão (admin / pessoa do checklist) é conferida aqui.
"""
import datetime as dt
import uuid

import psycopg
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from fin import DSN, q

router = APIRouter(prefix="/api/portal/checklists")
TZ = "America/Sao_Paulo"
DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]


def _agora(cur):
    return cur.execute(f"select (now() at time zone '{TZ}') as t").fetchone()["t"]


def _dow(d: dt.date) -> int:          # 0 = domingo, como em checklists.dias_semana
    return (d.weekday() + 1) % 7


def _admin(req):
    if req.state.usuario["perfil"] != "admin":
        raise HTTPException(403, "Só o administrador monta os checklists")


def _pode(cur, req, cid) -> dict:
    u = req.state.usuario
    c = cur.execute("select * from fin_app.checklists where id = %s", (cid,)).fetchone()
    if not c:
        raise HTTPException(404, "Checklist não encontrado")
    if u["perfil"] != "admin" and not cur.execute("select 1 from fin_app.checklist_pessoas where checklist_id = %s and usuario_id = %s",
                                                    (cid, u["id"])).fetchone():
        raise HTTPException(403, "Este checklist não é seu")
    return c


def _datas_editaveis(agora: dt.datetime) -> list[dt.date]:
    """Hoje e, até o meio-dia, ontem (fechamento que passa da meia-noite)."""
    hoje = agora.date()
    return [hoje, hoje - dt.timedelta(days=1)] if agora.hour < 12 else [hoje]


def _progresso(cur, cid, data) -> dict:
    r = cur.execute("""select e.id, e.finalizada_em, e.finalizada_por_nome, e.motivo, e.ciente_em,
                              (select count(*) from fin_app.checklist_itens i where i.checklist_id = %(c)s and i.ativo) as total,
                              (select count(*) from fin_app.checklist_marcas m join fin_app.checklist_itens i on i.id = m.item_id and i.ativo
                                where m.execucao_id = e.id) as feitos
                       from (select %(c)s::uuid as cid) x
                       left join fin_app.checklist_execucoes e on e.checklist_id = x.cid and e.data = %(d)s""",
                    {"c": cid, "d": data}).fetchone()
    if r["id"] is None:
        r["feitos"] = 0
    return r


# ------------------------------------------------------------------ para a Lista de tarefas (afazeres.py)
def tarefas_do_dia(cur, u) -> list[dict]:
    """Checklists que a pessoa tem para fazer agora (hoje e, até o meio-dia, o de ontem não finalizado)."""
    agora = _agora(cur)
    out = []
    for c in cur.execute("""select c.* from fin_app.checklists c join fin_app.checklist_pessoas p on p.checklist_id = c.id
                            where c.ativo and p.usuario_id = %s order by c.nome""", (u["id"],)).fetchall():
        for d in _datas_editaveis(agora):
            if _dow(d) not in c["dias_semana"]:
                continue
            p = _progresso(cur, c["id"], d)
            if p["finalizada_em"]:
                continue
            ontem = d < agora.date()
            out.append({"tipo": "checklist", "titulo": f"Checklist: {c['nome']}{' (de ontem)' if ontem else ''}",
                        "detalhe": f"{p['feitos']} de {p['total']} itens feitos", "link": f"#/checklist?id={c['id']}&d={d}",
                        "acao": "Abrir", "data": d, "urgente": ontem})
    return out


def avisos_admin(cur) -> list[dict]:
    """O que o admin precisa saber: itens não feitos ou checklist não finalizado (últimos 7 dias, até marcar ciente)."""
    agora = _agora(cur)
    hoje = agora.date()
    out = []
    for c in cur.execute("select * from fin_app.checklists where ativo order by nome").fetchall():
        inicio = max(c["criado_em"].astimezone(dt.timezone(dt.timedelta(hours=-3))).date(), hoje - dt.timedelta(days=7))
        d = inicio
        while d <= hoje:
            if _dow(d) in c["dias_semana"]:
                p = _progresso(cur, c["id"], d)
                faltam = p["total"] - p["feitos"]
                rot = "hoje" if d == hoje else "ontem" if d == hoje - dt.timedelta(days=1) else f"{DIAS_SEMANA[_dow(d)][:3]} {d:%d/%m}"
                if not p["ciente_em"]:
                    if p["finalizada_em"] and faltam > 0:
                        out.append({"tipo": "checklist_aviso", "titulo": f"Checklist {c['nome']} de {rot}: {faltam} item(ns) não feito(s)",
                                    "detalhe": f"Motivo: {p['motivo']}" if p["motivo"] else f"Finalizado por {p['finalizada_por_nome']}",
                                    "link": f"#/checklist?id={c['id']}&d={d}", "acao": "Ver", "data": d, "urgente": True})
                    elif not p["finalizada_em"] and d not in _datas_editaveis(agora):
                        out.append({"tipo": "checklist_aviso", "titulo": f"Checklist {c['nome']} de {rot} não foi finalizado",
                                    "detalhe": f"{p['feitos']} de {p['total']} itens marcados", "link": f"#/checklist?id={c['id']}&d={d}",
                                    "acao": "Ver", "data": d, "urgente": True})
            d += dt.timedelta(days=1)
    return out


# ------------------------------------------------------------------ fazer o checklist
@router.get("/{cid}/dia/{data}")
def dia(cid: uuid.UUID, data: dt.date, req: Request):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        c = _pode(cur, req, cid)
        agora = _agora(cur)
        p = _progresso(cur, cid, data)
        itens = cur.execute("""select i.id, i.texto, m.feito_em, m.feito_por_nome from fin_app.checklist_itens i
                               left join fin_app.checklist_marcas m on m.item_id = i.id and m.execucao_id = %s
                               where i.checklist_id = %s and i.ativo order by i.ordem""", (p["id"], cid)).fetchall()
    return {"checklist": {"id": c["id"], "nome": c["nome"], "descricao": c["descricao"]}, "data": data, "execucao": p, "itens": itens,
            "editavel": data in _datas_editaveis(agora) and not p["finalizada_em"], "vale_hoje": _dow(data) in c["dias_semana"]}


def _execucao(cur, cid, data) -> uuid.UUID:
    return cur.execute("""insert into fin_app.checklist_execucoes (checklist_id, data) values (%s, %s)
                          on conflict (checklist_id, data) do update set data = excluded.data returning id""", (cid, data)).fetchone()["id"]


def _editavel(cur, cid, data):
    if data not in _datas_editaveis(_agora(cur)):
        raise HTTPException(409, "Este dia já passou; o checklist não pode mais ser marcado")
    e = cur.execute("select finalizada_em from fin_app.checklist_execucoes where checklist_id = %s and data = %s", (cid, data)).fetchone()
    if e and e["finalizada_em"]:
        raise HTTPException(409, "Este checklist já foi finalizado")


class Marca(BaseModel):
    feito: bool


@router.put("/{cid}/dia/{data}/itens/{iid}")
def marcar(cid: uuid.UUID, data: dt.date, iid: uuid.UUID, b: Marca, req: Request):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        _pode(cur, req, cid)
        _editavel(cur, cid, data)
        if not cur.execute("select 1 from fin_app.checklist_itens where id = %s and checklist_id = %s and ativo", (iid, cid)).fetchone():
            raise HTTPException(404, "Item não encontrado")
        eid = _execucao(cur, cid, data)
        if b.feito:
            cur.execute("""insert into fin_app.checklist_marcas (execucao_id, item_id, feito_por_nome) values (%s, %s, %s)
                           on conflict do nothing""", (eid, iid, req.state.usuario["nome"]))
        else:
            cur.execute("delete from fin_app.checklist_marcas where execucao_id = %s and item_id = %s", (eid, iid))
    return {"ok": True}


class Finalizar(BaseModel):
    motivo: str | None = Field(None, max_length=1000)


@router.post("/{cid}/dia/{data}/finalizar")
def finalizar(cid: uuid.UUID, data: dt.date, b: Finalizar, req: Request):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        _pode(cur, req, cid)
        _editavel(cur, cid, data)
        eid = _execucao(cur, cid, data)
        p = _progresso(cur, cid, data)
        faltam = p["total"] - p["feitos"]
        motivo = (b.motivo or "").strip() or None
        if faltam and not motivo:
            raise HTTPException(422, f"{faltam} item(ns) sem marcar: conte o motivo para o administrador")
        cur.execute("""update fin_app.checklist_execucoes set finalizada_em = now(), finalizada_por_nome = %s, motivo = %s,
                         ciente_em = case when %s then now() end where id = %s""",
                    (req.state.usuario["nome"], motivo, faltam == 0, eid))   # tudo feito: não gera aviso
    return {"ok": True, "faltaram": faltam}


@router.post("/{cid}/dia/{data}/ciente")
def ciente(cid: uuid.UUID, data: dt.date, req: Request):
    """O admin viu o aviso (itens não feitos ou checklist não finalizado)."""
    _admin(req)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        eid = _execucao(cur, cid, data)
        cur.execute("update fin_app.checklist_execucoes set ciente_em = now() where id = %s", (eid,))
    return {"ok": True}


# ------------------------------------------------------------------ montar os checklists (admin)
@router.get("/admin")
def listar(req: Request):
    _admin(req)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        agora = _agora(cur)
        hoje = agora.date()
        cs = cur.execute("select * from fin_app.checklists order by not ativo, nome").fetchall()
        for c in cs:
            c["itens"] = cur.execute("select id, texto from fin_app.checklist_itens where checklist_id = %s and ativo order by ordem",
                                     (c["id"],)).fetchall()
            c["pessoas"] = cur.execute("""select u.id, u.nome from fin_app.checklist_pessoas p join fin_app.usuarios u on u.id = p.usuario_id
                                          where p.checklist_id = %s order by u.nome""", (c["id"],)).fetchall()
            # últimos 7 dias: feito / com pendência / não feito / não vale
            c["semana"] = []
            for k in range(6, -1, -1):
                d = hoje - dt.timedelta(days=k)
                criado = c["criado_em"].astimezone(dt.timezone(dt.timedelta(hours=-3))).date()
                if _dow(d) not in c["dias_semana"] or d < criado:      # não vale nesse dia (ou ainda não existia)
                    c["semana"].append({"data": d, "st": "folga"})
                    continue
                p = _progresso(cur, c["id"], d)
                st = ("ok" if p["feitos"] >= p["total"] else "pendencia") if p["finalizada_em"] \
                    else ("andamento" if d in _datas_editaveis(agora) else "nao_feito")
                c["semana"].append({"data": d, "st": st, "feitos": p["feitos"], "total": p["total"]})
    return {"checklists": cs, "pessoas": q("select id, nome, perfil from fin_app.usuarios where ativo order by perfil <> 'admin', lower(nome)")}


class Checklist(BaseModel):
    nome: str = Field(min_length=1, max_length=100)
    descricao: str | None = Field(None, max_length=500)
    dias_semana: list[int] = Field(min_length=1, max_length=7)
    ativo: bool = True
    itens: list[str] = Field(min_length=1, max_length=100)
    pessoas: list[uuid.UUID] = Field([], max_length=200)


def _gravar(cur, cid, c: Checklist):
    """Mantém o id dos itens com o mesmo texto (o histórico de marcas continua valendo); os que saíram ficam inativos."""
    textos = [t.strip() for t in c.itens if t.strip()]
    if not textos:
        raise HTTPException(422, "Coloque pelo menos um item")
    atuais = {r["texto"]: r["id"] for r in cur.execute("select id, texto from fin_app.checklist_itens where checklist_id = %s", (cid,)).fetchall()}
    cur.execute("update fin_app.checklist_itens set ativo = false where checklist_id = %s", (cid,))
    for n, t in enumerate(textos):
        if t in atuais:
            cur.execute("update fin_app.checklist_itens set ativo = true, ordem = %s where id = %s", (n, atuais[t]))
        else:
            cur.execute("insert into fin_app.checklist_itens (checklist_id, texto, ordem) values (%s, %s, %s)", (cid, t[:300], n))
    cur.execute("delete from fin_app.checklist_pessoas where checklist_id = %s", (cid,))
    for p in dict.fromkeys(c.pessoas):
        cur.execute("insert into fin_app.checklist_pessoas (checklist_id, usuario_id) values (%s, %s)", (cid, p))


@router.post("/admin")
def criar(c: Checklist, req: Request):
    _admin(req)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        cid = cur.execute("""insert into fin_app.checklists (nome, descricao, dias_semana, ativo) values (%s, %s, %s, %s) returning id""",
                          (c.nome.strip(), c.descricao, sorted(set(c.dias_semana)), c.ativo)).fetchone()["id"]
        _gravar(cur, cid, c)
    return {"id": cid}


@router.put("/admin/{cid}")
def editar(cid: uuid.UUID, c: Checklist, req: Request):
    _admin(req)
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        if not cur.execute("""update fin_app.checklists set nome = %s, descricao = %s, dias_semana = %s, ativo = %s where id = %s returning id""",
                           (c.nome.strip(), c.descricao, sorted(set(c.dias_semana)), c.ativo, cid)).fetchone():
            raise HTTPException(404, "Checklist não encontrado")
        _gravar(cur, cid, c)
    return {"id": cid}


@router.delete("/admin/{cid}")
def excluir(cid: uuid.UUID, req: Request):
    _admin(req)
    q("delete from fin_app.checklists where id = %s returning id", (cid,))
    return {"ok": True}
