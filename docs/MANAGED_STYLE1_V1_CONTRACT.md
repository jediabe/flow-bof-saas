# Managed Style 1 V1 Contract

Status: frozen for V1
Spec version: `managed-style1-v1`

This document is the human-readable counterpart of
`src/lib/content-runs/constants.ts`, `types.ts`, and `schemas.ts`. Names in code
and this document are contractual. V1 implementations must not invent extra
states, slots, operation kinds, required actions, or Hermes tool arguments.

## Objective and non-negotiable invariants

A ContentRun represents one logical objective: create one Style 1 piece for one
approved Product. The Product must have `reviewStatus="approved"`; there is no
bypass. The run is committed before any paid provider call.

Every required asset is written to private SaaS-owned object storage and then
persisted in Prisma before QA begins. Every required asset must pass mandatory
QA. A run is `ready` only when all four canonical slots have an `APPROVED`
selected asset.

The effective image and video models are application/workspace defaults frozen
in the run snapshot. Hermes cannot select or override models. V1 permits one
creative attempt per slot, no automatic semantic repair, and at most two safe
technical retries after the initial transport attempt. Exactly one provider
generation operation may be active per workspace. Any valid QA result other
than `APPROVE` stops dependent progression as `human_review`. QA evaluator or
infrastructure failure maps the asset to `FAILED` and the run to `failed`.

Hermes is the only orchestration interface. Tool authentication binds a service
actor to a workspace outside tool arguments. Visual QA continues to use the
SaaS credential resolver; provider credentials and legacy workspace keys are
never exposed through MCP.

## Canonical slots and persisted labels

| Canonical slot | Media | Asset type | Persisted scene label | Source slot |
| --- | --- | --- | --- | --- |
| `scene_1_store_image` | image | `STORE_IMAGE` | `scene_1_store_image` | — |
| `scene_1_store_video` | video | `STORE_VIDEO` | `scene_1_store` | `scene_1_store_image` |
| `scene_2_home_image` | image | `HOME_IMAGE` | `scene_2_home_image` | — |
| `scene_2_home_video` | video | `HOME_VIDEO` | `scene_2_home` | `scene_2_home_image` |

The canonical video slot names are read-model names. Persisted video scene
labels remain `scene_1_store` and `scene_2_home` for compatibility with existing
QA resolution. No video may be requested until its source image is `APPROVED`.

## ContentRun states and transitions

The complete V1 state vocabulary is:

- `created`
- `generating`
- `qa_running`
- `human_review`
- `ready`
- `failed`
- `cancelled`

Allowed transitions are:

```text
created -> generating
created -> cancelled

generating -> qa_running
generating -> failed
generating -> cancelled

qa_running -> generating
qa_running -> human_review
qa_running -> ready
qa_running -> failed
qa_running -> cancelled
```

`ready`, `human_review`, `failed`, and `cancelled` stop automatic progression in
V1. `ready` is terminal. The remaining stop states require a new, separately
approved contract before progression can resume.

## Required next actions

The SaaS derives exactly one required action; Hermes follows it and does not
infer or skip work:

- `GENERATE_IMAGE` — generate the specified image slot.
- `RUN_QA` — run mandatory QA for the specified persisted asset.
- `GENERATE_VIDEO` — generate the specified video from its approved source image.
- `WAIT_FOR_OPERATION` — resume/poll the same provider operation.
- `HUMAN_REVIEW` — stop dependent generation for a valid negative/ambiguous QA result.
- `COMPLETE` — all four required slots are selected and `APPROVED`.
- `FAILED` — stop with a structured terminal reason.

After eligible persistence, the next action is always `RUN_QA`. `COMPLETE` is
valid only with four approved selected assets.

## QA vocabulary and mapping

Managed assets use the existing QA statuses `NOT_QA_CHECKED`, `QA_RUNNING`,
`APPROVED`, `REGEN_NEEDED`, `REGEN_IN_FLIGHT`, `HUMAN_REVIEW`, and `FAILED`.
Existing QA decisions are `APPROVE`, `REGENERATE`, and `HUMAN_REVIEW`.

A newly persisted managed asset starts as `NOT_QA_CHECKED`. Decision `APPROVE`
maps it to `APPROVED`. Because V1 exhausts creative attempts at one, decisions
`REGENERATE` and `HUMAN_REVIEW` both stop the managed run at `human_review`;
they do not dispatch repair. Evaluator/infrastructure failure maps to `FAILED`
and run state `failed`.

## Provider operations and idempotency

V1 operation kinds are `image_generation` and `video_generation`. V1 operation
statuses are `requested`, `running`, `succeeded`, and `failed`. The provider
identifier is `google_flow_useapi`.

Run creation idempotency is scoped by `(productId, idempotencyKey)`. Generation
idempotency is scoped by `(workspaceId, idempotencyKey)`. Repeating a completed
command returns the original run, operation, and asset. Repeating a running
video command resumes or polls the same accepted provider job and never spends
credits on a second job.

A technical retry is permitted only when the adapter classifies a failure as
safe and no provider job or media ID was accepted. “Two technical retries”
means at most three transport attempts total. Provider content/safety
rejection, insufficient credits, account/session errors, model errors, and
valid provider failures are terminal and non-retryable.

Exactly one provider generation operation may hold the workspace lock. QA uses
its existing per-asset lock and does not take this generation lock. Acquire the
workspace lock before an external call and release it after terminal operation
persistence, including failure. A conflict returns
`WORKSPACE_PROVIDER_BUSY` with the active operation and run IDs. A stale lock
may be removed only after expiry and the deletion must be audited.

## Object storage

Canonical private object keys are:

```text
managed-content/<workspaceId>/<contentRunId>/images/<assetId>.<ext>
managed-content/<workspaceId>/<contentRunId>/videos/<assetId>.<ext>
```

No public-read ACL is allowed. Upload bytes before committing a successful
asset row; compute SHA-256 and byte length while persisting; validate content
type by header and basic media signature/container checks where practical.
Read surfaces return short-lived signed URLs. Provider media IDs and URLs are
provenance only; signed provider URLs are not canonical storage locations.

If the DB write fails after upload, delete the orphan object best-effort and
record operation failure. If upload fails, do not create a successful asset
row. Managed asset rows require non-null run ID, bucket, key, content type, byte
count, and SHA-256; legacy rows remain representable with nullable storage
fields.

## Model policy

Application defaults are `nano-banana-pro` for images and `veo-3.1-lite` for
video. The service reads workspace defaults with application fallback,
validates them against the application allowlist and current account
capabilities where available, and freezes effective values into the run
snapshot. Generation reads the frozen snapshot, never mutable settings.

No Hermes tool input includes an image model, video model, provider account,
provider credentials, `workspaceId`, or `flowEmail`.

## Frozen Hermes MCP tools

The exact V1 surface is:

1. `content_get_product`
2. `content_create_style1_run`
3. `content_generate_style1_image`
4. `content_generate_style1_video`
5. `content_run_asset_qa`
6. `content_get_run`

Inputs are strict objects:

| Tool | Allowed input fields |
| --- | --- |
| `content_get_product` | `productId` |
| `content_create_style1_run` | `productId`, `objective`, `idempotencyKey` |
| `content_generate_style1_image` | `contentRunId`, image `slot`, `idempotencyKey` |
| `content_generate_style1_video` | `contentRunId`, video `slot`, `idempotencyKey` |
| `content_run_asset_qa` | `contentRunId`, `slot` |
| `content_get_run` | `contentRunId` |

Unknown fields are rejected. In particular, no input accepts workspace
identity, `flowEmail`, credentials, model names, QA scores, QA decisions, or
arbitrary state values. Handlers receive the authenticated
`{workspaceId, actorType, actorId}` context separately.

The first video command starts an asynchronous provider job. Repeated calls
with the same idempotency key resume/poll it and persist the video on
completion. `content_get_run` is read-only.

## Run read model

The run result contains run and product identity, objective, state, spec
version, frozen model summary, exactly four slot records, attempts per slot,
selected/current attempt, authorized object-storage preview URL, latest QA
summary, active operation, required next action, and terminal reason when
applicable. A read model may expose canonical slots while translating persisted
video labels internally.

## Authentication

Local V1 uses `HERMES_MCP_DEV_TOKEN` bound to
`HERMES_MCP_DEV_WORKSPACE_ID`. Bearer comparison is constant-time. Development
credential configuration is rejected in production. The resolver returns an
internal `{workspaceId, actorType, actorId}` context and tool handlers receive
it separately from validated arguments. A later delegated-auth resolver must
not change request or response schemas.
