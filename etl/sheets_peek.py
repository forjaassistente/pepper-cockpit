"""Mostra as células não vazias de abas escolhidas (somente leitura). Uso: sheets_peek.py <id> <aba> [<aba>...]"""
import sys
from urllib.parse import quote
import google.auth.transport.requests
from google.oauth2 import service_account

creds = service_account.Credentials.from_service_account_file(
    "/secrets/google-sa.json", scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
s = google.auth.transport.requests.AuthorizedSession(creds)
sid, tabs = sys.argv[1], sys.argv[2:]

def col(i):
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out

for tab in tabs:
    r = s.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{quote(chr(39)+tab+chr(39), safe='')}",
              params={"valueRenderOption": "FORMATTED_VALUE"})
    r.raise_for_status()
    f = s.get(f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{quote(chr(39)+tab+chr(39), safe='')}",
              params={"valueRenderOption": "FORMULA"}).json().get("values", [])
    print(f"\n######## aba [{tab}]")
    for ri, row in enumerate(r.json().get("values", [])):
        cells = []
        for ci, v in enumerate(row):
            if v == "":
                continue
            fv = f[ri][ci] if ri < len(f) and ci < len(f[ri]) else ""
            extra = f"  ={fv[1:60]}" if isinstance(fv, str) and fv.startswith("=") else ""
            cells.append(f"{col(ci)}{ri+1}:{v!r}{extra}")
        if cells:
            print("  " + " | ".join(cells))
