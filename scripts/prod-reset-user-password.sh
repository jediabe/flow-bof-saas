#!/usr/bin/env bash
#
# Reset a User's password on a production VPS that has NO host
# Node install (the usual docker-compose-only deploy shape).
# Wraps scripts/reset-user-password.mjs in the same one-shot
# node container pattern used by prod-db-push.sh /
# prod-import-openai-oauth.sh.
#
# Usage:
#
#   # Interactive prompt (recommended — password never in shell history)
#   ./scripts/prod-reset-user-password.sh user@example.com
#
#   # Inline (visible in `ps` briefly — fine on a single-operator VPS)
#   ./scripts/prod-reset-user-password.sh user@example.com 'the-new-password'
#
#   # List every registered email so you can pick the right one
#   ./scripts/prod-reset-user-password.sh --list
#
# The script spins up a node:20-bookworm-slim container, joins the
# compose network so it can reach `db`, npm-installs Prisma +
# bcryptjs, and runs the reset script. The container is discarded
# on exit — no state persists on the host.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Missing $ENV_FILE — copy .env.production.example and fill it in." >&2
  exit 1
fi
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ Missing $COMPOSE_FILE — are you in the repo root?" >&2
  exit 1
fi

# --list shortcut
LIST_MODE=""
if [ "${1:-}" = "--list" ]; then
  LIST_MODE="--list"
  EMAIL=""
  PASSWORD=""
else
  EMAIL="${1:-}"
  PASSWORD="${2:-}"
  if [ -z "$EMAIL" ]; then
    echo "usage: $0 <email> [password]" >&2
    echo "       $0 --list" >&2
    exit 2
  fi
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

# Make sure the DB is up.
echo "▶ ensuring db is up..."
$COMPOSE up -d db

# Discover the compose network name — same lookup as
# prod-db-push.sh / prod-import-openai-oauth.sh.
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

# Build the argv the inner script will use. When PASSWORD is
# empty AND we're not in --list mode, we allocate a TTY so the
# script can prompt interactively.
INNER_ARGS=""
INTERACTIVE=""
if [ -n "$LIST_MODE" ]; then
  INNER_ARGS="--list"
elif [ -n "$PASSWORD" ]; then
  # shell-escape single quotes in the password
  ESC_PASSWORD=$(printf %s "$PASSWORD" | sed "s/'/'\\\\''/g")
  INNER_ARGS="--email '$EMAIL' --password '$ESC_PASSWORD'"
else
  INNER_ARGS="--email '$EMAIL'"
  INTERACTIVE="-it"
fi

echo "▶ running via node:20-bookworm-slim..."
docker run --rm $INTERACTIVE \
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
    # Swap postgres schema so Prisma client generates against the
    # production DB shape.
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    echo '▶ npm install (Prisma client + bcryptjs)...'
    npm install --no-audit --no-fund --silent
    echo '▶ prisma generate...'
    npx --yes prisma generate
    echo '▶ resetting password...'
    node scripts/reset-user-password.mjs $INNER_ARGS
  "
