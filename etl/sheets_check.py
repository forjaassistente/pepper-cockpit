"""Testa acesso somente-leitura da service account às planilhas."""
import sys
import google.auth.transport.requests
from google.oauth2 import service_account

SHEETS = {
    "Fechamento de Caixa": "1BgqSbnpJ3vqIO8lTpMf3FM0MyJ5lzLkHogg8781AdRU",
    "Fechamento das entregas": "1tyz1C3FSBeR90EkCxyttAlR25X9DMFO59G7Rk4sWjIg",
}
creds = service_account.Credentials.from_service_account_file(
    "/secrets/google-sa.json",
    scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
s = google.auth.transport.requests.AuthorizedSession(creds)
for name, sid in SHEETS.items():
    r = s.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}",
              params={"fields": "properties.title,sheets.properties(title,gridProperties)"})
    if r.status_code == 200:
        d = r.json()
        print(f"OK   {name}: '{d['properties']['title']}'")
        for sh in d["sheets"]:
            g = sh["properties"].get("gridProperties", {})
            print(f"       aba '{sh['properties']['title']}' ({g.get('rowCount')}x{g.get('columnCount')})")
    else:
        e = r.json().get("error", {})
        reason = ",".join(x.get("reason", "") for x in e.get("details", []) if isinstance(x, dict))
        print(f"FALHA {name}: HTTP {r.status_code} {e.get('status')} {reason} | {e.get('message','')[:200]}")
