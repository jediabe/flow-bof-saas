#!/usr/bin/env bash
#
# Prod wrapper for scripts/qa-reset-lock.mjs.
#
# Same one-shot pattern as
# scripts/prod-qa-backfill-content-run.sh — Prisma-only, no
# src/ or ffmpeg needed. Passes all args straight through.
#
# USAGE:
#   ./scripts/prod-qa-reset-lock.sh --asset-id <id> --kind <video|image>
#   ./scripts/prod-qa-reset-lock.sh --asset-id <id> --kind video --commit

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing $ENV_FILE." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ Missing $COMPOSE_FILE." >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

echo "▶ ensuring db is up..."
$COMPOSE up -d db

PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_')"
fi
NETWORK="${PROJECT_NAME}_default"
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  NETWORK="$(docker network ls --format '{{.Name}}' \
    | grep -i flow | grep default | head -n 1 || true)"
fi
if [ -z "${NETWORK:-}" ] || ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "❌ Could not find a Docker Compose network for this project." >&2
  docker network ls >&2
  exit 1
fi
echo "▶ joining network: $NETWORK"

ARGS=""
for a in "$@"; do
  ARGS="$ARGS $(printf '%q' "$a")"
done

echo "▶ running reset via node:20-bookworm-slim..."
docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -v "$PWD":/repo:ro \
  -w /tmp/app \
  node:20-bookworm-slim \
  bash -lc "
    set -euo pipefail
    apt-get update -qq
    apt-get install -y --no-install-recommends openssl ca-certificates >/dev/null
    mkdir -p /tmp/app/prisma /tmp/app/scripts
    cp /repo/package.json /repo/package-lock.json /tmp/app/
    cp -r /repo/prisma/. /tmp/app/prisma/
    cp -r /repo/scripts/. /tmp/app/scripts/
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    npm install --no-audit --no-fund --silent
    npx --yes prisma generate
    node scripts/qa-reset-lock.mjs $ARGS
  "
