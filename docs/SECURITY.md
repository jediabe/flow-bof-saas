# Security model

The SaaS and the local agent enforce a hard boundary between **content**
and **credentials**. Read this before adding any feature that touches
the agent or the user's browser.

## What this SaaS NEVER touches

- **Google credentials.** The SaaS does not present a Google sign-in
  page, does not receive OAuth tokens, does not see passwords.
- **TikTok credentials.** Same.
- **Browser cookies.** The user's `chrome-flow-automation` profile dir
  (under `%USERPROFILE%` / `~`) holds session cookies. The SaaS has
  no API to read those, and the local agent only TALKS to Chrome over
  CDP — it never reads the profile dir directly either.
- **Chrome user-data directory.** Same.
- **Captured generated content** (the actual image/video files Flow
  produces). They stay inside the user's Flow account. The SaaS
  records only the media_id references the agent reports back.

If any future feature would touch one of the above, the answer is
almost always "have the agent do it locally and report only summary
data back."

## What this SaaS DOES hold

- Product metadata, prompts, batch state.
- Agent registration info: name, base URL, runner-token **hash**, last
  seen / last-poll timestamps.
- Job envelopes: payload, result JSON, error JSON, event timeline.
- Per-workspace settings: AI provider key, model, OpenRouter
  attribution fields.
- User accounts: email, optional name, **bcrypt-hashed password**.

If a SaaS-side breach happened tomorrow, the worst case is leaked
product lists + leaked AI prompts. No Google account is compromised.

## User accounts and workspace isolation

Every user record owns exactly one Workspace. Every other row
(Agent, Batch, Product, Job, JobEvent, WorkspaceSettings, plus the
runner-token + per-batch uploads) is scoped by `workspaceId`.

- `getCurrentWorkspace()` in `src/lib/workspace.ts` is the only
  place that resolves "who is the request for." Every server action,
  page, and API route that touches user data calls it first.
- Cross-workspace IDs are not enumerable: `db.batch.findFirst({
  where: { id, workspaceId: workspace.id } })` returns null when
  a stranger guesses someone else's batch ID, and the page
  renders a 404.
- Runner tokens are also workspace-scoped through their owning
  Agent — `/api/runner/jobs/next` only ever hands back rows where
  `agentId == this token's agent.id`.

## Authentication

- **App login**: minimal cookie session. HS256 JWT signed with
  `AUTH_SECRET` (32+ chars; `openssl rand -base64 48` generates one),
  stored in an HttpOnly + Secure (in production) + SameSite=Lax
  cookie named `flowbof_session`. 30-day expiry. Middleware verifies
  the cookie's signature using `jose` so the Edge runtime can gate
  every request without loading Prisma.
- **Passwords**: bcryptjs, 10 rounds. Stored on `User.passwordHash`.
  Never logged. Login failures return the same error string
  regardless of whether the email exists — no account enumeration.
- **Optional Basic Auth outer gate**: when `BASIC_AUTH_USER` +
  `BASIC_AUTH_PASSWORD` are set, the whole app sits behind HTTP
  Basic. App login still runs on top of it. Set neither for a
  signup-only deploy.
- **Runner API**: lives at `/api/runner/*` and bypasses *both* the
  basic-auth gate and the app-login redirect because the runner
  authenticates with a per-Agent Bearer token (see runner-auth.ts).
  Tokens are stored as SHA-256 hex only; the full value is shown
  to the user exactly once at mint time.

## Local agent posture

- **Binds to `127.0.0.1` by default.** The alpha agent doesn't accept
  connections from anything but the loopback interface. Setting
  `AGENT_API_HOST=0.0.0.0` is explicitly opt-in and the agent logs a
  warning at startup if you do it without setting an
  `AGENT_API_TOKEN`.
- **Optional Bearer token.** If `AGENT_API_TOKEN` is set on the agent,
  every request must carry `Authorization: Bearer <token>`. The token
  is compared with `hmac.compare_digest` (constant-time, no length
  leak via timing).
- **Never logs the token.**
- **No CORS.** Browsers can't call the agent directly from an HTTPS
  page; that's intentional for the alpha.
- **No TLS in the alpha.** Real production needs a desktop wrapper
  that brokers TLS between the SaaS and the localhost agent (or a
  reverse tunnel — see [ARCHITECTURE.md](ARCHITECTURE.md) +
  [ROADMAP.md](ROADMAP.md)).

## Pairing flow (future)

Today the user types the agent URL into the SaaS by hand. This
doesn't scale (anyone with the URL + token can drive the agent).

Phase-5 pairing flow (not yet built):

1. User clicks "Pair agent" in the SaaS dashboard.
2. SaaS generates a one-time 6-digit code + short-lived enrollment
   token.
3. User pastes the code into the agent's tray menu (or visits
   `http://127.0.0.1:9444/enroll`).
4. Agent posts back to the SaaS with the enrollment token + a fresh
   keypair.
5. SaaS verifies, persists the agent's public key, and returns a
   per-agent rotating token.
6. From then on, the SaaS signs every outbound job with the agent's
   public key. The agent verifies the signature before executing.

## Data retention

Currently nothing is GC'd. Jobs accumulate forever. Real production
should:

- Retain job payloads / results for N days (configurable per org).
- Aggressively prune `JobEvent` rows older than the job's retention
  window — they're the bulk.
- Offer a "delete batch" cascade that already exists in the Prisma
  schema (`onDelete: Cascade` from Batch → Product, Batch → Job).

## Reporting issues

Found a credential leak or an API path that hands out something it
shouldn't? Don't open a public issue. Email <security@…> (placeholder
— wire this up before the SaaS goes public).
