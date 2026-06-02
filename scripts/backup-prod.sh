#!/usr/bin/env bash
#
# Snapshot the Postgres database + the ./uploads folder. Writes both
# to ./backups/. Off-VPS shipping is your responsibility — wire this
# script into a cron + rclone / s3 sync if durability matters.
#
#   ./scripts/backup-prod.sh
#
# Files produced:
#   backups/postgres-YYYYMMDD-HHMMSS.sql.gz
#   backups/uploads-YYYYMMDD-HHMMSS.tar.gz

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE is missing." >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"
TS=$(date -u +%Y%m%d-%H%M%S)
OUT=backups
mkdir -p "$OUT"

# Pull Postgres creds out of .env.production so we don't have to
# hard-code them here. `set -a` exports everything sourced.
set -a
# shellcheck disable=SC1091
. ./"$ENV_FILE"
set +a

echo "▶ pg_dump → $OUT/postgres-$TS.sql.gz"
$COMPOSE exec -T db \
  pg_dump --clean --if-exists \
          -U "$POSTGRES_USER" \
          -d "$POSTGRES_DB" \
  | gzip > "$OUT/postgres-$TS.sql.gz"

if [ -d uploads ] && [ "$(ls -A uploads 2>/dev/null)" ]; then
  echo "▶ tarball → $OUT/uploads-$TS.tar.gz"
  tar czf "$OUT/uploads-$TS.tar.gz" uploads
else
  echo "▶ uploads/ is empty — skipping upload tarball."
fi

echo
echo "✅ Done. Latest backups:"
ls -lh "$OUT" | tail -n +2 | tail -10
