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
//
// Reads the CONTENT_TYPE_TO_EXT / magic-byte tables in tandem so a
// Kalodata CDN that lies about its Content-Type still produces a
// correct filename. Order:
//
//   1. Content-Type response header (most authoritative when present)
//   2. First few bytes of the body (deterministic when content-type
//      is wrong or absent)
//   3. URL path suffix (least authoritative — many CDN URLs end .php)
//   4. Default jpg.
//
// `jpeg` is normalised to `jpg` so all stored URLs share one
// extension family. Supported: jpg, png, webp, gif, bmp.

import { getBatchUploadDir, publicUploadUrlFor } from "@/lib/uploads";

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg":  "jpg",
  "image/jpg":   "jpg",
  "image/pjpeg": "jpg",
  "image/png":   "png",
  "image/webp":  "webp",
  "image/gif":   "gif",
  "image/bmp":   "bmp",
};

/** Returns the canonical extension if `body` starts with a known
 *  image magic prefix; "" otherwise. */
function sniffImageMagic(body: Buffer): string {
  if (body.length < 4) return "";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "jpg";
  if (
    body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  ) return "png";
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "gif";
  if (body[0] === 0x42 && body[1] === 0x4d) return "bmp";
  // WEBP: "RIFF<size>WEBP"
  if (
    body.length >= 12 &&
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) return "webp";
  return "";
}

/**
 * Best-effort extension inference: content-type → magic bytes → URL
 * suffix → jpg fallback. Returns the canonical (jpeg→jpg) form.
 */
function inferImageExt(
  contentType: string | null,
  body: Buffer,
  url: string,
): string {
  if (contentType) {
    const ct = contentType.split(";", 1)[0].trim().toLowerCase();
    if (CONTENT_TYPE_TO_EXT[ct]) return CONTENT_TYPE_TO_EXT[ct];
  }
  const magic = sniffImageMagic(body);
  if (magic) return magic;
  try {
    const u = new URL(url);
    const suffix = path.extname(u.pathname).toLowerCase().replace(/^\./, "");
    if (suffix === "jpeg") return "jpg";
    if (["jpg", "png", "webp", "gif", "bmp"].includes(suffix)) return suffix;
  } catch {
    // malformed URL — fall through to jpg
  }
  return "jpg";
}

/** Loose "is this image-ish" sniff used to reject obvious junk
 *  payloads (HTML error pages, redirects to login walls, etc.). */
function looksLikeImage(contentType: string | null, body: Buffer): boolean {
  if (contentType) {
    const ct = contentType.split(";", 1)[0].trim().toLowerCase();
    if (ct.startsWith("image/")) return true;
  }
  return sniffImageMagic(body).length > 0;
}

export interface DownloadResult {
  /** Absolute on-disk path of the saved file. */
  filePath: string;
  /** Public URL stored on Product.referenceImageUrl, e.g.
   *  `/uploads/workspaces/<ws>/batches/<b>/<p>_primary.jpg`. */
  relUrl: string;
  /** Detected extension (without leading dot). */
  ext: string;
  /** Size in bytes. */
  size: number;
}

/** Default max image size before we refuse to keep buffering. 20MB
 *  is comfortably above any reasonable product hero shot. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Download a Kalodata product image into
 * `public/uploads/workspaces/<wsId>/batches/<batchId>/<productId>_primary.<ext>`
 * and return the on-disk path + the public URL the Product row should
 * store. Hard guarantees on the return value:
 *
 *   - The file at `filePath` exists, has size > 0, and looks like
 *     a real image (content-type starts with `image/` OR magic bytes
 *     match a known format).
 *   - `relUrl` is a relative `/uploads/…` path. Never a filesystem
 *     path, never null on success.
 *
 * On any failure (bad HTTP status, non-image body, EACCES, write
 * failure) we throw with a message safe to render to the user. The
 * caller is responsible for the per-product retry / "set
 * referenceImageUrl to null" decision.
 */
export async function downloadProductImage({
  url,
  workspaceId,
  batchId,
  productId,
  timeoutMs = 20_000,
}: {
  url: string;
  workspaceId: string;
  batchId: string;
  productId: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      // Some CDNs reject our naked default UA + return a 403/HTML
      // login wall. The header set below is what a vanilla Chrome
      // sends for a direct image GET — friendly to most CDNs without
      // pretending to be a full browser.
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const ct = resp.headers.get("content-type");
  const ab = await resp.arrayBuffer();
  if (ab.byteLength === 0) throw new Error("empty response body");
  if (ab.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `image too large (${ab.byteLength} bytes, max ${MAX_IMAGE_BYTES})`,
    );
  }
  const buf = Buffer.from(ab);
  if (!looksLikeImage(ct, buf)) {
    throw new Error(
      `response does not look like an image (content-type=${ct ?? "?"})`,
    );
  }

  const ext = inferImageExt(ct, buf, url);
  const fname = `${productId}_primary.${ext}`;
  const dir = getBatchUploadDir(workspaceId, batchId);

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      throw new Error(
        "Upload directory is not writable. " +
          "Run scripts/fix-upload-perms.sh on the server.",
      );
    }
    throw err;
  }

  const filePath = path.join(dir, fname);
  try {
    await fs.writeFile(filePath, buf);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      throw new Error(
        "Upload directory is not writable. " +
          "Run scripts/fix-upload-perms.sh on the server.",
      );
    }
    throw err;
  }

  // Belt-and-suspenders: confirm the file actually ended up where
  // we said it did before we hand the URL back to the caller. A
  // disk-full or filesystem-quota issue can swallow the write
  // silently in older Node versions; stat surfaces it.
  const st = await fs.stat(filePath);
  if (!st.isFile() || st.size === 0) {
    throw new Error("post-write stat reported zero-size or non-file");
  }

  return {
    filePath,
    relUrl: publicUploadUrlFor(
      "workspaces",
      workspaceId,
      "batches",
      batchId,
      fname,
    ),
    ext,
    size: st.size,
  };
}
