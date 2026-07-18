"use server";

import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { callProvider } from "@/lib/ai/providers";
import {
  loadOrCreateSettings,
  toServerSettings,
} from "@/lib/workspace-settings";
import type { AiPromptOutput } from "@/lib/ai/types";

/**
 * /prompts — live one-shot generation for a chosen Product.
 *
 * The batches flow persists the AI output to the Product row so
 * the pipeline downstream (image gen, mobile posting review) can
 * read a stable state. This surface is different: it's a hooks +
 * caption preview surface for a UK creator who wants a fresh
 * batch of hooks NOW (possibly flavoured with today's live
 * discount %), copies them to their clipboard, posts, and moves
 * on. We deliberately do NOT persist — discount % is time-
 * sensitive, and overwriting the batch row's hooks with a run
 * tied to a temporary discount would be confusing later.
 *
 * If the operator wants to persist, they can go back to the
 * batch flow. This surface stays a preview.
 */

export interface GeneratePromptsPreviewInput {
  productId: string;
  /** Optional TikTok Shop discount %. Integer 1..100 or null. */
  discountPercent: number | null;
}

export interface GeneratePromptsPreviewResult {
  ok: boolean;
  message: string;
  provider: string;
  output?: AiPromptOutput;
}

export async function generatePromptsPreview(
  input: GeneratePromptsPreviewInput,
): Promise<GeneratePromptsPreviewResult> {
  const { productId, discountPercent } = input;
  if (!productId) {
    return { ok: false, message: "Pick a product first.", provider: "" };
  }
  // Sanitize the percent — trust nothing from the client. Any
  // out-of-range value is coerced to null so the LLM sees no
  // discount and skips the %-dependent variants.
  const pct =
    typeof discountPercent === "number" &&
    Number.isFinite(discountPercent) &&
    discountPercent > 0 &&
    discountPercent <= 100
      ? Math.round(discountPercent)
      : null;

  const { workspace } = await getCurrentWorkspace();

  const product = await db.product.findFirst({
    where: {
      id: productId,
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      tiktokUrl: true,
      referenceImageUrl: true,
      market: true,
      batch: { select: { market: true } },
    },
  });
  if (!product) {
    return {
      ok: false,
      message: "Product not found in this workspace.",
      provider: "",
    };
  }

  // Per-product market wins, then batch market, then UK.
  const effectiveMarket: "uk" | "us" =
    product.market === "us"
      ? "us"
      : product.market === "uk"
        ? "uk"
        : product.batch?.market === "us"
          ? "us"
          : "uk";

  const settingsRow = await loadOrCreateSettings(workspace.id);
  const settings = toServerSettings(settingsRow);

  try {
    const { output } = await callProvider(
      {
        productName:       product.productName,
        originalTitle:     product.originalTitle,
        category:          product.category,
        retailerName:      product.retailerName,
        tiktokUrl:         product.tiktokUrl,
        referenceImageUrl: product.referenceImageUrl,
        market:            effectiveMarket,
        discountPercent:   pct,
      },
      settings,
      { useVision: false },
    );
    return {
      ok: true,
      message: "Generated.",
      provider: settings.provider,
      output,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      message: `${e.name}: ${String(e.message ?? e).slice(0, 240)}`,
      provider: settings.provider,
    };
  }
}
