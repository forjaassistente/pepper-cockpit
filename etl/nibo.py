"""Pepper BI · carga completa do Nibo -> pepper_bi (schema raw).

Baixa tudo, confere as contagens com o total informado pela API e só então
substitui o conteúdo das tabelas numa única transação. Se algo falhar, os
dados anteriores ficam intactos.
"""
import json
import os
import sys
import time
from pathlib import Path

import psycopg
import requests

API = "https://api.nibo.com.br/empresas/v1"
RUNS_DDL = """CREATE TABLE IF NOT EXISTS raw.etl_runs (
    id bigserial PRIMARY KEY, source text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
    status text NOT NULL DEFAULT 'running', row_counts jsonb, error text)"""
PAGE = 500
TOKEN = os.environ["NIBO_API_TOKEN"]
SESSION = requests.Session()
SESSION.headers.update({"ApiToken": TOKEN, "Accept": "application/json"})


def get(path, params):
    for attempt in range(6):
        try:
            r = SESSION.get(f"{API}/{path}", params=params, timeout=60)
        except requests.RequestException as exc:
            err = str(exc)
        else:
            if r.status_code == 200:
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504):
                r.raise_for_status()
            err = f"HTTP {r.status_code}"
        wait = 2 ** attempt
        print(f"  {path}: {err}, nova tentativa em {wait}s", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"{path}: falhou após várias tentativas ({err})")


def fetch_all(path, id_field):
    items, skip, total = {}, 0, None
    while True:
        d = get(path, {"$top": PAGE, "$skip": skip, "$orderby": id_field, "$count": "true"})
        total = d.get("count", total)
        page = d.get("items", [])
        for it in page:
            items[it[id_field]] = it
        skip += PAGE
        if len(page) < PAGE:
            break
        time.sleep(0.2)
    if total is not None and len(items) != total:
        raise RuntimeError(f"{path}: baixados {len(items)} únicos, API informa {total}")
    print(f"  {path}: {len(items)}", flush=True)
    return list(items.values())


def d(s):
    # Datas do Nibo vêm como "2026-10-15T00:00:00Z" mas são datas puras: não converter fuso.
    return s[:10] if s else None


def ref(obj, key):
    return (obj or {}).get(key)


def uuid_or_none(s):
    return None if not s or s == "00000000-0000-0000-0000-000000000000" else s


def main():
    data = {
        "accounts": fetch_all("accounts", "id"),
        "categories": fetch_all("categories", "id"),
        "stakeholders": fetch_all("stakeholders", "id"),
        "receipts": fetch_all("receipts", "entryId"),
        "payments": fetch_all("payments", "entryId"),
        "credit": fetch_all("schedules/credit", "scheduleId"),
        "debit": fetch_all("schedules/debit", "scheduleId"),
    }
    counts = {k: len(v) for k, v in data.items()}
    if counts["receipts"] == 0 or counts["payments"] == 0:
        raise RuntimeError(f"contagem suspeita, abortando sem gravar: {counts}")

    conn = psycopg.connect(
        host=os.environ.get("PGHOST", "postgres"), dbname="pepper_bi",
        user="bi_etl", password=os.environ["BI_ETL_PASSWORD"],
        application_name="pepper-bi-etl-nibo",
    )
    with conn.transaction():
        cur = conn.cursor()
        cur.execute(RUNS_DDL)
        cur.execute("INSERT INTO raw.etl_runs (source) VALUES ('nibo') RETURNING id")
        run_id = cur.fetchone()[0]
    try:
        # Estrutura + dados na mesma transação: o Metabase nunca vê um estado intermediário.
        with conn.transaction():
            cur = conn.cursor()
            cur.execute(Path("/app/nibo_schema.sql").read_text())
            load(cur, data)
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


def load(cur, data):
    for t in ("nibo_accounts", "nibo_categories", "nibo_stakeholders",
              "nibo_entries", "nibo_entry_categories", "nibo_schedules"):
        cur.execute(f"DELETE FROM raw.{t}")

    cur.executemany(
        "INSERT INTO raw.nibo_accounts VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
        [(a["id"], a.get("name"), a.get("type"), a.get("bankName"), a.get("openBalance"),
          d(a.get("dateOfOpenBalance")), a.get("isArchived"), json.dumps(a))
         for a in data["accounts"]])

    cur.executemany(
        "INSERT INTO raw.nibo_categories VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        [(c["id"], c.get("name"), c.get("referenceCode"), c.get("type"),
          ref(c.get("group"), "id"), ref(c.get("group"), "name"), ref(c.get("group"), "referenceCode"),
          c.get("subgroupName"), json.dumps(c))
         for c in data["categories"]])

    cur.executemany(
        "INSERT INTO raw.nibo_stakeholders VALUES (%s,%s,%s,%s,%s,%s)",
        [(s["id"], s.get("name"), s.get("type"), s.get("isDeleted"), s.get("isArchived"), json.dumps(s))
         for s in data["stakeholders"]])

    entries, splits = [], []
    for kind, rows in (("receipt", data["receipts"]), ("payment", data["payments"])):
        for e in rows:
            entries.append((
                e["entryId"], kind, d(e.get("date")), d(e.get("accrualDate")), e.get("value"),
                ref(e.get("account"), "id"), ref(e.get("account"), "name"),
                e.get("isTransfer"), e.get("isReconciliated"), e.get("isVirtual"),
                uuid_or_none(e.get("scheduleId")),
                uuid_or_none(ref(e.get("stakeholder"), "id")), ref(e.get("stakeholder"), "name"),
                uuid_or_none(ref(e.get("category"), "id")), ref(e.get("category"), "name"),
                e.get("description"), e.get("identifier"), e.get("reference"), json.dumps(e)))
            for c in e.get("categories") or []:
                if c.get("isDeleted"):
                    continue
                splits.append((e["entryId"], kind, uuid_or_none(c.get("categoryId")),
                               c.get("categoryName"), c.get("parent"), c.get("value")))
    cur.executemany(
        "INSERT INTO raw.nibo_entries VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        entries)
    cur.executemany("INSERT INTO raw.nibo_entry_categories VALUES (%s,%s,%s,%s,%s,%s)", splits)

    cur.executemany(
        "INSERT INTO raw.nibo_schedules VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        [(s["scheduleId"], s.get("type"), d(s.get("dueDate")), d(s.get("accrualDate")),
          d(s.get("scheduleDate")), s.get("value"), s.get("paidValue"), s.get("openValue"),
          s.get("isPaid"), s.get("isDued"), s.get("hasRecurrence"),
          uuid_or_none(ref(s.get("stakeholder"), "id")), ref(s.get("stakeholder"), "name"),
          uuid_or_none(ref(s.get("category"), "id")), ref(s.get("category"), "name"),
          s.get("description"), json.dumps(s))
         for s in data["credit"] + data["debit"]])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERRO: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
