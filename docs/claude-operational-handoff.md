# Operational handoff — flow-bof-saas + APEX MCP (managed Style 1 branch)

Written for an engineering agent picking up the `integration/managed-style1-v1` branch. Focuses only on how the deployment is actually shaped and how to safely deploy + test managed Style 1 against it. No secret values.

---

## 1. Live VPS architecture

Single Hostinger VPS, Docker Compose (`docker-compose.prod.yml`), five services on the default compose bridge network:

| Service | Image | Role | Public port |
|---|---|---|---|
| `app` | Built locally from repo `Dockerfile` (Next.js standalone on `node:20-alpine`) | The SaaS itself. Prisma against `db`, MCP client against `apex-mcp`. | none (Caddy reverse-proxies) |
| `db` | `postgres:16-alpine` | Sole database. Not published to host. | none |
| `caddy` | `caddy:2-alpine` | HTTPS termination + Let's Encrypt auto-cert. Also serves `/uploads/*` straight from disk (Next standalone can't serve runtime files). | 80, 443 |
| `cron` | Built from `docker/cron/Dockerfile` | Hits `/api/cron/{health-and-revenue,products}` on a schedule via `Authorization: Bearer $CRON_SECRET`. BOF Dashboard refresh only. | none |
| `apex-mcp` | Built from `apex-mcp/Dockerfile` | Stateless MCP wrapping useapi.net Google Flow. Reachable as `http://apex-mcp:3000` inside the compose network only — Caddy has no route to it. | none |

Public DNS: `APP_DOMAIN` (e.g. `app.autobof.xyz`) → VPS IP → Caddy → `app:3000`.

The `app` container mounts `./uploads:/app/public/uploads` (bind), and Caddy mounts the same host path read-only as `/srv/uploads` so `/uploads/*` never touches Next.

---

## 2. Deployment + restart commands

All run on the VPS from the repo root.

**Full redeploy** (git pull, rebuild, restart, push Prisma schema):

```bash
./scripts/deploy-prod.sh
```

This is idempotent — safe to re-run if it bails mid-way.

**Just the schema push (no rebuild):**

```bash
./scripts/prod-db-push.sh
```

**Restart one service only:**

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml restart app        # or apex-mcp, cron
```

**Logs:**

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f app
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f apex-mcp
```

**Postgres shell:**

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

**Any one-off Prisma / migration / user-management task** goes through the `scripts/prod-*.sh` wrappers, which spin up a `node:20-bookworm-slim` one-shot container joined to the compose network with the postgres schema swapped in. See §7 for the QA-specific ones.

---

## 3. Environment variables (name-only)

Everything lives in `.env.production` on the VPS. Local dev uses `.env` with SQLite. Full list documented in `.env.production.example`.

### Core

| Var | Where used | Notes |
|---|---|---|
| `APP_DOMAIN` | Caddy | Hostname for TLS. Use `:80` for HTTP-only test boxes. |
| `NEXT_PUBLIC_APP_URL` | inlined at build time | Absolute URL the app embeds in reference-image links, mobile QR codes, etc. |
| `AGENT_ASSET_BASE_URL` | server code | URL the local runner uses to fetch uploaded reference images. Usually === `NEXT_PUBLIC_APP_URL`. |
| `APP_RUNNER_MODE` | server code | Always `polling` in prod. |
| `NODE_ENV` | Node | `production` in prod. |

### Postgres

| Var | Notes |
|---|---|
| `DATABASE_URL` | `postgresql://<user>:<pw>@db:5432/<db>` — the `db` service name resolves inside compose net. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Used only by the `db` service's own bootstrap; the app reads DATABASE_URL. |

### Auth + encryption

| Var | Purpose |
|---|---|
| `AUTH_SECRET` | HS256 session-JWT signing. ≥32 chars, `openssl rand -base64 48`. |
| `LLM_CRED_ENC_KEY` | AES-256-GCM key for `LlmCredential` (per-user ChatGPT OAuth / API keys). 32 bytes base64. **NEVER rotate after data lands** — every existing credential row becomes undecryptable. |
| `TIKTOK_COOKIE_ENC_KEY` | Same envelope for `TikTokAccount.cookieRaw`. 32 bytes base64. Same never-rotate rule. |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | Optional outer gate (blank in prod). |

### APEX MCP

| Var | Purpose |
|---|---|
| `USEAPI_TOKEN` | useapi.net API token, keeps `user:` prefix. One token per deployment covers all workspaces. |
| `APEX_JWT_SECRET` | HS256 secret the Next.js app AND apex-mcp both use. App mints JWTs with `flow_email` claim per request; apex-mcp verifies. ≥32 chars. |
| `APEX_SERVICE_KEY` | Guards apex-mcp's `/admin/*` routes (Google Flow account connect/list/disconnect). Server-to-server only. |
| `USEAPI_CAPTCHA_PROVIDERS_JSON` | Optional JSON string mapping captcha-solver names → API keys. |

### BOF Dashboard / cron

| Var | Purpose |
|---|---|
| `TIKHUB_API_KEY` | tikhub.io. Missing = /analytics and /settings/tiktok-accounts 500. |
| `CRON_SECRET` | Bearer token the `cron` sidecar sends to `/api/cron/*`. Missing = sidecar refuses to start (loud fail). |
| `TZ` | Optional. Timezone for the cron sidecar's crontab. Defaults UTC. |

### LLM app-key fallbacks (last-resort for `resolveLlmCredential` chain)

| Var | Purpose |
|---|---|
| `APP_OPENAI_API_KEY` | Used when a workspace has no per-user credential. |
| `APP_ANTHROPIC_API_KEY` | Same for Anthropic. |

`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` are legacy names in `.env.production.example` labeled "bootstrap only, not read at runtime." Real per-workspace keys go into `WorkspaceSettings` via the Settings UI.

### Managed Style 1 — S3-compatible object storage (**new on this branch**)

Set on the `app` service `environment:` block in `docker-compose.prod.yml`, pulled from `.env.production`:

| Var | Purpose |
|---|---|
| `S3_ENDPOINT` | Optional; blank = AWS. Set for R2 / MinIO / Backblaze / etc. |
| `S3_REGION` | Required. |
| `S3_BUCKET` | Required. Bucket must be **private** — SaaS mints time-limited signed URLs. |
| `S3_ACCESS_KEY_ID` | Required. |
| `S3_SECRET_ACCESS_KEY` | Required. |
| `S3_SESSION_TOKEN` | Optional. For STS/temporary creds. |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO / non-AWS S3-compatible endpoints. Default `false`. |

The generated-media bucket is deployment-owned. The storage service itself is external to `docker-compose.prod.yml` — provision it separately.

### QA — optional FFmpeg overrides

`FFMPEG_PATH` / `FFPROBE_PATH` — absolute paths to the binaries. Default to `ffmpeg` / `ffprobe` on PATH, which resolves to the ones installed via `apk add ffmpeg` in the runner Dockerfile stage.

---

## 4. Google Flow account integration

- **Token model:** one `USEAPI_TOKEN` covers the whole deployment. Each workspace picks its Google Flow account via `WorkspaceSettings.flowEmail`. That value ends up as the `flow_email` claim on every JWT the app mints for MCP calls.
- **Onboarding a Flow account:** operator uses useapi.net's own automated setup flow (see `apex-mcp` README `USEAPI_CAPTCHA_PROVIDERS_JSON` for captcha-solver plumbing). The SaaS Settings page holds the resulting email address.
- **Session errors:** any 596 from Flow means the useapi.net session is dead — chat agent surfaces "reconnect in Settings" and stops. No auto-retry.
- **Per-user token migration** (up to ~10 workspaces / 50 useapi accounts): documented but deferred. See `.claude/projects/…/memory/mcp-per-user-migration.md`.

Managed Style 1 branch adds **`ContentOperation`** (one row per provider generation job, with `idempotencyKey`, `providerJobId`, `technicalAttemptCount`, `status`) and **`WorkspaceProviderLock`** (one active op per workspace) so parallel generation attempts don't collide on the shared useapi subscription. Both live in `schema.postgres.prisma` and `schema.prisma`.

---

## 5. Visual QA credentials + provider setup

Milestone 1 Phase C — the QA orchestrator (`src/lib/qa/orchestrator.ts`) walks the **same** `resolveLlmCredential` chain the chat agent uses. No separate QA-specific credential.

Chain (default order, user_oauth first — see `src/lib/llm/credentials.ts:116`):

1. **`user_oauth`** — workspace owner's ChatGPT subscription. `apiShape="responses"` → factory returns Codex Responses variant (`gpt-5.6-sol`).
2. **`user_key`** — workspace owner's OpenAI or Anthropic API key from `WorkspaceSettings`. `apiShape="chat_completions"` → OpenAI Chat Completions vision (`gpt-4o-mini` default); `apiShape="anthropic_messages"` → Anthropic Messages (`claude-3-5-sonnet-latest` default).
3. **`app_key`** — env-based (`APP_OPENAI_API_KEY` or `APP_ANTHROPIC_API_KEY`).

**Known unknown:** Codex Responses vision is **unproven**. The OpenAI Responses API accepts `input_image` items in principle; whether Codex-lite routes them to a vision-capable backend is not documented and has not been smoke-tested end-to-end yet. If Codex 400s on the image content, the provider throws `ProviderError` with a message explicitly pointing at the OpenAI / Anthropic API-key fallback.

Frame extraction uses local ffmpeg (installed in the `app` runner stage). Frame prep is 1 fps + first + last, ≤1024px longest edge, JPEG quality 3. Sampling policy in `src/lib/qa/frame-extraction.ts`; rubric + thresholds in `src/lib/qa/rubric.ts` + `config.ts`.

**Stuck-lock recovery:** intentionally NOT automated in M1. Use `scripts/prod-qa-reset-lock.sh` (see §7).

---

## 6. Health checks

**`GET /api/health`** — always returns 200 with:

```json
{ "ok": true, "version": "...", "database": "reachable"|"unreachable", "timestamp": "..." }
```

Bypasses basic auth. Ping-safe from load balancers. See `src/app/api/health/route.ts`. Flip to 503-on-unreachable if you want LB to drop the node.

**Postgres:** compose-native healthcheck via `pg_isready`. The `app` service uses `depends_on: db: condition: service_healthy`.

**apex-mcp:** no health endpoint wired into compose. Reachability probe: from inside the app container, `curl http://apex-mcp:3000/mcp` should get a 401 (JWT required). If it hangs, the container is unreachable.

**cron sidecar:** self-verifies at startup — refuses to boot if `CRON_SECRET` is unset.

---

## 7. Managed Style 1 — what's new + how to test

### Branch topology

```
integration/managed-style1-v1        ← current work
├── kanban/style1-v1-t01..t12        ← per-ticket branches
└── fix/managed-style1-lock-safety
    fix/managed-style1-provider-safety
```

Merge upward through `integration/managed-style1-v1` first; only that branch gets deployed once green.

### Schema additions on this branch

- `ContentOperation` — provider-op tracking + idempotency key + technical attempts. See `schema.postgres.prisma:504`.
- `WorkspaceProviderLock` — one row per workspace, guarantees single in-flight provider op per workspace. Expires via `expiresAt`.
- `FlowGeneratedVideo` + `FlowGeneratedImage` gained `storageBucket` / `storageKey` / `storageContentType` / `storageBytes` / `storageSha256`. Nullable for legacy rows.
- `FlowGeneratedVideo.sourceImageId` FK → `FlowGeneratedImage` (video → its Nano source still). Complements the existing `imageMediaGenerationId` denorm.

Any first-time `prisma db push` against a populated prod DB should be safe (all new fields nullable OR defaulted), **but always run `./scripts/prod-db-push.sh` before restarting the app**. If it prints "cannot be executed" for any new required column, do NOT `--force-reset` — instead add `@default(now())` on the offending column (the pattern we used for the M1 `updatedAt` columns).

### QA scripts

All three follow the docker-one-shot pattern (see `scripts/prod-import-openai-oauth.sh` for the reference implementation). Dry-run by default; explicit `--commit` required to mutate.

| Script | Purpose |
|---|---|
| `./scripts/prod-qa-backfill-content-run.sh --product-id <id>` | One-off: create a `ContentRun` for a specific product's recently-generated (last 6h by default) assets so pre-M1 chat-agent-generated videos can be QA'd. NOT a permanent chat-agent integration — that permanent wiring is still open. |
| `./scripts/prod-qa-smoke.sh --asset-id <id> --kind <video\|image>` | Run the full Phase C pipeline against one asset. Downloads video, runs ffmpeg, calls the resolved provider, writes `QaAttempt` + updates `qaStatus`. Prints JSON with attempt id, decision, score, latency. |
| `./scripts/prod-qa-reset-lock.sh --asset-id <id> --kind <video\|image>` | Escape hatch when an asset gets stuck at `qaStatus=QA_RUNNING` (aborted process, killed container, etc.). Refuses to touch non-QA_RUNNING assets without `--any-status`. Does NOT delete `QaAttempt` history. |

Smoke tests are **safe to run repeatedly** — the lock CAS prevents overlap; each successful run appends one `QaAttempt` row and updates `qaStatus`.

### Testing the branch

1. `git pull` on VPS.
2. `./scripts/deploy-prod.sh` — rebuilds `app` + `apex-mcp`, restarts, pushes schema.
3. Verify `curl https://<APP_DOMAIN>/api/health` returns `database: "reachable"`.
4. Verify apex-mcp is reachable: `docker compose exec app curl -sf http://apex-mcp:3000/mcp | head`. Expect a 401 body (JWT required = service is up).
5. Verify S3 creds work: minimal probe is `docker compose exec app node -e "process.stdout.write(JSON.stringify({b: process.env.S3_BUCKET, r: process.env.S3_REGION}))"`. Real bucket connectivity is exercised by the first managed-generation attempt — check logs for AWS SDK error signatures.
6. If a Style 1 batch already exists but has no ContentRun, backfill: `./scripts/prod-qa-backfill-content-run.sh --product-id <id>` (dry-run first, then `--commit`).
7. Kick off one QA: `./scripts/prod-qa-smoke.sh --asset-id <video-id> --kind video`. Paste the JSON output for review.
8. If it stalls with `ConcurrencyError`: `./scripts/prod-qa-reset-lock.sh --asset-id <id> --kind video --commit`.

---

## 8. Production vs local/staging differences

| Concern | Local (`npm run dev`) | Prod (Docker Compose) |
|---|---|---|
| Prisma provider | SQLite via `prisma/schema.prisma` (unchanged) | Postgres via `prisma/schema.postgres.prisma` — Dockerfile swaps it over `schema.prisma` at build time (`Dockerfile:45`). |
| DB location | `./dev.db` | `db` service, `postgres_data` volume |
| MCP | Same `apex-mcp` codebase; run separately or in prod-only mode | Compose service, internal-only |
| Storage | `./public/uploads/*` on disk | Same bind-mount, plus S3 for generated media (managed Style 1 only) |
| TLS | none (localhost) | Caddy + Let's Encrypt on `APP_DOMAIN` |
| Cron | none | `cron` sidecar |
| Basic auth | off | off (blank env by default; only used for private preview boxes) |
| LLM credential | Whatever's in `.env` | `.env.production` app-key envs + per-user `LlmCredential` rows in DB |
| Health check | `curl localhost:3000/api/health` | Same shape, at `https://<APP_DOMAIN>/api/health` |
| ffmpeg for QA | Not installed by default — set `FFMPEG_PATH` or install via winget/homebrew | Installed by the runner-stage `apk add ffmpeg` |

The dual-schema convention (SQLite dev, Postgres prod, kept structurally identical) is a hard rule. The only allowed differences are Postgres-native type refinements (`@db.Decimal(12,2)`, `@db.Date`). Anything that breaks this — including `Json?` (SQLite doesn't support Prisma's Json type) — is a first-of-its-kind exception and needs justification.

---

## 9. Gotchas the next agent will hit

1. **Any new `updatedAt DateTime @updatedAt` column against an existing Postgres table must also carry `@default(now())`** — otherwise `prisma db push` errors on backfill. Precedent: fix commit `9513ae5`.
2. **The Codex Responses vision path is unproven.** If your test workspace only has ChatGPT OAuth (no OpenAI or Anthropic API key), and QA fails with `provider_call_failed` mentioning image rejection, add an OpenAI API key in Settings. `resolveLlmCredential` chain then falls through to `user_key`.
3. **Chat agent does NOT create a `ContentRun`.** Videos generated via the /prompts chat panel today land as `FlowGeneratedVideo` rows with `contentRunId=null`. QA refuses to run on these ("legacy asset") until backfilled. Permanent wiring — creating the `ContentRun` at chat-turn boundary and propagating the id through `local_save_generated_video` — is still open work.
4. **Uploaded reference images serve through Caddy, not Next.** Any URL under `/uploads/*` skips Next entirely. If you add a new upload target, make sure Caddy's `@uploads path /uploads/*` block still catches it, or the path 404s with a `Vary: rsc` HTML response.
5. **`apex-mcp` has no DB.** Its state is `USEAPI_TOKEN` in env + whatever useapi.net remembers. Deleting the `apex-mcp` container loses nothing; restart is safe any time.
6. **`LLM_CRED_ENC_KEY` and `TIKTOK_COOKIE_ENC_KEY` are write-once.** Rotating either makes every existing encrypted row unreadable. Only rotate as part of an explicit re-provisioning plan.
7. **`docker compose` invocations MUST pass `--env-file .env.production`** for the `${VAR}` interpolations in `docker-compose.prod.yml` to resolve. `deploy-prod.sh` and every `scripts/prod-*.sh` wrapper handles this; anything you write should too.
8. **First-time `prisma db push` after schema changes: dry-run mentality.** Read the CLI output before it prompts. "Cannot be executed" means back off, patch the schema, retry — don't `--force-reset`.
9. **The `app` container runs as non-root user `nextjs` (uid 1001).** The `./uploads` host directory must be chown'd accordingly — `scripts/fix-upload-perms.sh` handles it, called from `deploy-prod.sh` before/after `up -d`.

---

## 10. Fast reference — file locations

| Concern | File |
|---|---|
| Compose | `docker-compose.prod.yml` |
| SaaS Dockerfile | `Dockerfile` (multi-stage; runner stage on `node:20-alpine` + ffmpeg) |
| MCP Dockerfile | `apex-mcp/Dockerfile` |
| Reverse proxy config | `Caddyfile` |
| Env example | `.env.production.example` (fully commented) |
| SQLite schema | `prisma/schema.prisma` |
| Postgres schema | `prisma/schema.postgres.prisma` |
| Credential chain | `src/lib/llm/credentials.ts` |
| QA orchestrator | `src/lib/qa/orchestrator.ts` |
| QA provider factory | `src/lib/qa/providers/factory.ts` |
| Prisma singleton | `src/lib/db.ts` |
| MCP client | `src/lib/apex-mcp.ts` |
| Health endpoint | `src/app/api/health/route.ts` |
| Prod-op scripts | `scripts/prod-*.sh` |
| SOPs served to chat agent | `apex-mcp/docs/STYLE-1-SOP.md`, `STYLE-2-SOP.md` |
