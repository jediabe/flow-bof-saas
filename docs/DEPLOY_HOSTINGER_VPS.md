# Deploy to a Hostinger VPS

Step-by-step recipe for putting flow-bof-saas on a fresh Hostinger
VPS (Ubuntu 22.04 / 24.04 / 25.10). One person, one domain, private
alpha — no public signup, no billing, no fancy auth.

After this you'll have:

- HTTPS via Caddy + Let's Encrypt.
- Postgres in Docker (data persisted in a named volume).
- The Next.js app in Docker, reachable only through Caddy.
- HTTP Basic Auth gating every page.
- Kalodata reference images persisted to a host-side `./uploads`
  folder.

## 0. Prerequisites

- A Hostinger VPS plan with root SSH.
- A domain or subdomain pointed at the VPS IPv4 with an `A` record.
  `app.example.com` is fine; so is the root domain. DNS must resolve
  *before* you bring Caddy up the first time or the cert request will
  fail.
- SSH access from your laptop.
- GitHub access to the repo. Use a deploy key or PAT.

## 1. Set up the VPS

SSH in:

```bash
ssh root@your-vps-ip
```

Install Docker, Compose v2, git:

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg lsb-release git ufw

# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io \
                docker-buildx-plugin docker-compose-plugin

# Confirm both are installed.
docker --version
docker compose version
```

Open the right firewall ports:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

(Postgres on 5432 stays inside the Docker network — never expose it.)

## 2. Clone the repo

```bash
mkdir -p /opt/flow-bof
cd /opt/flow-bof
git clone https://github.com/<your-org-or-user>/flow-bof-saas.git
cd flow-bof-saas
```

## 3. Create `.env.production`

```bash
cp .env.production.example .env.production
nano .env.production
```

Fill in:

- `APP_DOMAIN` — the FQDN that resolves to this VPS.
- `NEXT_PUBLIC_APP_URL` and `AGENT_ASSET_BASE_URL` — same host, plus
  `https://` scheme.
- `POSTGRES_PASSWORD` + matching `DATABASE_URL` — pick a long random
  password.
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` — your private-alpha gate.
- `AUTH_SECRET` — `openssl rand -base64 48` is fine.

Leave AI keys blank; you'll set those through the in-app Settings
page once it's live.

## 4. First build + boot

> **Always pass `--env-file .env.production`** to every `docker compose`
> command. Compose only auto-reads `.env`; the variables in
> `docker-compose.prod.yml` (`${POSTGRES_USER}`, `${APP_DOMAIN}`, …)
> won't interpolate without it.
>
> If you'd rather not type the flag every time, symlink:
> `ln -s .env.production .env` (the deploy script still works
> either way).

```bash
docker compose --env-file .env.production \
  -f docker-compose.prod.yml up -d --build
```

This builds the app image, pulls Postgres + Caddy, and brings
everything up. Watch logs:

```bash
docker compose --env-file .env.production \
  -f docker-compose.prod.yml logs -f
```

You're looking for:

- `db    | database system is ready to accept connections`
- `app   | ▲ Next.js …` followed by `Listening on http://0.0.0.0:3000`
- `caddy | obtained certificate` (or a clear ACME error message)

## 5. Apply the schema

The first boot leaves Postgres empty. **Do not** try to run Prisma
from inside the `app` container — the standalone production image is
slim and ships without `@prisma/engines` / the Prisma CLI. Use the
helper:

```bash
./scripts/prod-db-push.sh
```

That script spins up a one-shot `node:20-bookworm-slim` container,
joins the compose network so it can reach `db`, stages the repo into
a temp dir (so the host's `prisma/schema.prisma` stays SQLite-shaped),
and runs `prisma db push --accept-data-loss` against Postgres.

Seeding is optional. The repo's seed script also doesn't ship in the
prod image, so the same temp-container trick applies if you want it —
edit `scripts/prod-db-push.sh` to call `prisma db seed` after the
push, or run it ad-hoc from a bookworm-slim container the same way.

## 6. Smoke test

Open `https://your-domain` in a browser. You should see:

1. **Optional outer gate**: if `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`
   are set, the browser prompts for HTTP Basic credentials first.
2. **App signup**: redirected to `/signup`. Create your first account.
   The dashboard appears immediately after — there's no email
   verification step yet.
3. **Logout / login flow** lives in the left rail (your email + a
   "Log out" link). Logging out drops you at `/login`.
4. `https://your-domain/api/health` returns
   `{"ok": true, "database": "reachable", ...}` *without* prompting
   for any credential (the middleware skips that path on purpose).

> **First-user note.** Anyone who can reach `/signup` can create an
> account. Behind a populated `BASIC_AUTH_*` outer gate this is
> fine — you control the gate. On a fully public deploy you'll
> want to add invite-only signup before flipping the gate off.

### `AUTH_SECRET` must be set

The app login uses `AUTH_SECRET` to sign session cookies. It needs
to be **at least 32 characters**:

```bash
openssl rand -base64 48
```

If `AUTH_SECRET` is missing or too short, every signup/login attempt
fails with a server error. Set it in `.env.production` before the
first boot.

## 7. Daily operations

Every compose command below uses `--env-file .env.production` so the
shell variables in the compose file interpolate. If you skip that
flag you'll get `WARN[0000] The "POSTGRES_USER" variable is not set`
and the stack will misboot.

| Action                            | Command                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tail all logs                     | `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f`                       |
| Tail app only                     | `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f app`                   |
| Container status                  | `docker compose --env-file .env.production -f docker-compose.prod.yml ps`                            |
| Restart the app                   | `docker compose --env-file .env.production -f docker-compose.prod.yml restart app`                   |
| Restart everything                | `docker compose --env-file .env.production -f docker-compose.prod.yml restart`                       |
| Stop everything                   | `docker compose --env-file .env.production -f docker-compose.prod.yml down`                          |
| Pull latest code + rebuild        | `git pull && docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build`     |
| Apply a new Prisma schema change  | `./scripts/prod-db-push.sh`                                                                          |
| Open psql against the live DB     | `docker compose --env-file .env.production -f docker-compose.prod.yml exec db psql -U $POSTGRES_USER -d $POSTGRES_DB` |

The helper script `scripts/deploy-prod.sh` bundles
*pull → build → up → db push* into one command:

```bash
./scripts/deploy-prod.sh
```

## 7a. Hourly uploads cleanup

The SaaS isn't a media library — final videos stay in Google Flow,
Kalodata XLSX uploads are parsed in-memory, and reference images
live only as long as their batch does. A small cleanup script
sweeps the bits that can leak through anyway:

- `public/uploads/_tmp/` and `public/uploads/excel/`: anything
  older than 24 hours is deleted.
- `public/uploads/batches/<batchId>/`: any directory whose Batch
  row no longer exists is removed.

Run it on demand:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec -T app node scripts/cleanup-uploads.mjs
```

Hourly cron line (`crontab -e` on the VPS):

```cron
0 * * * * cd /opt/flow-bof/flow-bof-saas && docker compose --env-file .env.production -f docker-compose.prod.yml exec -T app node scripts/cleanup-uploads.mjs >> /var/log/flow-bof-cleanup.log 2>&1
```

The script never touches the database, never deletes products /
prompts / job rows / reference images of *active* batches, and
never exits non-zero on a missing scratch directory — so a stale
cron line on a fresh install is harmless.

## 8. Backups

Two things need backing up: the Postgres volume and the uploads
folder. `scripts/backup-prod.sh` does both:

```bash
./scripts/backup-prod.sh
```

It writes:

- `backups/postgres-YYYYMMDD-HHMMSS.sql.gz` (pg_dump of the whole DB)
- `backups/uploads-YYYYMMDD-HHMMSS.tar.gz` (tarball of `./uploads`)

Rotate these to off-VPS storage on a schedule that matters to you.
A weekly cron line:

```cron
0 3 * * 0 cd /opt/flow-bof/flow-bof-saas && ./scripts/backup-prod.sh
```

Restore (db):

```bash
gunzip -c backups/postgres-….sql.gz \
  | docker compose --env-file .env.production -f docker-compose.prod.yml \
      exec -T db psql -U $POSTGRES_USER -d $POSTGRES_DB
```

Restore (uploads):

```bash
tar xzf backups/uploads-….tar.gz
# Re-place files under ./uploads on the host.
```

## 9. Updating from GitHub

```bash
cd /opt/flow-bof/flow-bof-saas
git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
./scripts/prod-db-push.sh
```

(Or just run `./scripts/deploy-prod.sh`, which does all of the above.)

## 10. Resetting / wiping

Nuke containers but keep data:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

Nuke containers **and data** (irreversible — wipes Postgres + Caddy
state):

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml down -v
rm -rf uploads
```

## 11. Troubleshooting

**`EACCES: permission denied, mkdir '/app/public/uploads/workspaces'`**
(or any other path under `/app/public/uploads/`). The host-side
`./uploads` directory is missing or root-owned, so the bind mount
the app container sees is read-only to the non-root `nextjs` user.
Fix:

```bash
./scripts/fix-upload-perms.sh
docker compose --env-file .env.production -f docker-compose.prod.yml restart app
```

`scripts/fix-upload-perms.sh` is idempotent and `scripts/deploy-prod.sh`
calls it for you on every deploy. If you've never run it, the very
first Kalodata import on a fresh VPS will fail until you do.

**Imported product cards show "load failed" and `/uploads/...`
returns 404 with `Content-Type: text/html` + `Vary: rsc, …`.**
That's Next.js standalone refusing to serve runtime-added
`public/` files. The standalone server bakes its public-asset
manifest at *build* time, the Kalodata importer writes images at
*runtime*, so the request falls through to the App Router and
404s as an HTML page (the `Vary: rsc` header is the giveaway).

Fix (one-time, already applied in the repo): the Caddyfile has a
`@uploads` block that serves `/uploads/*` directly from
`/srv/uploads`, which the compose file mounts read-only from the
same host `./uploads/` the app writes into. If your deploy
pre-dates that change, redeploy:

```bash
git pull
./scripts/deploy-prod.sh
```

After redeploy, a direct curl returns the bytes (note `server: Caddy`,
not `x-powered-by: Next.js`):

```bash
curl -I https://app.autobof.xyz/uploads/workspaces/<wsId>/batches/<batchId>/<productId>_primary.jpg
# HTTP/2 200
# content-type: image/jpeg
# server: Caddy
```

If you instead see 404 *without* `Vary: rsc` — i.e. a plain
file-not-found from Caddy's file_server — the import hasn't
actually written the file. Diagnose:

```bash
# 1. Confirm the file isn't on disk:
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec app ls -la /app/public/uploads/workspaces/<wsId>/batches/<batchId>/

# 2. Run the API debug endpoint while signed in:
#    /api/debug/uploads?batchId=<id>
#    Reports referenceImageUrl + on-disk presence per product.

# 3. Fix perms and re-import:
./scripts/fix-upload-perms.sh
docker compose --env-file .env.production -f docker-compose.prod.yml \
  restart app
```

**`WARN[0000] The "POSTGRES_USER" variable is not set`** (or
`POSTGRES_DB`, `POSTGRES_PASSWORD`, `APP_DOMAIN`) — you ran
`docker compose -f docker-compose.prod.yml ...` *without*
`--env-file .env.production`. Compose only auto-reads `.env`, not
`.env.production`. Re-run with the flag, or symlink
`ln -s .env.production .env`.

**`failed to compute cache key: "/app/public": not found`** during
`docker compose ... up --build` — your repo is missing
`public/.gitkeep`. Pull the latest commit (the file is tracked
exactly so this directory always exists in the build context).

**Caddy can't bind port 80.** Another process is squatting on it.
```bash
sudo ss -tulpn | grep ':80'
```
If you see `traefik` (often pre-installed on some Hostinger images):
```bash
sudo systemctl stop traefik
sudo systemctl disable traefik
```
If it's another Docker container, stop it via `docker ps` →
`docker stop <name>`.

**Caddy can't get an LE certificate.** DNS for `APP_DOMAIN` isn't
pointed at the VPS yet, or ports 80/443 aren't open on the firewall.
`dig +short app.example.com` from your laptop should show the VPS
IP. UFW must allow `80/tcp` + `443/tcp`.

**Prisma — `Cannot find module '@prisma/engines'`.** You tried to
run `prisma db push` *inside the production app container*. The
standalone image strips Prisma's CLI + engines on purpose (smaller +
faster cold start). Always use `./scripts/prod-db-push.sh` instead;
it runs the migration in a separate `node:20-bookworm-slim`
container that has everything Prisma needs.

**Prisma — `Prisma failed to detect the libssl/openssl version`** /
`Could not parse schema engine response`. You ran the migration
from a `node:20-alpine` container. Alpine's musl libc + bundled libssl
confuse Prisma's engine. The helper script uses
`node:20-bookworm-slim` (Debian glibc + OpenSSL) for exactly this
reason — use it via `./scripts/prod-db-push.sh` rather than rolling
your own one-shot container.

**`./scripts/prod-db-push.sh` says it can't find the compose
network.** The script auto-detects `<projectname>_default`; if you
set `COMPOSE_PROJECT_NAME` to something exotic or renamed the
deploy folder, the network name won't match. Bring the stack up
first (`docker compose --env-file .env.production -f
docker-compose.prod.yml up -d db`), then re-run the script — it
re-runs the discovery on every invocation.

**`app` exits immediately.** Almost always a bad `DATABASE_URL` or
Postgres hasn't finished booting. Compose's healthcheck already
delays `app` until `db` reports `pg_isready`, but logs are gold:
```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs app
```

**Kalodata images 404 on the runner.** `AGENT_ASSET_BASE_URL` must
be reachable *from the runner* — that's normally a public URL.
Check the value in `.env.production` and that the firewall allows
ingress on 443.

**First page load hangs forever then 401s.** Browsers cache the
401 challenge response if Cache-Control isn't strict. Hard-refresh,
or open in a private window and re-enter credentials.

## 12. What's NOT in this deploy

- No public sign-up; basic auth + a single workspace is the alpha.
- No object storage; reference images live on local disk under
  `./uploads`. Phase-4 moves them to R2/S3 (see
  [LOCAL_AGENT_INTEGRATION.md](LOCAL_AGENT_INTEGRATION.md)).
- No local runner on the VPS. The runner is still a desktop install;
  the SaaS only writes prompts and asks runners to execute. See
  [SECURITY.md](SECURITY.md) for the boundary rules.
- No real auth — basic auth is a gate, not an identity system. Phase-4
  brings Clerk / Auth.js / Supabase.
- No backups off-VPS by default. Wire `scripts/backup-prod.sh` to
  your own S3-compatible bucket if you care about durability beyond
  the VPS's disk.
