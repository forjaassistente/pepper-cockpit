"""Pepper BI · carga completa das planilhas Google -> pepper_bi (schema raw).

Fechamento de Caixa  : fonte oficial de faturamento, canal e forma de pagamento.
Fechamento das entregas: controle interno (comandas), carregado a partir de 19/08/2026.

A data vem do NOME da aba (a data escrita dentro das abas não é confiável).
"12+1" no nome = dia 13. Abas "Semana ..." e "MODELO" são ignoradas.
"""
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

import google.auth.transport.requests
import psycopg
from google.oauth2 import service_account

CAIXA = "1BgqSbnpJ3vqIO8lTpMf3FM0MyJ5lzLkHogg8781AdRU"
ENTREGAS = "1tyz1C3FSBeR90EkCxyttAlR25X9DMFO59G7Rk4sWjIg"
ANO = 2026
ENTREGAS_DESDE = dt.date(2026, 8, 19)   # antes disso só há aba de teste
RUNS_DDL = """CREATE TABLE IF NOT EXISTS raw.etl_runs (
    id bigserial PRIMARY KEY, source text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', row_counts jsonb, error text)"""

creds = service_account.Credentials.from_service_account_file(
    "/secrets/google-sa.json", scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
SESSION = google.auth.transport.requests.AuthorizedSession(creds)


def api(sid, suffix="", params=None):
    r = SESSION.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}{suffix}",
                    params=params, timeout=120)
    r.raise_for_status()
    return r.json()


def tab_date(tab):
    m = re.fullmatch(r"\s*(\d{1,2})(\+1)?\s*[-/]\s*(\d{1,2})\s*", tab)
    if not m:
        return None
    return dt.date(ANO, int(m[3]), int(m[1]) + (1 if m[2] else 0))


def daily_tabs(sid):
    meta = api(sid, params={"fields": "sheets.properties.title"})
    out = {}
    for s in meta["sheets"]:
        t = s["properties"]["title"]
        d = tab_date(t)
        if d is None:
            continue
        if d in out:
            raise RuntimeError(f"duas abas para o mesmo dia {d}: {out[d]!r} e {t!r}")
        out[d] = t
    return out


def read_tabs(sid, tabs, rng):
    """tabs: {date: title} -> {date: linhas}"""
    items = list(tabs.items())
    out = {}
    for i in range(0, len(items), 60):
        chunk = items[i:i + 60]
        d = api(sid, "/values:batchGet", params={
            "ranges": [f"'{t}'!{rng}" for _, t in chunk],
            "valueRenderOption": "UNFORMATTED_VALUE",
        })
        for (day, _), vr in zip(chunk, d["valueRanges"]):
            out[day] = vr.get("values", [])
    return out


def num(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    s = str(v).replace("R$", "").replace("\xa0", "").replace(" ", "")
    if not s:
        return None
    neg = s.startswith("-")
    s = s.lstrip("-")
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        x = float(s)
    except ValueError:
        return None
    return round(-x if neg else x, 2)


def cell(rows, r, c):
    return rows[r][c] if r < len(rows) and c < len(rows[r]) else ""


def txt(v):
    return str(v).strip() if v not in (None, "") else None


FORMAS = {  # rótulo na planilha -> forma de pagamento
    "DINHEIRO TOTAL": "Dinheiro",
    "CARTÃO DÉBITO": "Débito",
    "CARTÃO CRÉDITO": "Crédito",
    "PIX MÁQUINA CARTÃO": "Pix Máquina Cartão",
    "PIX DIRETO": "Pix Direto",
    "AIQFOME": "Aiqfome",
    "ANOTA AÍ": "Anota Aí",
}


def parse_caixa(day, tab, rows):
    """Retorna (dias, recebimentos, conferencia, equipe) ou None se a aba está vazia."""
    dias, receb, conf, equipe = [], [], [], []
    for canal, lc in (("Salão", 0), ("Delivery", 3)):   # rótulo na coluna A/D, valor na B/E
        vc = lc + 1
        rec = {"responsavel": None, "troco": None, "fech": None, "equipe": None,
               "diversos": None, "total": None}
        obs, formas = [], {}
        zona = None
        for r in range(len(rows)):
            label = str(cell(rows, r, lc)).strip().upper()
            val = cell(rows, r, vc)
            if label.startswith("OBSERVAÇÕES"):
                zona = "obs"
                continue
            if label == "NOME":
                zona = "equipe"
                continue
            if zona == "obs":
                obs += [txt(x) for x in (cell(rows, r, lc), val) if txt(x)]
                continue
            if zona == "equipe":
                if txt(cell(rows, r, lc)) or num(val):
                    equipe.append((day, canal, r + 1, txt(cell(rows, r, lc)), num(val)))
                continue
            if label == "RESPONSÁVEL":
                rec["responsavel"] = txt(val)
            elif label == "TROCO INICIAL":
                rec["troco"] = num(val)
            elif label == "FECHAMENTO DINHEIRO":
                rec["fech"] = num(val)
            elif label in ("FREE LANCES (TOTAL)", "MOTOBOYS (TOTAL)"):
                rec["equipe"] = num(val)
            elif label == "DIVERSOS":
                rec["diversos"] = num(val)
            elif label.startswith("FECHAMENTO TOTAL"):
                rec["total"] = num(val)
            elif label in FORMAS:
                formas[FORMAS[label]] = num(val) or 0.0
        soma = round(sum(formas.values()), 2)
        dias.append((day, canal, tab, rec["responsavel"], rec["troco"], rec["fech"],
                     rec["equipe"], rec["diversos"], rec["total"], soma,
                     " | ".join(obs) or None))
        receb += [(day, canal, f, v) for f, v in formas.items()]

    in_conf = False
    for r in range(len(rows)):
        g = str(cell(rows, r, 6)).strip()
        if g.upper() == "CAIXA":
            in_conf = True
            continue
        if in_conf and g.upper().endswith("DEVE TER"):
            conf.append((day, g, num(cell(rows, r, 7)), num(cell(rows, r, 8)), num(cell(rows, r, 9))))

    vazio = all(not (d[8] or d[9]) and not d[10] for d in dias)
    return None if vazio else (dias, receb, conf, equipe)


def parse_entregas(day, tab, rows):
    out = []
    for r in range(5, len(rows)):          # comandas a partir da linha 6
        v = num(cell(rows, r, 1))
        if not v:
            continue
        out.append((day, tab, r + 1, txt(cell(rows, r, 0)), v, num(cell(rows, r, 2)),
                    txt(cell(rows, r, 3)), txt(cell(rows, r, 4)), txt(cell(rows, r, 5)),
                    txt(cell(rows, r, 6))))
    return out


def main():
    cx_tabs = daily_tabs(CAIXA)
    cx_rows = read_tabs(CAIXA, cx_tabs, "A1:J60")
    dias, receb, conf, equipe = [], [], [], []
    for day in sorted(cx_rows):
        p = parse_caixa(day, cx_tabs[day], cx_rows[day])
        if p:
            dias += p[0]; receb += p[1]; conf += p[2]; equipe += p[3]

    en_tabs = {d: t for d, t in daily_tabs(ENTREGAS).items() if d >= ENTREGAS_DESDE}
    en_rows = read_tabs(ENTREGAS, en_tabs, "A1:G505")
    comandas = []
    for day in sorted(en_rows):
        comandas += parse_entregas(day, en_tabs[day], en_rows[day])

    counts = {"caixa_abas": len(cx_tabs), "caixa_dias": len(dias) // 2,
              "caixa_recebimentos": len(receb), "caixa_conferencia": len(conf),
              "caixa_equipe": len(equipe), "entregas_abas": len(en_tabs),
              "entregas_comandas": len(comandas)}
    print("lido:", counts, flush=True)

    divergentes = [(d[0], d[1], d[8], d[9]) for d in dias
                   if d[8] is not None and abs((d[8] or 0) - d[9]) > 0.01]
    if divergentes:
        print(f"  aviso: {len(divergentes)} dia/canal com total da planilha ≠ soma das formas: "
              f"{divergentes[:5]}", flush=True)

    conn = psycopg.connect(
        host=os.environ.get("PGHOST", "postgres"), dbname="pepper_bi",
        user="bi_etl", password=os.environ["BI_ETL_PASSWORD"],
        application_name="pepper-bi-etl-sheets",
    )
    with conn.transaction():
        cur = conn.cursor()
        cur.execute(RUNS_DDL)
        cur.execute("INSERT INTO raw.etl_runs (source) VALUES ('planilhas') RETURNING id")
        run_id = cur.fetchone()[0]
    try:
        with conn.transaction():
            cur = conn.cursor()
            cur.execute(Path("/app/sheets_schema.sql").read_text())
            cur.execute("SELECT count(*) FROM raw.caixa_dia")
            antes = cur.fetchone()[0]
            if len(dias) < 0.9 * antes:
                raise RuntimeError(f"caixa_dia cairia de {antes} para {len(dias)} linhas; abortando sem gravar")
            for t in ("caixa_dia", "caixa_recebimentos", "caixa_conferencia",
                      "caixa_pagamentos_equipe", "entregas_comandas"):
                cur.execute(f"DELETE FROM raw.{t}")
            cur.executemany("INSERT INTO raw.caixa_dia VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", dias)
            cur.executemany("INSERT INTO raw.caixa_recebimentos VALUES (%s,%s,%s,%s)", receb)
            cur.executemany("INSERT INTO raw.caixa_conferencia VALUES (%s,%s,%s,%s,%s)", conf)
            cur.executemany("INSERT INTO raw.caixa_pagamentos_equipe VALUES (%s,%s,%s,%s,%s)", equipe)
            cur.executemany("INSERT INTO raw.entregas_comandas VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", comandas)
            conn.execute(
                "UPDATE raw.etl_runs SET status='ok', finished_at=now(), row_counts=%s WHERE id=%s",
                (json.dumps(counts), run_id))
    except Exception as exc:
        with conn.transaction():
            conn.execute(
                "UPDATE raw.etl_runs SET status='erro', finished_at=now(), error=%s WHERE id=%s",
                (str(exc)[:2000], run_id))
        raise
    conn.close()
    print("ok", counts, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERRO: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
