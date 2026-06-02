/**
 * Kalodata XLSX import — parser + image downloader.
 *
 * Mirrors the canonical-field/alias map the Python Streamlit importer
 * uses (flow-bof-automation/streamlit_app.py:KALODATA_FIELD_ALIASES)
 * so a workbook imported in either UI produces the same rows.
 *
 * The parser is a pure function: bytes in, list-of-rows out, no I/O.
 * The downloader writes to `public/uploads/batches/<batchId>/` so the
 * Next dev server (or any Node server) serves them at
 * `/uploads/batches/<batchId>/<file>` automatically.
 */

import * as XLSX from "xlsx";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

/**
 * Canonical field → ordered list of Kalodata column-header aliases we
 * should look for. First match wins, comparison is case-insensitive
 * and ignores leading/trailing whitespace.
 *
 * Keep in sync with the Python equivalent. When Kalodata renames a
 * column we update both — but because the alias list is "best of N",
 * the *previous* names keep working for old exports too.
 */
export const KALODATA_FIELD_ALIASES: Record<string, string[]> = {
  product_name:     ["Product Name"],
  img_url:          ["img_url", "Image Link", "Image URL", "ImageUrl"],
  category:         ["Category"],
  tiktok_url:       ["TikTokUrl", "TikTok URL", "TikTok Link", "TiktokUrl", "Product URL"],
  kalodata_url:     ["KalodataUrl", "Kalodata URL", "Kalodata Details Link"],

  price:            ["Avg. Unit Price($)", "Price($)", "Price"],
  price_range:      ["Price Range($)"],
  commission:       ["Commission Rate"],
  revenue:          ["Revenue($)", "Revenue"],
  revenue_growth:   ["Revenue Growth Rate"],
  live_revenue:     ["Live Revenue($)"],
  video_revenue:    ["Video Revenue($)"],
  card_revenue:     ["Product Card Revenue"],

  creators:         ["Creator Count", "Creator Number"],
  new_creators:     ["New Creator Count"],
  conversion:       ["Creator Conversion Ratio"],
  video_count:      ["Video Count"],
  new_videos:       ["New Video Count"],

  rating:           ["Product Rating"],
  item_sold:        ["Item Sold", "Items Sold"],
  item_sold_growth: ["Item Sold Growth Rate"],
  launch_date:      ["Launch Date"],
  date_range:       ["Date Range"],
  remarks:          ["Remarks"],
};

const PREFERRED_SHEETS = ["LIST_PRODUCT", "LIST_PRODUCT_FOCUS"];
const META_SHEET_NAMES = new Set([
  "intro", "info", "about", "cover", "metadata", "summary",
]);

/**
 * Pick the most likely product-list sheet. Same precedence as the
 * Python importer:
 *   1. Exact match for a preferred sheet (case-insensitive).
 *   2. Any sheet whose name starts with LIST_PRODUCT (handles future
 *      Kalodata variants).
 *   3. The first non-metadata sheet.
 */
export function selectKalodataSheet(sheetNames: string[]): string {
  const upperToActual = new Map(
    sheetNames.map((n) => [n.toUpperCase(), n]),
  );
  for (const wanted of PREFERRED_SHEETS) {
    if (sheetNames.includes(wanted)) return wanted;
    const hit = upperToActual.get(wanted.toUpperCase());
    if (hit) return hit;
  }
  for (const n of sheetNames) {
    if (n.toUpperCase().startsWith("LIST_PRODUCT")) return n;
  }
  for (const n of sheetNames) {
    if (!META_SHEET_NAMES.has(n.trim().toLowerCase())) return n;
  }
  throw new Error(
    `No product sheet found. Sheets present: ${sheetNames.join(", ") || "(none)"}`,
  );
}

/**
 * Read a canonical field from a raw row dict. The row is the
 * `{header: cell}` shape `xlsx.sheet_to_json` produces; alias lookup
 * is case- and whitespace-tolerant.
 */
export function kalodataField(
  row: Record<string, unknown>,
  canonical: string,
): string {
  const aliases = KALODATA_FIELD_ALIASES[canonical] ?? [canonical];
  // Build a case-insensitive map once per row → fast for many fields.
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    norm.set(k.trim().toLowerCase(), v);
  }
  for (const a of aliases) {
    const v = norm.get(a.trim().toLowerCase());
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return "";
}

export interface KalodataRow {
  productName:     string;
  originalTitle:   string;
  imgUrl:          string;
  category:        string;
  tiktokUrl:       string;
  kalodataUrl:     string;
  price:           string;
  commission:      string;
  revenue:         string;
  revenueGrowth:   string;
  creators:        string;
}

export interface KalodataParseResult {
  sheetName: string;
  rows: KalodataRow[];
}

/**
 * Parse a Kalodata workbook into typed rows. Returns rows in the
 * sheet's natural order; downstream layers filter/limit as needed.
 *
 * Throws on malformed workbooks (no sheets, unreadable XLSX bytes);
 * caller turns that into a 4xx-style import error.
 */
export function parseKalodataWorkbook(bytes: Buffer): KalodataParseResult {
  const wb = XLSX.read(bytes, { type: "buffer" });
  const sheetName = selectKalodataSheet(wb.SheetNames);
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet ${sheetName} not found`);

  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    raw: false,
    defval: "",
  });

  const rows: KalodataRow[] = raw
    .map((r) => ({
      productName:   kalodataField(r, "product_name"),
      originalTitle: kalodataField(r, "product_name"),
      imgUrl:        kalodataField(r, "img_url"),
      category:      kalodataField(r, "category"),
      tiktokUrl:     kalodataField(r, "tiktok_url"),
      kalodataUrl:   kalodataField(r, "kalodata_url"),
      price:         kalodataField(r, "price"),
      commission:    kalodataField(r, "commission"),
      revenue:       kalodataField(r, "revenue"),
      revenueGrowth: kalodataField(r, "revenue_growth"),
      creators:      kalodataField(r, "creators"),
    }))
    .filter((r) => r.productName.length > 0);

  return { sheetName, rows };
}

// ---------------------------------------------------------------------
// Image download helpers
// ---------------------------------------------------------------------

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg":  "jpg",
  "image/jpg":   "jpg",
  "image/pjpeg": "jpg",
  "image/png":   "png",
  "image/webp":  "webp",
  "image/gif":   "gif",
  "image/bmp":   "bmp",
};

/**
 * Best-effort extension inference. Same order the runner uses on its
 * side: header → URL suffix → "jpg" fallback.
 */
function inferImageExt(contentType: string | null, url: string): string {
  if (contentType) {
    const ct = contentType.split(";", 1)[0].trim().toLowerCase();
    if (CONTENT_TYPE_TO_EXT[ct]) return CONTENT_TYPE_TO_EXT[ct];
  }
  try {
    const u = new URL(url);
    const suffix = path.extname(u.pathname).toLowerCase().replace(/^\./, "");
    if (suffix === "jpeg") return "jpg";
    if (["jpg", "png", "webp", "gif", "bmp"].includes(suffix)) return suffix;
  } catch {
    // ignore malformed URLs; caller has surfaced the original anyway
  }
  return "jpg";
}

export interface DownloadResult {
  /** Absolute on-disk path of the saved file. */
  filePath: string;
  /** Public URL prefix to store on the Product row, e.g. `/uploads/batches/<id>/<file>`. */
  relUrl: string;
  /** Detected extension (without leading dot). */
  ext: string;
  /** Size in bytes. */
  size: number;
}

/**
 * Download `url` and save it as
 * `public/uploads/batches/<batchId>/<productId>_primary.<ext>`.
 *
 * Returns both the on-disk path and the public-relative URL the
 * Product row should store (`/uploads/batches/<batchId>/...`). Caller
 * decides what to do on failure — we just raise.
 */
export async function downloadProductImage({
  url,
  batchId,
  productId,
  publicDir,
  timeoutMs = 20_000,
}: {
  url: string;
  batchId: string;
  productId: string;
  /** Absolute path of the Next "public/" folder. */
  publicDir: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "flow-bof-saas/0.1 (kalodata-import)" },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const ct = resp.headers.get("content-type");
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length === 0) throw new Error("empty response body");

  const ext = inferImageExt(ct, url);
  const fname = `${productId}_primary.${ext}`;
  const dir = path.join(publicDir, "uploads", "batches", batchId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fname);
  await fs.writeFile(filePath, buf);

  return {
    filePath,
    relUrl: `/uploads/batches/${batchId}/${fname}`,
    ext,
    size: buf.length,
  };
}

/**
 * Resolve the URL the local runner uses to fetch a reference image
 * stored under `/uploads/...`. The runner runs in a Docker container
 * (or as a sibling process on a separate machine), so the SaaS-internal
 * relative URL needs an externally-reachable prefix.
 *
 * Configurable via env: AGENT_ASSET_BASE_URL.
 *   Default: http://host.docker.internal:3000
 *
 * Pass-through for already-absolute URLs so we don't double-prefix
 * future signed URLs.
 */
export function agentAssetUrl(relUrl: string): string {
  if (/^https?:\/\//i.test(relUrl)) return relUrl;
  const base = (process.env.AGENT_ASSET_BASE_URL || "http://host.docker.internal:3000")
    .replace(/\/+$/, "");
  if (!relUrl.startsWith("/")) return `${base}/${relUrl}`;
  return `${base}${relUrl}`;
}
