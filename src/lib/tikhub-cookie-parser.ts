/**
 * Cookie parser for the BOF Dashboard account-add flow.
 *
 * The operator pastes a raw cookie string from their browser's
 * DevTools — usually copied straight from the "Cookie" request
 * header or a "Copy as cURL" extract. TikHub forwards the cookie
 * string to TikTok verbatim, so the more keys we pass through, the
 * better our odds of clearing TikTok's anti-bot gates.
 *
 * What we MUST see for the cookie to be usable:
 *
 *   sessionid   — the actual logged-in session id
 *   msToken     — TikTok's anti-bot proof-of-work token
 *   ttwid       — device fingerprint
 *
 * What we'd LIKE to see but don't require (different TikTok login
 * paths produce different cookie sets — for example, a QR-code
 * login does NOT include passport_csrf_token):
 *
 *   sessionid_ss, tt-target-idc, passport_csrf_token, sid_guard
 *
 * The normalized string we hand to TikHub is the FULL paste —
 * every cookie the user copied, not just the required subset.
 * This way TikHub forwards along whatever cookies TikTok wants for
 * the specific endpoint, even ones we haven't catalogued.
 *
 * Defensive: cookies are sensitive. We don't log raw values. The
 * returned object only includes the normalized string for use by
 * the TikHub service layer + the encryption layer.
 */

/** Cookies that MUST be present — without these the call cannot
 *  authenticate and TikHub will reject. */
const REQUIRED_KEYS = ["sessionid", "msToken", "ttwid"] as const;

/** Cookies we'd LIKE to see but accept the paste without. Surfaced
 *  in the parse result so the settings UI can warn the operator
 *  that they're missing a recommended gate. */
const RECOMMENDED_KEYS = [
  "sessionid_ss",
  "tt-target-idc",
  "passport_csrf_token",
] as const;

/** Backwards-compat alias — older callers (tikhub.ts) import this
 *  name when spot-checking that cookie strings have minimum
 *  content. */
export const REQUIRED_TIKTOK_COOKIES = REQUIRED_KEYS;

export type RequiredCookieKey = (typeof REQUIRED_KEYS)[number];

export interface ParsedCookieSuccess {
  ok: true;
  /** The normalized "key1=val1; key2=val2; …" string TikHub gets.
   *  Includes every cookie found in the paste, in original-paste
   *  order. */
  normalized: string;
  /** Required-keys-only extract. Useful for debugging; never
   *  logged. */
  extracted: Record<RequiredCookieKey, string>;
  /** Recommended cookies that were NOT in the paste. Empty array
   *  when everything was present. The settings UI surfaces this
   *  as a soft warning, not a hard error. */
  missingRecommended: string[];
}

export interface ParsedCookieFailure {
  ok: false;
  message: string;
  /** Which of the REQUIRED keys we couldn't find. */
  missing: RequiredCookieKey[];
}

export type ParsedCookie = ParsedCookieSuccess | ParsedCookieFailure;

interface ExtractedCookies {
  /** Insertion-ordered list of all (key, value) pairs the parser
   *  pulled out of the paste. Order matches the paste so cookie
   *  attributes that depend on order (rare but possible) survive
   *  the round-trip. */
  ordered: Array<[string, string]>;
  /** Same data keyed by name, last-write-wins (handles pastes that
   *  include the same cookie twice — the more-recently-set value
   *  wins, matching browser behaviour). */
  byName: Map<string, string>;
}

/**
 * Parse a raw cookie paste and return either the normalized
 * TikHub-ready string + extracted required keys, OR a structured
 * failure listing missing required keys.
 *
 * Accepts the following input shapes (DevTools paste patterns
 * we've seen in the wild):
 *
 *   1. Cookie header value:
 *      "sessionid=abc; sessionid_ss=def; tt-target-idc=ghi"
 *
 *   2. Multi-line Set-Cookie list:
 *      "sessionid=abc; Path=/; Domain=.tiktok.com
 *       sessionid_ss=def; Path=/; HttpOnly"
 *
 *   3. JSON array of {name, value} objects (Chrome's "EditThisCookie"
 *      extension export format)
 *
 *   4. Newline-separated key=value pairs without semicolons
 *
 * The matcher is conservative: it splits on both newlines AND
 * semicolons, then for each token finds the first "=" and treats
 * everything before it as the key and after as the value. Values
 * that contain "=" are preserved (msToken values have base64
 * padding).
 */
export function parseTikTokCookieString(raw: string): ParsedCookie {
  const trimmed = (raw ?? "").trim();
  const extracted = extractAll(trimmed);

  const missingRequired: RequiredCookieKey[] = [];
  const requiredValues: Partial<Record<RequiredCookieKey, string>> = {};
  for (const key of REQUIRED_KEYS) {
    const v = extracted.byName.get(key);
    if (v) requiredValues[key] = v;
    else missingRequired.push(key);
  }
  if (missingRequired.length > 0) {
    return {
      ok: false,
      message:
        `Cookie paste is missing required key(s): ${missingRequired.join(", ")}. ` +
        "Make sure you copied the full Cookie header from a " +
        "logged-in TikTok Shop session.",
      missing: missingRequired,
    };
  }

  const missingRecommended = RECOMMENDED_KEYS.filter(
    (k) => !extracted.byName.has(k),
  );

  // Normalize: include EVERY cookie found, in original paste
  // order, last-write-wins. We rebuild the string from
  // ordered+byName so duplicates collapse cleanly.
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [k] of extracted.ordered) {
    if (seen.has(k)) continue;
    seen.add(k);
    const v = extracted.byName.get(k);
    if (v !== undefined) parts.push(`${k}=${v}`);
  }

  return {
    ok: true,
    normalized: parts.join("; "),
    extracted: requiredValues as Record<RequiredCookieKey, string>,
    missingRecommended: [...missingRecommended],
  };
}

function extractAll(trimmed: string): ExtractedCookies {
  const out: ExtractedCookies = { ordered: [], byName: new Map() };

  if (!trimmed) return out;

  // Try JSON-array shape first (EditThisCookie / similar
  // browser-extension export). If it parses cleanly AND has
  // objects with name/value fields, walk it.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      let anyMatched = false;
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const n = String((item as { name?: unknown }).name ?? "").trim();
        const v = String((item as { value?: unknown }).value ?? "");
        if (!n || !v) continue;
        anyMatched = true;
        out.ordered.push([n, v]);
        out.byName.set(n, v);
      }
      if (anyMatched) return out;
    } catch {
      // Fall through to text parsing.
    }
  }

  // Split on newline AND semicolon — handles both header-style and
  // Set-Cookie-list-style pastes.
  const tokens = trimmed
    .split(/[\r\n;]+/g)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).trim();
    let value = token.slice(eq + 1).trim();
    // Defensive: some pastes wrap the value in quotes. Strip a
    // matched pair if present.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.ordered.push([key, value]);
    out.byName.set(key, value);
  }

  return out;
}

/**
 * Mask a normalized cookie string for safe display. Returns the key
 * names with the first 4 chars of each value, e.g.
 * "sessionid=abc1***; msToken=def2***; …". Use anywhere a cookie
 * value would otherwise hit the UI / logs.
 */
export function maskCookieString(normalized: string): string {
  return normalized
    .split("; ")
    .map((kv) => {
      const eq = kv.indexOf("=");
      if (eq <= 0) return kv;
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      const head = v.length <= 4 ? v : v.slice(0, 4);
      return `${k}=${head}***`;
    })
    .join("; ");
}
