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

COMPOSE="docker compose -f docker-compose.prod.yml"
TS=$(date -u +%Y%m%d-%H%M%S)
OUT=backups
mkdir -p "$OUT"

if [ ! -f .env.production ]; then
  echo "❌ .env.production is missing." >&2
  exit 1
fi

# Pull Postgres creds out of .env.production so we don't have to
# hard-code them here. `set -a` exports everything sourced.
set -a
# shellcheck disable=SC1091
. ./.env.production
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
