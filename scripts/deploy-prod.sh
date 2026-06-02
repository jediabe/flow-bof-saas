#!/usr/bin/env bash
#
# Pull, rebuild, restart, and re-push Prisma schema. Run this on the
# VPS whenever you've shipped new code to the deploy branch.
#
#   ./scripts/deploy-prod.sh
#
# Idempotent — safe to re-run if it bails mid-way through.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"

if [ ! -f .env.production ]; then
  echo "❌ .env.production is missing. Copy .env.production.example and fill it in." >&2
  exit 1
fi

echo "▶ git pull"
git pull --ff-only

echo "▶ docker compose up -d --build (this can take a few minutes)"
$COMPOSE up -d --build

echo "▶ waiting for the app container to come up..."
# Compose's healthcheck on `db` blocks `app` until Postgres is ready;
# we just have to wait for `app` itself to reach a steady state.
for i in $(seq 1 30); do
  if $COMPOSE ps app | grep -qE 'running|healthy'; then
    break
  fi
  sleep 2
done

echo "▶ prisma db push"
$COMPOSE exec -T app node_modules/.bin/prisma db push

APP_DOMAIN=$(grep -E '^APP_DOMAIN=' .env.production | head -1 | cut -d= -f2-)
echo
echo "✅ Deploy complete. Visit: https://${APP_DOMAIN}"
echo "   Health: https://${APP_DOMAIN}/api/health"
