# syntax=docker/dockerfile:1.7
#
# Production Dockerfile for flow-bof-saas.
#
# Build stages:
#   1. deps   — install npm dependencies (cached when package*.json
#               doesn't change).
#   2. builder — swap to the Postgres Prisma schema, run prisma
#               generate + next build (standalone output).
#   3. runner — slim runtime image. Copies the standalone bundle,
#               public/, and prisma/ in. Runs as a non-root user.
#
# Local dev (`npm run dev`) does NOT use this Dockerfile — it stays on
# SQLite via the working prisma/schema.prisma. The Postgres swap only
# happens inside the Docker build.

# ---------------------------------------------------------------------
# Stage 1 — deps
# ---------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# libc6-compat is needed by Prisma's OpenSSL bindings on Alpine.
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------
# Stage 2 — builder
# ---------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Belt-and-suspenders: make sure public/ exists so the runner stage's
# COPY of /app/public never fails. The repo ships `public/.gitkeep`,
# so this should always be a no-op, but a build context that excludes
# every file under public/ would otherwise leave the directory absent.
RUN mkdir -p /app/public/uploads/batches

# Swap the working SQLite schema for the Postgres variant so the
# generated Prisma client targets Postgres in production. The local
# schema file on the host is never touched — only the in-container copy.
RUN cp prisma/schema.postgres.prisma prisma/schema.prisma

# Prisma generate needs to run before `next build` because server
# actions / page modules import @prisma/client at build time.
# DATABASE_URL is irrelevant at generate-time (Prisma reads only the
# schema), but Prisma still complains if it's empty — supply a dummy.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* env vars must be in the environment when `next build`
# runs so they get inlined into the client JS bundle as string
# literals. Setting them via the container's env_file at runtime is
# TOO LATE — by then the JS has already been built with empty
# placeholders.
#
# docker-compose passes these as --build-arg, which lands here. The
# defaults are empty so a local `docker build` (no compose) still
# works; the runtime container behavior is unchanged when these are
# blank.
ARG NEXT_PUBLIC_RUNNER_WINDOWS_RELEASE_URL=""
ARG NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL=""
ARG NEXT_PUBLIC_RUNNER_RELEASES_URL=""
ENV NEXT_PUBLIC_RUNNER_WINDOWS_RELEASE_URL=$NEXT_PUBLIC_RUNNER_WINDOWS_RELEASE_URL
ENV NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL=$NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL
ENV NEXT_PUBLIC_RUNNER_RELEASES_URL=$NEXT_PUBLIC_RUNNER_RELEASES_URL

RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------
# Stage 3 — runner
# ---------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

# Same runtime libs Prisma's query engine needs.
# ffmpeg is used by the Milestone 1 visual-QA pipeline for
# video frame extraction (src/lib/qa/frame-extraction.ts).
# Alpine's community ffmpeg is a static-ish binary at
# /usr/bin/ffmpeg + /usr/bin/ffprobe. The frame-extraction
# module respects FFMPEG_PATH / FFPROBE_PATH env overrides but
# defaults to `ffmpeg` / `ffprobe` on PATH — which lands here.
RUN apk add --no-cache libc6-compat openssl ffmpeg

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user. uid 1001 keeps us off Alpine's 1000 (node) so volume
# mounts from the host can be chown-ed without colliding with the
# image's default node user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextjs

# Standalone bundle + static assets + public/ (Kalodata-downloaded
# reference images live here when UPLOAD_DIR resolves to it).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public

# Prisma needs the schema + the generated engine at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/prisma                          ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma            ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client     ./node_modules/@prisma/client
# `prisma db push` at first boot needs the CLI too. Smaller than
# `npx prisma` would have to install from scratch.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma             ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.bin/prisma        ./node_modules/.bin/prisma

# Hourly cleanup script: removes temp uploads older than 24h and
# orphaned per-batch reference-image directories. Invoked by cron
# via `docker compose exec app node scripts/cleanup-uploads.mjs`.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# Make sure the writable uploads dir exists with the right owner —
# the compose file mounts a host volume here. Pre-creating every
# subdir the app might mkdir into prevents EACCES on first boot when
# the bind mount inherits root ownership. The host-side
# scripts/fix-upload-perms.sh handles the bind-mount side.
RUN mkdir -p \
      /app/public/uploads/workspaces \
      /app/public/uploads/batches \
      /app/public/uploads/imports \
      /app/public/uploads/_tmp \
 && chown -R nextjs:nodejs /app/public/uploads

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
