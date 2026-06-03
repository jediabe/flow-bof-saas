#!/usr/bin/env bash
#
# Pull, rebuild, restart, and push the Prisma schema. Run this on the
# VPS whenever you've shipped new code to the deploy branch.
#
#   ./scripts/deploy-prod.sh
#
# Idempotent — safe to re-run if it bails mid-way through.
#
# Why every compose invocation passes --env-file:
#
#   docker-compose.prod.yml uses ${POSTGRES_USER}, ${APP_DOMAIN}, etc.
#   for interpolation. Compose only reads .env (implicit) or whatever
#   you point at with --env-file. We use the explicit form so this
#   script works regardless of whether the user also copied
#   .env.production to .env.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.production"
COMPOSE_FILE="docker-compose.prod.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ $ENV_FILE is missing. Copy .env.production.example and fill it in." >&2
  exit 1
fi

COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

echo "▶ git pull"
git pull --ff-only

# Make sure the host uploads tree exists and is owned by the
# container's nextjs user BEFORE the bind mount goes live. Without
# this, the first Kalodata import hits EACCES on
# /app/public/uploads/workspaces because the host path is root-owned.
echo "▶ fix-upload-perms (host-side)"
./scripts/fix-upload-perms.sh

echo "▶ docker compose up -d --build (this can take a few minutes)"
$COMPOSE up -d --build

# Re-run after `up -d` in case docker recreated the host dir with
# different ownership during volume init. Idempotent.
./scripts/fix-upload-perms.sh

echo "▶ pushing Prisma schema to Postgres..."
# Don't try `compose exec app prisma db push` — the standalone
# production image strips Prisma's CLI + engines. The dedicated
# helper spins up a node:20-bookworm-slim container that joins the
# compose network just long enough to run `prisma db push`.
./scripts/prod-db-push.sh

echo "▶ container status:"
$COMPOSE ps

APP_DOMAIN=$(grep -E '^APP_DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
echo
echo "✅ Deploy complete."
echo "   Visit:  https://${APP_DOMAIN}"
echo "   Health: https://${APP_DOMAIN}/api/health"
