/**
 * Local tools for the /generate agent — workspace-scoped functions
 * the LLM can call alongside the APEX MCP's 19 Flow tools.
 *
 * These give the agent context about our own data model:
 *   - What products are in this workspace
 *   - What copy / images / discount each product has
 *   - How to persist a generated video back to a product so it
 *     appears on the mobile posting page
 *
 * Every tool is namespaced with the `local_` prefix so it's
 * unambiguous which layer runs a given call in the agent loop
 * (local_* → runLocalTool, everything else → callMcpTool).
 *
 * SECURITY MODEL: every input arg the LLM supplies is treated as
 * untrusted — no eval, no dynamic SQL, no raw file access. workspaceId
 * is bound at the top of runLocalTool from the caller's context,
 * NEVER from an LLM-supplied field. A prompt-injected model that
 * tries to pass workspaceId in args is ignored.
 */

import { db } from "@/lib/db";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";

/** Anthropic Tool schema for each local tool. Registered
 *  alongside the MCP tools in the agent runner's tools[] array. */
export const LOCAL_TOOLS: Tool[] = [
  {
    name: "local_list_workspace_products",
    description:
      "List products in this workspace, optionally filtered by review status. Use this when the operator asks about 'my products', 'approved products', or refers to a product by name — call this first to find the productId, then get_product_context. Returns id, name, market, category, discountPercent, hasReferenceImage, hasStyle1Kit, generatedVideoCount.",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["approved", "needs_review", "rejected", "maybe", "any"],
          description:
            "Filter by review status. Default 'approved' — only ready-to-generate products.",
        },
        limit: {
          type: "number",
          description: "Max products to return. Default 20, max 100.",
        },
        search: {
          type: "string",
          description:
            "Case-insensitive substring match on productName. Handy when the operator mentions a product by name (e.g. 'Ninja').",
        },
      },
    },
  },
  {
    name: "local_get_product_context",
    description:
      "Get full context for a specific product: name, market, category, discount, referenceImageUrl (absolute URL), existing Style 1 copy options if generated (part1/2/3 arrays), hashtags, source description, and list of already-generated videos. Call this before deciding what Flow prompts to fire — the reference image URL is what you upload to Flow.",
    input_schema: {
      type: "object" as const,
      properties: {
        productId: {
          type: "string",
          description: "The product's id from list_workspace_products.",
        },
      },
      required: ["productId"],
    },
  },
  {
    name: "local_save_generated_video",
    description:
      "Persist a Flow-generated video to a product so it appears on the mobile posting page. Call this AFTER google_flow_get_job returns a completed video job — use the mediaGenerationId from the job result, NOT the jobId. sceneLabel maps this video to its slot in the Style 1 structure (scene_1_store for the store walk-up, scene_2_home for the product-at-home). Idempotent-ish: doesn't check for duplicates, so don't call twice for the same generation.",
    input_schema: {
      type: "object" as const,
      properties: {
        productId: { type: "string" },
        sceneLabel: {
          type: "string",
          enum: ["scene_1_store", "scene_2_home", "combined", "other"],
          description:
            "Which scene this video corresponds to. Use scene_1_store for the store walk-up (Scene 1 of Style 1), scene_2_home for the product-at-home (Scene 2), combined for a full stitched 16s video, other for adhoc / experimental generations.",
        },
        mediaGenerationId: {
          type: "string",
          description:
            "The mediaGenerationId returned by google_flow_get_job. NOT the jobId. Stable — resolves to a fresh signed URL via google_flow_get_asset on demand (URLs themselves expire in ~6h).",
        },
        prompt: {
          type: "string",
          description:
            "The motion/video prompt used to generate this video. Stored for debugging + regenerate-with-tweak flows.",
        },
        notes: {
          type: "string",
          description:
            "Optional operator-facing notes about this generation (e.g. 'first attempt, may regenerate for better lighting'). Rendered as hover text on the mobile posting page.",
        },
      },
      required: ["productId", "sceneLabel", "mediaGenerationId"],
    },
  },
  {
    name: "local_list_saved_videos_for_product",
    description:
      "List videos already saved for a product. Call this BEFORE generating to avoid regenerating scenes that are already done. Returns array of {id, sceneLabel, mediaGenerationId, prompt, notes, createdAt}.",
    input_schema: {
      type: "object" as const,
      properties: {
        productId: { type: "string" },
      },
      required: ["productId"],
    },
  },
];

/** Set of local tool names for fast "is this a local tool?" checks
 *  in the agent runner's dispatch. */
export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

/**
 * Execute a local tool. Called by the agent runner when
 * LOCAL_TOOL_NAMES.has(toolName). workspaceId comes from the
 * signed request context — never from the LLM's tool args.
 *
 * Returns a stringified result the runner can drop straight into
 * an Anthropic tool_result block. Errors are strings prefixed
 * "Error: " with a small suggestion — the model handles retries.
 */
export async function runLocalTool(input: {
  workspaceId: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<{ isError: boolean; result: string }> {
  try {
    switch (input.name) {
      case "local_list_workspace_products":
        return {
          isError: false,
          result: JSON.stringify(
            await listWorkspaceProducts(input.workspaceId, input.args),
          ).slice(0, 20_000),
        };
      case "local_get_product_context":
        return {
          isError: false,
          result: JSON.stringify(
            await getProductContext(input.workspaceId, input.args),
          ).slice(0, 20_000),
        };
      case "local_save_generated_video":
        return {
          isError: false,
          result: JSON.stringify(
            await saveGeneratedVideo(input.workspaceId, input.args),
          ),
        };
      case "local_list_saved_videos_for_product":
        return {
          isError: false,
          result: JSON.stringify(
            await listSavedVideosForProduct(input.workspaceId, input.args),
          ),
        };
      default:
        return {
          isError: true,
          result: `Error: unknown local tool "${input.name}". Check LOCAL_TOOL_NAMES.`,
        };
    }
  } catch (err) {
    return {
      isError: true,
      result: `Error: ${(err as Error).message?.slice(0, 400) || "unknown"}`,
    };
  }
}

/* ------------------------------------------------------------------
 * Individual tool implementations
 * ---------------------------------------------------------------- */

async function listWorkspaceProducts(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<{
  products: Array<{
    id: string;
    name: string;
    market: string;
    category: string | null;
    discountPercent: number | null;
    reviewStatus: string;
    hasReferenceImage: boolean;
    hasStyle1Kit: boolean;
    generatedVideoCount: number;
  }>;
}> {
  const status = String(args.status ?? "approved");
  const limit = Math.min(Number(args.limit ?? 20) || 20, 100);
  const search = typeof args.search === "string" ? args.search.trim() : "";

  const rows = await db.product.findMany({
    where: {
      batch: { workspaceId },
      deletedAt: null,
      ...(status !== "any" ? { reviewStatus: status } : {}),
      // SQLite's LIKE (what Prisma's contains compiles to on the
      // SQLite provider) is case-insensitive by default for ASCII
      // — no mode:"insensitive" needed. Postgres also honors this
      // shape (case-sensitive by default there, but the operator
      // typically types the same case as the stored name).
      ...(search
        ? { productName: { contains: search } }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      productName: true,
      category: true,
      discountPercent: true,
      reviewStatus: true,
      referenceImageUrl: true,
      style1Kit: true,
      batch: { select: { market: true } },
      _count: { select: { flowGeneratedVideos: true } },
    },
  });
  return {
    products: rows.map((r) => ({
      id: r.id,
      name: r.productName,
      market: r.batch.market,
      category: r.category,
      discountPercent: r.discountPercent,
      reviewStatus: r.reviewStatus,
      hasReferenceImage: !!r.referenceImageUrl,
      hasStyle1Kit: !!r.style1Kit,
      generatedVideoCount: r._count.flowGeneratedVideos,
    })),
  };
}

async function getProductContext(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const productId = String(args.productId ?? "").trim();
  if (!productId) throw new Error("productId is required");
  const row = await db.product.findFirst({
    where: {
      id: productId,
      batch: { workspaceId },
      deletedAt: null,
    },
    include: {
      batch: { select: { market: true, name: true } },
      flowGeneratedVideos: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          sceneLabel: true,
          mediaGenerationId: true,
          prompt: true,
          notes: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row) throw new Error(`product "${productId}" not found`);

  // Parse the style1Kit JSON if present so the agent can see the
  // copy options directly rather than a stringified blob.
  let style1Kit: unknown = null;
  if (row.style1Kit) {
    try {
      style1Kit = JSON.parse(row.style1Kit);
    } catch {
      // ignore malformed kit
    }
  }

  // Build absolute image URL for the agent's Flow uploads.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  const referenceImageAbsUrl = row.referenceImageUrl
    ? row.referenceImageUrl.startsWith("http")
      ? row.referenceImageUrl
      : appUrl
        ? `${appUrl}${row.referenceImageUrl}`
        : row.referenceImageUrl
    : null;

  return {
    id: row.id,
    name: row.productName,
    market: row.batch.market,
    batchName: row.batch.name,
    category: row.category,
    discountPercent: row.discountPercent,
    discountType: row.discountType,
    reviewStatus: row.reviewStatus,
    tiktokUrl: row.tiktokUrl,
    referenceImageUrl: referenceImageAbsUrl,
    style1Kit,
    sourceDescription: row.sourceDescription,
    generatedVideos: row.flowGeneratedVideos.map((v) => ({
      id: v.id,
      sceneLabel: v.sceneLabel,
      mediaGenerationId: v.mediaGenerationId,
      prompt: v.prompt,
      notes: v.notes,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

async function saveGeneratedVideo(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<{ id: string; sceneLabel: string }> {
  const productId = String(args.productId ?? "").trim();
  const sceneLabel = String(args.sceneLabel ?? "").trim();
  const mediaGenerationId = String(args.mediaGenerationId ?? "").trim();
  const prompt =
    typeof args.prompt === "string" ? args.prompt.slice(0, 4000) : null;
  const notes =
    typeof args.notes === "string" ? args.notes.slice(0, 1000) : null;

  if (!productId) throw new Error("productId is required");
  if (!mediaGenerationId) throw new Error("mediaGenerationId is required");
  const validScenes = new Set([
    "scene_1_store",
    "scene_2_home",
    "combined",
    "other",
  ]);
  if (!validScenes.has(sceneLabel)) {
    throw new Error(
      `sceneLabel must be one of: ${Array.from(validScenes).join(", ")}`,
    );
  }

  // Verify product belongs to this workspace — the agent's args
  // could point at any id, but the workspace boundary is
  // authoritative.
  const product = await db.product.findFirst({
    where: { id: productId, batch: { workspaceId }, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new Error(`product "${productId}" not found`);

  const row = await db.flowGeneratedVideo.create({
    data: {
      productId: product.id,
      sceneLabel,
      mediaGenerationId,
      prompt,
      notes,
    },
    select: { id: true, sceneLabel: true },
  });
  return row;
}

async function listSavedVideosForProduct(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<{
  videos: Array<{
    id: string;
    sceneLabel: string;
    mediaGenerationId: string;
    prompt: string | null;
    notes: string | null;
    createdAt: string;
  }>;
}> {
  const productId = String(args.productId ?? "").trim();
  if (!productId) throw new Error("productId is required");
  const product = await db.product.findFirst({
    where: { id: productId, batch: { workspaceId }, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw new Error(`product "${productId}" not found`);
  const rows = await db.flowGeneratedVideo.findMany({
    where: { productId: product.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      sceneLabel: true,
      mediaGenerationId: true,
      prompt: true,
      notes: true,
      createdAt: true,
    },
  });
  return {
    videos: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}
