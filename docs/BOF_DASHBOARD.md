# BOF Dashboard — multi-account TikTok Shop analytics

A read-only analytics layer that connects to N TikTok Shop creator
accounts via session cookies, polls TikHub (`api.tikhub.io`) on a
schedule, and renders dashboards across all accounts.

Lives entirely in additive routes so the existing Flow automation
surface (`/dashboard`, `/batches`, `/jobs`, etc.) is untouched.

## Surface

| Route | What it does |
|---|---|
| `/settings/tiktok-accounts` | Connect / edit / delete accounts. Paste session cookie, test it, refresh on demand. |
| `/analytics` | Aggregate dashboard across all connected accounts. Window toggle (today / 7d / 30d). |
| `/analytics/[accountId]` | Single-account detail with daily breakdown, top products, health history. |
| `POST /api/cron/health-and-revenue` | Bearer-auth cron endpoint. Refreshes health + revenue + P&L for every account. Fast. |
| `POST /api/cron/products` | Same + per-product analytics. Heavier — run daily. |

## Env vars

Three new keys in `.env`:

```
TIKHUB_API_KEY          # one key, serves all accounts
TIKTOK_COOKIE_ENC_KEY   # 32-byte base64; AES-GCM key for cookieRaw
CRON_SECRET             # shared bearer for cron endpoints
```

Generate the secrets with:

```bash
openssl rand -base64 32   # TIKTOK_COOKIE_ENC_KEY
openssl rand -hex 32      # CRON_SECRET
```

**Rotating `TIKTOK_COOKIE_ENC_KEY` invalidates every stored cookie.**
Operators will have to re-paste cookies. There is no automatic
re-encryption migration.

## Connecting an account

1. Log into the TikTok Shop creator dashboard in a browser.
2. Open DevTools → Network → reload → pick any request.
3. Copy the entire `Cookie:` request-header value.
4. Go to `/settings/tiktok-accounts`, paste it into the Cookie box,
   add a label + region, click Add.
5. Click "Test cookie" — if green, you're connected.
6. Either wait for the next cron tick or click "Refresh now" to
   populate analytics immediately.

The six cookies we extract are:

```
sessionid, sessionid_ss, tt-target-idc, msToken, ttwid, passport_csrf_token
```

Any other keys in the paste are ignored.

## Cron wiring

The endpoints expect:

```
POST /api/cron/health-and-revenue
POST /api/cron/products
Authorization: Bearer <CRON_SECRET>
```

Recommended cadence:

| Endpoint | Cadence | Why |
|---|---|---|
| `health-and-revenue` | every 6 hours | cheap; catches health flips quickly |
| `products` | once a day | heavier; product list doesn't change minute-to-minute |

### Docker host crontab (the existing Hostinger VPS deployment)

Add to root's crontab on the host running the container:

```
# every 6h on the hour
0 */6 * * * curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/health-and-revenue >> /var/log/bof-cron.log 2>&1

# daily at 03:15 UTC
15 3 * * * curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://127.0.0.1:3000/api/cron/products >> /var/log/bof-cron.log 2>&1
```

`$CRON_SECRET` must be exported in the crontab environment (`source /etc/profile.d/flow-bof.sh` or similar).

### Vercel Cron

Add to `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/health-and-revenue", "schedule": "0 */6 * * *" },
    { "path": "/api/cron/products",          "schedule": "15 3 * * *"  }
  ]
}
```

Vercel adds its own auth header for `vercel.json` crons; you'll also
want the project env var `CRON_SECRET` set and a 5-line tweak to the
route handler that accepts the Vercel cron header in place of the
bearer. (Out of scope here — wire it the day you migrate.)

## Architecture notes

- **Service layer**: `src/lib/tikhub.ts` is the single point of contact
  with `api.tikhub.io`. Swapping to the official TikTok Shop Partner
  API later means rewriting this one file behind the same four
  exported functions (`getAccountHealth`, `getAccountOverview`,
  `getVideoAnalytics`, `getProductAnalytics`).

- **Shared refresh path**: `src/lib/tikhub-refresh.ts` is the single
  function that updates one account's DB rows from a TikHub call.
  Both the manual button + scheduled cron route through it, so they
  stay byte-for-byte equivalent.

- **Cookie storage**: AES-256-GCM via `src/lib/tikhub-crypto.ts`.
  Plaintext never leaves the server. Format on disk: `v1:<iv>:<ct+tag>`.

- **Tenancy**: `TikTokAccount.workspaceId` FK; every query in the
  page renderers and server actions is scoped by `getCurrentWorkspace()`.

- **Read path**: Pages read from the DB only. No TikHub call during a
  page render — that would make the dashboard slow and ratelimit-
  sensitive. Cron writes; pages read.

- **Money**: stored as Prisma `Decimal`. The Postgres schema overlay
  adds `@db.Decimal(12, 2)`; SQLite stores it as text and Prisma
  coerces.

## What can go wrong

| Symptom | Cause | Fix |
|---|---|---|
| All accounts show `cookie: expired` | TikTok rotated tokens for the user | Re-paste cookies one by one |
| `CRON_SECRET_UNSET` 500 from cron | `CRON_SECRET` not set in env | Set in `.env`, restart |
| `decryptCookie` throws on refresh | `TIKTOK_COOKIE_ENC_KEY` rotated without re-encrypting | Re-paste cookies; or restore the old key |
| `/analytics` empty after Add | Haven't refreshed yet | Click "Refresh now" on the accounts page |
| TikHub 429s | Too many accounts, too frequent cron | Lengthen the 6h cadence or pay for a higher tier |
