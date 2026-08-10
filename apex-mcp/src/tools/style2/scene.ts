/**
 * Style 2 SOP §3 — scene selection.
 *
 * Pure functions. No network, no context, no time. Given a
 * product type (+ optional seed + optional recent-scene ledger),
 * roll one fresh combination from every rotation menu for the
 * matching room, hash it into a stable id, and assemble the
 * finished scene-image prompt.
 *
 * The server is stateless. Anti-repetition (SOP §3, account-safety
 * critical) lives in the CALLER's ledger — this function only
 * receives `recent_scene_hashes` and re-rolls until it finds a
 * combination not in that set. If a fresh combo can't be found
 * within `MAX_ATTEMPTS` it returns the last attempt with
 * `collision: true` rather than looping forever — the caller
 * decides whether to burn one repeat or widen the room.
 */

import { createHash } from "node:crypto";
import {
  MENUS_BY_ROOM,
  PRODUCT_TYPE_TO_ROOM,
  type ProductType,
  type Room,
} from "./menus.js";
import { makeRng, randomSeed, type Rng } from "./prng.js";

/** How many re-rolls to try before giving up and returning the
 *  best-effort combo. Sized so a heavily-used bathroom can still
 *  find a fresh combo even after 100+ posts (menu Cartesian
 *  product runs into the thousands). */
const MAX_ATTEMPTS = 50;

export interface RollScenePureInput {
  product_type: ProductType;
  recent_scene_hashes?: readonly string[];
  seed?: number;
}

export interface RolledScene {
  product_type: ProductType;
  room: Room;
  /** Stable identifier of THIS combination — feed this back into
   *  a future call's `recent_scene_hashes` to prevent repeats. */
  scene_hash: string;
  /** True if we exhausted MAX_ATTEMPTS trying to avoid the
   *  recent-hashes set and returned a repeat anyway. */
  collision: boolean;
  /** The actual seed used — echoes the input, or fills in the
   *  random one we generated when the caller omitted it. */
  seed: number;
  /** SOP menu key → picked value. Also keyed identically inside
   *  the assembled scene_prompt so debugging is grep-able. */
  rolls: Record<string, string>;
  /** The finished scene-image prompt, ready to hand to
   *  google_flow_generate_image. */
  scene_prompt: string;
  /** Non-fatal observations — currently only set when
   *  product_type is "other" (bathroom fallback) so the caller
   *  can override. */
  notes: string[];
}

/**
 * Pure roll — no MCP wrapper, no error mapping. Everything the
 * MCP tool needs is here so tests can call it directly.
 */
export function rollScenePure(input: RollScenePureInput): RolledScene {
  const room = PRODUCT_TYPE_TO_ROOM[input.product_type];
  const menu = MENUS_BY_ROOM[room];
  const seed = input.seed ?? randomSeed();
  const rng = makeRng(seed);
  const recent = new Set(input.recent_scene_hashes ?? []);

  let lastRolls: Record<string, string> = {};
  let lastHash = "";
  let attempts = 0;
  let collision = true;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    lastRolls = rollMenu(menu, rng);
    lastHash = hashScene(room, lastRolls);
    if (!recent.has(lastHash)) {
      collision = false;
      break;
    }
  }

  const notes: string[] = [];
  if (input.product_type === "other") {
    // SOP §3 says "else → a realistic room it belongs in". A
    // deterministic tool can't guess that, so we default to
    // bathroom and warn the caller.
    notes.push(
      "product_type=other — using the bathroom rotation as a fallback. Override room/props in the caller if the product belongs elsewhere.",
    );
  }
  if (collision) {
    notes.push(
      `couldn't find a fresh combination in ${MAX_ATTEMPTS} attempts — returning a repeat. Consider widening the room or accepting one repeat.`,
    );
  }

  return {
    product_type: input.product_type,
    room,
    scene_hash: lastHash,
    collision,
    seed,
    rolls: lastRolls,
    scene_prompt: buildScenePrompt(room, lastRolls),
    notes,
  };
}

/* ------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------- */

function rollMenu(
  menu: Record<string, readonly string[]>,
  rng: Rng,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Iterate in insertion order — JavaScript preserves it. Menu
  // key order is the source-of-truth ORDER OF ROLLS, so a seeded
  // roll is reproducible only as long as menus.ts key order is
  // stable. Reordering menu keys is a SOP-level change.
  for (const [key, values] of Object.entries(menu)) {
    out[key] = rng.pick(values);
  }
  return out;
}

/**
 * Stable content hash of a rolled scene. Uses SHA-1 truncated to
 * 12 hex chars — collision-resistant enough for a per-account
 * anti-repetition ledger; short enough to be readable in logs.
 * Room is included so the same rolls-object across two rooms
 * hashes differently.
 */
function hashScene(room: Room, rolls: Record<string, string>): string {
  // Sort keys so the hash is insensitive to menu-key iteration
  // order (defensive against a future menus.ts refactor that
  // renames-but-preserves values).
  const sortedKeys = Object.keys(rolls).sort();
  const payload = [room, ...sortedKeys.map((k) => `${k}=${rolls[k]}`)].join("|");
  return createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

/**
 * Assemble the scene-image prompt from the room + rolled values.
 *
 * Composition constants (SOP §3) are baked in verbatim per room
 * — do not substitute or paraphrase them. The exact wording is
 * what makes Nano produce the tight-selfie framing we want; the
 * SOP notes several phrases are load-bearing.
 *
 * The scene image never contains the promoted product (SOP §3
 * "Scene-image rule"). Clothing is the exception; for that room
 * the caller passes the garment as a second reference image and
 * writes "wearing the exact garment from the attached image" —
 * NOT in this scene prompt.
 */
export function buildScenePrompt(room: Room, rolls: Record<string, string>): string {
  const identity =
    "Use the uploaded avatar as identity reference — same woman, face identical.";
  const universal =
    "Photorealistic, vertical 9:16, natural skin texture, real pores, subtle imperfections, no over-smoothing, no beauty filter, no plastic sheen, no blur. Not a mirror selfie, no phone or camera interface visible.";

  if (room === "bathroom") {
    return [
      identity,
      `Place her in a ${rolls.style} bathroom with a ${rolls.mirror} mirror.`,
      `She is wearing a ${rolls.outfit}.`,
      `Camera angle: ${rolls.camera_angle}. Pose: ${rolls.pose}. Lighting: ${rolls.lighting}.`,
      `A DENSE prop cluster (${rolls.product_cluster}) crammed into the immediate foreground along the bottom.`,
      "CLOSE and STRAIGHT-ON, tight close-up so her face and upper chest fill the frame, leaning slightly in. Handheld selfie — selfie arm extended toward the lens (phone NOT visible), other hand over her mouth in shock, eyes widened, looking into the camera. Raw phone-video look.",
      "No promoted product in the frame — generic props only.",
      universal,
    ].join(" ");
  }

  if (room === "kitchen") {
    return [
      identity,
      `Place her in a ${rolls.setting} kitchen, leaning on the counter.`,
      `She is wearing a ${rolls.outfit}.`,
      `Camera angle: ${rolls.camera_angle}. Pose: ${rolls.pose}. Lighting: ${rolls.lighting}.`,
      `A DENSE prop cluster (${rolls.foreground_cluster}) crammed into the immediate foreground along the bottom.`,
      "CLOSE and STRAIGHT-ON, tight close-up so her face and upper chest fill the frame, leaning slightly in. Handheld selfie — selfie arm extended toward the lens (phone NOT visible), other hand over her mouth in shock, eyes widened, looking into the camera. Raw phone-video look.",
      "No promoted product in the frame — generic props only.",
      universal,
    ].join(" ");
  }

  if (room === "outdoor") {
    return [
      identity,
      `Place her ${rolls.setting}.`,
      `She is wearing a ${rolls.outfit_colour} ${rolls.outfit}.`,
      `Camera angle: ${rolls.camera_angle}. Pose: ${rolls.pose}. Lighting: ${rolls.lighting}.`,
      `A DENSE prop cluster (${rolls.foreground_cluster}) crammed into the immediate foreground along the bottom.`,
      "CLOSE and STRAIGHT-ON, tight close-up so her face and upper chest fill the frame, leaning slightly in. Handheld selfie — selfie arm extended toward the lens (phone NOT visible), other hand over her mouth in shock, eyes widened, looking into the camera. Raw phone-video look.",
      "No promoted product in the frame — generic props only.",
      universal,
    ].join(" ");
  }

  // bedroom (clothing/fashion). Different composition rule —
  // camera pulled BACK so the garment is the focus, not a tight
  // face shot. Outfit is the promoted garment, referenced via a
  // separate attached image; do NOT name it in the prompt.
  return [
    identity,
    `Place her in a ${rolls.setting} bedroom (${rolls.framing}).`,
    "She is wearing the exact garment shown in the second attached reference image — match colour, cut, waistband and length.",
    `Camera angle: ${rolls.camera_angle}. Pose: ${rolls.pose}. Lighting: ${rolls.lighting}.`,
    "Pull BACK so the garment is the focus (not a tight face shot); handheld selfie or mirror selfie; a real lived-in bedroom softly behind.",
    universal,
  ].join(" ");
}
