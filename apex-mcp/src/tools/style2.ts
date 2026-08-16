/**
 * Style 2 MCP tool + prompt registration.
 *
 * Wires the pure functions in ./style2/*.ts up to MCP:
 *   - apex_style2_roll_scene         (pure)
 *   - apex_style2_build_clip_prompts (pure)
 *   - apex_style2_validate_copy      (pure)
 *   - apex_style2_next_step          (dispatches to /images or /videos)
 *
 * Also registers the style2_copywriter MCP prompt so the calling
 * model can produce the copy blocks then validate them.
 *
 * The three pure tools do NOT need a per-request GoogleFlowClient
 * — no upstream call, no credentials. next_step DOES need it
 * because it fires Nano / Veo generation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compact, expandSlots } from "../services/client.js";
import { formatToolError } from "../services/errors.js";
import { ResponseFormat } from "../types.js";
import { responseFormatParam, seedParam } from "../schemas/common.js";
import { generationResult, result, runTool } from "./shared.js";
import { rollScenePure } from "./style2/scene.js";
import { PRODUCT_TYPES } from "./style2/menus.js";
import {
  buildClipPromptsPure,
  DEMO_AREAS,
  DURATION_STRATEGIES,
  PRODUCT_FORMS,
  type ClipStep,
} from "./style2/chain.js";
import { MARKETS, validateCopyPure } from "./style2/copy.js";
import { getStyle2AgentInstructions } from "./style2/agent-instructions.js";
import { SYNC_GENERATION_TIMEOUT_MS } from "../constants.js";

/* ==================================================================
 * runPure — mirrors runTool for the pure tools that don't need a
 * GoogleFlowClient. Keeps error mapping and CallToolResult shape
 * consistent with the rest of the server.
 * ================================================================ */

async function runPure(
  fn: () => Promise<CallToolResult> | CallToolResult,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: formatToolError(error) }],
    };
  }
}

/* ==================================================================
 * Registration entry point
 * ================================================================ */

export function registerStyle2Tools(server: McpServer): void {
  registerRollScene(server);
  registerBuildClipPrompts(server);
  registerValidateCopy(server);
  registerNextStep(server);
  registerCopywriterPrompt(server);
  registerFlowAgentV6Prompt(server);
}

/* ------------------------------------------------------------------
 * apex_style2_roll_scene
 * ---------------------------------------------------------------- */

function registerRollScene(server: McpServer): void {
  server.registerTool(
    "apex_style2_roll_scene",
    {
      title: "Style 2 · Roll a fresh scene",
      description: `Deterministically roll a fresh Style 2 scene for the promoted product. Picks the room from the product type per SOP §3, rolls one value from every rotation menu for that room, produces a stable scene_hash, and assembles the finished scene-image prompt ready for google_flow_generate_image.

Anti-repetition is ACCOUNT-SAFETY CRITICAL. Near-identical videos trigger TikTok's repetitive-content flag, which bans accounts. The server is stateless — it cannot remember past scenes — so the CALLER must pass every recently-used scene_hash in recent_scene_hashes and store the returned scene_hash for future calls. If the caller ignores this, nothing else will warn them.

Provide seed for reproducible rolls (tests / debugging). Omit for a fresh random roll.

Returns:
  { "product_type": string, "room": "bathroom" | "kitchen" | "outdoor" | "bedroom",
    "scene_hash": string, "collision": boolean, "seed": number,
    "rolls": { style: string, mirror: string, outfit: string, camera_angle: string, ... },
    "scene_prompt": string, "notes": string[] }

Examples:
  - "Roll a bathroom scene for a face serum, avoid our last 12" -> product_type: "skincare_beauty_makeup_haircare", recent_scene_hashes: [...]
  - "Deterministic scene for the countertop slushie" -> product_type: "home_kitchen", seed: 42
  - "Fashion scene for a top" -> product_type: "clothing_fashion_shoes" (returns bedroom + garment-reference notes)

Errors: pure function; the only failure mode is an invalid product_type, caught by the schema.`,
      inputSchema: {
        product_type: z
          .enum(PRODUCT_TYPES)
          .describe(
            "SOP §3 product type. Drives room selection (skincare/beauty/makeup/haircare → bathroom, clothing/fashion/shoes → bedroom, outdoor/garden/fitness → outdoor, home/kitchen → kitchen, other → bathroom fallback with a note).",
          ),
        recent_scene_hashes: z
          .array(z.string())
          .max(500)
          .optional()
          .describe(
            "scene_hash values from every recently-used scene. The tool re-rolls until it finds a combination not in this set (max 50 attempts). Missing this defeats anti-repetition — bans follow.",
          ),
        seed: seedParam,
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) =>
      runPure(async () => {
        const rolled = rollScenePure({
          product_type: params.product_type,
          ...(params.recent_scene_hashes ? { recent_scene_hashes: params.recent_scene_hashes } : {}),
          ...(params.seed !== undefined ? { seed: params.seed } : {}),
        });
        const md = [
          `# Style 2 scene rolled`,
          "",
          `- **room**: ${rolled.room}`,
          `- **scene_hash**: \`${rolled.scene_hash}\`${rolled.collision ? " _(collision — see notes)_" : ""}`,
          `- **seed**: ${rolled.seed}`,
          "",
          "## Rolls",
          ...Object.entries(rolled.rolls).map(([k, v]) => `- **${k}**: ${v}`),
          "",
          "## Scene prompt",
          rolled.scene_prompt,
          rolled.notes.length > 0 ? `\n## Notes\n${rolled.notes.map((n) => `- ${n}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return result(
          rolled as unknown as Record<string, unknown>,
          md,
          params.response_format,
        );
      }),
  );
}

/* ------------------------------------------------------------------
 * apex_style2_build_clip_prompts
 * ---------------------------------------------------------------- */

function registerBuildClipPrompts(server: McpServer): void {
  server.registerTool(
    "apex_style2_build_clip_prompts",
    {
      title: "Style 2 · Build the clip chain",
      description: `Deterministically assemble the Nano/Veo clip chain for a Style 2 video. Given the scene from apex_style2_roll_scene, the product name, and its physical form, returns the ordered list of steps ready to feed to apex_style2_next_step.

Chain kind depends on product_form (SOP §4):
  - handheld (skincare, makeup, small gadgets)  → 7 clips N1..N7
  - large_countertop (appliance / machine)       → 7 clips N1..N7 with the SOP §4 countertop swaps (unit never moves, no push-in, no animation of the machine, demo shows the RESULT)
  - worn (clothing / shoes / accessories)        → 3-clip mirror try-on, REQUIRES TWO reference images (avatar + garment)

Demo area is derived from product_form per SOP §4 (lip → LIPS, eye → under-eye, spray/pump → the area, etc). Defaulting to the face is an explicit SOP failure — pass demo_area only if you're overriding for a product that doesn't fit the table.

duration_strategy defaults to generate_8_and_trim (works on every tier). Set "native" only when the account is on Google AI Ultra ($199) — cheaper tiers 402 on 4s/6s Veo requests.

Returns:
  { "product_form": string, "chain_kind": "handheld" | "countertop" | "worn",
    "demo_area": string, "reference_images_required": 1 | 2,
    "duration_strategy": string,
    "steps": [{ "id": "N1", "engine": "veo", "duration_seconds": 4,
                 "request_duration_seconds": 8, "trim_to_seconds": 4,
                 "prompt": string, "continues_from": null,
                 "reference_image_count": 1, "notes": [] }, ...],
    "notes": string[] }

Every Veo step prompt contains "no talking, no lip movement" — the SOP is silent-by-design and voiceover sits on top; a lip-syncing clip is a re-shoot.

Errors: pure function; invalid enums surface via the schema.`,
      inputSchema: {
        scene_prompt: z
          .string()
          .min(1, "scene_prompt is required")
          .max(5000)
          .describe(
            "The scene_prompt returned by apex_style2_roll_scene. Anchored into every step so the clips share room/framing/props.",
          ),
        product_name: z
          .string()
          .min(1, "product_name is required")
          .max(200)
          .describe("The exact product name as it appears on the label. Injected into N2, N4, N6 and N7."),
        product_form: z
          .enum(PRODUCT_FORMS)
          .describe(
            "SOP §4 product form. Determines the chain structure: cream/serum/pump/spray/eye_patch/razor/hair/roller/lip/nail/device → 7-clip handheld. large_countertop → 7-clip countertop swap. worn → 3-clip mirror try-on.",
          ),
        product_count: z
          .union([z.literal(1), z.literal(2), z.literal(3)])
          .describe("Number of product units on screen. SOP §4 count rule — must stay constant across N2/N6/N7."),
        demo_area: z
          .enum(DEMO_AREAS)
          .optional()
          .describe(
            "Optional override of the demo area (SOP §4 table). Do not set unless the product doesn't fit the default mapping — never default to face.",
          ),
        duration_strategy: z
          .enum(DURATION_STRATEGIES)
          .optional()
          .describe(
            "generate_8_and_trim (default, works on every tier) or native (requires Google AI Ultra).",
          ),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) =>
      runPure(async () => {
        const built = buildClipPromptsPure({
          scene_prompt: params.scene_prompt,
          product_name: params.product_name,
          product_form: params.product_form,
          product_count: params.product_count,
          ...(params.demo_area ? { demo_area: params.demo_area } : {}),
          ...(params.duration_strategy ? { duration_strategy: params.duration_strategy } : {}),
        });
        const md = [
          `# Style 2 clip chain`,
          "",
          `- **chain_kind**: ${built.chain_kind}`,
          `- **demo_area**: ${built.demo_area}`,
          `- **reference_images_required**: ${built.reference_images_required}`,
          `- **duration_strategy**: ${built.duration_strategy}`,
          "",
          ...built.steps.map((s, i) => renderStepMarkdown(s, i + 1)),
          built.notes.length > 0
            ? `\n## Notes\n${built.notes.map((n) => `- ${n}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        return result(built as unknown as Record<string, unknown>, md, params.response_format);
      }),
  );
}

function renderStepMarkdown(s: ClipStep, ordinal: number): string {
  const lines = [
    `## ${ordinal}. ${s.id} · ${s.engine} · ${s.duration_seconds}s`,
    s.engine === "veo"
      ? `- request_duration: ${s.request_duration_seconds}s${s.trim_to_seconds ? ` (trim to ${s.trim_to_seconds}s in post)` : ""}`
      : "",
    s.continues_from ? `- continues_from: ${s.continues_from}` : "",
    `- reference_image_count: ${s.reference_image_count}`,
    "",
    "```",
    s.prompt,
    "```",
  ];
  return lines.filter(Boolean).join("\n");
}

/* ------------------------------------------------------------------
 * apex_style2_validate_copy
 * ---------------------------------------------------------------- */

function registerValidateCopy(server: McpServer): void {
  server.registerTool(
    "apex_style2_validate_copy",
    {
      title: "Style 2 · Validate copy against SOP §6 compliance rules",
      description: `Compliance gate for Style 2 copy — hook, benefit, CTA and voiceover. Enforces every rule from SOP §6 and returns violations with severity + concrete fix. Call BEFORE handing copy to the voice tool.

Rules enforced:
  - US: no digits, %, or currency symbols ANYWHERE. High severity.
  - UK: no £/$ prices; must include % or the word "voucher".
  - No result / improvement / before-after wording ("lighter", "fuller", "gone", "reduces", etc). Prefer false positives — a missed one gets a video removed.
  - No medical or absolute claims ("cures", "clinically proven", "100%").
  - No fabricated pricing-error / glitch framing ("TikTok made a mistake").
  - No fake scarcity ("discontinuing") unless scarcity_is_true=true.
  - No profanity, including censored forms.
  - Voiceover word count 70-75. Under 65 is a hard failure with the SOP's "script is WRONG" message. Actual count always returned.
  - Benefit ≤8 words; CTA <10 words; max one emoji per card.
  - Warning when the last word looks truncated by an emoji ("21% of" instead of "21% off").

Returns:
  { "passed": boolean,
    "voiceover_word_count": number,
    "violations": [{ "rule": string, "severity": "high" | "medium" | "low",
                     "field": "hook" | "benefit" | "cta" | "voiceover" | "cross",
                     "detail": string, "fix": string }] }

passed=true only if there are NO high or medium violations. Low (warnings) don't fail.

Examples:
  - "Check this US script" -> market: "US", ... — any digit fails.
  - "Check this UK caption" -> market: "UK", hook_text: "21% off... 👀", ... — passes.
  - "Same UK script but no % anywhere" -> uk_deal_missing violation.

Errors: pure function; the only failure is a schema violation on market.`,
      inputSchema: {
        market: z.enum(MARKETS).describe("UK or US. Drives the deal rule."),
        hook_text: z.string().max(500).describe("The HOOK card text (over N1 shock)."),
        benefit_text: z.string().max(500).describe("The BENEFIT card text (over N4-N5 demo). ≤8 words per SOP §6."),
        cta_text: z.string().max(500).describe("The CTA card text (over N6-N7 end). <10 words per SOP §6."),
        voiceover: z
          .string()
          .max(5000)
          .describe("The full voiceover script. Must be 70-75 words; <65 is a hard failure."),
        scarcity_is_true: z
          .boolean()
          .optional()
          .describe(
            "Set true ONLY when the discontinuing / gone-forever claim is genuinely true (SOP §6). Default false catches fabricated scarcity.",
          ),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) =>
      runPure(async () => {
        const out = validateCopyPure({
          market: params.market,
          hook_text: params.hook_text,
          benefit_text: params.benefit_text,
          cta_text: params.cta_text,
          voiceover: params.voiceover,
          ...(params.scarcity_is_true !== undefined
            ? { scarcity_is_true: params.scarcity_is_true }
            : {}),
        });
        const md = [
          `# Copy validation ${out.passed ? "✅ PASSED" : "❌ FAILED"}`,
          "",
          `- **voiceover word count**: ${out.voiceover_word_count} (SOP requires 70-75)`,
          `- **violations**: ${out.violations.length}`,
          "",
          ...out.violations.map(
            (v, i) =>
              `## ${i + 1}. ${v.severity.toUpperCase()} · ${v.field} · ${v.rule}\n\n**Detail:** ${v.detail}\n\n**Fix:** ${v.fix}`,
          ),
        ].join("\n");
        return result(out as unknown as Record<string, unknown>, md, params.response_format);
      }),
  );
}

/* ------------------------------------------------------------------
 * apex_style2_next_step
 *
 * Runs ONE step of the chain: either a Nano image or a Veo video.
 * The caller drives the loop by:
 *   1. Calling once per step in order (0..N)
 *   2. Feeding the previous step's mediaGenerationId back in as
 *      previous_output_media_id
 *   3. For async Veo steps, polling google_flow_get_job themselves
 *
 * We don't build a background runner: 7 clips × ~2 min is over
 * 10 minutes of wall clock, which no MCP tool call should hold.
 * One step per call, model-driven, is the correct shape for a
 * stateless server.
 * ---------------------------------------------------------------- */

function registerNextStep(server: McpServer): void {
  const stepShape = z.object({
    id: z.string(),
    engine: z.enum(["nano", "veo"]),
    duration_seconds: z.number(),
    request_duration_seconds: z.number(),
    trim_to_seconds: z.number().nullable(),
    prompt: z.string(),
    continues_from: z.string().nullable(),
    reference_image_count: z.union([z.literal(1), z.literal(2)]),
    notes: z.array(z.string()),
  });

  server.registerTool(
    "apex_style2_next_step",
    {
      title: "Style 2 · Execute the next chain step",
      description: `Execute EXACTLY ONE step of the Style 2 chain. The caller drives the loop by calling once per step, feeding the previous step's mediaGenerationId back in as previous_output_media_id.

CRITICAL — avatar re-attachment on every step. avatar_media_id is REQUIRED on every single invocation of this tool, on every step of the chain. The MCP server is stateless: it does not remember the avatar between calls, and Google Flow does not "carry" reference images across separate generations. If the caller omits avatar_media_id on ANY step (including mid-chain steps 4-7 where it's tempting to skip because "she was already established in step 3"), the character drifts and the whole video is a re-shoot. Copy the SAME avatar_media_id into every call in the same conversation — do not swap it, do not upgrade it, do not omit it. The schema enforces .min(1), so an empty string is also rejected.

Same rule for product_media_id (must be passed on every Nano step that shows the product — N2, N4, N6 in the standard chain) and garment_media_id (must be passed on every step of a worn chain, alongside the avatar).

Never blocks on Veo — Veo steps return a jobId immediately and the caller polls google_flow_get_job. That's why this tool is single-step: a 7-clip chain is over 10 minutes of wall clock, which no MCP tool call should hold.

References attached per step:
  - avatar_media_id: EVERY step, no exceptions (face-drift mitigation).
  - product_media_id: attached to Nano steps that show the product (typically N2/N4/N6) so the model sees the physical product's shape and label.
  - garment_media_id: REQUIRED for worn chains — attached to EVERY step alongside the avatar. Missing it means the garment won't appear.

Returns the same shape as google_flow_generate_image (Nano) or google_flow_generate_video (Veo):
  { "operation": string, "mode": "sync" | "async", "jobId": string,
    "status": string, "media": [...], ... }

Errors:
  - 402: veo-3.1 4s/6s durations need Google AI Ultra. Rebuild the chain with duration_strategy=generate_8_and_trim.
  - 400 PUBLIC_ERROR_UNSAFE_GENERATION: the SOP prompts occasionally trip safety filters — rebuild with a different product name if it persists.
  - Missing garment_media_id when steps.reference_image_count === 2: the tool refuses to run.`,
      inputSchema: {
        steps: z
          .array(stepShape)
          .min(1)
          .describe("The steps array from apex_style2_build_clip_prompts."),
        step_index: z
          .number()
          .int()
          .min(0)
          .describe("Zero-based index of the step to run."),
        avatar_media_id: z
          .string()
          .min(1)
          .describe(
            "mediaGenerationId of the locked avatar image (uploaded once via google_flow_upload_asset). REQUIRED on EVERY invocation of this tool — the server is stateless, so omitting it on any step causes face drift and forces a re-shoot. Copy the same value into every call in the same chain.",
          ),
        product_media_id: z
          .string()
          .optional()
          .describe(
            "mediaGenerationId of the product image. Attached to Nano steps that show the product (typically N2/N4/N6). Pass the SAME value on every call in the chain — the server does not remember it between steps.",
          ),
        previous_output_media_id: z
          .string()
          .optional()
          .describe(
            "mediaGenerationId of the previous step's output. Required for Veo steps with continues_from set (used as start_image).",
          ),
        garment_media_id: z
          .string()
          .optional()
          .describe(
            "mediaGenerationId of the garment image. REQUIRED for worn chains (every step's reference_image_count === 2).",
          ),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const step = params.steps[params.step_index];
        if (!step) {
          throw new Error(
            `step_index ${params.step_index} is out of range for a ${params.steps.length}-step chain.`,
          );
        }
        if (step.reference_image_count === 2 && !params.garment_media_id) {
          throw new Error(
            `Step ${step.id} requires TWO reference images but garment_media_id was not provided. Worn chains need the garment image on every step.`,
          );
        }

        // Reference set — avatar always first, then optional
        // product/garment images per step shape.
        const references: string[] = [params.avatar_media_id];
        if (step.reference_image_count === 2 && params.garment_media_id) {
          references.push(params.garment_media_id);
        } else if (params.product_media_id) {
          // Attach the product image to Nano-only steps so the model
          // sees the label. Skip on Veo — the Nano before it already
          // baked the product into the frame via start_image.
          if (step.engine === "nano") references.push(params.product_media_id);
        }

        if (step.engine === "nano") {
          const raw = await client.request("/images", {
            method: "POST",
            body: compact({
              prompt: step.prompt,
              model: "nano-banana-2-lite",
              aspectRatio: "9:16",
              count: 1,
              email: client.email,
              ...expandSlots("reference", references, 10),
            }),
            timeoutMs: SYNC_GENERATION_TIMEOUT_MS,
          });
          return generationResult(raw, {
            operation: `style2_${step.id}_nano`,
            isAsync: false,
            format: params.response_format,
          });
        }

        // Veo step.
        if (step.continues_from && !params.previous_output_media_id) {
          throw new Error(
            `Step ${step.id} continues from ${step.continues_from} but previous_output_media_id was not provided. Feed the ${step.continues_from} Nano's mediaGenerationId back in.`,
          );
        }
        const body = compact({
          prompt: step.prompt,
          model: "veo-3.1-lite",
          aspectRatio: "portrait",
          duration: step.request_duration_seconds,
          count: 1,
          email: client.email,
          ...(step.continues_from && params.previous_output_media_id
            ? { startImage: params.previous_output_media_id }
            : {}),
          async: true,
          ...expandSlots("referenceImage", references, 7),
        });
        const raw = await client.request("/videos", {
          method: "POST",
          body,
        });
        return generationResult(raw, {
          operation: `style2_${step.id}_veo`,
          isAsync: true,
          format: params.response_format,
        });
      }),
  );
}

/* ------------------------------------------------------------------
 * style2_copywriter MCP prompt
 *
 * Exposes SOP §6 as an authoring template the host model can pull
 * to write hook / benefit / CTA / voiceover copy that will then
 * feed apex_style2_validate_copy.
 * ---------------------------------------------------------------- */

function registerCopywriterPrompt(server: McpServer): void {
  server.registerPrompt(
    "style2_copywriter",
    {
      title: "Style 2 · Copywriter",
      description:
        "SOP §6 copy authoring guide for Style 2 videos. Produces the four copy blocks (hook, benefit, CTA, voiceover) and hands them to apex_style2_validate_copy.",
      argsSchema: {
        market: z.enum(MARKETS).describe("UK or US — drives the deal rule."),
        product_name: z.string().min(1).describe("Exact product name as it appears on the label."),
        discount_percent: z
          .string()
          .optional()
          .describe("The live discount % for UK (e.g. \"21\"). Omit if there is no %; the model will say \"voucher\"."),
        product_form: z
          .enum(PRODUCT_FORMS)
          .describe(
            "Product form. Steers the benefit language — a lip product's benefit is about lips, a spray's about coverage, etc.",
          ),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildCopywriterPromptText(args),
          },
        },
      ],
    }),
  );
}

function buildCopywriterPromptText(args: {
  market: "UK" | "US";
  product_name: string;
  discount_percent?: string | undefined;
  product_form: (typeof PRODUCT_FORMS)[number];
}): string {
  const isUS = args.market === "US";
  const dealClause = isUS
    ? `US market: NO digits, %, or currency ANYWHERE in any copy field. Say "on sale" or "voucher to claim at checkout" and point to the cart.`
    : args.discount_percent
      ? `UK market: state "${args.discount_percent}% off" from the live listing. Never a £/$ price.`
      : `UK market: there is no discount %, so say "voucher" with no number.`;

  return `You are writing Style 2 copy for an Apex TikTok Shop video.

Product: ${args.product_name}
Product form: ${args.product_form}
Market: ${args.market}

Deal rule (SOP §6 — compliance critical):
${dealClause}

Produce the FOUR copy blocks below. Every one has hard rules — the validator (apex_style2_validate_copy) will reject any violation.

## 1. HOOK — 5 options, over N1 shock (~4s)
Big, bold, curiosity / shock. Names the product + the deal. Max one emoji per option. Use these five shapes across the options:
  - apology ("I'm so sorry to everyone who bought the ${args.product_name} before this sale…")
  - "WAIT…"
  - everyone's-grabbing-it
  - this-is-your-sign
  - POV

## 2. BENEFIT — 5 options, over the N4-N5 demo
ONE real IN-THE-MOMENT benefit — how it looks/feels IN THE MOMENT (texture, tint, glide, feel, comfort, colour). ≤8 words. Max one emoji. NEVER a result / improvement / before-after ("lips look fuller", "wrinkles gone", "dark circles lighter" are all bans — the video gets pulled).

## 3. CTA — 5 options, over the N6-N7 end
Restate the deal + tap. Under 10 words. ${isUS ? "Say \"on sale\" or \"voucher\" — never a number." : "Include the % or the word \"voucher\"."} UK says "basket", US says "cart".

## 4. VOICEOVER — 70-75 words, ONE take, runs over N2-N7 starting at ~4s
Casual, excited, first-person, like talking to a close friend. Never an ad read. Use "…" for natural pauses; put ONE word in CAPS for emphasis.

Structure:
  - Opener ("so this is the ${args.product_name} everyone's been going on about…")
  - TWO genuine experiential benefits (texture / tint / glide / feel / colour — NEVER a result)
  - The deal (${isUS ? "on sale / voucher" : args.discount_percent ? `${args.discount_percent}% off` : "voucher"})
  - CTA ("tap the orange ${isUS ? "cart" : "basket"} before the sale ends")

**HARD LENGTH RULE: 70-75 words. Count them. Under 65 is WRONG — never output a short 20-45 word script. Under 70: add benefit detail until it reaches 70-75. Over 75: trim.**

Prohibitions across every block:
  - No result / improvement / before-after language.
  - No medical or absolute claims ("cures", "clinically proven", "100%").
  - No fabricated pricing-error / glitch framing.
  - No fake scarcity ("discontinuing") unless it's true.
  - No profanity, including censored forms.

Output each block clearly labeled. After producing the copy, call apex_style2_validate_copy with the four fields to confirm compliance.`;
}

/* ------------------------------------------------------------------
 * style2_flow_agent_v6 MCP prompt
 *
 * Serves the full rev-6 Style 2 Flow-agent instructions (loaded
 * from docs/STYLE-2-SOP.md at server boot) as a fetchable MCP
 * prompt. Chat agents pull this at the start of a Style 2
 * conversation to load the complete spec — 8-node chain, the
 * character-ref attachment rules, room menus, LARGE/WORN
 * overrides, prohibitions, and the fixed prompt templates —
 * without the calling app having to embed 700+ lines of Style 2
 * text in its own system prompt.
 *
 * No args: the spec is self-contained; the operator fills in
 * product-specific details (rolled scene, form, count) at
 * invocation time per the spec's INTAKE section.
 * ---------------------------------------------------------------- */

function registerFlowAgentV6Prompt(server: McpServer): void {
  server.registerPrompt(
    "style2_flow_agent_v6",
    {
      title: "Style 2 · Flow-agent instructions (rev 6.1)",
      description:
        "Full Style 2 (MOF AI Avatar) instructions for a chat agent that will drive the 8-node image + video chain end-to-end via the google_flow_* tools. Uses character-ref registration for identity anchoring (see NO CHARACTER REFERENCE ON FILE), enforces the 8-node S0/N1–N7 attachment table with the rev-6.1 correction (video nodes carry startImage ONLY — never characters or referenceImages alongside a start frame, per the confirmed-live Flow rejection), ships the fixed prompt text for every node, and lists prohibitions. Load this at the start of any Style 2 conversation via prompts/get.",
      // No args — the spec is self-contained; product/scene
      // details are filled in at invocation time per the
      // INTAKE section of the doc.
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getStyle2AgentInstructions(),
          },
        },
      ],
    }),
  );
}
