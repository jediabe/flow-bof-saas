# Architecture — flow-bof-saas

> **Hosted SaaS = brain. Local agent = hands.**
>
> The SaaS lives here. The hands live in the sibling repo
> [`flow-bof-automation`](../../flow-bof-automation/).

This skeleton is the cloud-side prototype called out as Phase 3 in
`flow-bof-automation/docs/MIGRATION_PLAN_TO_SAAS.md`. It's the brain
that issues jobs, the database that records their results, and the UI
that lets users author content.

## High-level picture

```
┌────────────────────────────────────────────────────────────────────┐
│                         flow-bof-saas (this repo)                   │
│                                                                    │
│   Next.js app router + server actions                              │
│   ─────────────────────────────────                                │
│   /dashboard          summary metrics                              │
│   /agents             register + test local agents                 │
│   /batches            batch CRUD + product entry                   │
│   /jobs               history + per-job detail with events         │
│                                                                    │
│   Prisma + SQLite (alpha) / Postgres (planned)                     │
│   ───────────────────────────────────────────                      │
│   User · Workspace · WorkspaceSettings (AI keys)                   │
│   Agent · Batch · Product · Job · JobEvent                          │
│                                                                    │
│   AI prompt generator (src/lib/ai/*)                               │
│   ──────────────────────────────                                    │
│   manual · openai · anthropic · openrouter providers               │
│   UK APEX system prompt (uk-retail-prompts.ts)                     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │  HTTPS / WebSocket later
                              │  (alpha: direct HTTP to localhost)
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                  flow-bof-automation (sibling repo)                 │
│                                                                    │
│   src/agent_server.py — FastAPI on 127.0.0.1:9444                  │
│     GET  /health                                                   │
│     GET  /jobs/types                                               │
│     POST /jobs/run                                                 │
│     POST /jobs/run-stream                                          │
│                                                                    │
│   src/agent_api.py — handle_agent_job(envelope) dispatcher         │
│     health_check                                                   │
│     check_flow_connection                                          │
│     scan_favorited_images                                          │
│     generate_flow_images                                           │
│     generate_flow_videos_from_favorites                            │
│                                                                    │
│   Playwright + CDP → user's host Chrome → Flow / TikTok later      │
└────────────────────────────────────────────────────────────────────┘
```

## Boundary rules (security model)

**The SaaS is an automation/control dashboard, not a media library.**
It holds just enough metadata to orchestrate work and track its
status. Final generated videos stay in Google Flow; users download
them directly from there.

The SaaS:

- **Holds:**
  - Product metadata (name, category, retailer, TikTok URL, prompt)
  - Reference image URLs/paths used as inputs to image generation
  - Job metadata: status, payload, result envelope, error, events
  - Flow media IDs / edit IDs returned by the runner
  - AI provider settings (per-workspace, server-side only)
  - Runner registration + connected-runner token hashes
- **Does NOT hold:**
  - Final generated video files
  - Large Google Flow output media
  - Google / TikTok cookies, credentials, or browser profiles
  - AI provider keys in plaintext on the client
  - Debug snapshots from the runner

The local agent:

- **Holds:** session tokens for the SaaS, the path to the user's debug
  Chrome profile, the per-run job cache, debug snapshots/screenshots.
  Everything sensitive (Google cookies, TikTok cookies, the actual
  logged-in browser session) lives inside the user's Chrome — the
  agent only TALKS to that Chrome via CDP, it never reads the profile
  dir directly.
- **Reports back only metadata.** Job envelopes coming back to the
  SaaS carry counts, media IDs, edit IDs, errors — never raw video
  files or large image payloads.

See [SECURITY.md](SECURITY.md) for the longer form.

## Storage policy (alpha)

Concrete retention rules for the dashboard's on-disk state. The
hourly cleanup job (`npm run cleanup:uploads`, also wired to a
VPS cron — see [DEPLOY_HOSTINGER_VPS.md](DEPLOY_HOSTINGER_VPS.md))
enforces them.

| Artefact                             | Retained where                    | TTL                            |
| ------------------------------------ | --------------------------------- | ------------------------------ |
| Kalodata `.xlsx` upload              | Parsed in-memory, never on disk   | n/a (no persistence)           |
| Temp import scratch files            | `public/uploads/_tmp/`, `…/excel/` | 24h (auto-deleted)            |
| Product reference images             | `public/uploads/batches/<batchId>/` | While the Batch row exists  |
| Orphaned reference-image directories | (after batch delete)              | Hourly cleanup sweep           |
| Product / prompt / job metadata      | Postgres / SQLite                 | Indefinite (until manually cleared) |
| **Generated videos**                 | **Not stored — live in Google Flow** | **n/a**                    |
| **Generated images**                 | **Not stored — live in Google Flow** | **n/a**                    |
| Runner debug snapshots               | Runner's own filesystem           | Runner-side; never uploaded    |
| Backups (Postgres dump + uploads tar) | `./backups/`, off-VPS sync up to you | Run on-demand or via cron  |

When the user creates a batch via Kalodata import:

1. The XLSX bytes arrive as a multipart upload, hit the parser in
   memory, and are GC'd after the request. No file lands on disk.
2. For each product row, the SaaS downloads the row's image URL once
   and writes it under `public/uploads/batches/<batchId>/<productId>_primary.<ext>`.
3. The image stays for as long as the batch exists. Deleting the batch
   triggers a Prisma cascade that removes products + jobs; the hourly
   cleanup picks up the orphan files some time later.

## Data flow — a generate-images job

1. User creates a `Batch` in the SaaS and adds `Product`s with prompts
   + reference image URLs (S3/R2 in the future; manual paste in the
   alpha).
2. User clicks "Run generate_flow_images" (or the agent runs on a
   schedule).
3. SaaS creates a `Job` row, status `queued`. Builds the standard
   envelope:
   ```json
   {
     "protocol_version": "0.1",
     "job_id": "<Job.id>",
     "job_type": "generate_flow_images",
     "payload": { "items": [...], "limit": 30, "wait_mode": "submit_only" }
   }
   ```
4. SaaS POSTs the envelope to the registered agent's
   `/jobs/run-stream`. Status → `running`.
5. Agent receives each NDJSON progress event over the stream. SaaS
   persists them as `JobEvent` rows in order.
6. Agent emits the final `event_type: result` envelope. SaaS updates
   the `Job` row's `result` JSON and flips status to `succeeded` /
   `failed`.
7. User reloads the job detail page and sees the full event timeline
   + final envelope.

In the alpha skeleton, step 5 is simplified: we use `/jobs/run`
(non-streaming) and record a single `result` `JobEvent`. NDJSON
streaming + per-progress-event persistence is a Phase-2 follow-up;
see [ROADMAP.md](ROADMAP.md).

## Why a local agent at all

We could try to run a headless browser in the cloud. Three reasons we
don't:

1. **Google blocks login from datacenter IPs.** Playwright-in-cloud
   triggers captchas the cloud can't solve.
2. **Cookies don't transplant cleanly.** Bringing the user's Chrome
   cookies to a cloud browser invalidates them within minutes —
   they're session-bound to UA + IP fingerprint.
3. **No official Flow API.** Reverse-engineering the private GraphQL
   would be a constant break-fix tax.

Driving the user's already-logged-in local Chrome via CDP is the
robust answer. The SaaS becomes a coordinator + history store; the
agent does the actual driving.

## What this skeleton is NOT

- **No real auth.** A single default workspace is seeded on first run.
  Plug in Clerk / Auth.js / Supabase when you cross over from skeleton
  → product.
- **No billing.**
- **No multi-tenant scheduling / per-org quotas.**
- **No agent pairing flow.** The user types the agent URL by hand into
  /agents. Phase 5 will replace this with a pairing-code dance.
- **No production push notification of jobs to the agent.** The alpha
  flow has the SaaS call the agent directly over localhost — only
  works on the same machine. Phase 5 introduces server-push via
  WebSocket / long-polling.

## File tour

```
src/
  app/
    layout.tsx                 ← global shell + nav
    page.tsx                   ← redirect to /dashboard
    dashboard/page.tsx         ← summary counters + recent jobs
    agents/
      page.tsx                 ← list + add + test
      actions.ts               ← createAgent / testAgentHealth / deleteAgent
      TestAgentForm.tsx        ← client component for the Test button
    batches/
      page.tsx                 ← list + create batch
      actions.ts               ← createBatch / deleteBatch / addProduct
      [id]/
        page.tsx               ← batch detail + product table + jobs
        SampleJobButtons.tsx   ← sample agent-job kickers
    jobs/
      page.tsx                 ← job history
      actions.ts               ← createSampleJob (envelope build + agent POST)
      [id]/page.tsx            ← job detail (payload, result, events)
      new/page.tsx             ← unattached sample-job dispatcher
  lib/
    db.ts                      ← Prisma client singleton
    workspace.ts               ← getCurrentWorkspace (skeleton stub)
    agent-client.ts            ← getHealth / getJobTypes / runJob / runJobStream
  components/
    Nav.tsx                    ← header nav
    StatusChip.tsx             ← ok / warn / bad / muted chip
prisma/
  schema.prisma                ← all 8 models
  seed.ts                      ← default user + workspace on first run
docs/
  ARCHITECTURE.md              ← this file
  LOCAL_AGENT_INTEGRATION.md
  ROADMAP.md
  SECURITY.md
```
