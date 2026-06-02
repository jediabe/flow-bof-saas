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

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

This builds the app image, pulls Postgres + Caddy, and brings
everything up. Watch logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

You're looking for:

- `db    | database system is ready to accept connections`
- `app   | ▲ Next.js …` followed by `Listening on http://0.0.0.0:3000`
- `caddy | obtained certificate` (or a clear ACME error message)

## 5. Apply the schema + seed

The first boot leaves Postgres empty. Push the Prisma schema:

```bash
docker compose -f docker-compose.prod.yml exec app \
  node_modules/.bin/prisma db push
```

Seed (optional — only if you have a seed.ts you actually want to run
on a fresh deploy):

```bash
docker compose -f docker-compose.prod.yml exec app \
  node_modules/.bin/prisma db seed
```

> ⚠ The seed currently inserts a default user + workspace. Re-running
> it on a populated DB is a no-op because it uses `findOrCreate`-style
> reads, but verify by reading `prisma/seed.ts` before you run it.

## 6. Smoke test

Open `https://your-domain` in a browser. You should see:

1. A Basic Auth prompt — log in with `BASIC_AUTH_USER` /
   `BASIC_AUTH_PASSWORD`.
2. The cockpit dashboard.
3. `https://your-domain/api/health` returns
   `{"ok": true, "database": "reachable", ...}` *without* prompting
   for credentials (the middleware skips this path on purpose).

## 7. Daily operations

| Action                            | Command                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Tail all logs                     | `docker compose -f docker-compose.prod.yml logs -f`                                              |
| Tail app only                     | `docker compose -f docker-compose.prod.yml logs -f app`                                          |
| Restart the app                   | `docker compose -f docker-compose.prod.yml restart app`                                          |
| Restart everything                | `docker compose -f docker-compose.prod.yml restart`                                              |
| Stop everything                   | `docker compose -f docker-compose.prod.yml down`                                                 |
| Pull latest code + rebuild        | `git pull && docker compose -f docker-compose.prod.yml up -d --build`                            |
| Apply a new Prisma schema change  | `docker compose -f docker-compose.prod.yml exec app node_modules/.bin/prisma db push`            |
| Open psql against the live DB     | `docker compose -f docker-compose.prod.yml exec db psql -U $POSTGRES_USER -d $POSTGRES_DB`       |

The helper script `scripts/deploy-prod.sh` bundles
*pull → build → up → db push* into one command:

```bash
./scripts/deploy-prod.sh
```

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
  | docker compose -f docker-compose.prod.yml exec -T db \
      psql -U $POSTGRES_USER -d $POSTGRES_DB
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
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec app \
  node_modules/.bin/prisma db push
```

(Or just run `./scripts/deploy-prod.sh`.)

## 10. Resetting / wiping

Nuke containers but keep data:

```bash
docker compose -f docker-compose.prod.yml down
```

Nuke containers **and data** (irreversible — wipes Postgres + Caddy
state):

```bash
docker compose -f docker-compose.prod.yml down -v
rm -rf uploads
```

## 11. Troubleshooting

- **Caddy can't get a cert.** DNS for `APP_DOMAIN` isn't pointed at
  the VPS yet, or ports 80/443 aren't open on the firewall. `dig
  +short app.example.com` from your laptop should show the VPS IP.
- **`app` exits immediately.** Almost always a bad `DATABASE_URL` or
  the DB hasn't finished booting. Compose's healthcheck already
  delays `app` until Postgres is ready, but logs are gold:
  `docker compose -f docker-compose.prod.yml logs app`.
- **Kalodata images 404 on the runner.** `AGENT_ASSET_BASE_URL` must
  be reachable *from the runner* — that's normally a public URL.
  Check the value in `.env.production` and that the firewall allows
  ingress on 443.
- **First page load hangs forever then 401s.** Browsers cache the
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
