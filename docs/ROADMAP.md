# Roadmap — flow-bof-saas

This skeleton corresponds to Phase 3 of the migration plan in the
sibling repo: `flow-bof-automation/docs/MIGRATION_PLAN_TO_SAAS.md`.

## Current milestone — AI prompt generation in SaaS

Ported from `flow-bof-automation/ai/`:

- `manual` / `openai` / `anthropic` / `openrouter` providers,
  TypeScript ports of the proven Python versions.
- Same UK APEX system prompt verbatim; same JSON output shape (with
  snake_case → camelCase normalisation).
- Per-workspace `WorkspaceSettings` row stores the active provider +
  API keys (SQLite, unencrypted — alpha only; see
  [AI_PROVIDERS.md](AI_PROVIDERS.md)).
- `/settings` page has an **AI Providers** form. Keys are stored
  server-side and never round-trip to the client.
- `/batches/[id]` has an **AI Prompt Generation** panel with two
  buttons: AI provider (configured) and deterministic UK fallback.
- Products gain `hook` / `caption` / `hashtags` / `aiPromptError` /
  `aiPromptGeneratedAt`. Per-product card renders the AI-generated
  copy + AI status chips.
- Local runner protocol is unchanged. AI keys are never sent to the
  runner; only finished prompts ship in `generate_flow_images` items.

## Previous milestone — Kalodata import + SaaS-hosted reference images

The cockpit now drives the runner end-to-end for the *image* half of
the pipeline without the user touching a filesystem path:

1. Create a batch.
2. **Import from Kalodata** — upload an `.xlsx` export. The SaaS
   parses `LIST_PRODUCT`, creates one Product per row, and downloads
   each row's image into `public/uploads/batches/<id>/`.
3. **Generate UK Store Prompts** — the SaaS picks a retailer per
   product (category + product-name keywords) and fills in
   `imagePrompt` using the canonical UK store template.
4. **Generate Images** — SaaS dispatches `generate_flow_images` with
   one envelope item per ready product. Each item carries an
   externally-reachable `reference_image_url` derived from
   `AGENT_ASSET_BASE_URL + product.referenceImageUrl`.
5. Runner downloads each URL into
   `data/agent_cache/reference_images/<job_id>/<item_id>.<ext>` and
   submits the cached file to Google Flow.
6. SaaS persists progress + result; the batch page shows readiness
   counts, per-product submitted/failed/skipped status, and a link
   to the last image job.

The favorites + videos flow that landed earlier still runs from the
same batch workbench. The local-path field on each product survives
as a debug override, tucked under the product card's "Advanced
override" disclosure — power users iterating without the SaaS in the
loop can still drop files into the runner's `inputs/` folder and
point a single product at it.

### Local dev image storage

Reference images live under `public/uploads/batches/<batchId>/`
during dev. Gitignored, runtime-only, never committed. See
[LOCAL_AGENT_INTEGRATION.md](LOCAL_AGENT_INTEGRATION.md#local-dev-image-storage)
for the runner's view of the same files.

### Future milestone — cloud image upload + signed URLs

Same envelope shape (`reference_image_url`), different transport:

1. Browser uploads reference image directly to object storage
   (R2 / S3 / Supabase Storage) via a presigned PUT.
2. SaaS stores the *object key*, not a local-relative URL.
3. At job-dispatch time the SaaS mints a short-lived signed GET URL
   and ships it in the envelope.
4. Runner's existing download-and-cache step keeps working — only
   the URL host + lifetime change.

When that ships, `AGENT_ASSET_BASE_URL` becomes vestigial (signed
URLs are fully-qualified) and the gitignored `public/uploads/`
folder goes away.

## Where we are (Phase 3 — hosted backend prototype)

✅ Next.js + TypeScript + Tailwind shell.
✅ Prisma schema covering User, Workspace, Agent, Batch, Product, Job, JobEvent.
✅ Server actions for create/update/delete on each model.
✅ `agent-client.ts` — typed wrapper around the agent HTTP API.
✅ `/dashboard` summary, `/agents` (Runner) registration + Test Agent,
  `/batches` list + workbench detail with product editor, generate-images
  section, favorites + videos sections, `/jobs` list + detail with
  friendly result renderers + activity timeline.
✅ Sample-job buttons that round-trip an envelope to a registered
  agent and persist the result; streaming dispatch for the long jobs
  (`generate_flow_images`, `generate_flow_videos_from_favorites`).

## Phase 4 — replace placeholders with product surface

1. **Real auth.** Pick one of: Clerk / Auth.js / Supabase. Add
   middleware to gate everything behind a session. Wire
   `getCurrentWorkspace()` to the session user. Org switcher.
2. **Workspace membership.** `OrgMember` row with roles
   (`owner`/`admin`/`member`).
3. **shadcn/ui properly installed.** The skeleton currently uses
   raw Tailwind primitives. Replace the `.btn` / `.panel` / `.chip`
   utilities with shadcn components for accessibility + polish.
4. **Bulk product import.** Port the Kalodata XLSX importer from
   `flow-bof-automation/src/kalodata_importer.py` to a TS server
   action. Accept `.xlsx` upload → preview → confirm → bulk insert.
5. **AI prompt generation.** Port `flow-bof-automation/ai/providers/`
   shape to TS (`/lib/ai/providers/`). Server action takes a list of
   products + the configured provider + key, returns prompts.
6. **Reference image uploads → cloud storage with signed-URL download.**
   S3 / R2 / Supabase Storage. Signed URLs for upload from the
   browser; runner fetches reference images by signed URL instead of
   reading from a local filesystem path. See
   [LOCAL_AGENT_INTEGRATION.md](LOCAL_AGENT_INTEGRATION.md#future-cloud-storage--signed-urls)
   for the planned envelope shape. The current `Product.referenceImageUrl`
   field is reserved for this transition; the runner ignores it today
   and reads `referenceImagePathLocal` instead.

## Phase 5 — real agent transport

1. **Streaming progress.** Switch `createSampleJob` from `runJob` →
   `runJobStream`. Persist each `progress` event as a `JobEvent`.
2. **Server-sent events to the client.** API route that streams from
   the agent to the browser so the job-detail page shows live progress
   instead of needing a refresh.
3. **Agent pairing flow.** Replace the bare URL field with a 6-digit
   pairing code. See [SECURITY.md](SECURITY.md).
4. **Push instead of pull.** Today the SaaS calls the agent directly,
   which only works over localhost. Replace with one of:
   - Agent dials out to SaaS WebSocket (recommended).
   - Agent polls SaaS for jobs (simpler MVP).
5. **Per-agent rotating tokens.** Per-agent token issued at pairing,
   stored only in the agent's local config + the SaaS DB.

## Phase 6 — billing / multi-tenant readiness

Out of scope for the skeleton entirely. Bullet-point only:

- Stripe / LemonSqueezy for subscriptions.
- Plan-based limits (jobs/month, agents/workspace).
- Audit log for every mutating action.
- Backups + retention policies for `Job` / `JobEvent`.
- Real production logging + observability.

## Non-goals

- This repo will never run Playwright. If you find yourself reaching
  for a browser, the work belongs in `flow-bof-automation`.
- This repo will never store browser cookies or Google credentials.
- This repo doesn't replace the local Streamlit UI. The two coexist
  during alpha; the SaaS is the long-term product.
