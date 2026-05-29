#!/usr/bin/env bash
# Project Brain — restore Postgres from a pg_dump.gz backup.
#
# Usage:
#   scripts/restore.sh ./backups/postgres/projectbrain-20260429-030000.sql.gz
#
# What it does:
#   1. Confirms the backup file exists and looks like a gzipped SQL dump.
#   2. Stops web + worker (postgres + redis stay up so we can restore in place).
#   3. Drops and recreates the projectbrain database.
#   4. Pipes the gunzipped SQL into psql.
#   5. Re-runs migrations (defensive — backup may pre-date current schema).
#   6. Restarts web + worker, polls /api/health.
#
# This is destructive — the existing database is wiped. Confirms before
# proceeding unless RESTORE_ASSUME_YES=true is set.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <backup-file.sql.gz>" >&2
  exit 2
fi

BACKUP_FILE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

[ -f "$BACKUP_FILE" ] || { echo "error: $BACKUP_FILE not found" >&2; exit 1; }
[ -f .env ] || { echo "error: .env missing" >&2; exit 1; }

# Sanity check: gzipped SQL dumps start with the gzip magic.
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  echo "error: $BACKUP_FILE is not a valid gzip file" >&2
  exit 1
fi

# Detect prod overlay so we hit the right service set.
COMPOSE_ARGS=(-f docker-compose.yml)
if [ -f docker-compose.prod.yml ]; then
  COMPOSE_ARGS+=(-f docker-compose.prod.yml)
fi

if [ "${RESTORE_ASSUME_YES:-false}" != "true" ]; then
  echo "About to RESTORE $BACKUP_FILE into the running database."
  echo "The existing 'projectbrain' database will be dropped first."
  read -r -p "Type 'restore' to continue: " confirm
  [ "$confirm" = "restore" ] || { echo "aborted."; exit 1; }
fi

echo "==> [1/5] Stopping web + worker"
docker compose "${COMPOSE_ARGS[@]}" stop web worker graphify-sidecar

echo "==> [2/5] Dropping and recreating projectbrain database"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres psql -U brain -d postgres -c "DROP DATABASE IF EXISTS projectbrain;"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres psql -U brain -d postgres -c "CREATE DATABASE projectbrain OWNER brain;"

echo "==> [3/5] Restoring from $BACKUP_FILE"
gunzip -c "$BACKUP_FILE" | docker compose "${COMPOSE_ARGS[@]}" exec -T postgres psql -U brain -d projectbrain >/dev/null

echo "==> [4/5] Running migrations (in case backup pre-dates current schema)"
docker compose "${COMPOSE_ARGS[@]}" run --rm migrate

echo "==> [5/5] Starting web + worker + sidecar"
docker compose "${COMPOSE_ARGS[@]}" up -d web worker graphify-sidecar graphify-egress-proxy

echo "==> Waiting for readiness (120s budget)"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(docker compose "${COMPOSE_ARGS[@]}" exec -T web wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if echo "$body" | grep -q '"readiness":true'; then
    echo "==> Restore complete. App is up."
    exit 0
  fi
  sleep 3
done

echo "error: readiness not reached. Check: docker compose ${COMPOSE_ARGS[*]} logs --tail=200" >&2
exit 1
