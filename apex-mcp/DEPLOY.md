# APEX MCP — deployment notes (Docker Compose sidecar)

The MCP server ships as a service in the main app's
`docker-compose.prod.yml`. Reachable at
`http://apex-mcp:3000` from other containers in the compose
network. Never exposed publicly (Caddy has no route to it, no
host port is published).

## One-time setup on the VPS

**Before the first `docker compose up`**, add three secrets to
`.env.production`.

```bash
# On the VPS, from the project root:
cd ~/flow-bof-saas

# Generate the two APEX secrets. Same command works in bash /
# Git Bash / anything with openssl. Take the two lines below,
# paste each into .env.production after its variable name.
openssl rand -base64 32       # copy this into APEX_JWT_SECRET
openssl rand -base64 32       # copy this into APEX_SERVICE_KEY

# Then paste your useapi.net token (the one starting with "user:").
# Get it from https://useapi.net (Account -> API token).
```

`.env.production` should end up with these three new lines
alongside the existing ones (DATABASE_URL, etc.):

```ini
# ------------------------------------------------------------
# APEX MCP (Google Flow proxy)
# ------------------------------------------------------------

# Your useapi.net API token. Copy verbatim — the "user:" prefix
# is part of the token. One token for the whole deployment; end
# users are distinguished by which Google Flow account is
# connected to this subscription (see docs/mcp-google-flow-onboarding.md).
USEAPI_TOKEN=user:XXXX-your-real-token-here

# HS256 secret the Next.js app uses to sign JWTs it sends to the
# MCP server. Must be at least 32 characters. Both the app and
# the MCP server must have the SAME value.
APEX_JWT_SECRET=<paste the first openssl output here>

# Shared secret guarding /admin/* routes on the MCP server
# (Google Flow account connect / list / disconnect). Only the
# Next.js app should ever hold this — never the browser.
APEX_SERVICE_KEY=<paste the second openssl output here>
```

## Bring up

Standard deploy sequence — no MCP-specific incantation:

```bash
./scripts/deploy-prod.sh
```

Adds the new `apex-mcp` service to the compose stack; it builds,
starts, and its healthcheck runs against `/health` every 30s.

## Verify

From the VPS, hit the internal health endpoint:

```bash
docker compose -f docker-compose.prod.yml exec app \
  wget -qO- http://apex-mcp:3000/health
```

Expected JSON:

```json
{
  "status": "ok",
  "authMode": "jwt",
  "credentialStore": "env",
  "upstream": "https://api.useapi.net/v1/google-flow",
  "usingMockUpstream": false,
  ...
}
```

If it shows `usingMockUpstream: true`, `USEAPI_BASE_URL` got set
somewhere it shouldn't be — check `.env.production` doesn't have
that line (it exists only for test overrides).

If the container fails to start, look at its logs:

```bash
docker compose -f docker-compose.prod.yml logs apex-mcp | tail -30
```

Config validation is at startup — the error message names the
exact variable that's missing.

## After this

The MCP server is running but nothing on the Next.js side calls
it yet. Next commits wire up:

- `/settings` panel to connect a Google Flow account (cookie
  upload → MCP `/admin/connect`)
- `/generate` page with a chat agent that calls MCP tools via
  the Anthropic tool-use loop
- Mobile posting integration (finished videos attach to
  products)
