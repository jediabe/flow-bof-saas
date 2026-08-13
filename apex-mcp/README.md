# APEX MCP — Google Flow MCP Server

A remote MCP server exposing the [useapi.net Google Flow v1 API](https://useapi.net/docs/api-google-flow-v1) — Veo 3.1 video, Gemini Omni Flash audio-native video, and Nano Banana / Imagen images — as 19 tools an LLM can call.

Built for the case where the model loop runs inside your own web application. You hold one useapi.net subscription; each of your users connects their own Google Flow account to it and generations run against their own Google AI credits.

```
browser ──HTTPS──> your web app ──MCP over HTTP──> APEX MCP ──REST──> api.useapi.net
                        │                              │
                        └──> Anthropic API             └── one USEAPI_TOKEN (yours)
                             (the model loop)              N connected Google Flow accounts
```

## How authentication works

Three things get conflated under that word, so to be explicit about which is which:

**Your users signing into your app** is your existing login — sessions, Auth0, Clerk, whatever you already have. This server never sees it.

**Your backend talking to this server** is service-to-service. Your backend mints a short-lived HS256 JWT per request, signed with a secret only the two of them know. Your users never see it, never hold it, and never sign in to get one. It carries two claims:

```js
jwt.sign({ sub: userId, flow_email: "theirAccount@gmail.com" }, APEX_JWT_SECRET, {
  algorithm: "HS256",
  expiresIn: "5m",
})
```

**This server talking to useapi.net** uses one token, `USEAPI_TOKEN`, set in the environment. It is yours, it is the same for every request, and it is never per-user.

So the only thing that varies per user is `flow_email` — which connected Google Flow account to act as. An email address isn't a secret, which is why this server has no database. Your app already has a users table; that's where the mapping lives.

If your backend and this server share a private network you can use `AUTH_MODE=service-key` instead: one shared secret plus `X-Apex-User-Id` and `X-Apex-Flow-Email` headers. Simpler, but anything that can reach the port can name any account.

### Why the email has to be signed

`flow_email` decides whose Google Flow credits get spent. If the model could set it — as a tool argument, or a header it could influence — then a prompt-injected or merely confused model could run an expensive render against another user's account.

So there is no `email` parameter on any tool. The account is pinned from the verified request context and the model never sees it. Two related endpoints are also kept off the tool surface for the same reason: `GET /accounts` and `GET /jobs` both report across the whole subscription, meaning every one of your users, so they live on the admin API behind the service key. And because job ids are scoped to the shared token rather than to an account, `google_flow_get_job` checks that the id's embedded account matches the caller before polling it.

## Quick start

```bash
npm install
cp .env.example .env
npm run build
npm start
```

You need three values in `.env`:

```bash
USEAPI_TOKEN=user:1234-...        # from your useapi.net account, 'user:' prefix included
APEX_JWT_SECRET=$(openssl rand -base64 48)
APEX_SERVICE_KEY=$(openssl rand -base64 32)
```

To poke at it without wiring up a web app:

```bash
USEAPI_TOKEN='user:1234-...' TRANSPORT=stdio DEFAULT_FLOW_EMAIL='test@gmail.com' npm start
# or point the Inspector at http://localhost:3000/mcp with a JWT you signed
npx @modelcontextprotocol/inspector
```

## Onboarding a user's Google Flow account

This is the hard part of your product, and it's worth reading before you build the UI, because useapi.net has **no OAuth and no hosted sign-in**. Connecting an account means capturing the user's Google session cookies. From useapi.net's setup guide, the user must:

1. Use a dedicated Gmail account, not their personal one, with 2-Step Verification enabled.
2. Use a non-Chrome Chromium browser — Opera, Brave, or Ungoogled Chromium.
3. Clear all cookies, sign into `labs.google/fx/tools/flow`, and check **"Don't ask again on this device"** at the 2FA prompt. Skipping that breaks the API session.
4. Open DevTools on `myaccount.google.com`, go to Application → Cookies → `https://accounts.google.com/`, select all, copy.
5. Paste that blob into your UI.
6. Clear all cookies again immediately, without restarting the browser.

Then the constraint that will generate your support tickets: **once connected, the API owns that Google session.** If the user ever opens Google Flow or AI Studio in their own browser again, the session breaks and they have to redo all of it. That surfaces as a `596` error with no automatic recovery.

Your server forwards step 5 once and keeps only the returned email:

```bash
curl -X POST http://localhost:3000/admin/accounts \
  -H "Authorization: Bearer $APEX_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cookies":"<the pasted cookie table>"}'
# -> { "email": "their-account@gmail.com", "health": "OK", ... }
```

Store that email on your user record. The cookies are never persisted or logged here — useapi.net takes ownership of the session and refreshes it an hour before expiry.

`examples/web-app-client.mjs` has this whole flow plus the model loop in runnable form.

### Admin API

All routes take `Authorization: Bearer <APEX_SERVICE_KEY>`. None of them are tools.

| Route | Purpose |
|---|---|
| `POST /admin/accounts` | Connect an account from a cookie blob; returns the email |
| `GET /admin/accounts` | Every connected account and its health — for your ops dashboard |
| `GET /admin/accounts/:email` | One account's health and credits; `healthy: false` means reconnect |
| `DELETE /admin/accounts/:email` | Disconnect; also the first half of recovering from a 596 |
| `GET /admin/stats` | Throughput and throttling across all accounts |
| `GET /admin/captcha` | Captcha provider config and solve rates |

Poll `GET /admin/accounts/:email` on a schedule. Catching a broken session before the user hits it mid-generation is the difference between "reconnect your account" and "why did my render fail."

## The tools

| Tool | What it does |
|---|---|
| `google_flow_get_account` | The caller's credits, tier, session health, and available models |
| `google_flow_upload_asset` | Upload an image or MP4 from a URL or base64, returns a `mediaGenerationId` |
| `google_flow_get_asset` | Re-resolve an expired signed download URL |
| `google_flow_generate_image` | Nano Banana / Imagen stills, with references and characters |
| `google_flow_upscale_image` | Upscale a still to 2k or 4k |
| `google_flow_generate_video` | Veo 3.1 and Omni Flash: text-, image-, reference-, and video-to-video |
| `google_flow_extend_video` | Append ~8s to a Veo clip |
| `google_flow_upscale_video` | Upscale to 1080p or 4K |
| `google_flow_video_to_gif` | Convert a clip to an animated GIF |
| `google_flow_concatenate_videos` | Join 2–10 clips with per-clip trimming |
| `google_flow_get_job` | Poll an async job and collect its results |
| `google_flow_list_characters` / `get` / `create` / `delete` | Reusable characters for consistent subjects |
| `google_flow_list_voices` / `get` / `create` / `delete` | System presets and custom voices |
| `google_flow_list_captcha_providers` | Show which captcha solvers are configured (subscription-wide, keys masked) and whether free credits remain |
| `google_flow_get_captcha_stats` | Solver success rates + sample sizes per provider; supports anonymized cross-user benchmarks |

### Captcha configuration (app-wide)

Image, video and voice generation require reCAPTCHA solves — the useapi.net worker handles them automatically. The **subscription's** first Google Flow account ships with 300 free CapSolver credits; after that at least one solver provider must be configured or generation calls 403.

Configuration is **subscription-wide** — one config covers every Google Flow account under the useapi.net token, so users never touch captcha. Set the operator's provider key(s) once via env and every user benefits automatically:

```bash
# .env — JSON object mirroring useapi.net's POST body verbatim.
# Include only the providers you want to configure.
USEAPI_CAPTCHA_PROVIDERS_JSON='{"CapSolver":"cap-key-here","AntiCaptcha":"anti-key-here"}'
```

On boot, the server calls `POST /accounts/captcha-providers` once with this map. Failures log a warning but don't block startup — a captcha config error surfaces on the first generation call rather than crashing the server.

Valid provider names (case-sensitive): `CapSolver`, `AntiCaptcha`, `YesCaptcha`, `SolveCaptcha`, `2Captcha`, `EzCaptcha`. CapSolver has a `useapi` promo for 8% off.

There is deliberately **no** `google_flow_set_captcha_providers` MCP tool. The config is subscription-wide, so an end user calling it would change the deployment's config for everyone else. Write access lives on the env var + restart cycle only.

### Apex Style 2 workflow tools

Encode the Apex Style 2 (MOF AI Avatar) SOP as a set of deterministic tools plus one MCP prompt. The SOP itself lives at [`docs/STYLE-2-SOP.md`](docs/STYLE-2-SOP.md); rotation menus, prompt templates and compliance rules are transcribed verbatim in `src/tools/style2/*`.

| Tool | What it does |
|---|---|
| `apex_style2_roll_scene` | Pick the room from the product type, roll one value from each rotation menu, hash the combo, and assemble the finished scene-image prompt. Anti-repetition is caller-driven — pass `recent_scene_hashes`. |
| `apex_style2_build_clip_prompts` | Assemble the Nano/Veo chain from templates. Returns 7 steps for handheld / countertop products, 3-clip mirror try-on for `worn`. Every Veo prompt carries "no talking, no lip movement". `duration_strategy` defaults to `generate_8_and_trim` so it works below Google AI Ultra. |
| `apex_style2_validate_copy` | SOP §6 compliance gate. Blocks US number leaks, result claims ("lips look fuller"), medical / absolute language, fabricated pricing errors, fake scarcity, profanity, and enforces the 70–75 word voiceover length. Prefers false positives — a missed one gets a video pulled. |
| `apex_style2_next_step` | Execute one step of the chain — Nano image or Veo video — with the locked avatar attached as identity reference on every step. Veo steps return a jobId immediately; the caller polls `google_flow_get_job` themselves. |

The `style2_copywriter` MCP prompt hands the calling model the SOP §6 authoring rules and feeds its output back to `apex_style2_validate_copy`. Voice / ElevenLabs tools (synth, fit loop, timing map, captions) are a follow-up phase — not in this ship.

**`style2_flow_agent_v6` MCP prompt** — the current end-to-end Flow-agent spec (rev 6 of [`docs/STYLE-2-SOP.md`](docs/STYLE-2-SOP.md)). Fetch via `prompts/get` at the start of any Style 2 conversation to load the complete instructions: MODE 0 (avatar build + `google_flow_create_character` registration), MODE 1 (8-node S0/N1–N7 chain with the attachment table, room menus, LARGE/WORN overrides, prohibitions, and fixed prompt text for every node). The `apex_style2_next_step` / `_build_clip_prompts` / `_roll_scene` tools still ship but are superseded by v6's direct-tool-call flow — v6 has the agent call `google_flow_create_character`, `google_flow_upload_asset`, `google_flow_generate_image`, and `google_flow_generate_video` directly.

Every tool takes `response_format` (`markdown` by default, or `json`) and returns `structuredContent` alongside the text, so your UI can render media cards from the same call the model reads.

### How the tools differ from the raw API

The upstream API uses numbered parameter slots — `referenceImage_1` through `_7`, `character_1` through `_7`, `reference_1` through `_10`. Those are awkward for a model to fill in correctly, so the tools take arrays (`reference_images`, `characters`, `references`) and the server expands them.

Generated media comes back in four different shapes across sync video, async submit, job poll, and sync image, and the job id is spelled `jobId` in some responses and `jobid` in others. All of that normalizes to one `media[]` array and one `jobId` before the model sees it.

Base64 payloads — GIF conversion, video concatenation, image upscaling — are withheld unless you pass `include_base64: true`. A 7 MB base64 blob in a tool result is millions of tokens of context for no benefit; fetch the bytes in your application instead.

## Async video generation

Video takes 60–180 seconds, longer than most HTTP clients want to wait. `google_flow_generate_video` defaults to `async: true`: it returns a `jobId` immediately and the model polls `google_flow_get_job` until the status is `completed` or `failed`. Each job response carries a `nextAction` field telling the model in plain language whether to poll again or stop, which keeps it from spinning on a terminal failure.

If you'd rather your app handle completion, pass `reply_url` and useapi.net will POST the job payload to your webhook on every state change; the payload matches the `GET /jobs/{jobId}` shape.

`async: false` makes the tool block until generation finishes. It works, but a slow render will hit a client timeout, so it's only worth it for fast operations.

## Testing

```bash
npm run build
npm run test:e2e     # starts a mock upstream + the server, runs 100 assertions
```

The mock in `test/mock-useapi.mjs` reproduces useapi.net's documented response shapes including their inconsistencies — `jobId` on sync responses vs `jobid` on async, the doubly-nested `mediaGenerationId` on uploads, images arriving as `media[].image.generatedImage` while videos arrive flat — because those quirks are exactly what the normalization layer exists to absorb. Video jobs advance `created → started → completed` on a timer so polling is real. Any error can be forced by putting a marker in the prompt: `[[402]]`, `[[429]]`, `[[596]]`, `[[400]]`, `[[503]]`.

**What a green run does and doesn't prove.** It covers the whole path — JWT verification, request context, schema validation, slot expansion, the HTTP client, response normalization, error mapping, base64 withholding, SSRF and cross-account guards, and the admin routes. What it can't cover is whether useapi.net's live responses actually match their documentation, because the mock encodes one reading of those docs. A misreading would pass here and fail in production.

So before spending credits, run the read-only check against the real API:

```bash
# server running against the real api.useapi.net (no USEAPI_BASE_URL set)
FLOW_EMAIL=your-account@gmail.com npm run test:live
```

That calls only `get_account`, `list_voices`, and `list_characters` — zero credits — and reports session health, credit balance, tier, and which models the account can afford. If health isn't `OK`, stop there; nothing else will work. After that, the cheapest real generation is an image on `nano-banana-2-lite`, then a video on `veo-3.1-lite` at 10 credits, before anything expensive.

## Deployment

`/mcp` is stateless — a fresh transport and server instance per request, no sessions. Scale horizontally behind any load balancer, no sticky routing.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

`GET /health` returns liveness and the active auth mode.

Set `ALLOWED_ORIGINS` if anything browser-originated can reach the server; requests with an `Origin` outside the list are rejected. Server-to-server callers send no `Origin` and are unaffected.

`google_flow_upload_asset` accepts a `source_url` the server fetches, which is a server-side request forgery vector by construction. Hostnames are resolved before the fetch and loopback, link-local (including cloud metadata at `169.254.169.254`), RFC1918, and carrier-NAT targets are refused.

## Operational notes

Each useapi.net subscription supports up to 50 connected Google Flow accounts, so that's your ceiling on concurrent users unless you add subscriptions. Each account ships with 300 free captcha credits; after those run out you need a configured captcha provider (CapSolver ~$3.00/1K solves, AntiCaptcha ~$2.00/1K) or generation starts failing. Check `GET /admin/captcha` for burn rate.

Credits are consumed against each user's own Google AI plan at consumer rates, so `402` and `403` usually mean their plan doesn't include what was asked for rather than that the request was malformed. `veo-3.1-quality` costs 100 credits; `veo-3.1-lite-low-priority` is free but requires the $199 Ultra tier specifically.

The parameter surface was built from the published useapi.net docs as of August 2026. Two details there are ambiguous and worth confirming against the live API: whether `POST /images` accepts an `async` parameter (the parameter table omits it, but `replyUrl` is documented and image jobs do appear in the jobs endpoint), and the behaviour of `referenceVideo` slots beyond `_1`, which aren't documented.

## Sources

- [Google Flow API v1 documentation](https://useapi.net/docs/api-google-flow-v1)
- [Setup Google Flow](https://useapi.net/docs/start-here/setup-google-flow)
- [useapi/google-flow-api examples](https://github.com/useapi/google-flow-api)
- [Model Context Protocol specification](https://modelcontextprotocol.io)
