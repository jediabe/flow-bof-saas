import { CreativeDirectionSchema } from "@/lib/content-runs/schemas";
import type { VideoCreativeDirection } from "./types";

export class InvalidVideoCreativeDirectionError extends Error {
  readonly name = "InvalidVideoCreativeDirectionError";

  constructor(message = "Invalid creative direction") {
    super(message);
  }
}

const CAMERA_MOVEMENT_COPY = {
  locked_off: "locked-off camera",
  minimal_push_in: "minimal push-in",
  gentle_push_in: "gentle push-in",
  subtle_lateral_drift: "subtle lateral drift",
} as const satisfies Record<VideoCreativeDirection["cameraMovement"], string>;

const PACING_COPY = {
  steady: "steady pacing",
  unhurried: "unhurried pacing",
  natural: "natural pacing",
} as const satisfies Record<VideoCreativeDirection["pacing"], string>;

const FRAMING_COPY = {
  stable_wide: "stable wide framing",
  stable_medium: "stable medium framing",
  stable_close: "stable close framing",
} as const satisfies Record<VideoCreativeDirection["framing"], string>;

const DISTANCE_COPY = {
  hold_distance: "held distance",
  slight_approach: "slight approach",
  slight_retreat: "slight retreat",
} as const satisfies Record<VideoCreativeDirection["distance"], string>;

const INTERACTION_COPY = {
  single_gentle_tap: "single gentle tap",
  single_gentle_touch: "single gentle touch",
  minimal_hand_interaction: "minimal hand interaction",
} as const satisfies Record<VideoCreativeDirection["interactionStyle"], string>;

const INTENSITY_COPY = {
  minimal: "minimal movement intensity",
  low: "low movement intensity",
  moderate: "moderate movement intensity",
} as const satisfies Record<VideoCreativeDirection["movementIntensity"], string>;

const PRESERVATION_COPY = {
  label_layout: "label layout",
  lettering_placement: "lettering placement",
  nozzle_geometry: "nozzle geometry",
  packaging_proportions: "packaging proportions",
  reflections: "reflections",
  fine_product_features: "fine product features",
} as const satisfies Record<VideoCreativeDirection["preservationFocus"][number], string>;

export function parseVideoCreativeDirection(
  creativeDirection: unknown,
): VideoCreativeDirection {
  const parsed = CreativeDirectionSchema.safeParse(creativeDirection);
  if (!parsed.success) {
    throw new InvalidVideoCreativeDirectionError();
  }
  return parsed.data;
}

export function serializeVideoCreativeDirection(
  creativeDirection: VideoCreativeDirection | undefined,
): string | null {
  if (!creativeDirection) return null;
  return JSON.stringify({
    cameraMovement: creativeDirection.cameraMovement,
    pacing: creativeDirection.pacing,
    framing: creativeDirection.framing,
    distance: creativeDirection.distance,
    interactionStyle: creativeDirection.interactionStyle,
    movementIntensity: creativeDirection.movementIntensity,
    preservationFocus: creativeDirection.preservationFocus,
  });
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function normalizedProductName(productName: string | undefined): string {
  const trimmed = productName?.trim();
  return trimmed || "product";
}

export function compileVideoPrompt(input: {
  canonicalPrompt: string;
  creativeDirection?: VideoCreativeDirection;
  productName?: string;
}): string {
  if (!input.creativeDirection) return input.canonicalPrompt;

  const direction = input.creativeDirection;
  const productName = normalizedProductName(input.productName);
  const preservationFocus = direction.preservationFocus.map(
    (focus) => PRESERVATION_COPY[focus],
  );

  return [
    input.canonicalPrompt,
    "Canonical prompt above wins over every direction clause below.",
    `Use a ${CAMERA_MOVEMENT_COPY[direction.cameraMovement]} with ${PACING_COPY[direction.pacing]}, ${FRAMING_COPY[direction.framing]}, ${DISTANCE_COPY[direction.distance]}, ${INTERACTION_COPY[direction.interactionStyle]}, and ${INTENSITY_COPY[direction.movementIntensity]}.`,
    `Preserve ${productName} ${joinList(preservationFocus)} exactly; do not reshape or relabel the product.`,
  ].join("\n\n");
}
