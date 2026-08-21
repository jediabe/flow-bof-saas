# Managed Content Operator Tool Contracts

This reference freezes the only MCP surface Hermes may use for managed ready-to-post ContentRuns. Hermes orchestrates; the SaaS validates, persists, sequences, and rejects invalid work.

## Approved tools

- `content_get_product`: fetch product data and approval status before spend. Required before `content_create_run`.
- `content_create_run`: create or resume a managed run for Style1 or Style2 using a stable objective idempotency key.
- `content_generate_image`: execute the exact image slot named by persisted `requiredNextAction` using a stable slot idempotency key.
- `content_generate_video`: execute the exact video slot named by persisted `requiredNextAction` using a stable slot idempotency key and optional bounded `creativeDirection`.
- `content_run_qa`: run mandatory QA for the exact persisted asset awaiting review.
- `content_run_final_output`: drive at most one persisted final-output phase using a single stable final-output idempotency root.
- `content_get_run`: recover and verify current run state, especially after QA and before claiming READY.

## Product contract

`content_get_product` must return the selected product with `id` matching the request and `reviewStatus: approved`. A missing, rejected, draft, or ambiguous product stops the operator before creation or spend.

## Run creation contract

The W4A `content_create_run` input is strict:

- `productId`
- `style`: `style1` or `style2`
- `idempotencyKey`: deterministic objective key
- `compilerInput`: singular schema-valid Style1 or Style2 compiler input
- optional `videoModel` only when a human explicitly selected an allowlisted model

Do not pass top-level `variant`, `objective`, or `compilerInputs`; W4A rejects those fields. The variant lives inside `compilerInput.variant`. Never inject model unless human explicitly selected an allowlisted model. Never infer a model from memory or prior chat.

## Generation contract

For each generation step, the operator must read the latest projection and call the exact tool requested by `requiredNextAction`:

- `GENERATE_IMAGE` -> `content_generate_image({ contentRunId, idempotencyKey })`
- `GENERATE_VIDEO` -> `content_generate_video({ contentRunId, idempotencyKey, creativeDirection? })`
- `RUN_QA` -> `content_run_qa({ contentRunId })`, then `content_get_run({ contentRunId })` before selecting the next command
- `GENERATE_VOICEOVER` -> `content_run_final_output({ contentRunId, idempotencyKey })`
- `ASSEMBLE_FINAL` -> `content_run_final_output({ contentRunId, idempotencyKey })`
- `RUN_FINAL_QA` -> `content_run_final_output({ contentRunId, idempotencyKey })`
- `WAIT_FOR_OPERATION` -> repeat the exact same W4A-accepted command with the same idempotency key; approved W4A supports this for video-generation WAIT replay and final-output WAIT polling. Do not invent image WAIT replay because synchronous image generation has no safe in-flight replay path.
- `HUMAN_REVIEW` -> stop
- `FAILED` -> stop; terminal for that ContentRun
- `COMPLETE` -> verify with `content_get_run`

`creativeDirection` is allowed only where the selected style manifest allows it, and values must stay within the bounded manifest schema: `cameraMovement`, `pacing`, `framing`, `distance`, `interactionStyle`, `movementIntensity`, and unique `preservationFocus`. It is not a general prompt channel and not a repair mechanism.

## QA and final output contract

There is no manual bypass path: no QA skip, no QA override, no QA repair. Source scene QA and final output QA are both mandatory. `content_run_qa` returns `RunManagedQaResult`; Hermes must then call `content_get_run` and use nested `run.requiredNextAction` as the sequencing authority. `content_run_final_output` returns exact W4A-correlated final phase objects: `{action:"GENERATE_VOICEOVER",phase:"GENERATE_VOICEOVER",status:"VOICEOVER_READY",finalVideoId}`, `{action:"ASSEMBLE_FINAL",phase:"ASSEMBLE_FINAL",status:"MEDIA_VALIDATED",finalVideoId}`, and after successful final QA `{action:"READY",phase:"RUN_FINAL_QA",status:"ready",finalVideoId}`. It returns projected terminal/poll objects as `{action:"WAIT",operationId}` while polling, `{action:"READY"}` when the projection is already complete, `{action:"HUMAN_REVIEW",reason}` for review stops, and `{action:"FAILED",reason}` for terminal failure.

Final output is complete only when all are true in the `content_get_run` response:

1. source assets required by the manifest are approved;
2. voiceover asset is persisted;
3. final MP4 is persisted with private storage metadata;
4. deterministic final media validation passed;
5. final QA approved.

If final QA returns human review, the run stops in HUMAN_REVIEW. If infrastructure or terminal pipeline failure occurs, the run stops in FAILED. A FAILED ContentRun is terminal: report the reason and never resume, retry, or spend again on that existing run; a later human-requested fresh attempt must be a distinct operation with genuinely changed canonical W4A create data if architecture permits it.

## Unsupported work

- Style3 and any unregistered style variant.
- Posting/uploading to TikTok.
- Raw provider calls, unmanaged Flow operation, or direct database mutation.
- Lifecycle updates not returned by the SaaS projection.
- Automatic semantic repair after QA failure.
