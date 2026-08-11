#!/usr/bin/env bash
#
# One-shot ingestion of a ChatGPT-subscription OAuth grant on a
# production VPS that has NO host Node install (the usual
# docker-compose-only deploy shape).
#
# Follows the same pattern as scripts/prod-db-push.sh:
#   - Spins up a one-shot node:20-bookworm-slim container.
#   - Joins the compose network so it can reach the `db` service.
#   - Bind-mounts the repo read-only + the auth.json read-only.
#   - Runs scripts/import-openai-oauth.mjs against the postgres
#     schema (swapped into schema.prisma inside /tmp/app).
#
# Usage:
#
#   ./scripts/prod-import-openai-oauth.sh /path/to/auth.json
#   ./scripts/prod-import-openai-oauth.sh /path/to/auth.json user@example.com
#
# Second arg is optional — omit it if there's only one User in
# the DB (the script auto-selects).
#
# Prerequisites:
#   - .env.production contains LLM_CRED_ENC_KEY (same 32-byte
#     base64 key the running app uses).
#   - DATABASE_URL in .env.production points at the postgres
#     the compose stack runs.

set -euo pipefail

cd "$(dirname "$0")/.."

AUTH_FILE="${1:-}"
USER_EMAIL="${2:-}"

if [ -z "$AUTH_FILE" ]; then
  echo "usage: $0 <path-to-auth.json> [user-email]" >&2
  exit 2
fi
if [ ! -f "$AUTH_FILE" ]; then
  echo "❌ auth file not found: $AUTH_FILE" >&2
  exit 1
fi

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing $ENV_FILE. Copy .env.production.example and fill it in." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ Missing $COMPOSE_FILE — are you in the repo root?" >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

# Make sure Postgres is up before we try to write.
echo "▶ ensuring db is up..."
$COMPOSE up -d db

# Discover the compose network name. Same lookup as prod-db-push.sh.
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

# Absolute path to the auth file so the docker bind-mount works
# regardless of pwd. `readlink -f` works on Linux VPS defaults.
AUTH_ABS="$(readlink -f "$AUTH_FILE")"

# Prepare a shell-safe user-email argument. If the operator
# passed nothing, the inner script auto-detects the sole User.
USER_EMAIL_ARG=""
if [ -n "$USER_EMAIL" ]; then
  USER_EMAIL_ARG="--user-email $USER_EMAIL"
fi

echo "▶ running import via node:20-bookworm-slim..."
docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -v "$PWD":/repo:ro \
  -v "$AUTH_ABS":/tmp/auth.json:ro \
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
    # Swap postgres schema into place so Prisma client generates
    # against the production DB shape.
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    echo '▶ npm install (Prisma client + engines)...'
    npm install --no-audit --no-fund --silent
    echo '▶ prisma generate...'
    npx --yes prisma generate
    echo '▶ importing OAuth credential...'
    node scripts/import-openai-oauth.mjs $USER_EMAIL_ARG --file /tmp/auth.json
  "

echo
echo "✅ Import complete. Trigger a chat turn — logs should show:"
echo "   [agent-runner] source=resolver provider=user_oauth/openai_responses ..."
