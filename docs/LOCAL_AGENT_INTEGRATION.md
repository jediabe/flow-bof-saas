# Local agent integration

How `flow-bof-saas` talks to the sibling `flow-bof-automation` local
agent.

## Wire format

Every request to the agent uses the same envelope shape that the local
CLI (`python main.py --agent-job-json …`) accepts:

```json
{
  "protocol_version": "0.1",
  "job_id": "<unique string>",
  "job_type": "<known job type>",
  "payload": { /* type-specific */ }
}
```

The SaaS uses each `Job` row's `id` as the envelope's `job_id` so the
two systems share an identifier — handy when diffing agent logs
against the SaaS event timeline.

Responses come back with the same protocol version + a `status` of
`succeeded` or `failed`, plus either `result` (success) or `error`
(failure). See `src/lib/agent-client.ts` for the typed TypeScript
view.

## Endpoints we call

| Endpoint | When |
| --- | --- |
| `GET /health` | When the user clicks **Test Agent Health** on `/agents`. Persists `lastSeenAt` + `status`. |
| `GET /jobs/types` | Same path as health; informational only. Lets the dashboard tell the user which jobs their agent's version supports. |
| `POST /jobs/run` | Default for every job the SaaS dispatches in the skeleton. Synchronous — the action blocks until the agent returns the final envelope. |
| `POST /jobs/run-stream` | Same submission, NDJSON progress events. **Implemented in the client** (`runJobStream`), but the skeleton's `createSampleJob` action still uses `/jobs/run` for simplicity. Switching is a one-line change once we want per-event persistence; see the TODO at the bottom of this file. |

## Supported job types (today)

The agent registers these in `flow-bof-automation/src/agent_api.py`:

| `job_type` | Purpose |
| --- | --- |
| `health_check` | Probes Chrome + Flow reachability. No mutations. |
| `check_flow_connection` | Actively inspects the open Flow tab for sign-in + project state. No mutations. |
| `scan_favorited_images` | Read-only Flow grid scan. Returns favorited tiles. |
| `generate_flow_images` | Submits image generation for a list of items (each with a **local** reference image path + prompt). See below. |
| `generate_flow_videos_from_favorites` | Animates favorited tiles with the universal blanket video prompt. |

Adding new job types is one-PR-each on the agent side and a string in
the SaaS `SAMPLE_JOBS` list to surface a button.

### `generate_flow_images` — Kalodata-driven workflow

The SaaS sends one envelope with an `items` array. Each item is a
product the runner should drive through Flow's image generator.

```json
{
  "protocol_version": "0.1",
  "job_id": "<saas job id>",
  "job_type": "generate_flow_images",
  "payload": {
    "items": [
      {
        "item_id": "<product id>",
        "product_name": "Skincare cleanser 200ml",
        "reference_image_url": "http://host.docker.internal:3000/uploads/batches/<batchId>/<productId>_primary.jpg",
        "image_prompt": "Use the uploaded reference image only to …"
      }
    ],
    "limit": 30,
    "wait_mode": "submit_only",
    "automation_mode": "balanced"
  }
}
```

Each item carries an `image_prompt` plus *one of*:

- `reference_image_url` — preferred. The runner downloads the URL into
  `data/agent_cache/reference_images/<job_id>/<item_id>.<ext>` and
  hands the cached path to Flow.
- `reference_image_path` — debug/fallback. A local filesystem path on
  the runner machine. Used when a power user has cached a local copy
  or is iterating without the SaaS in the loop.

If both are set, the runner prefers the path **when the file exists**;
otherwise it falls through to the URL.

#### Kalodata import flow

The actual user flow that puts those URLs in the envelope:

1. User clicks **Import from Kalodata** on `/batches/[id]` and
   uploads a Kalodata `.xlsx` export.
2. SaaS parses the `LIST_PRODUCT` sheet (or first worksheet as
   fallback), creates one `Product` row per source row, and
   downloads each row's `img_url` into
   `public/uploads/batches/<batchId>/<productId>_primary.<ext>`.
3. The Product row stores the local-relative URL on
   `referenceImageUrl` (e.g. `/uploads/batches/clx../clx.._primary.jpg`).
4. User clicks **Generate UK Store Prompts** to fill in `imagePrompt`
   on every product that's missing one (retailer chosen automatically
   from category + name keywords; see `src/lib/uk-retailers.ts`).
5. User clicks **Generate Images** in the workbench.
6. The SaaS builds each envelope item with
   `reference_image_url = AGENT_ASSET_BASE_URL + product.referenceImageUrl`.
7. The runner downloads the URL once, caches it, and submits it to Flow.

### Local dev image storage

Reference images live under `public/uploads/batches/<batchId>/` while
the SaaS runs in dev. That folder is gitignored — files there are
runtime data, not source.

Next serves anything under `public/` automatically at `/<...>`, so the
SaaS reaches its own files at `/uploads/batches/<id>/<file>`. The
runner, on the other hand, is usually in a Docker container or on a
sibling machine and needs an externally-reachable URL.

### `AGENT_ASSET_BASE_URL`

| Env var                | Default                          | Purpose                                                                                                                          |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_ASSET_BASE_URL` | `http://host.docker.internal:3000` | Prepended to a Product's relative `referenceImageUrl` when building the runner's envelope item. Set to whatever URL the runner can actually reach from its network. |

`host.docker.internal:3000` is the right default when the runner runs
in Docker Desktop on the same machine as `npm run dev`. On Linux
Docker hosts use `--add-host=host.docker.internal:host-gateway` or
substitute the host's LAN IP. On a remote runner, set this to the
public hostname of the SaaS (with HTTPS once that's set up).

### Future: object storage + signed URLs

Today the SaaS stores reference images on its own filesystem and
hands the runner a URL it can reach over the local network. The next
upgrade is:

1. Replace `public/uploads/batches/...` with an object-storage bucket
   (R2 / S3 / Supabase Storage).
2. Upload from the browser via a presigned PUT.
3. Hand the runner a *short-lived signed GET URL* in the envelope.

The envelope shape stays the same — `reference_image_url` is already
the contract. Only the URL host + lifetime changes. See
[ROADMAP.md](ROADMAP.md) Phase 4 for the cutover plan.

## Configuration

Two env vars on the SaaS side:

| Env var | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_AGENT_BASE_URL` | `http://127.0.0.1:9444` | Default URL pre-filled in the **Add agent** form. |
| `AGENT_API_TOKEN` | *(unset)* | Bearer token used for every call. Only required when the agent itself was started with `AGENT_API_TOKEN` set. |

The agent registration row's `baseUrl` field is what's actually used
at runtime — the env var only seeds the default value in the form.

## Token + auth model

Today: a single shared token across the workspace (the `AGENT_API_TOKEN`
env var). If set, every call sends `Authorization: Bearer <token>`.

This is fine for the alpha (localhost, single user) but does NOT
scale. Real production needs per-agent rotating tokens issued via a
pairing flow:

1. User clicks "Add agent" in the SaaS.
2. SaaS shows a 6-digit pairing code + a short-lived token.
3. User pastes the code into the agent's tray menu.
4. Agent calls back to the SaaS with the code + a fresh keypair.
5. SaaS verifies, stores the agent's public key, returns a per-agent
   token.

Phase-5 work; out of scope for this skeleton.

## Reachability assumption

The skeleton assumes the SaaS can directly reach the agent's URL. In
the alpha that's only true when both run on the same machine
(localhost), or when the SaaS is on the user's LAN.

For real production we need one of:

- **Tunnel** — agent dials out to a SaaS WebSocket and the SaaS sends
  jobs over the open socket (recommended; works through any NAT).
- **Polling** — agent polls a SaaS endpoint every N seconds for new
  jobs.
- **Cloudflare Tunnel / Tailscale** — user-side networking setup.
  Fine for technical users; bad UX for everyone else.

The skeleton's `runJob` and `runJobStream` only need a URL — when we
swap transports, the SaaS-side code that calls them barely changes.

## TODOs explicit in code

- `src/app/jobs/actions.ts:createSampleJob` uses `runJob`
  (non-streaming). Switch to `runJobStream` and persist each progress
  event as a `JobEvent` row. The plumbing is in
  `src/lib/agent-client.ts:runJobStream` already — needs an
  on-event handler that calls Prisma + revalidates the path.
- Streaming server-action progress to the client requires either an
  intermediate API route (Server-Sent Events) or polling
  `/jobs/[id]`. Skeleton ships polling-ready (the page is
  `force-dynamic` so a reload always picks up the latest events).
