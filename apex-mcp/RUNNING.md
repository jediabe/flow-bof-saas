# Running APEX MCP locally

Every command here works identically in **Windows Command Prompt, PowerShell, macOS/Linux bash, and Git Bash**. Nothing depends on `source`, `$(...)`, `openssl`, or single-quoted JSON — those are the things that break on cmd, so the commands below route around them.

Steps 1 and 2 need no credentials at all. You can confirm the whole thing works before you have a useapi.net account.

**Prerequisites:** Node 20 or newer (`node -v`). Nothing else — no database, no Docker, no openssl.

---

## Step 1 — Install and build

Unzip the package, then:

```
cd apex-mcp
npm install
npm run build
```

On Windows, `tar -xf apex-google-flow-mcp.zip` works in cmd, or just extract it in Explorer.

`npm run build` compiles TypeScript into `dist/`. It should print nothing but the `tsc` banner.

Note that `npm install` is per-folder. If you unzip a second copy of the project, it starts with no `node_modules` — running `npm run build` there first gives `'tsc' is not recognized`, which sounds like a broken machine but just means dependencies haven't been installed in *that* directory yet.

## Step 2 — Prove it works, with no credentials

```
npm run test:e2e
```

This starts a mock useapi.net, starts the server against it, runs 100 assertions, and tears both down. You want `100 passed, 0 failed`.

This is the fastest way to know your Node version and install are sane. It exercises the real code path — auth, schema validation, the HTTP client, response normalization, error mapping — without touching the network or costing anything.

To poke at it by hand:

```
npm run dev:mock
```

That starts the mock and a server wired to it, with auth disabled. It passes every setting directly to the child processes, so **nothing leaks into your shell** — which matters, because a variable set with `set` or `export` overrides `.env` for the entire life of that terminal window, and a stale `USEAPI_BASE_URL` will silently serve you fake accounts later.

The banner tells you which upstream is in play, every time:

```
  auth:     none
  upstream: http://127.0.0.1:4010/v1/google-flow
==========================================================================
  NOT talking to the real API.
  ...
```

Then, in another terminal, call tools:

```
npm run call -- --list
npm run call -- google_flow_get_account
npm run call -- google_flow_generate_video prompt="a lighthouse in a storm" --watch
```

`npm run call` exists specifically so you never have to hand-write JSON at a shell prompt. Arguments are `key=value`, and values that look like JSON are parsed as JSON — so `count=1` is a number, `async=false` is a boolean, and `reference_images=["a","b"]` is an array. Add `--json` for raw structured output, or `--watch` on a video call to poll the job to completion automatically.

---

Everything above works with no useapi.net account. From here you need real credentials.

## Step 3 — Configure

Copy `.env.example` to `.env` (`copy .env.example .env` on cmd, `cp` elsewhere), then generate the two secrets:

```
npm run secrets
```

That prints an `APEX_JWT_SECRET` and an `APEX_SERVICE_KEY`. Paste both into `.env` along with your token:

```ini
USEAPI_TOKEN=user:1234-your-real-token-here
AUTH_MODE=jwt
APEX_JWT_SECRET=<generated>
APEX_SERVICE_KEY=<generated>
PORT=3000
```

`USEAPI_TOKEN` comes from your useapi.net account and **must keep its `user:` prefix** — the prefix is part of the token, and dropping it is the most common cause of a 401. The server refuses to boot without it.

There is deliberately no `USEAPI_BASE_URL` line. Leaving it unset points the server at the real API; it exists only so the tests can redirect to the mock.

```
npm start
```

Every script reads `.env` automatically, so there is no `source` step. You should see:

```
google-flow-mcp-server v1.0.0 listening on http://0.0.0.0:3000/mcp (auth: jwt)
```

If it exits instead, the message names the exact variable that's missing — config is validated at startup rather than failing on the first tool call.

## Step 4 — Connect a Google Flow account

This is the fiddliest step in the system, and there's no OAuth for it. Read [useapi.net's setup guide](https://useapi.net/docs/start-here/setup-google-flow) first. The short version:

Use a browser that is **not** Chrome — Opera, Brave, or Ungoogled Chromium. Clear all cookies. Sign into `https://labs.google/fx/tools/flow`, and at the 2FA prompt **check "Don't ask again on this device"** — skipping that breaks the session immediately. Then open `https://myaccount.google.com/`, DevTools → Application → Cookies → `https://accounts.google.com/`, select all, copy.

useapi.net also has an [automated browser setup](https://useapi.net/assets/setup-browser/google-flow.html) that skips the manual copying. Try that first.

Then hand the blob to your running server. Because the cookie table is large and full of characters that shells mangle, save it to a file rather than pasting it into a command:

```
:: save the cookies to cookies.txt first, then:
npm run connect -- cookies.txt
```

It prints the connected account's email. **Store that email against your user record** — it's what goes in the `flow_email` JWT claim from then on. The cookies aren't persisted by this server; useapi.net takes ownership of the session and refreshes it hourly.

Immediately afterward, back in the browser: open a new empty tab, close the others, clear all cookies again, don't restart the browser. Then delete `cookies.txt`.

Check it landed:

```
npm run accounts
```

## Step 5 — Read-only live check (costs nothing)

Add your connected account to `.env`:

```ini
FLOW_EMAIL=your-connected-account@gmail.com
```

Then:

```
npm run test:live
```

Calls only `get_account`, `list_voices`, and `list_characters` — zero credits — and prints session health, credit balance, tier, and which models the account can currently afford.

If health is anything but `OK`, stop. The session is broken and nothing else will work; disconnect and redo step 4.

## Step 6 — First real generation

Work up the cost ladder rather than starting with video.

Cheapest possible generation:

```
npm run call -- google_flow_generate_image prompt="a red bicycle against a white wall" model=nano-banana-2-lite count=1
```

If that returns an image URL, the whole path works. Then a video at 10 credits, polling automatically:

```
npm run call -- google_flow_generate_video prompt="a red bicycle falling over in slow motion" model=veo-3.1-lite duration=8 --watch
```

Expect 60–180 seconds. Only after that works should you spend 100 credits on `veo-3.1-quality`.

## Step 7 — Drive it from an actual model loop

`examples/web-app-client.mjs` is the shape your backend takes:

```
npm i @anthropic-ai/sdk
npm run demo -- "make an 8 second video of a lighthouse in a storm"
```

Set `ANTHROPIC_API_KEY` and `DEMO_FLOW_EMAIL` in `.env` first. The model plans, calls tools, polls the job, and reports back — exactly what your web app will do, minus the UI.

---

## Windows specifics

The npm scripts are all cross-platform. The only things that differ are how you set an environment variable ad hoc and how you extract the zip:

| Task | cmd | PowerShell | bash |
|---|---|---|---|
| Set a variable | `set FOO=bar` | `$env:FOO="bar"` | `export FOO=bar` |
| Extract | `tar -xf file.zip` | `Expand-Archive file.zip` | `unzip file.zip` |

In practice you rarely need any of these — put everything in `.env` and the scripts pick it up.

Two cmd gotchas worth knowing if you go off-script. `curl` on Windows 10+ is real curl, but cmd has no single quotes, so inline JSON needs `-d "{\"key\":\"value\"}"` with every quote escaped. That's why `npm run call` exists. And `%VAR%` expansion happens before the command runs, so `--watch` style flags are safer than shell substitution.

PowerShell has its own trap: `curl` is an alias for `Invoke-WebRequest`, which takes entirely different arguments. Use `curl.exe` explicitly, or again, just use `npm run call`.

## Poking at it with MCP Inspector

```
npx @modelcontextprotocol/inspector
```

Transport **Streamable HTTP**, URL `http://localhost:3000/mcp`, and add an `Authorization` header of `Bearer <token>` where the token comes from:

```
npm run jwt -- your-connected-account@gmail.com
```

You get a clickable list of all 19 tools with generated forms.

## Using it from Claude Desktop

stdio mode serves a single account, which is fine for testing. Use absolute paths, and on Windows escape the backslashes:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "node",
      "args": ["C:\\Users\\you\\apex-mcp\\dist\\index.js"],
      "env": {
        "TRANSPORT": "stdio",
        "USEAPI_TOKEN": "user:1234-your-token",
        "DEFAULT_FLOW_EMAIL": "your-connected-account@gmail.com"
      }
    }
  }
}
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| **Accounts you don't recognise** (`fl***@gmail.com`, `so***@gmail.com`) | You're talking to the mock, not the real API. Those are its two fake accounts. See below. |
| `'tsc' is not recognized` | `npm install` hasn't been run in this folder. Each unzipped copy needs its own. |
| `npm install` ran but `tsc` still missing | `NODE_ENV=production` skips devDependencies. `npm install --include=dev`. |
| `[config] USEAPI_TOKEN must include its 'user:' prefix` | You trimmed the prefix. Copy the token verbatim. |
| `[config] AUTH_MODE=jwt requires APEX_JWT_SECRET` | `.env` missing or in the wrong directory. It must sit next to `package.json`. |
| `Could not reach http://localhost:3000/mcp` | Server isn't running, or it's on a different port. |
| 401 with `invalid_jwt` | Token signed with a different secret, or expired. Re-mint. |
| 401 with `missing_flow_email` | Set `FLOW_EMAIL` in `.env`. |
| 403 from a tool | The JWT's `flow_email` doesn't own that job or asset. |
| Tool result mentions **596** | Google session is dead. Redo step 4. Retrying never fixes this. |
| Tool result mentions **402** | Out of credits, or the model needs a higher Google AI tier. |
| Tool result mentions **503** with captcha | The account's 300 free captcha credits are gone; configure a provider on useapi.net. |
| `test:e2e` fails at "server did not come up" | Port 3200 or 4010 already in use. |
| PowerShell: `curl` behaves strangely | It's aliased to `Invoke-WebRequest`. Use `curl.exe` or `npm run call`. |

## If you see accounts you don't recognise

`fl***@gmail.com` and `so***@gmail.com` are the two fake accounts inside `test/mock-useapi.mjs`. Seeing them means your server is pointed at the mock rather than the real API.

The cause is almost always a leftover `USEAPI_BASE_URL` in the terminal running the server. **A shell variable overrides `.env`**, so once it's set with `set` or `export`, editing `.env` won't help and neither will restarting the server in that same window.

Confirm it:

```
curl http://localhost:3000/health
```

`"usingMockUpstream": true` means you're on the mock. The fix:

1. **Close every terminal window** you've used for this project. Don't just restart the server.
2. Open a fresh one.
3. Check `.env` has no `USEAPI_BASE_URL` line.
4. `npm start` — the banner will show `upstream: https://api.useapi.net/v1/google-flow`.

Use `npm run dev:mock` for sandbox work from now on; it never touches your shell environment.

## The one thing that will bite you

Once an account is connected, **do not sign into it in a browser again**. Opening Google Flow or AI Studio with that account invalidates the session useapi.net holds, and the only fix is redoing step 4 from scratch.

Whether ordinary Gmail or Drive use also breaks it is genuinely unknown — useapi.net's docs mention only Flow and AI Studio, and nobody has published a test either way. The underlying rotating Google cookie is account-wide rather than Flow-scoped, so there's a plausible mechanism, but no evidence. Treat the account as untouchable until you've tested otherwise, and use a dedicated Google account rather than anyone's real one.
