#!/usr/bin/env bash
#
# Prod wrapper for scripts/qa-backfill-content-run.mjs.
#
# Same one-shot pattern as scripts/prod-import-openai-oauth.sh:
# spins up a node:20-bookworm-slim container joined to the
# compose network, bind-mounts the repo, runs npm install +
# prisma generate against the Postgres schema, then invokes the
# backfill .mjs.
#
# The backfill script is Prisma-only (no @/… imports, no MCP,
# no ffmpeg) so we don't need src/ or ffmpeg here — that's what
# makes it lighter than prod-qa-smoke.sh.
#
# USAGE:
#
#   ./scripts/prod-qa-backfill-content-run.sh --product-id <id>
#   ./scripts/prod-qa-backfill-content-run.sh --product-id <id> --commit
#   ./scripts/prod-qa-backfill-content-run.sh --video-id <id>
#   ./scripts/prod-qa-backfill-content-run.sh --help
#
# All args pass through to the .mjs. Default is dry-run; add
# --commit to actually write.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing $ENV_FILE." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ Missing $COMPOSE_FILE — are you in the repo root?" >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

echo "▶ ensuring db is up..."
$COMPOSE up -d db

# Discover the compose network name — same lookup as
# prod-import-openai-oauth.sh + prod-db-push.sh.
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

# All CLI args after this script name are passed straight
# through to the .mjs. shell-quote them safely.
ARGS=""
for a in "$@"; do
  ARGS="$ARGS $(printf '%q' "$a")"
done

echo "▶ running backfill via node:20-bookworm-slim..."
docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -v "$PWD":/repo:ro \
  -w /tmp/app \
  node:20-bookworm-slim \
  bash -lc "
    set -euo pipefail
    echo '▶ installing OS deps (openssl)...'
    apt-get update -qq
    apt-get install -y --no-install-recommends openssl ca-certificates >/dev/null
    echo '▶ staging repo into /tmp/app...'
    mkdir -p /tmp/app/prisma /tmp/app/scripts
    cp /repo/package.json /repo/package-lock.json /tmp/app/
    cp -r /repo/prisma/. /tmp/app/prisma/
    cp -r /repo/scripts/. /tmp/app/scripts/
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    echo '▶ npm install...'
    npm install --no-audit --no-fund --silent
    echo '▶ prisma generate...'
    npx --yes prisma generate
    echo '▶ running backfill...'
    node scripts/qa-backfill-content-run.mjs $ARGS
  "
