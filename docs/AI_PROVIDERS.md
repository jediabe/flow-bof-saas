# AI Providers

The cockpit uses an AI provider to author per-product **image prompts**
(plus optional hook / caption / hashtags). Image generation in Flow is
still done by the local runner — the AI provider only writes the prompt
that the runner ships to Flow.

## Supported providers

| Provider     | What it is                                         | Default model                      |
| ------------ | -------------------------------------------------- | ---------------------------------- |
| `manual`     | Deterministic UK retail prompt. No API call.       | n/a                                |
| `openai`     | OpenAI Chat Completions (JSON response_format).    | `gpt-4o-mini`                      |
| `anthropic`  | Anthropic Messages API.                            | `claude-3-5-sonnet-latest`         |
| `openrouter` | OpenAI-compatible API at `openrouter.ai/api/v1`.   | `openrouter/auto`                  |

Manual is the only provider that works without an API key. The other
three need a key from the respective provider's developer console.

> **A ChatGPT or Claude subscription does NOT include API access.**
> The API is billed separately, against a key issued from the
> provider's developer dashboard. If you only pay for the consumer
> chat product you'll need to add a payment method on the dev side.

## Configuring a provider

1. Open **Settings** in the SaaS.
2. Pick the active provider in the **AI Providers** panel.
3. Paste the API key and (optionally) override the default model.
4. Click **Save settings**.
5. Click **Test active provider** — sends a tiny `{"ok": true}` round-trip
   to verify the key + model.

The form is conservative about secrets:

- API keys are stored on the SaaS server's SQLite DB.
- They are **never** sent back to the client; the form only sees
  `****abcd` previews + a `key set` flag.
- Leaving the **API key** input blank on Save means *keep the current
  key*. Clicking **Clear key** wipes it.
- The keys are never sent to the local runner, never embedded in any
  job envelope, and never logged.

## How prompt generation runs

`/batches/[id]` has an **AI Prompt Generation** section. The button
calls the configured provider for each product missing an
`imagePrompt` (or all products if you flip the mode to "overwrite").

Per-product:

1. The provider receives the UK APEX system prompt + the product's
   metadata.
2. The reply is strict JSON (we extract from fenced or commentary-wrapped
   responses gracefully).
3. The SaaS writes `imagePrompt`, `retailerName`, `hook`, `caption`,
   and `hashtags` to the Product row, and stamps `aiPromptGeneratedAt`.
4. If the provider fails (key missing, network, bad JSON), the failure
   message lands in `Product.aiPromptError` and the loop continues
   with the next product. No previously-working prompt is overwritten.

The **Use deterministic UK prompts** button is the escape hatch:

- Always works (no API call, no key required).
- Uses the same UK retailer keyword mapping as the auto-picker in
  `src/lib/uk-retailers.ts`.
- Produces the same 4-paragraph APEX-style image prompt.

## What the AI sees vs. what the runner sees

| Layer        | Sees AI keys? | Sees the prompt? |
| ------------ | :-----------: | :--------------: |
| Browser UI   |       —       |        ✓         |
| SaaS server  |       ✓       |        ✓         |
| Local runner |       —       |        ✓         |
| Google Flow  |       —       |        ✓         |

The local runner is given only the *finished* prompt + reference
image URL. It never has the chance to leak a key because it never
holds one.

## Production hardening — TODOs

The alpha stores API keys unencrypted in `prisma/dev.db`. That's fine
for a local prototype; production needs more:

- **Encrypt at rest.** Column-level encryption with a workspace KMS
  key, or move the keys to a secrets manager (1Password, AWS Secrets
  Manager, Hashicorp Vault).
- **Rotate.** Surface "rotate key" + auto-expire stored keys after N
  days of inactivity.
- **Audit log.** Every `generateAiPrompts` run should write a row
  with provider, model, product IDs, and (later) token cost.
- **Per-user keys.** Phase-4 auth lands per-user; per-user keys
  follow.

Until then: the **alpha** model is "single-tenant localhost SQLite
prototype; don't run on a shared host." See
[ROADMAP.md](ROADMAP.md) Phase 5 for the migration plan.
