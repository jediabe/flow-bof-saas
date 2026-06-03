# Connected Runner (alpha)

How a local runner authenticates against the hosted SaaS and picks up
jobs over an outbound polling connection. This is the alpha
replacement for the "SaaS POSTs directly to the agent's localhost"
flow that only ever worked when the dashboard *and* the runner lived
on the same machine.

## Why polling?

The hosted SaaS at `https://app.autobof.xyz` can't reach
`http://127.0.0.1:9444` on your laptop. NAT, ISP firewalls, Docker
Desktop's `host.docker.internal`, you name it — none of them let an
arbitrary HTTPS origin punch into the user's localhost.

Two robust answers exist:

1. **Polling** — runner dials *out* every N seconds, asks for work,
   does the work, posts results. Easiest to get right; no infra needed
   beyond an outbound HTTPS connection. ← *we're here*
2. **Outbound WebSocket** — runner opens one long-lived TLS connection
   to the SaaS; the SaaS pushes jobs over it. Lower latency, more
   moving parts. Future milestone.

## Authentication

The runner authenticates with a per-agent bearer token:

```
Authorization: Bearer runner_<base64url-32-bytes>
```

Issuing:

1. SaaS → **Runner** page (`/agents`) → pick an Agent row.
2. Click **Generate runner token** (the row shows it once — copy on the
   spot; the SaaS only ever stores its SHA-256 hash + last 4 chars).
3. Set `RUNNER_TOKEN=<that value>` in the runner's environment.

Rotation: click **Rotate runner token** to mint a new one. The old
one stops working immediately. **Revoke** clears the column entirely;
the next runner call gets 401.

## API surface

| Method | Path                              | Body                                 | Returns                                  |
| ------ | --------------------------------- | ------------------------------------ | ---------------------------------------- |
| POST   | `/api/runner/health`              | `{runnerVersion, platform, capabilities[]}` | `{ok, agentId, serverTime}`        |
| POST   | `/api/runner/jobs/next`           | `{capabilities[]}`                   | `{ok, job}` or `{ok, job:null}`          |
| POST   | `/api/runner/jobs/:id/events`     | `{stage, message, current, total, details}` | `{ok}`                            |
| POST   | `/api/runner/jobs/:id/complete`   | `{envelope}`                         | `{ok, status}`                           |
| POST   | `/api/runner/jobs/:id/fail`       | `{error:{code,message,details}}`     | `{ok, status}`                           |

Every route bypasses HTTP Basic Auth and is gated by the Bearer
token. A missing or wrong token returns 401 with no body details.

The runner's `/jobs/next` response embeds an envelope shape identical
to what `POST /jobs/run` would have produced on a direct-mode agent:

```json
{
  "ok": true,
  "job": {
    "id": "<saas job id>",
    "protocol_version": "0.1",
    "job_id": "<saas job id>",
    "job_type": "scan_favorited_images",
    "payload": { "...": "..." }
  }
}
```

Hand that dict straight to `handle_agent_job(...)`.

## Polling protocol — happy path

```
runner             saas
   │                 │
   │  POST /health   │  ← every interval (~5s)
   ├────────────────▶│
   │ {ok, agentId}   │
   │◀────────────────┤
   │                 │
   │ POST /jobs/next │
   ├────────────────▶│
   │ {ok, job:{…}}   │
   │◀────────────────┤
   │                 │
   │ /events ...     │  ← one POST per progress event
   ├────────────────▶│
   │ /events ...     │
   ├────────────────▶│
   │                 │
   │ /complete       │
   ├────────────────▶│
   │ {ok, "succeeded"}│
   │◀────────────────┤
   │                 │
```

## Mode switch

The SaaS picks queue-vs-direct based on `APP_RUNNER_MODE`:

| `APP_RUNNER_MODE` | What `createSampleJob` does                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `direct` (default)| Calls the agent's `baseUrl` over HTTP directly. Used by local dev where the SaaS and runner share a host.                     |
| `polling`         | Creates a Job row at `status="queued"` and returns immediately. The connected runner picks it up via `/api/runner/jobs/next`. |

Hosted production (`https://app.autobof.xyz`) sets
`APP_RUNNER_MODE=polling` in `.env.production`.

## Runner browser + console lifecycle

The packaged runner (Windows `.exe` / macOS `.app`+`.command`)
launches Chrome with a **dedicated `--user-data-dir`** — not the
user's normal Chrome profile. Two consequences worth surfacing in
support replies:

- **Closing the user's normal Chrome doesn't stop the runner**, and
  vice versa. They're separate processes pointing at separate
  profile directories.
- **The runner never wholesale-kills Chrome.** It only operates on
  the dedicated profile it spawned.

If the dedicated Flow window gets closed mid-session, the user can
reopen it via the runner's `Open/Reopen Google Flow browser` menu
item (or `FlowBOFRunner --open-browser` from a terminal). The
helper focuses an existing Flow tab when possible, opens a new tab
via CDP when one isn't there, and only cold-launches Chrome when
the dedicated profile's window was fully closed.

The runner is **console mode** on both platforms — the window stays
open while jobs run, prints live status, and pauses with
`Press Enter to exit.` on errors so the user can read what
happened. See
[`flow-bof-automation/docs/CONNECTED_RUNNER.md`](../../flow-bof-automation/docs/CONNECTED_RUNNER.md#console-lifecycle)
for the runner-side detail.

## Flow UI prep (centralised, runner-side)

Before every image or video submit, the runner runs a centralised
prep pass against the dedicated Chrome profile to recover from
stale Flow UI state — open menus, agent-prompt suggestion pills,
side panels, leftover Radix dialogs — that would otherwise
intercept clicks on the prompt input or the Generate button.

The same prep code runs from every dispatch path (Docker / CLI /
connected polling / standalone exe / .app). See
[`flow-bof-automation/docs/CONNECTED_RUNNER.md#automatic-flow-ui-prep`](../../flow-bof-automation/docs/CONNECTED_RUNNER.md#automatic-flow-ui-prep)
for the per-step breakdown and the operator-only env switches.

Each prep pass also lands on the job's event timeline as a
`flow_ui_prep` JobEvent with a per-step detail blob, so a selector
regression is easy to spot in the SaaS UI.

## Boundary guarantees

- **Metadata only.** The runner reports job progress, success /
  failure, Flow media IDs, edit IDs, counts, and errors. It never
  uploads generated videos, generated images, debug snapshots, or
  any other media payload to the SaaS. Final videos stay in Google
  Flow — users download from there.
- **No keys leave the SaaS server.** AI provider keys never appear in
  any job payload; the runner never sees them.
- **No browser cookies cross the boundary.** Google / TikTok session
  state stays on the runner.
- **Token never echoed.** Even the 401 response carries no header data.
  Server-side logs never print the raw token.
- **Atomic job claim.** Two runners racing each other can't claim the
  same job — the SaaS uses an `UPDATE … WHERE status='queued'` guard
  that returns 0 if someone else got there first.

## Setup checklist

On the SaaS side (already done if you followed
[DEPLOY_HOSTINGER_VPS.md](DEPLOY_HOSTINGER_VPS.md)):

- [ ] `APP_RUNNER_MODE=polling` in `.env.production`.
- [ ] App reachable at `https://your-domain/api/health` (returns
      `{"ok": true}`).

On the runner machine (end-user path, recommended):

- [ ] Register a runner in the SaaS Runner Setup page.
- [ ] Generate a token via **Generate runner token**.
- [ ] Download `FlowBOFRunner.exe` from GitHub Releases.
- [ ] Double-click. Paste the SaaS URL and runner token when
      prompted (or use copy buttons from the Runner Setup page).
- [ ] A dedicated Chrome window opens; sign into Google Flow inside
      it. Keep both the runner and that Chrome open.

On the runner machine (developer path):

- [ ] Clone `flow-bof-automation`.
- [ ] `python runner_app.py` (one-time prompt + same flow as the
      exe) — or the legacy `python main.py --runner-poll` with
      env vars.
- [ ] Docker is optional; see
      [`flow-bof-automation/docs/RUNNER_PACKAGING.md`](../../flow-bof-automation/docs/RUNNER_PACKAGING.md)
      for build instructions and the supported developer paths.

After a successful first health POST the SaaS shows the Agent row
with **online** + **token set (****abcd)** chips and the last-poll
timestamp.
