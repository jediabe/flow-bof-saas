# APEX MCP server — remote MCP wrapping useapi.net's Google Flow v1 API.
#
# Stateless service. No database, no persistent storage. One useapi.net
# subscription (USEAPI_TOKEN) is the whole deployment; end users are
# distinguished by the flow_email claim inside signed JWTs the Next.js
# app mints per request.
#
# Multi-stage: builder installs full deps + TypeScript, compiles to
# dist/; runner ships only prod deps + dist. Alpine base to match the
# rest of the compose stack.

# ---- builder ----------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dep manifests first so npm install is cached when only source
# files change.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# Copy source + tsconfig and compile.
COPY tsconfig.json ./
COPY src ./src
# Call tsc directly rather than `npm run build` — the package's
# `prebuild` hook runs `node test/check-deps.mjs`, but our
# .dockerignore excludes test/ from the build context (we don't
# want test helpers in the production image). tsc alone gives the
# same output without the missing-file crash.
RUN npx tsc

# ---- runner -----------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Prod deps only — no TypeScript, no tsx, no test helpers.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# The compiled output from the builder.
COPY --from=builder /app/dist ./dist

# Non-root user (Node's built-in one) so the process can't touch
# the container filesystem outside /app.
USER node

# Server binds HOST=0.0.0.0 by default (see src/config.ts) so it's
# reachable across the docker network.
EXPOSE 3000

# Simple healthcheck against the /health endpoint the server exposes.
# Alpine's `wget` is BusyBox — quiet mode + spider mode = just check
# the status code, no output.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
