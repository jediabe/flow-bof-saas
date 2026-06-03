#!/usr/bin/env bash
#
# Make the host-side `./uploads` directory tree writable by the
# production app container.
#
# The app container runs as the non-root `nextjs` user (UID/GID 1001;
# see Dockerfile). docker-compose.prod.yml bind-mounts ./uploads to
# /app/public/uploads, and on a fresh VPS clone that host path either
# doesn't exist yet or is owned by root — which produces:
#
#   EACCES: permission denied, mkdir '/app/public/uploads/workspaces'
#
# during the Kalodata import. This script fixes it idempotently.
#
#   ./scripts/fix-upload-perms.sh
#
# Safe to re-run any time. Never chmods world-writable.

set -euo pipefail

cd "$(dirname "$0")/.."

UPLOADS_DIR="uploads"
# UID/GID the container's nextjs user owns. Keep in sync with the
# Dockerfile's `adduser --uid 1001 --ingroup nodejs` line.
APP_UID="1001"
APP_GID="1001"

# Sub-directories the app expects to be able to mkdir into.
SUBDIRS=(
  ""           # the root itself
  "workspaces" # current scheme — public/uploads/workspaces/<wsId>/batches/<id>/
  "batches"    # legacy scheme retained for back-compat (alpha-1 imports)
  "imports"    # temp Kalodata staging when/if we ever persist .xlsx server-side
  "_tmp"       # generic scratch — cleanup-uploads.mjs sweeps this every hour
)

echo "▶ ensuring host uploads tree exists under $PWD/$UPLOADS_DIR"
for sub in "${SUBDIRS[@]}"; do
  dir="$UPLOADS_DIR${sub:+/$sub}"
  mkdir -p "$dir"
done

# `chown -R` is the simplest fix. If running on macOS where IDs map
# differently (Docker Desktop munges UIDs), the command still
# succeeds — the bind mount just inherits the host's effective IDs.
echo "▶ chown -R $APP_UID:$APP_GID $UPLOADS_DIR"
if ! chown -R "$APP_UID:$APP_GID" "$UPLOADS_DIR" 2>/dev/null; then
  if command -v sudo >/dev/null 2>&1; then
    echo "  (needs sudo)"
    sudo chown -R "$APP_UID:$APP_GID" "$UPLOADS_DIR"
  else
    echo "❌ chown failed and sudo is unavailable. Run this as root." >&2
    exit 1
  fi
fi

# `u+rwX,g+rwX` — read+write for owner and group; the X (capital X)
# only adds execute on directories + already-executable files, so we
# don't accidentally mark every image file executable.
echo "▶ chmod -R u+rwX,g+rwX $UPLOADS_DIR"
chmod -R u+rwX,g+rwX "$UPLOADS_DIR" 2>/dev/null \
  || (command -v sudo >/dev/null 2>&1 && sudo chmod -R u+rwX,g+rwX "$UPLOADS_DIR")

# Summary so the operator can sanity-check.
echo
echo "✅ uploads tree ready:"
ls -ld "$UPLOADS_DIR"
ls -ld "$UPLOADS_DIR"/* 2>/dev/null || true
