# flow-bof-saas

Hosted skeleton for **Flow BOF Automation**. The cloud-side companion
to the local-agent repo at `../flow-bof-automation/`.

> **Hosted SaaS = brain. Local agent = hands.**

This repo is the brain prototype: Next.js + TypeScript + Prisma +
Postgres. It owns user/workspace data, batches, products, jobs, and
talks to the local agent's HTTP API to run actual browser work.

The local agent is unchanged: it lives in the sibling repo and
listens on `http://127.0.0.1:9444`. This SaaS sends it jobs.

## What this is and isn't

| Yes | No |
| --- | --- |
| Skeleton with real DB + routing | Production-ready product |
| Next.js app router + server actions | Billing / payments |
| One default workspace, no real login | Real auth (Clerk / Auth.js → Phase 4) |
| Talks to the local agent over HTTP | Runs Playwright / Chrome anywhere |
| Stores job results + event timelines | Stores Google / TikTok credentials |

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for what comes next.

## Requirements

- Node.js 20+
- Postgres 14+ (or change `prisma/schema.prisma`'s datasource to
  SQLite for the lightest local dev experience)
- The local agent running at `http://127.0.0.1:9444`. Start it in
  `flow-bof-automation/` with either:
  ```bash
  docker compose --profile agent up -d agent
  ```
  or
  ```bash
  python main.py --agent-server
  ```

## Setup

```bash
# 1. Install deps.
npm install

# 2. Copy env template + fill in DATABASE_URL + AUTH_SECRET.
#    Generate AUTH_SECRET with:  openssl rand -base64 48
cp .env.example .env
$EDITOR .env

# 3. Push the schema.
npm run db:push

# 4. Run the dev server.
npm run dev
```

Open <http://localhost:3000>. You'll be redirected to `/signup` —
create the first account, and you land on `/dashboard`.

Need a quick-and-dirty no-signup dev mode? Set
`ALLOW_AUTH_BYPASS=true` in `.env` (only honoured outside
production). The app falls back to the env-driven default user from
`DEFAULT_USER_EMAIL` / `DEFAULT_USER_NAME`. Don't ship that to a
real deploy.

## First-run flow

1. **Add an agent.** Sidebar → **Agents** → fill in `Name` + `Base URL`
   (defaults to `http://127.0.0.1:9444`) → **Register agent**.
2. **Test it.** Click **Test Agent Health** under the agent row. You
   should see `✅ Agent reachable.` with the agent's structured
   envelope (chrome reachable, flow reachable, etc.).
3. **Create a batch.** Sidebar → **Batches** → **Create**.
4. **Add a product manually.** On the batch detail page, fill in
   `Product name` + `Image prompt` (the agent will need both at
   generation time). Optionally include a reference image URL.
5. **Run a sample job.** Under "Sample jobs" on the batch detail
   page, click any of:
   - `Health check`
   - `Check Flow connection`
   - `Scan favorited images`
   - `Generate videos from favorites`

   The SaaS builds a job envelope, POSTs it to the agent, persists
   the response, and routes you to the Job detail page.

## Routes

| Path | What |
| --- | --- |
| `/dashboard` | Summary counters + recent jobs. |
| `/agents` | Register / edit / delete agents. Test their `/health`. |
| `/batches` | List batches + create new. |
| `/batches/[id]` | Batch detail. Add products. Run sample jobs. |
| `/jobs` | Job history (all jobs in workspace). |
| `/jobs/[id]` | Job detail: payload + result + error + event timeline. |
| `/jobs/new` | Unattached sample-job dispatcher. |

## Code structure

```
src/app/         Next.js app router (pages + server actions)
src/lib/
  db.ts          Prisma client singleton
  workspace.ts   getCurrentWorkspace (skeleton stub, no real auth)
  agent-client.ts Typed wrapper around the agent HTTP API
src/components/  Nav + StatusChip
prisma/
  schema.prisma  User · Workspace · Agent · Batch · Product · Job · JobEvent
  seed.ts        Default user + workspace
docs/
  ARCHITECTURE.md
  LOCAL_AGENT_INTEGRATION.md
  SECURITY.md
  ROADMAP.md
```

## Deploying

Local dev (this README's Setup section) uses SQLite. A production
deploy to a VPS uses Docker + Postgres + Caddy and is documented
step-by-step in [`docs/DEPLOY_HOSTINGER_VPS.md`](docs/DEPLOY_HOSTINGER_VPS.md).

Short version:

```bash
# On the VPS, with Docker + Compose v2 installed:
git clone <your-fork-url> /opt/flow-bof/flow-bof-saas
cd /opt/flow-bof/flow-bof-saas
cp .env.production.example .env.production
$EDITOR .env.production   # set APP_DOMAIN, POSTGRES_PASSWORD, BASIC_AUTH_*, AUTH_SECRET
chmod +x scripts/*.sh

docker compose --env-file .env.production -f docker-compose.prod.yml \
  up -d --build
./scripts/prod-db-push.sh
```

`--env-file .env.production` is mandatory — Compose auto-reads `.env`,
not `.env.production`, so omitting it leaves `${POSTGRES_USER}` etc.
unset. The Prisma schema is pushed via a separate
`node:20-bookworm-slim` helper rather than `exec`-ing into the app
container; the standalone production image strips the Prisma CLI.

The production image swaps in [`prisma/schema.postgres.prisma`](prisma/schema.postgres.prisma)
at build time so local `npm run dev` keeps using SQLite.

## What the SaaS does NOT do

- ❌ Run Playwright / Chrome / any browser automation.
- ❌ Read your Chrome user-data dir.
- ❌ Receive your Google or TikTok credentials.
- ❌ Bill you for anything.
- ❌ Replace the local Streamlit UI in `flow-bof-automation/`.

These are deliberate boundaries, not gaps. See
[`docs/SECURITY.md`](docs/SECURITY.md).

## License

Private alpha. Don't redistribute.
