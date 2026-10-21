"""Módulo financeiro: contas a pagar/receber + fluxo projetado.

Lê o Nibo só pelas views fin_app.v_* e grava apenas em fin_app.lancamentos,
usando o usuário fin_app_rw (o banco impede escrita em raw/bi e DELETE).
"""
import calendar
import datetime as dt
import decimal
import os
import uuid
from decimal import Decimal
from typing import Literal

import psycopg
from psycopg.rows import dict_row
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator

DSN = dict(host=os.environ.get("PGHOST", "postgres"), port=5432, dbname="pepper_bi",
           user="fin_app_rw", password=os.environ["FIN_APP_PASSWORD"],
           options="-c statement_timeout=15000")

router = APIRouter(prefix="/api/fin")

# Campos que "este e os seguintes" propaga; datas ficam só no lançamento editado.
PROPAGA = ("contato", "contato_id", "categoria_id", "categoria_nome", "conta_id", "conta_nome", "descricao")


def _conv(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _rows(cur):
    return [{k: _conv(v) for k, v in r.items()} for r in cur.fetchall()]


def q(sql, params=None):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        return _rows(conn.execute(sql, params or {}))


def add_months(d: dt.date | None, n: int) -> dt.date | None:
    if d is None:
        return None
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


# ------------------------------------------------------------------ modelos
class Lancamento(BaseModel):
    tipo: Literal["pagar", "receber"]
    vencimento: dt.date
    competencia: dt.date | None = None
    previsto_para: dt.date | None = None
    contato_id: uuid.UUID | None = None   # pessoa do cadastro (sem nome livre)
    categoria_id: uuid.UUID | None = None
    conta_id: uuid.UUID | None = None
    descricao: str | None = Field(None, max_length=500)
    valor: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    status: Literal["aberto", "pago"] = "aberto"
    valor_pago: Decimal | None = Field(None, ge=0, max_digits=14, decimal_places=2)
    data_pagamento: dt.date | None = None

    @model_validator(mode="after")
    def _pago(self):
        if self.status == "pago":
            self.valor_pago = self.valor_pago if self.valor_pago is not None else self.valor
            self.data_pagamento = self.data_pagamento or dt.date.today()
        else:
            self.valor_pago = self.data_pagamento = None
        return self


class NovoLancamento(Lancamento):
    repeticao: Literal["nenhuma", "mensal", "parcelado"] = "nenhuma"
    vezes: int = Field(1, ge=1, le=120)
    anexo_id: uuid.UUID | None = None   # boleto lido na tela (boleto.py)


class Pagamento(BaseModel):
    data_pagamento: dt.date
    valor_pago: Decimal = Field(gt=0, max_digits=14, decimal_places=2)


def _nomes(cur, tipo, categoria_id, conta_id, contato_id=None):
    """Valida ids contra o Nibo e devolve os nomes para guardar junto."""
    cat_nome = conta_nome = None
    if categoria_id:
        r = cur.execute("select categoria, tipo from fin_app.v_categorias where id = %s",
                        (categoria_id,)).fetchone()
        if not r:
            raise HTTPException(422, "Categoria não encontrada no Nibo")
        if r["tipo"] != tipo:
            raise HTTPException(422, f"A categoria \"{r['categoria']}\" é de conta a {r['tipo']}")
        cat_nome = r["categoria"]
    if conta_id:
        r = cur.execute("select conta from fin_app.v_contas where id = %s", (conta_id,)).fetchone()
        if not r:
            raise HTTPException(422, "Conta bancária não encontrada no Nibo")
        conta_nome = r["conta"]
    contato_nome = None
    if contato_id:
        r = cur.execute("""select nome from fin_app.pessoas where id = %s and ativo
                             and papeis && array['fornecedor','cliente','funcionario','socio']""", (contato_id,)).fetchone()
        if not r:
            raise HTTPException(422, "Fornecedor/cliente não encontrado no cadastro")
        contato_nome = r["nome"]
    return cat_nome, conta_nome, contato_nome


def _plano(l: NovoLancamento):
    """Gera as linhas a gravar: 1, N repetições mensais ou N parcelas."""
    n = l.vezes if l.repeticao != "nenhuma" else 1
    grupo = uuid.uuid4() if n > 1 else None
    if l.repeticao == "parcelado" and n > 1:
        centavos = int(l.valor * 100)
        base = centavos // n
        valores = [Decimal(base) / 100] * (n - 1) + [Decimal(centavos - base * (n - 1)) / 100]
    else:
        valores = [l.valor] * n
    linhas = []
    for i in range(n):
        pago = l.status == "pago" and i == 0  # só a primeira ocorrência nasce paga
        linhas.append({
            "tipo": l.tipo,
            "vencimento": add_months(l.vencimento, i),
            "competencia": add_months(l.competencia, i),
            "previsto_para": add_months(l.previsto_para, i),
            "descricao": l.descricao, "valor": valores[i],
            "status": "pago" if pago else "aberto",
            "valor_pago": (l.valor_pago if n == 1 else valores[i]) if pago else None,
            "data_pagamento": l.data_pagamento if pago else None,
            "grupo_id": grupo, "parcela": i + 1 if grupo else None, "total_parcelas": n if grupo else None,
            "recorrencia": l.repeticao if grupo else None,
        })
    return linhas


# ------------------------------------------------------------------ leitura
@router.get("/opcoes")
def opcoes():
    return {
        "contas": q("select id, conta, tipo, banco, saldo_atual from fin_app.v_contas order by conta"),
        "categorias": q("select id, categoria, codigo, tipo, grupo, subgrupo from fin_app.v_categorias "
                        "where ativo order by ordem, grupo, categoria"),
        "pessoas": q("""select id, nome, papeis, tipo_fornecedor, documento from fin_app.pessoas
                         where ativo and papeis && array['fornecedor','cliente','funcionario','socio']
                         order by lower(nome)"""),
    }


@router.get("/titulos")
def titulos(tipo: Literal["pagar", "receber"], ini: dt.date | None = None, fim: dt.date | None = None,
            status: Literal["todos", "aberto", "pago", "vencido"] = "todos",
            categoria: uuid.UUID | None = None, origem: Literal["todos", "nibo", "manual"] = "todos"):
    hoje = dt.date.today()
    p = {"tipo": tipo, "ini": ini or hoje.replace(day=1), "fim": fim or add_months(hoje.replace(day=1), 1) - dt.timedelta(days=1),
         "categoria": categoria, "origem": origem, "status": status, "hoje": hoje}
    filtro = """
        t.tipo = %(tipo)s and t.vencimento between %(ini)s and %(fim)s
        and (%(categoria)s::uuid is null or t.categoria_id = %(categoria)s::uuid)
        and (%(origem)s = 'todos' or t.origem = %(origem)s)
        and (%(status)s = 'todos'
             or (%(status)s = 'vencido' and t.status = 'aberto' and t.vencimento < %(hoje)s)
             or t.status = %(status)s)"""
    linhas = q(f"""
        select t.*, (t.status = 'aberto' and t.vencimento < %(hoje)s) as vencido,
               (t.origem = 'manual' and exists (
                   select 1 from fin_app.v_titulos n
                   where n.origem = 'nibo' and n.tipo = t.tipo and n.valor = t.valor
                     and abs(n.vencimento - t.vencimento) <= 3)) as possivel_duplicado
        from fin_app.v_titulos t where {filtro}
        order by t.vencimento, t.contato limit 3000""", p)
    totais = q(f"""
        select coalesce(sum(valor_em_aberto), 0) as em_aberto,
               coalesce(sum(valor_em_aberto) filter (where vencimento < %(hoje)s), 0) as vencido,
               coalesce(sum(valor_pago), 0) as pago, count(*) as qtd
        from fin_app.v_titulos t where {filtro}""", p)[0]
    return {"periodo": {"ini": p["ini"].isoformat(), "fim": p["fim"].isoformat()}, "linhas": linhas, "totais": totais}


@router.get("/duplicados")
def duplicados(tipo: Literal["pagar", "receber"], valor: Decimal, vencimento: dt.date):
    return q("""select id, vencimento, contato, descricao, valor, status from fin_app.v_titulos
                where origem = 'nibo' and tipo = %s and valor = %s and abs(vencimento - %s::date) <= 3
                order by vencimento limit 10""", (tipo, valor, vencimento))


@router.get("/lancamento/{lid}")
def lancamento(lid: uuid.UUID):
    r = q("select * from fin_app.v_titulos where origem = 'manual' and id = %s", (str(lid),))
    if not r:
        raise HTTPException(404, "Lançamento manual não encontrado")
    l = r[0]
    return {
        "lancamento": l,
        "grupo": q("""select id, parcela, total_parcelas, vencimento, valor, status from fin_app.v_titulos
                      where origem = 'manual' and grupo_id = %s order by parcela""", (l["grupo_id"],))
        if l["grupo_id"] else [],
        "anexos": q("""select id, nome, mime, paginas, criado_em from fin_app.anexos
                       where lancamento_id = %s or (%s::uuid is not null and grupo_id = %s::uuid)
                       order by criado_em""", (str(lid), l["grupo_id"], l["grupo_id"])),
        "historico": q("select acao, em, antes->>'status' as status_antes, depois->>'status' as status_depois "
                       "from fin_app.historico where lancamento_id = %s order by em desc limit 20", (lid,)),
    }


# ------------------------------------------------------------------ escrita (só fin_app.lancamentos)
COLS = ("tipo", "vencimento", "competencia", "previsto_para", "contato", "contato_id", "categoria_id", "categoria_nome",
        "conta_id", "conta_nome", "descricao", "valor", "status", "valor_pago", "data_pagamento",
        "grupo_id", "parcela", "total_parcelas", "recorrencia")


@router.post("/lancamentos")
def criar(l: NovoLancamento):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        cat_nome, conta_nome, contato = _nomes(cur, l.tipo, l.categoria_id, l.conta_id, l.contato_id)
        ids = []
        for linha in _plano(l):
            linha.update(categoria_id=l.categoria_id, categoria_nome=cat_nome,
                         conta_id=l.conta_id, conta_nome=conta_nome, contato_id=l.contato_id, contato=contato)
            cur.execute(f"insert into fin_app.lancamentos ({', '.join(COLS)}) "
                        f"values ({', '.join('%(' + c + ')s' for c in COLS)}) returning id", linha)
            ids.append(str(cur.fetchone()["id"]))
        if l.anexo_id:
            grupo = cur.execute("select grupo_id from fin_app.lancamentos where id = %s", (ids[0],)).fetchone()["grupo_id"]
            cur.execute("""update fin_app.anexos set lancamento_id = %s, grupo_id = %s
                           where id = %s and lancamento_id is null""", (ids[0], grupo, l.anexo_id))
            # Veio da caixa de entrada: o documento passa a "processado" e guarda os lançamentos gerados.
            doc = cur.execute("select documento_id from fin_app.anexos where id = %s", (l.anexo_id,)).fetchone()
            if doc and doc["documento_id"]:
                cur.execute("""update fin_app.documentos set status = 'processado', processado_em = now(),
                                   lancamento_ids = lancamento_ids || %s::uuid[] where id = %s""",
                            (ids, doc["documento_id"]))
    return {"ids": ids}


@router.put("/lancamento/{lid}")
def editar(lid: uuid.UUID, l: Lancamento, escopo: Literal["este", "seguintes"] = "este"):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        cur = conn.cursor()
        atual = cur.execute("select * from fin_app.lancamentos where id = %s and cancelado_em is null for update",
                            (lid,)).fetchone()
        if not atual:
            raise HTTPException(404, "Lançamento manual não encontrado")
        cat_nome, conta_nome, contato = _nomes(cur, l.tipo, l.categoria_id, l.conta_id, l.contato_id)
        novo = l.model_dump() | {"categoria_nome": cat_nome, "conta_nome": conta_nome, "contato": contato, "id": lid}
        campos = [c for c in COLS if c in novo]
        cur.execute(f"update fin_app.lancamentos set {', '.join(f'{c} = %({c})s' for c in campos)} "
                    "where id = %(id)s", novo)
        n = 1
        if escopo == "seguintes" and atual["grupo_id"]:
            prop = [c for c in PROPAGA] + (["valor"] if atual["recorrencia"] == "mensal" else [])
            cur.execute(f"""update fin_app.lancamentos set {', '.join(f'{c} = %({c})s' for c in prop)}
                            where grupo_id = %(grupo)s and parcela > %(parcela)s
                              and status = 'aberto' and cancelado_em is null""",
                        novo | {"grupo": atual["grupo_id"], "parcela": atual["parcela"]})
            n += cur.rowcount
    return {"atualizados": n}


@router.post("/lancamento/{lid}/pagar")
def pagar(lid: uuid.UUID, p: Pagamento):
    with psycopg.connect(**DSN) as conn:
        cur = conn.execute("""update fin_app.lancamentos set status = 'pago', valor_pago = %s, data_pagamento = %s
                              where id = %s and cancelado_em is null""", (p.valor_pago, p.data_pagamento, lid))
        if cur.rowcount != 1:
            raise HTTPException(404, "Lançamento manual não encontrado (lançamentos do Nibo não podem ser baixados aqui)")
    return {"ok": True}


@router.post("/lancamento/{lid}/reabrir")
def reabrir(lid: uuid.UUID):
    with psycopg.connect(**DSN) as conn:
        cur = conn.execute("""update fin_app.lancamentos set status = 'aberto', valor_pago = null, data_pagamento = null
                              where id = %s and cancelado_em is null""", (lid,))
        if cur.rowcount != 1:
            raise HTTPException(404, "Lançamento manual não encontrado")
    return {"ok": True}


@router.post("/lancamento/{lid}/cancelar")
def cancelar(lid: uuid.UUID, escopo: Literal["este", "seguintes"] = "este"):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn, conn.transaction():
        atual = conn.execute("select grupo_id, parcela from fin_app.lancamentos where id = %s and cancelado_em is null",
                             (lid,)).fetchone()
        if not atual:
            raise HTTPException(404, "Lançamento manual não encontrado")
        if escopo == "seguintes" and atual["grupo_id"]:
            cur = conn.execute("""update fin_app.lancamentos set cancelado_em = now()
                                  where grupo_id = %s and cancelado_em is null
                                    and (id = %s or (parcela > %s and status = 'aberto'))""",
                               (atual["grupo_id"], lid, atual["parcela"]))
        else:
            cur = conn.execute("update fin_app.lancamentos set cancelado_em = now() where id = %s", (lid,))
    return {"cancelados": cur.rowcount}


# ------------------------------------------------------------------ projeção
@router.get("/projecao")
def projecao(dias: int = Query(90, ge=7, le=730), nibo: bool = True, manual: bool = True, vencidos: bool = True):
    hoje = dt.date.today()
    fim = hoje + dt.timedelta(days=dias)
    origens = [o for o, on in (("nibo", nibo), ("manual", manual)) if on] or ["nenhuma"]
    contas = q("""select c.id, c.conta, c.banco, c.saldo_nibo, c.ajuste_manual, c.saldo_atual, c.ultima_mov,
                         coalesce(m.entradas, 0) as manual_entradas, coalesce(m.saidas, 0) as manual_saidas
                  from fin_app.v_contas c
                  left join (select conta_id,
                                    sum(valor_em_aberto) filter (where tipo = 'receber') as entradas,
                                    sum(valor_em_aberto) filter (where tipo = 'pagar') as saidas
                             from fin_app.v_titulos
                             where origem = 'manual' and status = 'aberto' and previsto_para <= %s
                               and (%s or previsto_para >= current_date)
                             group by conta_id) m on m.conta_id = c.id
                  order by c.saldo_atual desc""", (fim, vencidos))
    mov = q("""select data, sum(entradas) as entradas, sum(saidas) as saidas
               from fin_app.v_projecao_diaria
               where data <= %s and origem = any(%s) and (%s or not vencido)
               group by data order by data""", (fim, origens, vencidos))
    venc = q("""select origem, sum(entradas) as entradas, sum(saidas) as saidas
                from fin_app.v_projecao_diaria where vencido group by origem""")

    saldo = sum(c["saldo_atual"] for c in contas)
    por_dia = {m["data"]: m for m in mov}
    serie, d = [], hoje
    while d <= fim:
        m = por_dia.get(d.isoformat(), {})
        e, s = m.get("entradas") or 0, m.get("saidas") or 0
        saldo += e - s
        serie.append({"data": d.isoformat(), "entradas": e, "saidas": s, "saldo": round(saldo, 2)})
        d += dt.timedelta(days=1)

    semanas = {}
    for p in serie:
        d = dt.date.fromisoformat(p["data"])
        k = (d - dt.timedelta(days=d.weekday())).isoformat()
        w = semanas.setdefault(k, {"semana": k, "entradas": 0, "saidas": 0})
        w["entradas"] += p["entradas"]
        w["saidas"] += p["saidas"]
        w["saldo_final"] = p["saldo"]
    menor = min(serie, key=lambda p: p["saldo"])
    return {
        "hoje": hoje.isoformat(), "fim": fim.isoformat(),
        "saldo_atual": round(sum(c["saldo_atual"] for c in contas), 2),
        "contas": contas, "serie": serie, "semanas": list(semanas.values()),
        "totais": {"entradas": round(sum(p["entradas"] for p in serie), 2),
                   "saidas": round(sum(p["saidas"] for p in serie), 2),
                   "saldo_final": serie[-1]["saldo"], "menor_saldo": menor},
        "vencidos": venc,
    }
