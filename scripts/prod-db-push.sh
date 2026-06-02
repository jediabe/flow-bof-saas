#!/usr/bin/env bash
#
# Push the Prisma schema to the production Postgres container.
#
# Why this exists:
#
#   - The standalone production app image is intentionally minimal; it
#     strips the Prisma CLI + engines, so `docker compose exec app
#     prisma db push` fails with "Cannot find module '@prisma/engines'".
#   - Running Prisma from a node:20-alpine container hits OpenSSL/libssl
#     detection failures ("Prisma failed to detect the libssl/openssl
#     version") — Alpine's musl-based libssl confuses Prisma's engine.
#
# This script sidesteps both by:
#
#   - Spinning up a one-shot `node:20-bookworm-slim` container (Debian
#     glibc, OpenSSL friendly).
#   - Joining the compose network so it can reach the `db` service by
#     name.
#   - Bind-mounting the repo read-only and copying the bits Prisma
#     needs into /tmp/app inside the container — that way `npm install`
#     and the SQLite→Postgres schema swap never touch the host working
#     tree.
#
# Usage (on the VPS):
#
#   ./scripts/prod-db-push.sh

set -euo pipefail

cd "$(dirname "$0")/.."

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
if [ ! -f "prisma/schema.postgres.prisma" ]; then
  echo "❌ Missing prisma/schema.postgres.prisma — are you on a recent commit?" >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

# Make sure Postgres is up before we try to push. Compose is
# idempotent — this is a no-op when db is already running.
echo "▶ ensuring db is up..."
$COMPOSE up -d db

# Discover the compose network name. Compose builds it as
# "<projectname>_default" where project name defaults to the directory
# name (sanitised). We try a few candidates so the script keeps
# working if the user set COMPOSE_PROJECT_NAME or renamed the folder.
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}"
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_')"
fi

NETWORK="${PROJECT_NAME}_default"
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  # Fallback: any network that contains both "flow" and "default".
  NETWORK="$(docker network ls --format '{{.Name}}' \
    | grep -i flow | grep default | head -n 1 || true)"
fi
if [ -z "${NETWORK:-}" ] || ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "❌ Could not find a Docker Compose network for this project." >&2
  echo "   Existing networks:" >&2
  docker network ls >&2
  exit 1
fi
echo "▶ joining network: $NETWORK"

# The one-shot migrator. Notes on the inner script:
#
#   - We mount the host repo READ-ONLY so a confused npm/prisma install
#     can never write back to it.
#   - The container copies the *files Prisma cares about* into /tmp/app,
#     runs `npm install` there, then swaps schema.postgres.prisma →
#     schema.prisma and runs `prisma db push`. Host tree stays clean.
#   - `set -e` inside the inner script so any step failing fails the
#     whole run.
#   - DATABASE_URL comes from .env.production via --env-file.

echo "▶ running prisma db push via node:20-bookworm-slim..."
docker run --rm \
  --network "$NETWORK" \
  --env-file "$ENV_FILE" \
  -v "$PWD":/repo:ro \
  -w /tmp/app \
  node:20-bookworm-slim \
  bash -lc '
    set -euo pipefail
    echo "▶ installing OS deps (openssl)..."
    apt-get update -qq
    apt-get install -y --no-install-recommends openssl ca-certificates >/dev/null
    echo "▶ staging repo into /tmp/app..."
    mkdir -p /tmp/app/prisma
    cp /repo/package.json /repo/package-lock.json /tmp/app/
    cp -r /repo/prisma/. /tmp/app/prisma/
    cp /repo/prisma/schema.postgres.prisma /tmp/app/prisma/schema.prisma
    echo "▶ npm install (production-target Prisma client + CLI)..."
    npm install --no-audit --no-fund --silent
    echo "▶ prisma generate..."
    npx --yes prisma generate
    echo "▶ prisma db push..."
    npx --yes prisma db push --accept-data-loss
  '

echo
echo "✅ Schema pushed to Postgres."
