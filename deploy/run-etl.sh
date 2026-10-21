#!/bin/sh
# Pepper BI: roda uma carga do ETL. Uso: run-etl.sh nibo
# Trava por fonte para nunca sobrepor execuções. Log em /var/log/pepper-bi/etl-<fonte>.log
set -u
export TZ=America/Sao_Paulo
SRC="$1"
LOG="/var/log/pepper-bi/etl-$SRC.log"
cd /opt/pepper-bi || exit 1
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') início $SRC"
flock -n "/run/pepper-bi-etl-$SRC.lock" \
  timeout 900 docker compose --profile etl run --rm --no-deps -T etl "$SRC.py"
RC=$?
echo "=== $(date '+%F %T') fim $SRC (rc=$RC)"
exit $RC
