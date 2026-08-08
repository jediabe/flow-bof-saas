/**
 * End-to-end driver: acts as the MCP client against a running server backed by
 * the mock upstream, and asserts on what comes back.
 *
 * This exercises the whole path — JWT verification, request context, tool
 * schema validation, the useapi client, response normalization, error mapping —
 * everything except whether useapi.net's live responses match their docs.
 *
 * Run: node test/drive.mjs [mcpUrl]
 */

import jwt from "jsonwebtoken";

const MCP_URL = process.argv[2] ?? "http://127.0.0.1:3200/mcp";
const ADMIN_URL = MCP_URL.replace(/\/mcp$/, "");
const SECRET = process.env.APEX_JWT_SECRET ?? "testsecrettestsecrettestsecret1234";
const SERVICE_KEY = process.env.APEX_SERVICE_KEY ?? "test-admin-key-abcdefghij";
const FLOW_EMAIL = process.env.FLOW_EMAIL ?? "flowtester@gmail.com";

let id = 0;
let passed = 0;
const failures = [];

function token(email = FLOW_EMAIL, user = "user-1") {
  return jwt.sign({ sub: user, flow_email: email }, SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

async function rpc(method, params, auth = token()) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

async function callTool(name, args = {}, auth = token()) {
  const { body } = await rpc("tools/call", { name, arguments: args }, auth);
  if (body.error) return { protocolError: body.error };
  const r = body.result ?? {};
  return {
    isError: Boolean(r.isError),
    text: r.content?.[0]?.text ?? "",
    structured: r.structuredContent ?? null,
  };
}

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================================================================== */

section("Protocol");
{
  const { body } = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "drive", version: "1" },
  });
  check("initialize returns serverInfo", body.result?.serverInfo?.name === "google-flow-mcp-server");
  check("instructions are provided", (body.result?.instructions ?? "").length > 200);

  const { body: list } = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  check(`tools/list returns 19 tools (got ${tools.length})`, tools.length === 19);
  check(
    "no tool exposes an account/email input",
    !tools.some((t) => Object.keys(t.inputSchema?.properties ?? {}).some((k) => /email/i.test(k))),
  );
  check(
    "every tool has a description over 200 chars",
    tools.every((t) => (t.description ?? "").length > 200),
  );
  check("every tool has annotations", tools.every((t) => t.annotations));
  check(
    "destructive tools are flagged",
    tools
      .filter((t) => /delete/.test(t.name))
      .every((t) => t.annotations?.destructiveHint === true),
  );
  check(
    "read-only tools are flagged",
    ["google_flow_get_account", "google_flow_get_job", "google_flow_get_asset"].every(
      (n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint === true,
    ),
  );
}

section("Account");
{
  const r = await callTool("google_flow_get_account");
  check("get_account succeeds", !r.isError, r.text.slice(0, 120));
  check("pinned to the JWT's account", r.structured?.email === FLOW_EMAIL);
  check("reports healthy", r.structured?.healthy === true);
  check("surfaces credits", typeof r.structured?.credits?.credits === "number");
  check("lists video models", (r.structured?.videoModels?.length ?? 0) >= 3);

  const broken = await callTool("google_flow_get_account", {}, token("broken@gmail.com"));
  check("unhealthy account reports healthy:false", broken.structured?.healthy === false);
  check(
    "unhealthy account tells the model to stop",
    /reconnect/i.test(broken.text),
    broken.text.slice(0, 140),
  );
}

section("Images (sync, nested response shape)");
{
  const r = await callTool("google_flow_generate_image", {
    prompt: "a pirate cat on a cruise ship",
    count: 3,
    aspect_ratio: "16:9",
    model: "nano-banana-pro",
  });
  check("generate_image succeeds", !r.isError, r.text.slice(0, 160));
  check("flattens 3 images from media[].image.generatedImage", r.structured?.media?.length === 3);
  check("extracts mediaGenerationId", Boolean(r.structured?.media?.[0]?.mediaGenerationId));
  check("maps fifeUrl to url", /^https:\/\//.test(r.structured?.media?.[0]?.url ?? ""));
  check("tags kind as image", r.structured?.media?.[0]?.kind === "image");
  check("carries the seed through", typeof r.structured?.media?.[0]?.seed === "number");
}

section("Video (async submit, poll to completion)");
let videoMediaId = null;
let jobId = null;
{
  const sub = await callTool("google_flow_generate_video", {
    prompt: "a lighthouse in a storm, slow push in",
    model: "veo-3.1-fast",
    duration: 8,
  });
  check("generate_video accepted", !sub.isError, sub.text.slice(0, 160));
  check("reports async mode", sub.structured?.mode === "async");
  jobId = sub.structured?.jobId;
  check("returns a jobId despite the lowercase 'jobid' upstream", Boolean(jobId));
  check("tells the model to poll", /poll/i.test(sub.text));

  let job = await callTool("google_flow_get_job", { job_id: jobId });
  check("first poll is non-terminal", job.structured?.isTerminal === false, job.structured?.status);
  check("nextAction says to wait", /wait/i.test(job.structured?.nextAction ?? ""));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !job.structured?.isTerminal) {
    await sleep(1000);
    job = await callTool("google_flow_get_job", { job_id: jobId });
  }

  check("job reaches completed", job.structured?.status === "completed", job.structured?.status);
  check("returns exactly one video", job.structured?.media?.length === 1);
  videoMediaId = job.structured?.media?.[0]?.mediaGenerationId;
  check("video has a mediaGenerationId", Boolean(videoMediaId));
  check("video has a playable url", /^https:\/\//.test(job.structured?.media?.[0]?.url ?? ""));
  check("parses duration '8.000s' to a number", job.structured?.media?.[0]?.durationSeconds === 8);
  check("reports remaining credits", typeof job.structured?.remainingCredits === "number");
  check("nextAction says to stop", /done/i.test(job.structured?.nextAction ?? ""));
}

section("Cross-account job isolation");
{
  const r = await callTool("google_flow_get_job", { job_id: jobId }, token("mallory@evil.com"));
  check("another account cannot poll this job", r.isError === true);
  check("and is told why", /different Google Flow account/i.test(r.text), r.text.slice(0, 140));
}

section("Sync video path");
{
  const r = await callTool("google_flow_generate_video", {
    prompt: "quick sync render",
    async: false,
  });
  check("async:false returns media inline", r.structured?.media?.length === 1);
  check("mode reported as sync", r.structured?.mode === "sync");
}

section("Assets");
let uploadedImageId = null;
{
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64),
  ]).toString("base64");

  const up = await callTool("google_flow_upload_asset", { base64_data: png });
  check("upload succeeds", !up.isError, up.text.slice(0, 160));
  check("sniffs PNG without a mime hint", up.structured?.mimeType === "image/png");
  uploadedImageId = up.structured?.mediaGenerationId;
  check("unwraps the doubly-nested mediaGenerationId", typeof uploadedImageId === "string");

  const both = await callTool("google_flow_upload_asset", {
    base64_data: png,
    source_url: "https://example.com/x.png",
  });
  check("rejects both source_url and base64_data", both.isError === true);

  const neither = await callTool("google_flow_upload_asset", {});
  check("rejects neither supplied", neither.isError === true);

  const ssrf = await callTool("google_flow_upload_asset", {
    source_url: "http://169.254.169.254/latest/meta-data/",
  });
  check("blocks cloud metadata SSRF", ssrf.isError === true);
  check("SSRF message names the reason", /private or reserved/i.test(ssrf.text));

  const localhost = await callTool("google_flow_upload_asset", {
    source_url: "http://127.0.0.1:4010/v1/google-flow/accounts",
  });
  check("blocks loopback SSRF", localhost.isError === true);

  const asset = await callTool("google_flow_get_asset", {
    media_generation_id: videoMediaId ?? "user:1-video:1",
  });
  check("get_asset resolves a fresh url", /^https:\/\//.test(asset.structured?.url ?? ""));
}

section("Base64 withholding");
{
  const off = await callTool("google_flow_video_to_gif", {
    media_generation_id: videoMediaId ?? "user:1-video:1",
  });
  check("gif reports a size", (off.structured?.sizeBytes ?? 0) > 1000);
  check("gif payload withheld by default", off.structured?.encodedGif === null);
  check("gif text stays small", off.text.length < 1000, `${off.text.length} chars`);

  const on = await callTool("google_flow_video_to_gif", {
    media_generation_id: videoMediaId ?? "user:1-video:1",
    include_base64: true,
  });
  check("gif payload included on request", (on.structured?.encodedGif?.length ?? 0) > 1000);

  const cat = await callTool("google_flow_concatenate_videos", {
    clips: [
      { media_generation_id: "user:1-video:1", trim_start: 0.5 },
      { media_generation_id: "user:1-video:2" },
    ],
  });
  check("concatenate succeeds", !cat.isError, cat.text.slice(0, 160));
  check("concatenate withholds base64", cat.structured?.encodedVideo === null);
  check("concatenate reports input count", cat.structured?.inputsCount === 2);
}

section("Characters and voices");
{
  const created = await callTool("google_flow_create_character", {
    display_name: "Detective Ross",
    image_references: [uploadedImageId ?? "user:1-image:1"],
    personality_notes: "weary, dry humour",
    voice: "Kore",
  });
  check("create_character succeeds", !created.isError, created.text.slice(0, 160));
  const ref = created.structured?.character;
  check("returns a character ref", Boolean(ref));

  const list = await callTool("google_flow_list_characters");
  check("list_characters finds it", list.structured?.count === 1);

  const got = await callTool("google_flow_get_character", { character_ref: ref });
  check("get_character returns the right one", got.structured?.displayName === "Detective Ross");

  const voices = await callTool("google_flow_list_voices");
  check("list_voices returns system presets", (voices.structured?.count ?? 0) >= 5);

  const sys = await callTool("google_flow_delete_voice", { voice_ref: "Kore" });
  check("refuses to delete a system voice locally", sys.isError === true);
  check("without calling upstream", /built-in system voice/i.test(sys.text));

  const madeVoice = await callTool("google_flow_create_voice", {
    base_voice: "Charon",
    display_name: "Gravelly Narrator",
    dialog: "The city never really sleeps.",
    voice_performance: "low, gravelly, unhurried",
  });
  check("create_voice succeeds", !madeVoice.isError, madeVoice.text.slice(0, 160));
  const vref = madeVoice.structured?.voice;

  const delVoice = await callTool("google_flow_delete_voice", { voice_ref: vref });
  check("deletes a custom voice", !delVoice.isError);

  const delChar = await callTool("google_flow_delete_character", { character_ref: ref });
  check("deletes the character", !delChar.isError);
}

section("Error mapping");
{
  const cases = [
    ["402", /credit/i, "credits"],
    ["429", /rate limited/i, "throttling"],
    ["596", /reconnect/i, "session break"],
    ["400", /rewrite/i, "safety filter"],
    ["503", /captcha|unavailable/i, "captcha exhaustion"],
  ];
  for (const [code, pattern, label] of cases) {
    const r = await callTool("google_flow_generate_image", { prompt: `test [[${code}]]` });
    check(`${code} → isError with ${label} guidance`, r.isError && pattern.test(r.text), r.text.slice(0, 130));
  }

  const r429 = await callTool("google_flow_generate_image", { prompt: "x [[429]]" });
  check("429 surfaces the Retry-After value", /1800 seconds/.test(r429.text), r429.text.slice(0, 130));

  const bad = await callTool("google_flow_generate_video", { prompt: "x", model: "veo-9000" });
  check("invalid enum rejected before any upstream call", bad.protocolError || bad.isError);

  const badDur = await callTool("google_flow_generate_video", { prompt: "x", duration: 7 });
  check("invalid duration rejected", badDur.protocolError || badDur.isError);

  const tooMany = await callTool("google_flow_generate_image", {
    prompt: "x",
    references: Array.from({ length: 11 }, (_, i) => `id-${i}`),
  });
  check("over-length reference array rejected", tooMany.protocolError || tooMany.isError);

  const upstreamRule = await callTool("google_flow_generate_video", {
    prompt: "x",
    model: "veo-3.1-quality",
    reference_images: ["user:1-image:1"],
  });
  check(
    "upstream constraint (quality + references) surfaces as a 400",
    upstreamRule.isError && /400/.test(upstreamRule.text),
    upstreamRule.text.slice(0, 130),
  );
}

section("Slot expansion");
{
  const r = await callTool("google_flow_generate_video", {
    prompt: "@referenceImage_1 walks forward",
    model: "omni-flash",
    reference_images: ["img-a", "img-b"],
    reference_audio: ["Kore"],
    async: false,
  });
  check("array params accepted", !r.isError, r.text.slice(0, 160));
  const sent = r.structured?.raw?.request ?? {};
  // The sync path echoes nothing, so assert via the async path instead.
  const asyncRun = await callTool("google_flow_generate_video", {
    prompt: "@referenceImage_1 walks forward",
    model: "omni-flash",
    reference_images: ["img-a", "img-b"],
    reference_audio: ["Kore"],
    characters: ["char-1"],
  });
  const echoed = asyncRun.structured?.raw?.request ?? {};
  check("reference_images expanded to numbered slots", echoed.referenceImage_1 === "img-a" && echoed.referenceImage_2 === "img-b", JSON.stringify(echoed).slice(0, 200));
  check("reference_audio expanded", echoed.referenceAudio_1 === "Kore");
  check("characters expanded", echoed.character_1 === "char-1");
  check("array params are not passed through raw", echoed.reference_images === undefined);
}

section("Response format");
{
  const md = await callTool("google_flow_get_account", { response_format: "markdown" });
  const js = await callTool("google_flow_get_account", { response_format: "json" });
  check("markdown output is markdown", md.text.startsWith("#"));
  check("json output parses", (() => { try { JSON.parse(js.text); return true; } catch { return false; } })());
  check("both carry identical structuredContent", md.structured?.email === js.structured?.email);
}

section("Admin API");
{
  const admin = (path, init = {}) =>
    fetch(`${ADMIN_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
        ...(init.headers ?? {}),
      },
    });

  const list = await (await admin("/admin/accounts")).json();
  check("lists connected accounts", list.count === 2);
  check("surfaces an unhealthy account", list.accounts.some((a) => a.health !== "OK"));

  const connectBad = await admin("/admin/accounts", {
    method: "POST",
    body: JSON.stringify({ cookies: "x".repeat(60) }),
  });
  const badBody = await connectBad.json();
  check("rejects invalid cookies with actionable text", connectBad.status === 400);
  check("and flags the code", badBody.code === "invalid_cookies", JSON.stringify(badBody).slice(0, 140));

  const connect = await admin("/admin/accounts", {
    method: "POST",
    body: JSON.stringify({ cookies: `name\tvalue\n__Secure-1PSID\tabc123${"x".repeat(60)}` }),
  });
  const connected = await connect.json();
  check("connects an account", connect.status === 201);
  check("returns the email to store", connected.email === "flowtester@gmail.com");
  check("never echoes cookies back", !JSON.stringify(connected).includes("__Secure-1PSID"));
  check("never echoes the access token", !JSON.stringify(connected).includes("access_token"));

  const health = await (await admin(`/admin/accounts/${encodeURIComponent("broken@gmail.com")}`)).json();
  check("health check flags a dead session", health.healthy === false);

  const stats = await (await admin("/admin/stats?options=summary")).json();
  check("stats endpoint responds", Boolean(stats.emails));

  const withUserJwt = await fetch(`${ADMIN_URL}/admin/accounts`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  check("a user JWT cannot reach admin", withUserJwt.status === 401);

  const noAuth = await fetch(`${ADMIN_URL}/admin/accounts`);
  check("unauthenticated admin rejected", noAuth.status === 401);
}

section("Auth");
{
  const noAuth = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
  });
  check("unauthenticated rejected", noAuth.status === 401);

  const badSig = jwt.sign({ sub: "u", flow_email: FLOW_EMAIL }, "wrongwrongwrongwrongwrongwrong123");
  const r1 = await rpc("tools/list", {}, badSig);
  check("bad signature rejected", r1.body.error?.data?.code === "invalid_jwt");

  const noEmail = jwt.sign({ sub: "u" }, SECRET, { algorithm: "HS256" });
  const r2 = await rpc("tools/list", {}, noEmail);
  check("missing flow_email rejected", r2.body.error?.data?.code === "missing_flow_email");

  const expired = jwt.sign({ sub: "u", flow_email: FLOW_EMAIL }, SECRET, {
    algorithm: "HS256",
    expiresIn: "-1s",
  });
  const r3 = await rpc("tools/list", {}, expired);
  check("expired JWT rejected", r3.body.error?.data?.code === "invalid_jwt");

  const badEmail = jwt.sign({ sub: "u", flow_email: "not-an-email" }, SECRET, { algorithm: "HS256" });
  const r4 = await rpc("tools/list", {}, badEmail);
  check("malformed flow_email rejected", r4.body.error?.data?.code === "invalid_flow_email");

  const getMcp = await fetch(MCP_URL, { headers: { Authorization: `Bearer ${token()}` } });
  check("GET /mcp returns 405", getMcp.status === 405);
}

/* ===================================================================== */

console.log(
  `\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m` +
    (failures.length ? `\n\nFailures:\n${failures.map((f) => `  - ${f}`).join("\n")}` : ""),
);
process.exit(failures.length ? 1 : 0);
