#!/usr/bin/env bash
#
# Prod wrapper for scripts/qa-smoke.mjs → qa-smoke-runner.mts.
#
# Heavier one-shot than prod-qa-backfill-content-run.sh: the
# smoke test imports @/lib/qa/orchestrator, which pulls in the
# full QA pipeline (MCP client, Anthropic SDK, frame extraction
# with ffmpeg/ffprobe). So this wrapper:
#   - Copies the whole repo (including src/ and tsconfig.json)
#   - Installs ffmpeg via apt (frame extraction needs it)
#   - Runs `npx tsx scripts/qa-smoke-runner.mts` so @/ path
#     alias resolves through tsx + tsconfig
#
# Assumes the workspace whose asset is being QA'd has:
#   - anthropicApiKey set in WorkspaceSettings
#   - flowEmail set (so MCP get_asset resolves the media)
#   - The APEX MCP server (apex-mcp) reachable at the URL the
#     app is configured to use.
#
# USAGE:
#   ./scripts/prod-qa-smoke.sh --asset-id <id> --kind <video|image>
#
# All args pass straight through to qa-smoke-runner.mts.

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

# Compose network — same lookup as the other prod-*.sh scripts.
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

# Pass-through args.
ARGS=""
for a in "$@"; do
  ARGS="$ARGS $(printf '%q' "$a")"
done

echo "▶ running QA smoke via node:20-bookworm-slim..."
docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -v "$PWD":/repo:ro \
  -w /tmp/app \
  node:20-bookworm-slim \
  bash -lc "
    set -euo pipefail
    echo '▶ installing OS deps (openssl, ca-certificates, ffmpeg)...'
    apt-get update -qq
    apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg >/dev/null
    echo '▶ staging repo into /tmp/app (src/ + tsconfig + scripts + prisma)...'
    mkdir -p /tmp/app
    cp /repo/package.json /repo/package-lock.json /tmp/app/
    cp /repo/tsconfig.json /tmp/app/
    cp -r /repo/prisma /tmp/app/
    cp -r /repo/scripts /tmp/app/
    cp -r /repo/src /tmp/app/
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    echo '▶ npm install (full deps — tsx + prisma + anthropic-sdk + …)...'
    npm install --no-audit --no-fund --silent
    echo '▶ prisma generate...'
    npx --yes prisma generate
    echo '▶ running QA smoke runner...'
    npx --yes tsx scripts/qa-smoke-runner.mts $ARGS
  "
