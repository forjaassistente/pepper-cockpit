"""Contagem de estoque (etapa 1).

- Cada insumo/manufaturado tem frequência, setor que conta (salão/cozinha) e as CENTRAIS DE ESTOQUE onde fica
  (cadastro de cada empresa; um item pode estar em várias, ex.: bebida no Estoque Grande e no Bar). Na contagem ele é
  contado em cada central e o estoque do item é a soma; só vale a contagem em que todas as centrais dele foram contadas.
  Contado na unidade de compra.
- Agenda por dias fixos (contagem para compras): 2x por semana = domingo e quinta; semanal = domingo;
  quinzenal = domingo, um sim, um não; mensal = só no fim do mês. No ÚLTIMO DIA DO MÊS todos os itens entram
  (inventário para conciliação e CMV). Item cuja data passou sem contagem continua na lista até ser contado.
- Quem conta: login com o setor em usuarios.estoque_setores (admin conta todos). A contagem é CEGA: o portal
  nunca devolve a quantidade esperada nem a contagem anterior; cada item é salvo na hora.
- O admin vê o estoque atual, o histórico e a diferença de cada contagem para a anterior.
"""
import datetime as dt
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException, Request
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from fichas import Motor
from fin import DSN, q

portal = APIRouter(prefix="/api/portal/estoque")    # quem conta (qualquer login; o setor é conferido aqui)
admin = APIRouter(prefix="/api/estoque")            # só admin (regra geral do auth.permitido)

TZ = "America/Sao_Paulo"
Setor = Literal["salao", "cozinha"]
Freq = Literal["2x_semana", "semanal", "quinzenal", "mensal"]

# última contagem COMPLETA de cada insumo (todas as centrais dele contadas): quantidade = soma das centrais
SQL_ULTIMA = """
    select distinct on (x.insumo_id) x.insumo_id, x.quantidade, x.finalizada_em, x.dia, x.por_central
    from (select i.insumo_id, c.id, c.finalizada_em, (c.finalizada_em at time zone '{tz}')::date as dia,
                 sum(i.quantidade) as quantidade, bool_and(i.quantidade is not null) as completo,
                 jsonb_agg(jsonb_build_object('central', coalesce(ec.nome, 'Sem central'), 'quantidade', i.quantidade)
                           order by ec.ordem nulls last, ec.nome) as por_central
          from fin_app.estoque_contagem_itens i join fin_app.estoque_contagens c on c.id = i.contagem_id
          left join fin_app.estoque_centrais ec on ec.id = i.central_id
          where c.status = 'finalizada' {filtro}
          group by i.insumo_id, c.id, c.finalizada_em) x
    where x.completo
    order by x.insumo_id, x.finalizada_em desc"""

# centrais (ativas) de cada insumo, na ordem do cadastro
SQL_CENTRAIS = """
    select ic.insumo_id, array_agg(ec.id order by ec.ordem, ec.nome) as ids, array_agg(ec.nome order by ec.ordem, ec.nome) as nomes
    from fin_app.insumo_centrais ic join fin_app.estoque_centrais ec on ec.id = ic.central_id and ec.ativo
    group by ic.insumo_id"""
SEM_CENTRAL = "00000000-0000-0000-0000-000000000000"


def _hoje_sql():
    return f"(now() at time zone '{TZ}')::date"


# ------------------------------------------------------------------ agenda
DOMINGO, QUINTA = 6, 3      # date.weekday()


def fim_do_mes(d: dt.date) -> dt.date:
    return (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1)


def _ultimo(d: dt.date, dia_semana: int) -> dt.date:
    return d - dt.timedelta(days=(d.weekday() - dia_semana) % 7)


def _domingo_compras(domingo: dt.date) -> dt.date:
    """Dia da contagem de compras daquela semana: o domingo, ou o inventário do fim do mês quando ele cai
    colado — no sábado antes (vale pelo domingo seguinte) ou na segunda depois (substitui o domingo anterior)."""
    um = dt.timedelta(days=1)
    if fim_do_mes(domingo - um) == domingo - um:
        return domingo - um
    if fim_do_mes(domingo + um) == domingo + um:
        return domingo + um
    return domingo


def prazo(freq: str, hoje: dt.date) -> dt.date:
    """Última data (até hoje) em que o item deveria ter sido contado."""
    fim = hoje if hoje == fim_do_mes(hoje) else hoje.replace(day=1) - dt.timedelta(days=1)   # inventário do mês
    dom = _domingo_compras(_ultimo(hoje, DOMINGO))
    if dom > hoje:                                             # inventário da segunda ainda não chegou
        dom = _domingo_compras(_ultimo(hoje, DOMINGO) - dt.timedelta(days=7))
    base = {"2x_semana": max(dom, _ultimo(hoje, QUINTA)), "semanal": dom,
            "quinzenal": dom - dt.timedelta(days=13),          # domingo sim, domingo não
            "mensal": fim}[freq]
    return max(base, fim)


def vence(freq: str, ultima: dt.date | None, hoje: dt.date) -> bool:
    return ultima is None or ultima < prazo(freq, hoje)


def proxima(freq: str, ultima: dt.date | None, hoje: dt.date) -> dt.date:
    """Próximo dia (a partir de hoje) em que o item entra na lista."""
    d = hoje
    while not vence(freq, ultima, d) and d < hoje + dt.timedelta(days=62):
        d += dt.timedelta(days=1)
    return d


def _hoje(cur) -> dt.date:
    return cur.execute(f"select (now() at time zone '{TZ}')::date as d").fetchone()["d"]


def _configurados(cur, setor: str) -> list[dict]:
    return cur.execute(f"""
        with ult as ({SQL_ULTIMA.format(tz=TZ, filtro='')})
        select s.id, s.unidade, s.contagem_freq, ult.dia as ultima from fin_app.insumos s left join ult on ult.insumo_id = s.id
        where s.ativo and s.contagem_freq is not null and s.contagem_setor = %s""", (setor,)).fetchall()


def _devidos(cur, setor: str, todos: bool = False) -> list[dict]:
    """Itens do setor que entram na lista de hoje (ou todos os configurados do setor)."""
    hoje = _hoje(cur)
    return [i for i in _configurados(cur, setor) if todos or vence(i["contagem_freq"], i["ultima"], hoje)]


def _setores(req: Request) -> list[str]:
    u = req.state.usuario
    return ["salao", "cozinha"] if u["perfil"] == "admin" else list(u.get("estoque_setores") or [])


def _contagem_do_usuario(cur, req: Request, cid) -> dict:
    c = cur.execute("select * from fin_app.estoque_contagens where id = %s", (cid,)).fetchone()
    if not c or c["setor"] not in _setores(req):
        raise HTTPException(404, "Contagem não encontrada")
    if c["status"] != "aberta":
        raise HTTPException(409, "Esta contagem já foi finalizada")
    return c


# ------------------------------------------------------------------ portal: quem conta
@portal.get("")
def painel(req: Request):
    setores = _setores(req)
    if not setores:
        raise HTTPException(403, "Seu login não está habilitado para contagem de estoque")
    out = []
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        for s in setores:
            aberta = cur.execute("""select c.id, c.iniciada_em, c.usuario_nome,
                                           count(i.id) as total, count(i.quantidade) as contados
                                    from fin_app.estoque_contagens c left join fin_app.estoque_contagem_itens i on i.contagem_id = c.id
                                    where c.setor = %s and c.status = 'aberta' group by c.id""", (s,)).fetchone()
            ultima = cur.execute("""select max(finalizada_em) as em from fin_app.estoque_contagens
                                    where setor = %s and status = 'finalizada'""", (s,)).fetchone()["em"]
            hoje = _hoje(cur)
            conf = _configurados(cur, s)
            devidos = [i for i in conf if vence(i["contagem_freq"], i["ultima"], hoje)]
            prox = min((proxima(i["contagem_freq"], i["ultima"], hoje) for i in conf), default=None) if not devidos else hoje
            out.append({"setor": s, "aberta": aberta, "devidos": len(devidos), "configurados": len(conf), "ultima": ultima,
                        "proxima": prox})
        hoje = _hoje(cur)
    return {"setores": out, "hoje": hoje, "inventario": hoje == fim_do_mes(hoje)}


@portal.post("/{setor}/iniciar")
def iniciar(setor: Setor, req: Request, todos: bool = False):
    """Abre a contagem do setor com a lista do dia (ou devolve a que já está aberta)."""
    if setor not in _setores(req):
        raise HTTPException(403, "Você não está habilitado para contar este setor")
    u = req.state.usuario
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        aberta = cur.execute("select id from fin_app.estoque_contagens where setor = %s and status = 'aberta'", (setor,)).fetchone()
        if aberta:
            return {"id": aberta["id"], "ja_aberta": True}
        itens = _devidos(cur, setor, todos)
        if not itens:
            raise HTTPException(422, "Nada para contar hoje neste setor. Use “contar todos os itens” se quiser conferir mesmo assim.")
        hoje = _hoje(cur)
        cid = cur.execute("""insert into fin_app.estoque_contagens (setor, usuario_id, usuario_nome, inventario) values (%s, %s, %s, %s)
                             returning id""", (setor, u["id"], u["nome"], hoje == fim_do_mes(hoje))).fetchone()["id"]
        cents = {r["insumo_id"]: r["ids"] for r in cur.execute(SQL_CENTRAIS).fetchall()}
        cur.executemany("""insert into fin_app.estoque_contagem_itens (contagem_id, insumo_id, unidade, central_id) values (%s, %s, %s, %s)""",
                        [(cid, i["id"], i["unidade"], ce) for i in itens for ce in (cents.get(i["id"]) or [None])])
    return {"id": cid, "ja_aberta": False}


@portal.get("/{setor}/folha")
def folha(setor: Setor, req: Request, data: dt.date | None = None, todos: bool = False):
    """Folha para imprimir e contar à mão: itens do setor que vencem na data (ou todos), por estoque e categoria.
    Contagem cega: não traz a quantidade esperada."""
    if setor not in _setores(req):
        raise HTTPException(403, "Você não está habilitado para contar este setor")
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        dia = data or _hoje(cur)
        ids = [i["id"] for i in _configurados(cur, setor) if todos or vence(i["contagem_freq"], i["ultima"], dia)]
        itens = cur.execute(f"""
            with cents as ({SQL_CENTRAIS})
            select s.nome, s.unidade, coalesce(ce.nome, 'Sem estoque definido') as local, coalesce(ce.ordem, 9999) as local_ordem,
                   case when s.tipo = 'manufaturado' then 'Manufaturados' else coalesce(k.nome, 'Sem categoria') end as categoria,
                   coalesce(k.ordem, 999) as cat_ordem
            from fin_app.insumos s left join cents on cents.insumo_id = s.id
            left join lateral unnest(coalesce(cents.ids, array[null::uuid])) as u(cid) on true
            left join fin_app.estoque_centrais ce on ce.id = u.cid
            left join fin_app.cat_itens k on k.id = s.categoria_id
            where s.id = any(%s)
            order by local_ordem, local, s.tipo = 'manufaturado', cat_ordem, categoria, lower(s.nome)""", (ids,)).fetchall()
    return {"setor": setor, "data": dia, "todos": todos, "inventario": dia == fim_do_mes(dia), "itens": itens}


@portal.get("/contagem/{cid}")
def contagem(cid: uuid.UUID, req: Request):
    """Lista para contar: uma linha por item e central. Cega: só o que esta contagem registrou, nunca o esperado."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        cur = conn.cursor()
        c = _contagem_do_usuario(cur, req, cid)
        itens = cur.execute("""
            select i.insumo_id, i.central_id, s.nome, i.unidade, i.quantidade, i.previsto, s.tipo,
                   coalesce(ec.nome, 'Sem central definida') as local, coalesce(ec.ordem, 9999) as local_ordem,
                   case when s.tipo = 'manufaturado' then 'Manufaturados' else coalesce(k.nome, 'Sem categoria') end as categoria
            from fin_app.estoque_contagem_itens i join fin_app.insumos s on s.id = i.insumo_id
            left join fin_app.estoque_centrais ec on ec.id = i.central_id
            left join fin_app.cat_itens k on k.id = s.categoria_id
            where i.contagem_id = %s order by lower(s.nome), ec.ordem""", (cid,)).fetchall()
        # itens do setor (em cada central dele) que não estão na lista de hoje
        extras = cur.execute(f"""
            with cents as ({SQL_CENTRAIS})
            select s.id as insumo_id, ce.id as central_id, s.nome, s.unidade, coalesce(ce.nome, 'Sem central definida') as local,
                   coalesce(ce.ordem, 9999) as local_ordem
            from fin_app.insumos s left join cents on cents.insumo_id = s.id
            left join lateral unnest(coalesce(cents.ids, array[null::uuid])) as u(cid) on true
            left join fin_app.estoque_centrais ce on ce.id = u.cid
            where s.ativo and s.contagem_setor = %s
              and not exists (select 1 from fin_app.estoque_contagem_itens i where i.contagem_id = %s and i.insumo_id = s.id
                              and i.central_id is not distinct from u.cid)
            order by lower(s.nome), ce.ordem""", (c["setor"], cid)).fetchall()
    return {"id": c["id"], "setor": c["setor"], "iniciada_em": c["iniciada_em"], "usuario_nome": c["usuario_nome"], "inventario": c["inventario"],
            "itens": itens, "extras": extras}


class Quantidade(BaseModel):
    quantidade: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=3)


@portal.put("/contagem/{cid}/itens/{iid}")
def registrar(cid: uuid.UUID, iid: uuid.UUID, b: Quantidade, req: Request, central: uuid.UUID | None = None):
    """Salva um item de uma central na hora (vazio = ainda não contado). Item fora da lista entra como não previsto."""
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        c = _contagem_do_usuario(cur, req, cid)
        ins = cur.execute("select unidade, contagem_setor from fin_app.insumos where id = %s and ativo", (iid,)).fetchone()
        if not ins or ins["contagem_setor"] != c["setor"]:
            raise HTTPException(422, "Este item não é contado neste setor")
        cents = cur.execute("""select array_agg(ic.central_id) as ids from fin_app.insumo_centrais ic
                               join fin_app.estoque_centrais ec on ec.id = ic.central_id and ec.ativo where ic.insumo_id = %s""",
                            (iid,)).fetchone()["ids"] or []
        if (central is None and cents) or (central is not None and central not in cents):
            raise HTTPException(422, "Este item não fica nesta central de estoque")
        cur.execute(f"""insert into fin_app.estoque_contagem_itens (contagem_id, insumo_id, central_id, unidade, previsto, quantidade, contado_em, contado_por)
                       values (%(c)s, %(i)s, %(ce)s, %(u)s, false, %(q)s, case when %(q)s::numeric is null then null else now() end, %(por)s)
                       on conflict (contagem_id, insumo_id, coalesce(central_id, '{SEM_CENTRAL}'::uuid)) do update
                         set quantidade = excluded.quantidade, contado_em = excluded.contado_em, contado_por = excluded.contado_por""",
                    {"c": cid, "i": iid, "ce": central, "u": ins["unidade"], "q": b.quantidade, "por": req.state.usuario["id"]})
    return {"ok": True}


@portal.post("/contagem/{cid}/finalizar")
def finalizar(cid: uuid.UUID, req: Request):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        _contagem_do_usuario(cur, req, cid)
        cur.execute("delete from fin_app.estoque_contagem_itens where contagem_id = %s and not previsto and quantidade is null", (cid,))
        r = cur.execute("""select count(*) filter (where quantidade is not null) as contados, count(*) filter (where quantidade is null) as faltaram
                           from fin_app.estoque_contagem_itens where contagem_id = %s""", (cid,)).fetchone()
        if not r["contados"]:
            raise HTTPException(422, "Nenhum item foi contado ainda")
        cur.execute("update fin_app.estoque_contagens set status = 'finalizada', finalizada_em = now() where id = %s", (cid,))
    return {"ok": True, **r}


# ------------------------------------------------------------------ admin: configuração
@admin.get("/config")
def config():
    itens = q(f"""with cents as ({SQL_CENTRAIS})
                select s.id, s.nome, s.tipo, s.unidade, s.estoque_minimo, s.contagem_freq, s.contagem_setor,
                       coalesce(cents.ids, '{{}}') as centrais,
                       case when s.tipo = 'manufaturado' then 'Manufaturados' else coalesce(k.nome, 'Sem categoria') end as categoria
                from fin_app.insumos s left join fin_app.cat_itens k on k.id = s.categoria_id left join cents on cents.insumo_id = s.id
                where s.ativo order by s.tipo, k.ordem nulls last, k.nome, lower(s.nome)""")
    return {"itens": itens, "centrais": q("select id, nome from fin_app.estoque_centrais where ativo order by ordem, nome")}


class ConfigItem(BaseModel):
    id: uuid.UUID
    contagem_freq: Freq | None = None
    contagem_setor: Setor | None = None
    centrais: list[uuid.UUID] = Field([], max_length=50)


class Config(BaseModel):
    itens: list[ConfigItem] = Field(max_length=1000)


@admin.put("/config")
def salvar_config(b: Config):
    for it in b.itens:
        if it.contagem_freq and not it.contagem_setor:
            raise HTTPException(422, "Escolha o setor (salão ou cozinha) de todo item com frequência")
    with psycopg.connect(**DSN) as conn, conn.transaction():
        for it in b.itens:
            conn.execute("update fin_app.insumos set contagem_freq = %s, contagem_setor = %s where id = %s",
                         (it.contagem_freq, it.contagem_setor, it.id))
            conn.execute("delete from fin_app.insumo_centrais where insumo_id = %s", (it.id,))
            for ce in dict.fromkeys(it.centrais):
                conn.execute("insert into fin_app.insumo_centrais (insumo_id, central_id) values (%s, %s)", (it.id, ce))
    return {"ok": True, "gravados": len(b.itens)}


# ------------------------------------------------------------------ admin: cadastro das centrais de estoque
class Central(BaseModel):
    nome: str = Field(min_length=1, max_length=60)
    ordem: int = Field(100, ge=0, le=9999)
    ativo: bool = True


@admin.get("/centrais")
def centrais():
    return q("""select c.*, (select count(*) from fin_app.insumo_centrais ic join fin_app.insumos s on s.id = ic.insumo_id
                             where ic.central_id = c.id and s.ativo) as itens
                from fin_app.estoque_centrais c order by not c.ativo, c.ordem, c.nome""")


@admin.post("/centrais")
def criar_central(c: Central):
    return q("insert into fin_app.estoque_centrais (nome, ordem, ativo) values (%s, %s, %s) returning *",
             (c.nome.strip(), c.ordem, c.ativo))[0]


@admin.put("/centrais/{cid}")
def editar_central(cid: uuid.UUID, c: Central):
    r = q("update fin_app.estoque_centrais set nome = %s, ordem = %s, ativo = %s where id = %s returning *",
          (c.nome.strip(), c.ordem, c.ativo, cid))
    if not r:
        raise HTTPException(404, "Central não encontrada")
    return r[0]


# ------------------------------------------------------------------ admin: estoque atual e histórico
@admin.get("/atual")
def atual():
    m = Motor()
    linhas = q(f"""
        with ult as ({SQL_ULTIMA.format(tz=TZ, filtro='')}), cents as ({SQL_CENTRAIS})
        select s.id, s.nome, s.tipo, s.unidade, s.custo_unitario, s.estoque_minimo, s.contagem_freq, s.contagem_setor,
               coalesce(cents.ids, '{{}}') as central_ids, coalesce(cents.nomes, '{{}}') as centrais, ult.por_central,
               case when s.tipo = 'manufaturado' then 'Manufaturados' else coalesce(k.nome, 'Sem categoria') end as categoria,
               ult.quantidade, ult.finalizada_em as contado_em, ult.dia as ultima_dia, {_hoje_sql()} as hoje,
               (select coalesce(sum(e.quantidade), 0) from fin_app.estoque_entradas e
                 where e.insumo_id = s.id and (ult.dia is null or e.data > ult.dia)) as entradas
        from fin_app.insumos s left join ult on ult.insumo_id = s.id left join fin_app.cat_itens k on k.id = s.categoria_id
        left join cents on cents.insumo_id = s.id
        where s.ativo and (s.contagem_freq is not null or ult.insumo_id is not null
                           or exists (select 1 from fin_app.estoque_entradas e where e.insumo_id = s.id))
        order by k.ordem nulls last, k.nome, lower(s.nome)""")
    data = lambda v: v if v is None or isinstance(v, dt.date) else dt.date.fromisoformat(str(v)[:10])   # q() devolve datas como texto
    for l in linhas:
        ultima, hoje, f = data(l.pop("ultima_dia")), data(l.pop("hoje")), l["contagem_freq"]
        l["proxima"] = proxima(f, ultima, hoje) if f else None
        # atrasada: já devia ter sido contado num dia anterior (no próprio dia da contagem ainda não é atraso)
        l["atrasada"] = bool(f) and vence(f, ultima, hoje) and (ultima is None or prazo(f, hoje) < hoje)
        # valor no estoque: insumo pelo preço de compra (contado na unidade de compra); manufaturado pelo custo da receita
        preco = m.custo_unitario(l["id"])[0] if l["tipo"] == "manufaturado" else (float(l["custo_unitario"]) if l["custo_unitario"] is not None else None)
        # estoque atual = última contagem + entradas das notas depois dela (sem contagem ainda: não dá para saber)
        l["estoque"] = l["quantidade"] + l["entradas"] if l["quantidade"] is not None else None
        l["valor"] = round(float(l["estoque"]) * preco, 2) if l["estoque"] is not None and preco is not None else None
        l["abaixo_minimo"] = l["estoque"] is not None and l["estoque_minimo"] is not None and l["estoque"] < l["estoque_minimo"]
    return linhas


@admin.get("/contagens")
def contagens():
    return q("""select c.id, c.setor, c.status, c.iniciada_em, c.finalizada_em, c.usuario_nome, c.inventario,
                       count(i.id) filter (where i.quantidade is not null) as contados,
                       count(i.id) filter (where i.quantidade is null) as faltaram
                from fin_app.estoque_contagens c left join fin_app.estoque_contagem_itens i on i.contagem_id = c.id
                group by c.id order by c.iniciada_em desc limit 200""")


@admin.get("/contagens/{cid}")
def detalhe(cid: uuid.UUID):
    """Contagem com a anterior e as entradas das notas entre as duas: consumo = anterior + entradas − contado."""
    c = q("select * from fin_app.estoque_contagens where id = %s", (cid,))
    if not c:
        raise HTTPException(404, "Contagem não encontrada")
    itens = q(f"""
        with atual as (
          select i.insumo_id, max(i.unidade) as unidade, bool_or(i.previsto) as previsto,
                 case when bool_and(i.quantidade is not null) then sum(i.quantidade) end as quantidade,
                 jsonb_agg(jsonb_build_object('central', coalesce(ec.nome, 'Sem central'), 'quantidade', i.quantidade)
                           order by ec.ordem nulls last) as por_central
          from fin_app.estoque_contagem_itens i left join fin_app.estoque_centrais ec on ec.id = i.central_id
          where i.contagem_id = %(id)s group by i.insumo_id),
        ant as ({SQL_ULTIMA.format(tz=TZ, filtro="and c.id <> %(id)s and c.finalizada_em < coalesce(%(fim)s, now())")})
        select a.*, s.nome, s.custo_unitario, s.tipo, ant.quantidade as anterior,
               (select coalesce(sum(e.quantidade), 0) from fin_app.estoque_entradas e
                 where e.insumo_id = a.insumo_id and ant.dia is not null and e.data > ant.dia
                   and e.data <= (coalesce(%(fim)s, now()) at time zone '{TZ}')::date) as entradas
        from atual a join fin_app.insumos s on s.id = a.insumo_id left join ant on ant.insumo_id = a.insumo_id
        order by lower(s.nome)""", {"id": cid, "fim": c[0]["finalizada_em"]})
    return {"contagem": c[0], "itens": itens}


@admin.delete("/contagens/{cid}")
def cancelar(cid: uuid.UUID):
    r = q("delete from fin_app.estoque_contagens where id = %s and status = 'aberta' returning id", (cid,))
    if not r:
        raise HTTPException(409, "Só dá para cancelar uma contagem que ainda está aberta")
    return {"ok": True}
