"""Cockpit do restaurante: leitura das views bi.* (bi_reader) + módulo financeiro (fin.py, fin_app_rw)."""
import datetime as dt
import decimal
import os
import re
import time

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, Query, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import auth
import boleto
import cadastros
import caixa
import caixa_fluxo
import conferencia_nf
import producao
import extrato
import afazeres
import cardapio
import checklists
import compras
import empresa
import estoque
import fichas
import inbox
import portal
import rh
import fin

DSN = dict(host=os.environ.get("PGHOST", "postgres"), port=5432, dbname="pepper_bi",
           user="bi_reader", password=os.environ["BI_READER_PASSWORD"],
           options="-c default_transaction_read_only=on -c statement_timeout=15000")
HERE = os.path.dirname(__file__)

app = FastAPI(title="Cockpit", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")
app.include_router(auth.router)
app.include_router(fin.router)
app.include_router(boleto.router)
app.include_router(caixa.router)
app.include_router(caixa_fluxo.router)
app.include_router(cadastros.router)
app.include_router(extrato.router)
app.include_router(fichas.router)
app.include_router(cardapio.router)
app.include_router(afazeres.router)
app.include_router(checklists.router)
app.include_router(compras.router)
app.include_router(empresa.router)
app.include_router(estoque.portal)
app.include_router(estoque.admin)
app.include_router(conferencia_nf.router)   # antes do inbox: /api/inbox/{did} engoliria a rota
app.include_router(inbox.router)
app.include_router(rh.router)
app.include_router(portal.router)
app.include_router(producao.router)


@app.middleware("http")
async def sem_cache_antigo(request: Request, call_next):
    # Página e arquivos da tela: o navegador sempre confere se há versão nova (responde 304 se não mudou).
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.middleware("http")
async def exige_login(request: Request, call_next):
    # Toda rota /api exige sessão válida; cada perfil só alcança o que pode (auth.permitido).
    caminho = request.url.path
    if caminho.startswith("/api/") and not caminho.startswith(auth.ROTAS_PUBLICAS):
        usuario = await run_in_threadpool(auth.usuario_por_token, request.cookies.get(auth.COOKIE))
        if not usuario:
            return JSONResponse({"erro": "Faça login para continuar"}, status_code=401)
        if not auth.permitido(usuario["perfil"], request.method, caminho):
            return JSONResponse({"erro": "Seu perfil não tem acesso a esta área"}, status_code=403)
        request.state.usuario = usuario
    return await call_next(request)


# Registrado por último = roda primeiro: o cabeçalho é conferido antes do login.
@app.middleware("http")
async def exige_cabecalho_em_escrita(request: Request, call_next):
    # Cabeçalho próprio força preflight CORS: outro site aberto no navegador não consegue gravar.
    if request.method not in ("GET", "HEAD") and request.headers.get("x-cockpit") != "1":
        return JSONResponse({"erro": "Requisição recusada"}, status_code=403)
    return await call_next(request)


def _conv(v):
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def q(sql, params=None):
    with psycopg.connect(**DSN, row_factory=dict_row) as conn:
        rows = conn.execute(sql, params or {}).fetchall()
    return [{k: _conv(v) for k, v in r.items()} for r in rows]


def q1(sql, params=None):
    rows = q(sql, params)
    return rows[0] if rows else {}


def periodo(ini, fim):
    hoje = dt.date.today()
    fim = fim or hoje
    ini = ini or fim - dt.timedelta(days=29)
    return {"ini": ini, "fim": fim}


# Cada deploy ganha uma versão nova no endereço dos arquivos (app.js?v=…): o navegador sempre baixa o atual.
VERSAO = str(int(time.time()))


@app.get("/")
def index():
    with open(os.path.join(HERE, "static", "index.html"), encoding="utf-8") as f:
        html = re.sub(r'(/static/[\w.-]+\.(?:js|css))"', rf'\1?v={VERSAO}"', f.read())
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/api/resumo")
def resumo():
    ult = q1("select * from bi.faturamento_dia order by data desc limit 1")
    ref = dt.date.fromisoformat(ult["data"])
    p = {"ref": ref}
    return {
        "ultimo": ult,
        "semana_passada": q1("select data, total from bi.faturamento_dia where data = %(ref)s - 7", p),
        "media_dow": q1("select media_total from bi.media_dia_semana where dia_semana_num = %(n)s",
                        {"n": ult["dia_semana_num"]}),
        "mes": q1("""
            select
              (select coalesce(sum(total),0) from bi.faturamento_dia
                where data between date_trunc('month', %(ref)s::date) and %(ref)s) as atual,
              (select coalesce(sum(total),0) from bi.faturamento_dia
                where data between date_trunc('month', %(ref)s::date) - interval '1 month'
                               and %(ref)s::date - interval '1 month') as anterior,
              (select coalesce(sum(salao),0) from bi.faturamento_dia
                where data between date_trunc('month', %(ref)s::date) and %(ref)s) as salao,
              (select coalesce(sum(delivery),0) from bi.faturamento_dia
                where data between date_trunc('month', %(ref)s::date) and %(ref)s) as delivery""", p),
        "serie": q("""select data, dia_semana, salao, delivery, total from bi.faturamento_dia
                      where data > %(ref)s::date - 14 order by data""", p),
        "caixa": q1("""select sum(entradas) as entradas, sum(saidas) as saidas, sum(saldo_do_dia) as saldo
                       from bi.nibo_fluxo_diario where data > current_date - 30"""),
        "pagamentos": q("""select forma_pagamento as forma, sum(valor) as valor
                           from bi.vendas_forma_pagamento
                           where data between date_trunc('month', %(ref)s::date) and %(ref)s
                           group by 1 order by 2 desc limit 5""", p),
        "etl": q("select fonte, fim, status, erro from bi.etl_status order by fonte"),
    }


@app.get("/api/faturamento")
def faturamento(ini: dt.date | None = Query(None), fim: dt.date | None = Query(None)):
    p = periodo(ini, fim)
    return {
        "periodo": {k: v.isoformat() for k, v in p.items()},
        "dias": q("""select data, dia_semana, salao, delivery, total, pct_salao, pct_delivery
                     from bi.faturamento_dia where data between %(ini)s and %(fim)s order by data""", p),
        "totais": q1("""select coalesce(sum(salao),0) as salao, coalesce(sum(delivery),0) as delivery,
                               coalesce(sum(total),0) as total, round(avg(total),2) as media,
                               count(*) as dias, max(total) as melhor
                        from bi.faturamento_dia where data between %(ini)s and %(fim)s""", p),
    }


@app.get("/api/dias-semana")
def dias_semana():
    return q("select * from bi.media_dia_semana order by dia_semana_num")


@app.get("/api/pagamentos")
def pagamentos(ini: dt.date | None = Query(None), fim: dt.date | None = Query(None)):
    p = periodo(ini, fim)
    return {
        "periodo": {k: v.isoformat() for k, v in p.items()},
        "formas": q("""select forma_pagamento as forma,
                         coalesce(sum(valor) filter (where canal = 'Salão'),0) as salao,
                         coalesce(sum(valor) filter (where canal = 'Delivery'),0) as delivery,
                         sum(valor) as total
                       from bi.vendas_forma_pagamento where data between %(ini)s and %(fim)s
                       group by 1 order by total desc""", p),
    }


@app.get("/api/fluxo")
def fluxo(ini: dt.date | None = Query(None), fim: dt.date | None = Query(None)):
    p = periodo(ini, fim)
    return {
        "periodo": {k: v.isoformat() for k, v in p.items()},
        "dias": q("""select data, entradas, saidas, saldo_do_dia,
                       sum(saldo_do_dia) over (order by data) as acumulado
                     from bi.nibo_fluxo_diario where data between %(ini)s and %(fim)s order by data""", p),
        "totais": q1("""select coalesce(sum(entradas),0) as entradas, coalesce(sum(saidas),0) as saidas,
                               coalesce(sum(saldo_do_dia),0) as saldo
                        from bi.nibo_fluxo_diario where data between %(ini)s and %(fim)s""", p),
    }


@app.get("/api/health")
def health():
    q1("select 1 as ok")
    return {"status": "ok"}


@app.exception_handler(psycopg.errors.UniqueViolation)
def db_duplicado(_, exc):
    return JSONResponse({"erro": "Já existe um cadastro com esse nome"}, status_code=409)


@app.exception_handler(psycopg.errors.IntegrityError)
def db_regra(_, exc):
    return JSONResponse({"erro": "Dados inválidos para o lançamento", "detalhe": type(exc).__name__}, status_code=422)


@app.exception_handler(psycopg.Error)
def db_error(_, exc):
    return JSONResponse({"erro": "Falha ao consultar o banco", "detalhe": type(exc).__name__}, status_code=503)
