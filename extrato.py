"""Resumo de caixa (saldo por conta + fluxo realizado/projetado + próximos títulos),
extrato por conta e transferências entre contas. Tudo sai de fin_app.v_extrato / v_contas."""
import calendar
import datetime as dt
import uuid
from decimal import Decimal

import psycopg
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from fin import DSN, q

router = APIRouter(prefix="/api/fin")
MES = Query(None, pattern=r"^\d{4}-\d{2}$")


def _mes(m: str | None) -> dt.date:
    if not m:
        return dt.date.today().replace(day=1)
    a, mm = map(int, m.split("-"))
    return dt.date(a, mm, 1)


def _soma_meses(d: dt.date, n: int) -> dt.date:
    m = d.month - 1 + n
    return dt.date(d.year + m // 12, m % 12 + 1, 1)


def _fim_mes(d: dt.date) -> dt.date:
    return d.replace(day=calendar.monthrange(d.year, d.month)[1])


@router.get("/resumo-caixa")
def resumo_caixa(m: str | None = MES):
    centro = _mes(m)
    ini, fim = _soma_meses(centro, -1), _fim_mes(_soma_meses(centro, 1))
    hoje = dt.date.today()
    p = {"ini": ini, "fim": fim, "hoje": hoje}
    contas = q("""select v.id, v.conta, v.banco, v.saldo_atual, v.ordem,
                         c.saldo_inicial + coalesce((select sum(valor) from fin_app.v_extrato x
                                                     where x.conta_id = v.id and x.data < %(ini)s), 0) as saldo_ini
                  from fin_app.v_contas v join fin_app.contas_bancarias c on c.id = v.id
                  order by v.ordem, v.conta""", p)
    realizado = q("""select conta_id, data, sum(valor) as valor from fin_app.v_extrato
                     where data between %(ini)s and least(%(fim)s, %(hoje)s) group by 1, 2 order by 2""", p)
    projetado = q("""select data, sum(entradas) as entradas, sum(saidas) as saidas from fin_app.v_projecao_diaria
                     where data > %(hoje)s and data <= %(fim)s and not vencido group by 1 order by 1""", p)

    def lista(tipo):
        tot = q("""select coalesce(sum(valor_em_aberto), 0) as em_aberto,
                          coalesce(sum(valor_em_aberto) filter (where vencimento < current_date), 0) as vencido
                   from fin_app.v_titulos where tipo = %s and status = 'aberto'""", (tipo,))[0]
        base = """select origem, id, vencimento, contato, descricao, categoria_nome, valor_em_aberto,
                         vencimento < current_date as vencido
                  from fin_app.v_titulos where tipo = %s and status = 'aberto' and valor_em_aberto > 0"""
        return {**tot,
                # Próximos: vence hoje em diante. Em aberto: tudo que não foi pago. Vencido: antes de hoje.
                "proximos": q(base + " and vencimento >= current_date order by vencimento, contato limit 50", (tipo,)),
                "aberto": q(base + " order by vencimento, contato limit 50", (tipo,)),
                "vencidos": q(base + " and vencimento < current_date order by vencimento desc, contato limit 50", (tipo,))}

    return {"ini": ini.isoformat(), "fim": fim.isoformat(), "hoje": hoje.isoformat(), "centro": centro.isoformat()[:7],
            "contas": contas, "realizado": realizado, "projetado": projetado,
            "receber": lista("receber"), "pagar": lista("pagar")}


@router.get("/contas/{cid}/extrato")
def extrato(cid: uuid.UUID, mes: str | None = MES):
    ini = _mes(mes)
    fim = _fim_mes(ini)
    hoje = dt.date.today()
    p = {"id": cid, "ini": ini, "fim": fim, "hoje": hoje}
    conta = q("""select v.*, c.data_saldo_inicial from fin_app.v_contas v
                 join fin_app.contas_bancarias c on c.id = v.id where v.id = %(id)s""", p)
    if not conta:
        raise HTTPException(404, "Conta não encontrada ou arquivada")
    saldo_anterior = q("""select c.saldo_inicial + coalesce((select sum(valor) from fin_app.v_extrato
                                 where conta_id = %(id)s and data < %(ini)s), 0) as s
                          from fin_app.contas_bancarias c where c.id = %(id)s""", p)[0]["s"]
    movimentos = q("""select origem, id, data, nome, descricao, categoria, valor, transferencia, lancamento_id, transferencia_id
                      from fin_app.v_extrato where conta_id = %(id)s and data between %(ini)s and %(fim)s
                      order by data, valor desc, id""", p)
    previstos = q("""select previsto_para as data,
                            sum(valor_em_aberto) filter (where tipo = 'receber') as entradas,
                            sum(valor_em_aberto) filter (where tipo = 'pagar') as saidas
                     from fin_app.v_titulos
                     where conta_id = %(id)s and status = 'aberto' and previsto_para > %(hoje)s
                       and previsto_para between %(ini)s and %(fim)s
                     group by 1 order by 1""", p)
    return {"conta": conta[0], "mes": ini.isoformat()[:7], "ini": ini.isoformat(), "fim": fim.isoformat(),
            "hoje": hoje.isoformat(), "saldo_anterior": saldo_anterior, "movimentos": movimentos,
            "previstos": previstos,
            "contas": q("select id, conta, banco, saldo_atual from fin_app.v_contas order by ordem, conta")}


class Transferencia(BaseModel):
    data: dt.date
    conta_origem_id: uuid.UUID
    conta_destino_id: uuid.UUID
    valor: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    descricao: str | None = Field(None, max_length=200)


@router.post("/transferencias")
def transferir(t: Transferencia):
    if t.conta_origem_id == t.conta_destino_id:
        raise HTTPException(422, "Escolha uma conta de destino diferente da origem")
    with psycopg.connect(**DSN) as conn:
        ativas = conn.execute("select count(*) from fin_app.contas_bancarias where ativo and id = any(%s)",
                              ([t.conta_origem_id, t.conta_destino_id],)).fetchone()[0]
        if ativas != 2:
            raise HTTPException(422, "Conta de origem ou destino não encontrada")
        tid = conn.execute("""insert into fin_app.transferencias (data, conta_origem_id, conta_destino_id, valor, descricao)
                              values (%s, %s, %s, %s, %s) returning id""",
                           (t.data, t.conta_origem_id, t.conta_destino_id, t.valor,
                            (t.descricao or "").strip() or None)).fetchone()[0]
    return {"id": str(tid)}


@router.post("/transferencias/{tid}/cancelar")
def cancelar_transferencia(tid: uuid.UUID):
    with psycopg.connect(**DSN) as conn:
        cur = conn.execute("update fin_app.transferencias set cancelado_em = now() where id = %s and cancelado_em is null",
                           (tid,))
        if cur.rowcount != 1:
            raise HTTPException(404, "Transferência não encontrada")
    return {"ok": True}
