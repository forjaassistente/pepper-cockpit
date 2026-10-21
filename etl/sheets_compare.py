"""Compara, dia a dia, o delivery do Caixa com a soma das comandas das Entregas (somente leitura)."""
import re
from urllib.parse import quote
import google.auth.transport.requests
from google.oauth2 import service_account

CAIXA = "1BgqSbnpJ3vqIO8lTpMf3FM0MyJ5lzLkHogg8781AdRU"
ENTREGAS = "1tyz1C3FSBeR90EkCxyttAlR25X9DMFO59G7Rk4sWjIg"
creds = service_account.Credentials.from_service_account_file(
    "/secrets/google-sa.json", scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
s = google.auth.transport.requests.AuthorizedSession(creds)

def tabs(sid):
    d = s.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}", params={"fields": "sheets.properties.title"}).json()
    return [x["properties"]["title"] for x in d["sheets"]]

def batch(sid, ranges):
    out = {}
    for i in range(0, len(ranges), 80):
        r = s.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values:batchGet",
                  params={"ranges": ranges[i:i+80], "valueRenderOption": "UNFORMATTED_VALUE"})
        r.raise_for_status()
        for vr in r.json()["valueRanges"]:
            out[vr["range"]] = vr.get("values", [])
    return out

def day(tab):
    m = re.fullmatch(r"\s*(\d{1,2})(\+1)?[-/](\d{1,2})\s*", tab)
    if not m: return None
    dd = int(m[1]) + (1 if m[2] else 0)
    return f"2026-{int(m[3]):02d}-{dd:02d}"

def num(v):
    return v if isinstance(v, (int, float)) else 0

cx = {day(t): t for t in tabs(CAIXA) if day(t)}
en = {day(t): t for t in tabs(ENTREGAS) if day(t)}
cxv = batch(CAIXA, [f"'{t}'!A1:E30" for t in cx.values()])
env = batch(ENTREGAS, [f"'{t}'!A1:L505" for t in en.values()])

def get(rows, r, c):
    return rows[r][c] if r < len(rows) and c < len(rows[r]) else ""

print("dia        | caixa_salao caixa_deliv | entregas_soma linhas sheet_L13 | data_interna_entregas")
for d in sorted(set(cx) | set(en)):
    line = f"{d}"
    if d in cx:
        rows = next(v for k, v in cxv.items() if k.startswith(f"'{cx[d]}'") or k.startswith(cx[d] + "!"))
        line += f" | {num(get(rows,19,1)):>10.2f} {num(get(rows,19,4)):>10.2f} interna={get(rows,2,1)}"
    else:
        line += " |  (sem aba no caixa)        "
    if d in en:
        rows = next(v for k, v in env.items() if k.startswith(f"'{en[d]}'") or k.startswith(en[d] + "!"))
        vals = [num(get(rows, r, 1)) for r in range(5, len(rows))]
        n = sum(1 for v in vals if v)
        line += f" | {sum(vals):>10.2f} {n:>3} {num(get(rows,12,11)):>10.2f} | {get(rows,1,8)}"
    print(line)
