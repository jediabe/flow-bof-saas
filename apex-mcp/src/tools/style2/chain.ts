/**
 * Style 2 SOP §4-5 — clip chain assembly.
 *
 * Pure function: given the scene from roll_scene + product form
 * details, produce the ordered list of Nano and Veo steps to
 * generate the video.
 *
 * Two chain shapes:
 *   handheld / countertop → 7 clips (N1..N7)
 *   worn                  → 3 clips (only)
 *
 * The templates are transcribed verbatim from docs/STYLE-2-SOP.md
 * §5. Do NOT paraphrase. Load-bearing phrases the SOP calls out:
 *   - "continue from this exact image"
 *   - "does NOT pick up, shake, or fiddle with the bottle"
 *   - "no talking, no lip movement"
 *   - "MAKE THIS A 4-SECOND CLIP"
 * These aren't stylistic — they're what make Veo behave. A
 * paraphrase produces a different result and the SOP has been
 * refined against exactly this wording.
 *
 * Every Veo step in this file carries "no talking, no lip
 * movement" — the tests assert it, because a missing one means
 * that clip will lip-sync and the video is a re-shoot.
 */

/* ==================================================================
 * Types
 * ================================================================ */

export const PRODUCT_FORMS = [
  "cream",
  "serum",
  "pump",
  "spray",
  "eye_patch",
  "razor",
  "hair",
  "roller",
  "lip",
  "nail",
  "device",
  "large_countertop",
  "worn",
] as const;
export type ProductForm = (typeof PRODUCT_FORMS)[number];

/** SOP §4 demo-area table. `worn` and `large_countertop` do
 *  not demo on skin at all. */
export const DEMO_AREAS = [
  "face",
  "cheek",
  "lips",
  "under_eye",
  "hair",
  "nails",
  "hand",
  "body_area",
  "held_only",
  "worn_only",
  "counter_result",
] as const;
export type DemoArea = (typeof DEMO_AREAS)[number];

/**
 * Default demo-area lookup per SOP §4 "Demo placement — work out
 * WHERE the product goes and demo it THERE. Do not default to
 * the face."
 *
 * A caller may override via `demo_area` on build_clip_prompts —
 * useful for products that don't fit these buckets cleanly (a
 * body oil applied to the neck, say). But defaulting to the
 * face is explicitly a SOP failure, so the fallback here is
 * `held_only` (safe: shows the product but claims no application
 * area) rather than `face`.
 */
export const FORM_TO_DEMO_AREA: Record<ProductForm, DemoArea> = {
  cream: "cheek",
  serum: "cheek",
  pump: "cheek",
  spray: "hair", // most spray products in the Style 2 catalogue are hair sprays — cheek/skin sprays should override
  eye_patch: "under_eye",
  razor: "cheek", // razor "glides along her cheek/jaw" (SOP §4)
  hair: "hair",
  roller: "cheek",
  lip: "lips",
  nail: "nails",
  device: "held_only",
  large_countertop: "counter_result",
  worn: "worn_only",
};

/** Human-friendly description of the "single small [drop / dab]"
 *  in N4. The SOP calls out cream→dab, serum→drop, pump→pump. */
const FORM_TO_PREP: Record<ProductForm, string> = {
  cream: "a small dab of the cream sits on the index fingertip of her other hand",
  serum: "a single drop of the serum sits on the index fingertip of her other hand",
  pump: "a pump of the product sits on the index fingertip of her other hand",
  spray: "she aims the spray bottle at her hair with her finger on the trigger",
  eye_patch: "she holds an eye patch near her under-eye between her thumb and forefinger",
  razor: "she holds the razor to her cheek/jaw",
  hair: "a small amount of the product sits on her fingertips near her hair",
  roller: "she holds the roller at her cheekbone",
  lip: "she holds the applicator/bullet at her lips",
  nail: "she holds the applicator at her nails",
  device: "she holds the device up near her face so the label is readable",
  large_countertop: "a filled glass of the finished result sits on the counter next to the unit",
  worn: "n/a — worn products do not demo on skin",
};

/** N5 application action, per SOP §4 "Application action". */
const FORM_TO_APPLICATION: Record<ProductForm, string> = {
  cream:
    "she gently pats and blends the product onto her cheek in slow, soft circular motions. She does NOT pick up, shake, or fiddle with the bottle — she ONLY blends the product already on her fingertip into her cheek.",
  serum:
    "she gently pats and blends the drop into her cheek in slow, soft circular motions. She does NOT pick up, shake, or fiddle with the bottle — she ONLY blends the product already on her fingertip into her cheek.",
  pump:
    "she gently pats and blends the product into her cheek in slow, soft circular motions. She does NOT pick up, shake, or fiddle with the bottle — she ONLY blends the product already on her fingertip into her cheek.",
  spray:
    "her index finger presses down on the spray trigger as it mists onto her hair. She does NOT pick up, shake, or fiddle with the bottle beyond pressing the trigger.",
  eye_patch:
    "she gently places the eye patch onto her under-eye with a soft press-and-smooth motion. She does NOT pick up or fiddle with additional patches.",
  razor:
    "she glides the razor slowly along her cheek and jawline. She does NOT lift it away or fiddle with the handle.",
  hair:
    "she works the product gently into her hair with her fingertips in slow, soft strokes. She does NOT pick up or fiddle with the bottle.",
  roller:
    "she glides the roller up her cheekbone in slow, even strokes. She does NOT lift it away or fiddle with it.",
  lip:
    "she gently swipes the applicator across her LIPS in one smooth motion. She does NOT pick up, shake, or fiddle with the tube — she ONLY swipes it across her lips.",
  nail:
    "she gently paints the product onto one of her nails in one slow, even stroke. She does NOT pick up or fiddle with additional bottles.",
  device:
    "she holds the device up near her face so the label is clearly readable, with a soft natural smile. Nothing on the device changes — buttons, screens and lights stay exactly as they are.",
  large_countertop:
    "she picks up the filled glass of the finished result from the counter and takes a small natural sip. The unit on the counter stays exactly as it is — nothing on it moves, spins, fills or lights up.",
  worn:
    "n/a — worn products do not demo on skin. Use the 3-clip chain instead.",
};

/**
 * How to satisfy the SOP's 4s/6s clip durations.
 *
 *   native            request duration=4 or 6 to Veo. Requires
 *                     Google AI Ultra ($199) — cheaper tiers 402.
 *   generate_8_and_trim  request duration=8 (works on every tier)
 *                     and note the intended trim length so CapCut
 *                     can cut the export back to 4/6.
 *
 * Default is generate_8_and_trim because it works everywhere and
 * the SOP's own assembly note already tells the operator to trim
 * in CapCut.
 */
export const DURATION_STRATEGIES = ["native", "generate_8_and_trim"] as const;
export type DurationStrategy = (typeof DURATION_STRATEGIES)[number];

export interface ClipStep {
  /** N1..N7 for the handheld/countertop 7-clip chain. Worn uses
   *  the same N1..N6 slots but the semantics change — see chain_kind. */
  id: string;
  engine: "nano" | "veo";
  /** SOP-intended duration for this step in the final edit. Nano
   *  is an image but reports its slot duration so downstream
   *  timing tools have one field to key off. */
  duration_seconds: number;
  /** What to actually send to Veo. Only meaningful for engine=veo. */
  request_duration_seconds: number;
  /** When duration_strategy is generate_8_and_trim and the SOP
   *  duration is < the requested one, the extra footage must be
   *  trimmed in post. Null for Nano steps and for native strategy. */
  trim_to_seconds: number | null;
  prompt: string;
  /** Step id whose media becomes the start_image for this Veo
   *  step. Null for the first step and for Nano steps (which
   *  don't take start_image). */
  continues_from: string | null;
  /** How many reference images the caller must attach to this
   *  step. Always includes the locked avatar. `worn` steps also
   *  need the garment image on every step. */
  reference_image_count: 1 | 2;
  notes: string[];
}

export interface BuildClipsInput {
  scene_prompt: string;
  product_name: string;
  product_form: ProductForm;
  /** 1, 2 or 3. Fixed constant per SOP §4 "Count rule". */
  product_count: 1 | 2 | 3;
  /** Optional override of the demo area; null to accept the
   *  form's default. */
  demo_area?: DemoArea;
  /** Default generate_8_and_trim. */
  duration_strategy?: DurationStrategy;
}

export interface BuildClipsOutput {
  product_form: ProductForm;
  chain_kind: "handheld" | "countertop" | "worn";
  demo_area: DemoArea;
  reference_images_required: 1 | 2;
  duration_strategy: DurationStrategy;
  steps: ClipStep[];
  notes: string[];
}

/* ==================================================================
 * Public API
 * ================================================================ */

export function buildClipPromptsPure(input: BuildClipsInput): BuildClipsOutput {
  const form = input.product_form;
  const demoArea = input.demo_area ?? FORM_TO_DEMO_AREA[form];
  const strategy: DurationStrategy = input.duration_strategy ?? "generate_8_and_trim";
  const notes: string[] = [];

  // WORN — 3-clip mirror try-on. Requires TWO reference images
  // (avatar + garment). Completely different structure from
  // handheld/countertop.
  if (form === "worn") {
    return finalize(buildWornChain(input, notes), strategy);
  }

  // LARGE_COUNTERTOP — same 7 IDs (N1..N7) as handheld but
  // N2-N7 swap per SOP §4 rules: unit stays put, no push-in,
  // never animate the machine, demo shows the result.
  if (form === "large_countertop") {
    return finalize(buildCountertopChain(input, demoArea, notes), strategy);
  }

  // HANDHELD — the standard 7-clip chain. §4 count rule + §4
  // demo-area lookup + §4 spray/pump trigger rule.
  return finalize(buildHandheldChain(input, demoArea, notes), strategy);
}

/**
 * Apply the caller's duration_strategy to each step's Veo request
 * length. Nano steps get 0/null for the request fields — they're
 * still images.
 */
function finalize(
  built: DraftOutput,
  strategy: DurationStrategy,
): BuildClipsOutput {
  const steps: ClipStep[] = built.steps.map((s) => {
    if (s.engine === "nano") {
      return { ...s, request_duration_seconds: 0, trim_to_seconds: null };
    }
    if (strategy === "native") {
      return {
        ...s,
        request_duration_seconds: s.duration_seconds,
        trim_to_seconds: null,
      };
    }
    // generate_8_and_trim: request 8, trim back to the SOP length.
    const request = 8;
    return {
      ...s,
      request_duration_seconds: request,
      trim_to_seconds:
        s.duration_seconds < request ? s.duration_seconds : null,
    };
  });
  const strategyNote =
    strategy === "native"
      ? "duration_strategy=native — requests 4s or 6s directly to Veo. Requires Google AI Ultra ($199); cheaper tiers 402 on non-8s durations."
      : "duration_strategy=generate_8_and_trim — requests 8s to Veo (works on every tier) and trim to the SOP length in CapCut.";
  return {
    ...built,
    duration_strategy: strategy,
    steps,
    notes: [strategyNote, ...built.notes],
  };
}

/* ==================================================================
 * Handheld chain (N1..N7)
 * ================================================================ */

/** Sub-builder step shape — request_duration_seconds and
 *  trim_to_seconds get filled in by finalize() based on the
 *  caller's duration_strategy. */
type DraftStep = Omit<ClipStep, "request_duration_seconds" | "trim_to_seconds">;
type DraftOutput = Omit<BuildClipsOutput, "duration_strategy" | "steps"> & {
  steps: DraftStep[];
};

function buildHandheldChain(
  input: BuildClipsInput,
  demoArea: DemoArea,
  notes: string[],
): DraftOutput {
  const countPhrase = productCountPhrase(input.product_count);
  const prepPhrase = FORM_TO_PREP[input.product_form];
  const applicationPhrase = FORM_TO_APPLICATION[input.product_form];
  const demoDescriptor = demoAreaDescriptor(demoArea);
  const trailingLipReminder = input.product_form === "lip"
    ? " Applied to her LIPS, never her cheek or face."
    : "";
  if (input.product_form === "spray" || input.product_form === "pump") {
    notes.push(
      "Spray/pump: her index finger must be visibly ON the trigger when it mists (SOP §5 spray/pump rule). Regenerate the Veo step until it's clearly on the trigger.",
    );
  }
  if (input.product_form === "lip" && demoArea !== "lips") {
    notes.push(
      `Lip product with demo_area="${demoArea}" — the SOP explicitly says lip products demo on the LIPS. Overriding was intentional?`,
    );
  }

  const steps: DraftStep[] = [
    // N1 — Veo shock, 4 seconds. The one exception to the 6s rule.
    {
      id: "N1",
      engine: "veo",
      duration_seconds: 4,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded image as the identity reference — same woman, face identical. Ultra-realistic front-facing smartphone selfie video, close framing, her face dominant in frame. Soft shocked expression: eyes widen, one hand comes up to cover her mouth. At 0–0.4s a fast eye-widen with a quick small head jerk forward; 0.4–1.0s a sharp glance to the left; 1.0–1.6s a sharp glance to the right; then she returns to face the camera holding the shocked expression with subtle natural breathing. Dramatic and scroll-stopping, not subtle. Same lighting as the scene image. Vertical 9:16, photorealistic, no talking, no lip movement. MAKE THIS A 4-SECOND CLIP (all clips after are 6 seconds).`,
    },
    // N2 — Nano product-holding image, 6s (duration is a hint;
    // Nano is a still image but we report the intended timeline
    // duration for downstream timing tools).
    {
      id: "N2",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical. Ultra-realistic selfie, chest-up, same setting as the scene image. She holds the ${input.product_name} naturally — ${countPhrase}. All labels of the ${input.product_name} clearly facing the camera, true to size. Soft natural smile, direct eye contact. Indoor, photorealistic. No warping of the products or labels.`,
    },
    // N3 — Veo close-up continuing from N2, 6s.
    {
      id: "N3",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N2",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image — same avatar, identical face. She starts holding the ${input.product_name} at chest level, then slowly brings ${input.product_count === 1 ? "it" : "them"} closer to the camera. Labels stay sharp, no warping. Natural smile, eye contact. Same setting as the scene image. Vertical 9:16, fixed camera.`,
    },
    // N4 — Nano demo-prep image, 6s.
    {
      id: "N4",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical, same setting as the scene image. Keep her original age and youthful skin, no added wrinkles or under-eye shadows. She holds the ${input.product_name} in one hand, and ${prepPhrase}, raised up near ${demoDescriptor}.${input.product_count > 1 ? ` The other ${input.product_count - 1} product${input.product_count > 2 ? "s" : ""} sit${input.product_count > 2 ? "" : "s"} on the counter behind her, slightly out of focus.` : ""} Soft natural smile, looking at the camera. Photorealistic, sharp, product label readable.${trailingLipReminder}`,
    },
    // N5 — Veo application continuing from N4, 6s. The
    // load-bearing phrases live here.
    {
      id: "N5",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N4",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image — same woman, face identical, same setting, same lighting. ${applicationPhrase} Calm natural expression with a slight smile. Static front-facing iPhone perspective. Ultra-realistic UGC, no warping. Show ONLY the application and the feel — do NOT render a visible result, improvement, or before/after.`,
    },
    // N6 — Nano end-frame CTA image, 6s.
    {
      id: "N6",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical, same setting as the scene image. The ${input.product_name} is held very close to camera, filling most of the frame, label sharp and centered, hands holding both sides. Her face visible but softly out of focus behind. Depth of field: product sharp, face blurred. Raw iPhone UGC. Vertical 9:16.`,
    },
    // N7 — Veo final CTA continuing from N6, 6s.
    {
      id: "N7",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N6",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from the end-frame image, same avatar, face identical, same setting. The ${input.product_name} stays in her RIGHT hand at chest level, label forward; she pulls it back slightly so face and product are both visible. Her gaze shifts down to the bottom-left; using her LEFT hand only, she points down at the bottom-left corner in a clear rhythm (point, reset, point, reset). Soft confident smile. Product never switches hands. Static front-facing iPhone. No zoom cuts, no warping.`,
    },
  ];

  // Anchor the scene into the top of every step so the caller
  // (and any inspection tool) can see which scene the chain was
  // built for. Prepended verbatim.
  const stepsWithScene: DraftStep[] = steps.map((s) => ({
    ...s,
    prompt: `${s.prompt}\n\n[Scene context — reuse the same room, framing, and props as the scene image]\n${input.scene_prompt}`,
  }));

  return {
    product_form: input.product_form,
    chain_kind: "handheld",
    demo_area: demoArea,
    reference_images_required: 1,
    steps: stepsWithScene,
    notes,
  };
}

/* ==================================================================
 * Large countertop chain — N2..N7 swap per SOP §4
 * ================================================================ */

function buildCountertopChain(
  input: BuildClipsInput,
  demoArea: DemoArea,
  notes: string[],
): DraftOutput {
  notes.push(
    "Large-countertop rules (SOP §4): unit stays on the counter the whole time, camera never pushes in, nothing on the machine animates. Demo shows the RESULT, not the machine working.",
  );

  const steps: DraftStep[] = [
    // N1 — Shock. Same as handheld.
    {
      id: "N1",
      engine: "veo",
      duration_seconds: 4,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded image as the identity reference — same woman, face identical. Ultra-realistic front-facing smartphone selfie video, close framing, her face dominant in frame. Soft shocked expression: eyes widen, one hand comes up to cover her mouth. At 0–0.4s a fast eye-widen with a quick small head jerk forward; 0.4–1.0s a sharp glance to the left; 1.0–1.6s a sharp glance to the right; then she returns to face the camera holding the shocked expression with subtle natural breathing. Dramatic and scroll-stopping, not subtle. Same lighting as the scene image. Vertical 9:16, photorealistic, no talking, no lip movement. MAKE THIS A 4-SECOND CLIP (all clips after are 6 seconds).`,
    },
    // N2 — Nano: unit on the counter, she presents/points.
    {
      id: "N2",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical. Ultra-realistic selfie, same setting as the scene image. The ${input.product_name} sits on the counter, label clearly facing the camera. She stands beside it presenting it with an open hand and pointing to it — she is NOT holding or lifting the ${input.product_name}. One unit only. Nothing on the unit is moving or animated. Soft natural smile, direct eye contact. Photorealistic, sharp, product label readable, no warping.`,
    },
    // N3 — Veo: countertop variant of the close-up (from SOP §5).
    {
      id: "N3",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N2",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image. Handheld selfie, camera stays exactly where it is — no push-in, no zoom. She simply rests her hand on the ${input.product_name} on the counter and looks into the camera with small, natural movements. Nothing on the ${input.product_name} moves or changes — the contents and screen stay exactly as they are. Same setting as the scene image, same lighting. One unit only. No talking, no warping. Vertical 9:16.`,
    },
    // N4 — Nano: demo-prep with the RESULT (filled glass etc.).
    {
      id: "N4",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical, same setting as the scene image. The ${input.product_name} sits on the counter behind her, unchanged and unanimated. In front of her on the counter is a filled glass of the finished result (e.g. the poured drink / cooked food) — already complete. Soft natural smile, looking at the camera. Photorealistic, sharp, no warping.`,
    },
    // N5 — Veo: application-equivalent. She picks up the result,
    // takes a natural sip. The machine is untouched.
    {
      id: "N5",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N4",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image — same woman, face identical, same setting, same lighting. ${FORM_TO_APPLICATION.large_countertop} Calm natural expression with a slight smile. Static front-facing iPhone perspective. Ultra-realistic UGC, no warping. Show ONLY the finished result and the sip — do NOT animate the ${input.product_name} working.`,
    },
    // N6 — Nano end-frame: the RESULT close to lens, unit behind.
    {
      id: "N6",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 1,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference, face identical, same setting as the scene image. The finished result (e.g. the filled glass of the poured drink) is held very close to camera, filling most of the frame, hands holding both sides. The ${input.product_name} stays on the counter behind her, unchanged and unanimated. Her face visible but softly out of focus. Depth of field: result sharp, face blurred. Raw iPhone UGC. Vertical 9:16.`,
    },
    // N7 — Veo: final CTA. Points down to bottom-left.
    {
      id: "N7",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N6",
      reference_image_count: 1,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from the end-frame image, same avatar, face identical, same setting. She holds the finished result near the lens in her RIGHT hand; she pulls it back slightly so face and result are both visible. The ${input.product_name} stays on the counter behind her, unchanged and unanimated. Her gaze shifts down to the bottom-left; using her LEFT hand only, she points down at the bottom-left corner in a clear rhythm (point, reset, point, reset). Soft confident smile. Static front-facing iPhone. No zoom cuts, no warping.`,
    },
  ];

  const stepsWithScene: DraftStep[] = steps.map((s) => ({
    ...s,
    prompt: `${s.prompt}\n\n[Scene context — reuse the same room, framing, and props as the scene image]\n${input.scene_prompt}`,
  }));

  return {
    product_form: input.product_form,
    chain_kind: "countertop",
    demo_area: demoArea,
    reference_images_required: 1,
    steps: stepsWithScene,
    notes,
  };
}

/* ==================================================================
 * Worn chain — 3 Nano-per-pose clips, mirror try-on
 * ================================================================ */

function buildWornChain(
  input: BuildClipsInput,
  notes: string[],
): DraftOutput {
  notes.push(
    "Worn (clothing/shoes/accessories) requires TWO reference images: the locked avatar AND the garment photo (SOP §4). The garment will not appear unless both are attached and every Nano prompt says to swap what she is wearing.",
  );
  notes.push(
    "ONLY Clip 1 has the shock — clips 2 & 3 never bring her hand near her mouth (SOP §4).",
  );
  notes.push(
    "Final point must land bottom-LEFT — mirror selfies flip left/right, so check the export in CapCut and flip if it lands bottom-right.",
  );

  const steps: DraftStep[] = [
    // W-Nano-1 = full-body SHOCKED mirror selfie seed.
    {
      id: "N1",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 2,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference (face identical) and the second attached image as the garment reference. She wears the exact garment from the garment reference — match colour, cut, waistband and length. Full-body mirror selfie, standing, camera pulled back so the garment is visible head-to-thigh. SHOCKED expression: eyes widened, one hand up covering her mouth. Photorealistic, vertical 9:16, natural skin, no warping.`,
    },
    // W-Veo-1 = Clip 1. Opens shocked, resolves to smiling front.
    {
      id: "N2",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N1",
      reference_image_count: 2,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image. Same woman, face identical, same garment, same setting. She holds the shocked hand-over-mouth pose for about 1 second, then lowers her hand into a soft smile and shows off the FRONT of the garment for the camera. She settles standing front, both arms down. Handheld mirror selfie, camera fixed, phone in the same hand throughout. Vertical 9:16.`,
    },
    // W-Nano-2 = full-body, standing front, smiling, arm down.
    {
      id: "N3",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 2,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference (face identical) and the second attached image as the garment reference — same exact garment. Full-body mirror selfie, standing front, soft smile, both arms down at her sides (matching the ending pose of the previous clip). Photorealistic, vertical 9:16, natural skin, no warping.`,
    },
    // W-Veo-2 = Clip 2. Turns to show the back.
    {
      id: "N4",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N3",
      reference_image_count: 2,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image. Same woman, face identical, same garment, same setting. She turns around to show the BACK of the garment, glancing over her shoulder toward the camera with a soft smile. She settles in a clear back / over-shoulder pose. She does NOT bring her hand near her mouth. Handheld mirror selfie, camera fixed, phone in the same hand throughout. Vertical 9:16.`,
    },
    // W-Nano-3 = full-body back / over-shoulder pose.
    {
      id: "N5",
      engine: "nano",
      duration_seconds: 6,
      continues_from: null,
      reference_image_count: 2,
      notes: [],
      prompt:
        `Use the uploaded avatar as identity reference (face identical) and the second attached image as the garment reference — same exact garment. Full-body mirror selfie, back to the mirror in a clear over-shoulder pose glancing at the camera (matching the ending pose of the previous clip). Photorealistic, vertical 9:16, natural skin, no warping.`,
    },
    // W-Veo-3 = Clip 3. Turns back to face front and points to
    // bottom-LEFT. The point must be deliberate and held.
    {
      id: "N6",
      engine: "veo",
      duration_seconds: 6,
      continues_from: "N5",
      reference_image_count: 2,
      notes: [],
      prompt:
        `No talking, no lip movement. Continue from this exact image. Same woman, face identical, same garment, same setting. She turns back to face the mirror, smiles softly, then clearly extends her arm DOWN and points to the bottom-LEFT corner of the frame — big, deliberate, held for about 2 seconds — toward the shop link. She does NOT bring her hand near her mouth. Handheld mirror selfie, camera fixed, phone in the same hand throughout. Vertical 9:16.`,
    },
  ];

  const stepsWithScene: DraftStep[] = steps.map((s) => ({
    ...s,
    prompt: `${s.prompt}\n\n[Scene context — reuse the same room, framing, and props as the scene image]\n${input.scene_prompt}`,
  }));

  return {
    product_form: "worn",
    chain_kind: "worn",
    demo_area: "worn_only",
    reference_images_required: 2,
    steps: stepsWithScene,
    notes,
  };
}

/* ==================================================================
 * Helpers
 * ================================================================ */

/** SOP §4 count rule. */
function productCountPhrase(count: 1 | 2 | 3): string {
  if (count === 1) return "one in one hand";
  if (count === 2) return "one in each hand";
  return "two in one hand and one in the other";
}

/** Human description of the demo area, spliced into N4 near
 *  "raised up near ___". */
function demoAreaDescriptor(area: DemoArea): string {
  switch (area) {
    case "face":
      return "her face";
    case "cheek":
      return "her cheek";
    case "lips":
      return "her LIPS";
    case "under_eye":
      return "her under-eye";
    case "hair":
      return "her hair";
    case "nails":
      return "her nails";
    case "hand":
      return "her hand";
    case "body_area":
      return "the target body area";
    case "held_only":
      return "her face so the label is readable";
    case "worn_only":
      return "her (worn products do not demo on skin — this branch should not run)";
    case "counter_result":
      return "the counter";
  }
}
