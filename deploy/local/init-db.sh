#!/bin/bash
# Cria o banco do Cockpit do zero (só roda no primeiro "up", com o volume pgdata vazio).
# Mesma estrutura da produção:
#   bi_etl      = dono de raw/bi, escrito só pelo ETL
#   bi_reader   = leitura das views bi.* (app e Metabase)
#   fin_app_*   = criados pela sql/001; o app grava só em fin_app
#   metabase_app = banco interno do Metabase
set -euo pipefail

SQL_DIR="${SQL_DIR:-/migrations/sql}"
ETL_DIR="${ETL_DIR:-/migrations/etl}"
PSQL=(psql -v ON_ERROR_STOP=1 -X -q --username "${POSTGRES_USER:-postgres}")

echo ">> papéis e bancos"
"${PSQL[@]}" --dbname postgres \
  -v bi_etl_pw="$BI_ETL_PASSWORD" -v bi_reader_pw="$BI_READER_PASSWORD" \
  -v metabase_pw="$METABASE_APP_PASSWORD" <<'SQL'
CREATE ROLE bi_etl       LOGIN PASSWORD :'bi_etl_pw';
CREATE ROLE bi_reader    LOGIN PASSWORD :'bi_reader_pw';
CREATE ROLE metabase_app LOGIN PASSWORD :'metabase_pw';
CREATE DATABASE pepper_bi;
CREATE DATABASE metabase_app OWNER metabase_app;
SQL

echo ">> schemas raw/bi"
"${PSQL[@]}" --dbname pepper_bi <<'SQL'
REVOKE ALL ON DATABASE pepper_bi FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE pepper_bi TO bi_etl, bi_reader;
CREATE SCHEMA raw AUTHORIZATION bi_etl;
CREATE SCHEMA bi  AUTHORIZATION bi_etl;
GRANT USAGE ON SCHEMA bi TO bi_reader;
-- o ETL derruba e recria as views bi.* a cada carga: a leitura vem por padrão
ALTER DEFAULT PRIVILEGES FOR ROLE bi_etl IN SCHEMA bi GRANT SELECT ON TABLES TO bi_reader;
SQL

echo ">> tabelas do ETL (Nibo e planilhas), como bi_etl"
for f in nibo_schema.sql sheets_schema.sql; do
  echo "   $f"
  "${PSQL[@]}" --dbname pepper_bi -c "SET ROLE bi_etl" -f "$ETL_DIR/$f"
done

echo ">> migrações do app (sql/)"
for f in "$SQL_DIR"/[0-9][0-9][0-9]_*.sql; do
  echo "   $(basename "$f")"
  # As que trocam de papel sozinhas (001–024) rodam como superusuário: dão GRANT em raw.*
  # e criam os papéis fin_app_*. As demais (025+) são só ALTERs: rodam como fin_app_owner.
  if grep -qi '^SET ROLE fin_app_owner' "$f"; then
    "${PSQL[@]}" --dbname pepper_bi -f "$f"
  else
    "${PSQL[@]}" --dbname pepper_bi -c "SET ROLE fin_app_owner" -f "$f"
  fi
done

"${PSQL[@]}" --dbname pepper_bi -v fin_pw="$FIN_APP_PASSWORD" <<'SQL'
ALTER ROLE fin_app_rw PASSWORD :'fin_pw';
SQL

echo ">> banco pronto"
