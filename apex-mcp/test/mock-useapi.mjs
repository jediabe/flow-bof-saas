/**
 * Mock useapi.net Google Flow v1 upstream.
 *
 * Response shapes are copied from the published documentation, including its
 * inconsistencies — `jobId` on sync responses vs `jobid` on async ones, the
 * doubly-nested mediaGenerationId on uploads, images arriving as
 * media[].image.generatedImage while videos arrive flat. Those quirks are
 * exactly what the normalization layer exists to absorb, so a mock that
 * smoothed them over would test nothing.
 *
 * Video jobs advance created -> started -> completed on a timer so polling is
 * real rather than instant.
 *
 * Error injection: put a marker in the prompt to force a failure.
 *   [[402]] [[429]] [[596]] [[400]] [[503]] [[fail]]
 *
 * Run: node test/mock-useapi.mjs [port]
 */

import express from "express";

const PORT = Number(process.argv[2] ?? 4010);
const ACCOUNT = "flowtester@gmail.com";
const OTHER_ACCOUNT = "someone-else@gmail.com";

/** Video job completion delay, kept short so tests stay fast. */
const JOB_MS = Number(process.env.MOCK_JOB_MS ?? 2500);

const app = express();
app.use(express.json({ limit: "50mb" }));
// Raw binary uploads.
app.use(
  express.raw({
    type: ["image/png", "image/jpeg", "image/webp", "video/mp4"],
    limit: "120mb",
  }),
);

const jobs = new Map();
let credits = 18_760;
let seq = 0;

const maskEmail = (e) => `${e.slice(0, 2)}***${e.slice(e.indexOf("@"))}`;
const now = () => new Date().toISOString();

function mediaGenId(kind, email = ACCOUNT) {
  return `user:12345-email:${Buffer.from(email).toString("hex").slice(0, 8)}-${kind}:${++seq}-abcdef`;
}

/** Every request must carry the token, prefix included. */
app.use((req, res, next) => {
  const auth = req.header("authorization") ?? "";
  if (!/^Bearer user:/.test(auth)) {
    return res.status(401).json({ error: "Invalid token. Include the 'user:' prefix." });
  }
  next();
});

/** Lets a test force any documented failure through the prompt. */
function injected(req, res) {
  const text = JSON.stringify(req.body ?? {});
  const code = /\[\[(\d{3})\]\]/.exec(text)?.[1];
  if (!code) return false;

  const bodies = {
    400: { error: "PUBLIC_ERROR_UNSAFE_GENERATION: prompt rejected by safety filters" },
    402: { error: "Insufficient credits for veo-3.1-quality (100 required, 12 available)" },
    429: { error: "PUBLIC_ERROR_USER_REQUESTS_THROTTLED" },
    503: { error: "Captcha service failed: no credits remaining" },
    596: { error: "Google session refresh failed. The account needs to be reconfigured." },
  };
  if (Number(code) === 429) res.set("Retry-After", "1800");
  res.status(Number(code)).json(bodies[code] ?? { error: `Injected ${code}` });
  return true;
}

/* ------------------------------- accounts ------------------------------- */

app.get("/v1/google-flow/accounts", (_req, res) => {
  res.json({
    [maskEmail(ACCOUNT)]: {
      created: "2026-07-01T10:00:00.000Z",
      health: "OK",
      nextRefresh: { messageId: "m1", scheduledFor: "2026-08-07T13:00:00.000Z" },
      project: { projectId: "p-123", projectTitle: "Untitled project" },
      sessionData: { expires: "2026-08-07T14:00:00.000Z" },
    },
    [maskEmail(OTHER_ACCOUNT)]: {
      created: "2026-07-14T10:00:00.000Z",
      health: "Session expired",
      project: { projectId: "p-456", projectTitle: "Untitled project" },
      sessionData: { expires: "2026-08-01T10:00:00.000Z" },
    },
  });
});

app.get("/v1/google-flow/accounts/:email", (req, res) => {
  const email = decodeURIComponent(req.params.email);
  if (email === "broken@gmail.com") {
    return res.json({ created: "2026-07-01T10:00:00.000Z", health: "Session expired" });
  }
  res.json({
    created: "2026-07-01T10:00:00.000Z",
    health: "OK",
    project: { projectId: "p-123", projectTitle: "Untitled project" },
    nextRefresh: { messageId: "m1", scheduledFor: "2026-08-07T13:00:00.000Z" },
    sessionData: { user: { name: "Flow Tester", email }, expires: "2026-08-07T14:00:00.000Z" },
    credits: { credits, userPaygateTier: "PAYGATE_TIER_TWO" },
    models: {
      videoModels: [
        { key: "veo-3.1-fast", displayName: "Veo 3.1 Fast", creditCost: 20,
          supportedAspectRatios: ["landscape", "portrait"], videoLengthSeconds: 8,
          paygateTier: "PAYGATE_TIER_ONE", accessType: "INCLUDED" },
        { key: "veo-3.1-quality", displayName: "Veo 3.1 Quality", creditCost: 100,
          supportedAspectRatios: ["landscape", "portrait", "1:1"], videoLengthSeconds: 8,
          paygateTier: "PAYGATE_TIER_TWO", accessType: "INCLUDED" },
        { key: "omni-flash", displayName: "Gemini Omni Flash", creditCost: 25,
          supportedAspectRatios: ["landscape", "portrait"], videoLengthSeconds: 10,
          paygateTier: "PAYGATE_TIER_ONE", accessType: "INCLUDED" },
      ],
    },
  });
});

app.post("/v1/google-flow/accounts", (req, res) => {
  const { cookies } = req.body ?? {};
  if (!cookies || !String(cookies).includes("__Secure-1PSID")) {
    return res.status(400).json({ error: "Failed to validate cookies: 401 Unauthorized" });
  }
  res.status(201).json({
    created: now(),
    health: "OK",
    accountCookies: ["<redacted>"],
    sessionCookies: ["<redacted>"],
    sessionData: {
      user: { name: "Flow Tester", email: ACCOUNT, image: "https://x/y.png" },
      expires: "2026-08-07T14:00:00.000Z",
      access_token: "<redacted>",
    },
    project: { projectId: "p-123", projectTitle: "Untitled project" },
    nextRefresh: { messageId: "m1", scheduledFor: "2026-08-07T13:00:00.000Z" },
  });
});

app.delete("/v1/google-flow/accounts/:email", (req, res) => {
  res.json({ deleted: true, email: decodeURIComponent(req.params.email) });
});

// In-memory captcha-provider state so tests can round-trip
// POST -> GET the way the real service does. Starts with the
// 300-free-CapSolver-credits scenario that new accounts see.
const captchaState = { providers: /** @type {Record<string,string>} */ ({}) };

app.get("/v1/google-flow/accounts/captcha-providers", (_req, res) => {
  const keys = Object.keys(captchaState.providers);
  if (keys.length === 0) {
    return res.json({ freeCaptchaCredits: 300 });
  }
  // Masked keys — mirror useapi.net's actual response shape.
  const masked = {};
  for (const [k, v] of Object.entries(captchaState.providers)) {
    masked[k] = `${v.slice(0, 4)}***${v.slice(-3)}`;
  }
  res.json(masked);
});

app.post("/v1/google-flow/accounts/captcha-providers", (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "body must be a JSON object" });
  }
  const validKeys = new Set([
    "CapSolver",
    "AntiCaptcha",
    "YesCaptcha",
    "SolveCaptcha",
    "2Captcha",
    "EzCaptcha",
  ]);
  for (const k of Object.keys(body)) {
    if (!validKeys.has(k)) {
      return res.status(400).json({ error: `unknown provider "${k}"` });
    }
  }
  // Merge (partial updates supported per docs).
  Object.assign(captchaState.providers, body);
  const masked = {};
  for (const [k, v] of Object.entries(captchaState.providers)) {
    masked[k] = `${String(v).slice(0, 4)}***${String(v).slice(-3)}`;
  }
  res.json(masked);
});

app.get("/v1/google-flow/accounts/captcha-stats", (req, res) => {
  if (req.query.anonymized === "true") {
    return res.json({
      anonymized: true,
      totalSolves: 10000,
      overallSuccessRate: 0.94,
    });
  }
  res.json({
    stats: [
      { date: "2026-08-11", provider: "CapSolver", successCount: 412, failureCount: 9, successRate: 0.978 },
    ],
    remainingFreeCredits: 0,
  });
});

/* -------------------------------- images -------------------------------- */

app.post("/v1/google-flow/images", (req, res) => {
  if (injected(req, res)) return;
  const { prompt, count = 4, seed, model = "nano-banana-2-lite", aspectRatio = "16:9" } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  res.json({
    jobId: `j${Date.now()}i-u12345-email:${maskEmail(ACCOUNT)}-bot:google-flow`,
    media: Array.from({ length: count }, (_, i) => ({
      image: {
        generatedImage: {
          seed: seed ?? 1000 + i,
          mediaGenerationId: mediaGenId("image"),
          mediaVisibility: "PRIVATE",
          prompt,
          modelNameType: model,
          workflowId: "wf-1",
          fifeUrl: `https://storage.googleapis.com/mock/image-${i}.png?Expires=999`,
          aspectRatio,
        },
      },
    })),
    captcha: { service: "capsolver", taskId: "t1", durationMs: 1200, attempts: [] },
  });
});

app.post("/v1/google-flow/images/upscale", (req, res) => {
  if (injected(req, res)) return;
  if (!req.body?.mediaGenerationId)
    return res.status(400).json({ error: "mediaGenerationId is required" });
  res.json({
    encodedImage: Buffer.from("x".repeat(9000)).toString("base64"),
    captcha: { service: "capsolver" },
  });
});

/* -------------------------------- videos -------------------------------- */

function completeJob(jobId, request) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "started";
  job.updated = now();

  setTimeout(() => {
    const j = jobs.get(jobId);
    if (!j) return;
    credits -= 20;
    j.status = "completed";
    j.updated = now();
    j.response = {
      media: Array.from({ length: request.count ?? 1 }, () => ({
        name: "media/1",
        mediaGenerationId: mediaGenId("video"),
        videoUrl: `https://flow-content.google/video/${seq}.mp4?Expires=999`,
        thumbnailUrl: `https://flow-content.google/image/${seq}.png?Expires=999`,
        video: {
          generatedVideo: {
            seed: request.seed ?? 4242,
            prompt: request.prompt,
            model: request.model ?? "veo-3.1-fast",
            aspectRatio: request.aspectRatio ?? "landscape",
            isLooped: false,
          },
          dimensions: { length: `${request.duration ?? 8}.000s` },
        },
      })),
      remainingCredits: credits,
    };
  }, JOB_MS);
}

function submitVideo(req, res, kind) {
  if (injected(req, res)) return;
  const request = req.body ?? {};

  if (kind === "generate" && !request.prompt)
    return res.status(400).json({ error: "prompt is required" });
  if (kind !== "generate" && !request.mediaGenerationId)
    return res.status(400).json({ error: "mediaGenerationId is required" });

  // Documented constraint: omni-flash rejects endImage.
  if (request.model === "omni-flash" && request.endImage)
    return res.status(400).json({ error: "endImage is not supported by omni-flash" });
  // Documented constraint: quality tier rejects reference images.
  if (request.model === "veo-3.1-quality" && request.referenceImage_1)
    return res.status(400).json({ error: "referenceImage is not supported on veo-3.1-quality" });

  const jobId = `j${Date.now()}v-u12345-email:${maskEmail(ACCOUNT)}-bot:google-flow`;

  if (request.async === false) {
    credits -= 20;
    return res.json({
      jobId,
      media: [
        {
          mediaGenerationId: mediaGenId("video"),
          videoUrl: `https://flow-content.google/video/sync.mp4?Expires=999`,
          thumbnailUrl: `https://flow-content.google/image/sync.png?Expires=999`,
          video: {
            generatedVideo: {
              seed: request.seed ?? 7,
              prompt: request.prompt,
              model: request.model ?? "veo-3.1-fast",
              aspectRatio: request.aspectRatio ?? "landscape",
            },
            dimensions: { length: `${request.duration ?? 8}.000s` },
          },
        },
      ],
      remainingCredits: credits,
    });
  }

  // Note the lowercase `jobid` on the async path — this is what the docs show.
  jobs.set(jobId, { jobid: jobId, type: "video", status: "created", created: now(), request });
  res.status(201).json({
    jobid: jobId,
    type: "video",
    status: "created",
    created: now(),
    request,
  });
  completeJob(jobId, request);
}

app.post("/v1/google-flow/videos", (req, res) => submitVideo(req, res, "generate"));
app.post("/v1/google-flow/videos/extend", (req, res) => submitVideo(req, res, "extend"));
app.post("/v1/google-flow/videos/upscale", (req, res) => submitVideo(req, res, "upscale"));

app.post("/v1/google-flow/videos/gif", (req, res) => {
  if (!req.body?.mediaGenerationId)
    return res.status(400).json({ error: "mediaGenerationId is required" });
  if (req.body.mediaGenerationId.includes("image:"))
    return res.status(400).json({ error: "mediaGenerationId must reference a video" });
  res.json({ encodedGif: Buffer.from("g".repeat(60_000)).toString("base64") });
});

app.post("/v1/google-flow/videos/concatenate", (req, res) => {
  const media = req.body?.media;
  if (!Array.isArray(media) || media.length < 2)
    return res.status(400).json({ error: "media must contain 2-10 items" });
  res.json({
    jobId: `j${Date.now()}v-u12345-email:${maskEmail(ACCOUNT)}-bot:google-flow`,
    status: "MEDIA_GENERATION_STATUS_SUCCESSFUL",
    inputsCount: media.length,
    encodedVideo: Buffer.from("v".repeat(120_000)).toString("base64"),
  });
});

/* --------------------------------- jobs --------------------------------- */

app.get("/v1/google-flow/jobs", (_req, res) => {
  res.json({
    emails: [maskEmail(ACCOUNT)],
    combined: {
      summary: {
        [maskEmail(ACCOUNT)]: {
          executing: [...jobs.values()].filter((j) => j.status !== "completed").length,
          completed: [...jobs.values()].filter((j) => j.status === "completed").length,
          failed: 0, rateLimited: 0, avgResponseTime: 92_000, score: 100,
        },
      },
    },
  });
});

app.get("/v1/google-flow/jobs/:jobId", (req, res) => {
  // Deliberately strict: look the id up EXACTLY as it arrived on the wire.
  // The real API's own reference client and curl examples pass the jobId raw,
  // so a percent-encoded one must 404 here too. An earlier version of this mock
  // called decodeURIComponent and therefore agreed with a client bug that the
  // real API rejects.
  // Express decodes req.params, so inspect the untouched URL instead —
  // otherwise this check silently passes on the very input it exists to reject.
  if (/%3A|%40/i.test(req.originalUrl)) {
    return res.status(404).json({
      error:
        "Job not found. The jobId arrived percent-encoded; pass it raw, as the " +
        "reference client and the documented curl example do.",
    });
  }
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

/* -------------------------------- assets -------------------------------- */

app.post("/v1/google-flow/assets/:email?", (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!bytes.length) return res.status(400).json({ error: "Empty body" });

  const isVideo = (req.header("content-type") ?? "").startsWith("video/");
  res.json({
    media: isVideo
      ? { video: { dimensions: { width: 1920, height: 1080, length: "11.940s" } } }
      : { name: "media/x", image: { dimensions: { width: 1024, height: 1024 } } },
    // Note the double nesting — this is what the docs show.
    mediaGenerationId: { mediaGenerationId: mediaGenId(isVideo ? "video" : "image") },
    ...(isVideo ? { durationSeconds: 11.94 } : {}),
    width: isVideo ? 1920 : 1024,
    height: isVideo ? 1080 : 1024,
    email: req.params.email ? decodeURIComponent(req.params.email) : ACCOUNT,
  });
});

app.get("/v1/google-flow/assets/:id", (req, res) => {
  res.json({
    url: `https://storage.googleapis.com/mock/resolved.mp4?Expires=999`,
    mediaGenerationId: decodeURIComponent(req.params.id),
  });
});

/* -------------------------- characters and voices ------------------------ */

const characters = new Map();
const userVoices = new Map();
const SYSTEM_VOICES = ["Kore", "Puck", "Charon", "Zephyr", "Aoede"];

app.get("/v1/google-flow/characters", (req, res) => {
  if (!req.query.email) return res.status(400).json({ error: "email query param is required" });
  // The list reports the ref without the -imgs:N suffix.
  res.json({
    characters: [...characters.values()].map(({ listedAs, ...c }) => ({
      ...c,
      character: listedAs ?? c.character,
    })),
  });
});

app.post("/v1/google-flow/characters", (req, res) => {
  const { displayName, imageReference_1, personalityNotes, voice } = req.body ?? {};
  if (!displayName || !imageReference_1)
    return res.status(400).json({ error: "displayName and imageReference_1 are required" });

  // Real refs look like:
  //   user:2998-email:<hex>-character:<uuid>-imgs:1
  // and the list appears to return them WITHOUT the trailing -imgs:N. Reproduce
  // that here so the client is forced to match on something stable.
  const uuid = `e226df5b-e06b-4563-b14f-${String(characters.size + 1).padStart(12, "0")}`;
  const base = `user:12345-email:666c6f77-character:${uuid}`;
  const ref = `${base}-imgs:1`;
  const rec = {
    character: ref, listedAs: base, entityId: `e-${characters.size + 1}`, displayName,
    personalityNotes: personalityNotes ?? "",
    imageReferences: [{ mediaId: imageReference_1 }],
    voice: voice ?? null, createTime: now(),
  };
  characters.set(ref, rec);
  res.json(rec);
});

const findCharacter = (ref) => {
  const want = ref.replace(/-imgs:\d+$/, "");
  for (const c of characters.values()) {
    if (c.character === ref || c.character.replace(/-imgs:\d+$/, "") === want) return c;
  }
  return undefined;
};

app.get("/v1/google-flow/characters/:ref", (req, res) => {
  const rec = findCharacter(req.params.ref);
  if (!rec) return res.status(404).json({ error: "Character not found" });
  res.json({ ...rec, thumbnailUrl: "https://mock/thumb.png" });
});

app.delete("/v1/google-flow/characters/:ref", (req, res) => {
  const rec = findCharacter(req.params.ref);
  if (!rec) return res.status(404).json({ error: "Character not found" });
  characters.delete(rec.character);
  res.json({ deleted: true, entityId: rec.entityId, character: rec.character });
});

app.get("/v1/google-flow/voices", (req, res) => {
  if (!req.query.email) return res.status(400).json({ error: "email query param is required" });
  const system = SYSTEM_VOICES.map((v) => ({
    voice: v, source: "system", displayName: v,
    sampleUrl: `https://www.gstatic.com/aitestkitchen/voices/samples/${v}.wav`,
  }));
  const user = [...userVoices.values()];
  const src = req.query.source;
  res.json({ voices: src === "system" ? system : src === "user" ? user : [...system, ...user] });
});

app.post("/v1/google-flow/voices", (req, res) => {
  const { email, voice, displayName, dialog, voicePerformance } = req.body ?? {};
  for (const [k, v] of Object.entries({ email, voice, displayName, dialog, voicePerformance })) {
    if (!v) return res.status(400).json({ error: `${k} is required` });
  }
  const ref = `user-voice-${userVoices.size + 1}`;
  const rec = {
    voice: ref, source: "user", workflowId: "wf-v1", displayName,
    baseVoice: voice, dialog, voicePerformance,
    audioUrl: "https://mock/voice.wav",
  };
  userVoices.set(ref, rec);
  res.json(rec);
});

app.get("/v1/google-flow/voices/:ref", (req, res) => {
  const ref = decodeURIComponent(req.params.ref);
  if (SYSTEM_VOICES.includes(ref)) {
    return res.json({
      voice: ref, source: "system", displayName: ref,
      sampleUrl: `https://www.gstatic.com/aitestkitchen/voices/samples/${ref}.wav`,
    });
  }
  const rec = userVoices.get(ref);
  if (!rec) return res.status(404).json({ error: "Voice not found" });
  res.json(rec);
});

app.delete("/v1/google-flow/voices/:ref", (req, res) => {
  const ref = decodeURIComponent(req.params.ref);
  if (SYSTEM_VOICES.includes(ref))
    return res.status(400).json({ error: "System voices cannot be deleted" });
  if (!userVoices.delete(ref)) return res.status(404).json({ error: "Voice not found" });
  res.json({ deleted: true, workflowId: "wf-v1", voice: ref });
});

app.use((req, res) => {
  console.error(`[mock] unhandled ${req.method} ${req.path}`);
  res.status(404).json({ error: `No mock route for ${req.method} ${req.path}` });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`mock useapi.net listening on http://127.0.0.1:${PORT}/v1/google-flow`);
});
