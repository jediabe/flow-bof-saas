import { StyleManifestSchema } from "./schemas";
import { STYLE1_DEFINITION } from "./style1-definition";
import { STYLE2_DEFINITION } from "./style2-definition";
import type { StyleDefinition, StyleManifest } from "./types";

export const STYLE_REGISTRY = Object.freeze({
  style1: STYLE1_DEFINITION,
  style2: STYLE2_DEFINITION,
}) satisfies Record<string, StyleDefinition>;

for (const definition of Object.values(STYLE_REGISTRY)) {
  for (const variant of definition.variants) {
    StyleManifestSchema.parse(definition.compile(variant));
  }
}

export function getStyleDefinition(styleId: string, version: string): StyleDefinition {
  const definition = STYLE_REGISTRY[styleId as keyof typeof STYLE_REGISTRY];
  if (!definition || definition.version !== version) {
    throw new Error(`Unknown managed style definition: ${styleId}@${version}`);
  }
  return definition;
}

export function compileStyleManifest(
  styleId: string,
  version: string,
  variant: string,
): StyleManifest {
  const definition = getStyleDefinition(styleId, version);
  if (!definition.variants.includes(variant as never)) {
    throw new Error(`Unknown managed style variant: ${styleId}@${version}/${variant}`);
  }
  return StyleManifestSchema.parse(definition.compile(variant));
}
