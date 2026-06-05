/**
 * Deterministic IP / trademark risk heuristic for TikTok Shop products.
 *
 * This is a CONSERVATIVE screening tool, NOT legal advice. Output
 * messaging deliberately says "potential risk, review manually" and
 * never asserts that a product is illegal. The user is responsible
 * for the final go/no-go decision.
 *
 * Detection layers in this file:
 *   1. Imitation phrases — strongest signal. "dupe", "1:1", "replica",
 *      "designer inspired" etc. almost always mean counterfeit intent.
 *   2. Famous brand names — when found in a product title without a
 *      legitimate "compatibility" qualifier, raise to high.
 *   3. Character / franchise references — Disney, Pokémon, sports
 *      teams, etc.
 *   4. Logo / pattern terms — "monogram", "luxury logo print",
 *      "designer pattern".
 *
 * Special nuance the spec calls out:
 *   - "compatible with iPhone" / "case for Samsung Galaxy" should
 *     NOT auto-flag high. They're generic accessory products. The
 *     COMPATIBILITY_QUALIFIERS list lets the heuristic see this
 *     context and downgrade from high → medium.
 *
 * The AI-assisted check (phase-9c) consumes the same product fields
 * and returns its own verdict. The merge rule is "higher score wins"
 * — see mergeIpRisk() at the bottom. Heuristic-only mode is fine
 * (it's what users without an AI provider configured will use).
 */

import { parseJson } from "@/lib/json-column";

export type IpRiskStatus =
  | "unchecked"
  | "low"
  | "medium"
  | "high"
  | "needs_manual_review";

/** Numeric rank used internally for "higher score wins" comparisons.
 *  unchecked is treated as -1 so it can never beat a real verdict. */
const STATUS_RANK: Record<IpRiskStatus, number> = {
  unchecked:           -1,
  low:                 0,
  medium:              1,
  needs_manual_review: 2,
  high:                3,
};

export interface IpRiskAssessment {
  status: IpRiskStatus;
  /** Score 0-100. Useful for sorting; UI only shows the status chip. */
  score: number;
  /** Human-readable reasons surfaced on the product card. Each
   *  reason starts with a capital letter and is a complete thought
   *  ("Contains famous brand term: Nike"). */
  reasons: string[];
  /** Specific tokens that matched, for the user to verify the
   *  heuristic isn't being silly. Subset of reasons — just the
   *  matched substrings without the prose. */
  matchedTerms: string[];
  /** Free-form short recommendation ("approve", "review", "reject"
   *  — non-binding; the UI uses status for the actual gating). */
  recommendation: "approve" | "review" | "reject";
}

// ---------------------------------------------------------------------
// Term lists. These are intentionally hand-curated — automated
// generation from scraped brand databases produced too many false
// positives in early testing. When you add a brand here, also think
// about whether the brand has legitimate compatible-accessory
// products (Apple, Samsung, etc.) and whether the COMPATIBILITY
// nuance below should soften the flag.
// ---------------------------------------------------------------------

/** Imitation / counterfeit phrases. Match anywhere in title or
 *  description, case-insensitive, with word-boundary protection so
 *  "dupe" doesn't fire on "duplex". */
const IMITATION_PHRASES = [
  "dupe",
  "dupes",
  "inspired by",
  "designer inspired",
  "luxury inspired",
  "look alike",
  "lookalike",
  "look-alike",
  "replica",
  "replicas",
  "1:1",
  "1 to 1",
  " ua ", // "Unauthorized Authentic" — but only when surrounded by spaces so we don't false-positive on words like "actual"
  "mirror quality",
  "same as",
  "alternative to",
  "fake",
  "knockoff",
  "knock-off",
  "knock off",
  "clone",
  "copy of",
  "oem brand",
  "unbranded version of",
] as const;

/** Famous brand / luxury marks. Detected as whole words (regex
 *  \bword\b style). Hits this list = HIGH risk unless a
 *  COMPATIBILITY_QUALIFIER appears in the same product title, in
 *  which case it's downgraded to MEDIUM. */
const FAMOUS_BRANDS = [
  // Athletic / streetwear
  "nike", "adidas", "jordan", "yeezy", "air jordan", "off-white", "off white",
  "supreme", "stussy", "fear of god", "essentials", "kith",
  // Luxury fashion
  "gucci", "louis vuitton", "lv", "chanel", "dior", "prada", "versace",
  "balenciaga", "bottega veneta", "hermes", "hermès", "fendi", "givenchy",
  "saint laurent", "ysl", "burberry", "celine", "valentino", "loewe",
  "moncler", "canada goose",
  // Watches / jewelry
  "rolex", "cartier", "omega watch", "patek philippe", "audemars piguet",
  "richard mille", "hublot", "tag heuer", "tiffany", "van cleef",
  // Tech (handle compatibility carefully — see below)
  "apple", "iphone", "ipad", "macbook", "airpods", "samsung", "galaxy",
  "sony", "playstation", "ps5", "ps4", "xbox", "nintendo", "switch",
  "beats", "bose", "dyson",
  // Entertainment / IP holders
  "disney", "marvel", "dc comics", "star wars", "harry potter", "lord of the rings",
  "pixar", "lucasfilm", "warner bros", "universal pictures",
  // Toys / kids
  "barbie", "lego", "hot wheels", "fisher-price", "hello kitty", "pokemon",
  "pokémon", "my little pony", "transformers",
  // Eyewear
  "ray-ban", "ray ban", "rayban", "oakley", "persol",
  // Home / lifestyle / viral
  "stanley", "stanley cup", "stanley tumbler", "yeti", "owala",
  "ugg", "crocs", "doc martens", "dr martens", "dr. martens", "the north face", "north face",
  "patagonia", "carhartt", "champion", "lululemon",
  // Beauty
  "mac cosmetics", "fenty", "rare beauty", "drunk elephant", "sol de janeiro",
  "charlotte tilbury", "la mer", "sk-ii",
] as const;

/** Character / franchise references that imply protected IP even
 *  when no brand name is mentioned. Same matching rules as brands. */
const CHARACTER_FRANCHISES = [
  "mickey mouse", "minnie mouse", "spider-man", "spiderman", "batman",
  "superman", "iron man", "captain america", "wonder woman", "elsa",
  "frozen", "moana", "encanto", "anna and elsa", "stitch", "bluey",
  "peppa pig", "paw patrol", "cocomelon", "minecraft", "fortnite",
  "roblox", "among us", "squid game", "wednesday addams",
  "labubu", // viral collectible
  "sanrio", "kuromi", "my melody", "cinnamoroll", "pochacco",
  "demon slayer", "naruto", "one piece", "dragon ball",
  "attack on titan", "jujutsu kaisen", "studio ghibli", "totoro",
] as const;

/** Logo / pattern / monogram references. These don't always indicate
 *  counterfeit (a "monogram tote bag" could be a generic style term)
 *  but they're worth a "review" flag. Medium risk on hit. */
const LOGO_PATTERN_TERMS = [
  "monogram",
  "logo print",
  "logo pattern",
  "designer pattern",
  "luxury logo",
  "branded graphic",
  "cartoon character print",
  "team logo",
  "mascot",
  "copyrighted artwork",
  "designer monogram",
  "lv pattern",
  "gg pattern",
  "checkered designer",
] as const;

/** Compatibility / accessory qualifiers. When present in a title
 *  that ALSO mentions a famous brand, downgrade high → medium. The
 *  spec calls this out explicitly: "case for iPhone" is a
 *  legitimate accessory product, not a counterfeit. */
const COMPATIBILITY_QUALIFIERS = [
  "case for",
  "compatible with",
  "compatible for",
  "fits ",
  "works with",
  "screen protector for",
  "charger for",
  "cable for",
  "adapter for",
  "stand for",
  "dock for",
  "holder for",
  "mount for",
  "skin for",
  "cover for",
  "sleeve for",
  "replacement for",
  "replacement battery for",
  "strap for",
  "band for",
] as const;

/** "Official" / "authentic" / "OEM" claims that, when combined with
 *  a famous-brand hit, indicate the seller is claiming an
 *  affiliation that may not exist. These ESCALATE risk rather than
 *  reduce it — opposite signal from the compatibility qualifiers. */
const FALSE_OFFICIAL_CLAIMS = [
  "official",
  "authentic",
  "100% authentic",
  "genuine",
  "oem",
  "authorized",
  "authorised",
  "licensed",
  "branded",
] as const;

// ---------------------------------------------------------------------
// Input shape — kept minimal so callers (server actions, AI provider
// payload assembler) can pass whatever they have without an adapter.
// ---------------------------------------------------------------------

export interface ProductForRiskCheck {
  productName: string;
  originalTitle?: string | null;
  category?: string | null;
  tiktokUrl?: string | null;
  /** Optional long-form description, e.g. from Kalodata "Remarks"
   *  field. The heuristic scans it too but weights brand matches
   *  there slightly lower than in the title. */
  description?: string | null;
}

// ---------------------------------------------------------------------
// Matching primitives. Case-insensitive, with word boundaries for
// single tokens, but allowing multi-word phrases verbatim. Falls
// back to substring match for the few entries that legitimately
// contain word-internal chars (e.g. "1:1").
// ---------------------------------------------------------------------

function buildPattern(term: string): RegExp {
  // Multi-word phrases match as substrings, case-insensitive. Single
  // words use \b...\b so "nike" doesn't fire on "uniked" (which
  // doesn't exist but the principle holds for short brand names).
  // Numbers and punctuation in the term skip the \b boundary because
  // \b is a letter/digit transition.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isWordy = /^[a-z]+$/i.test(term);
  if (isWordy) {
    return new RegExp(`\\b${escaped}\\b`, "i");
  }
  return new RegExp(escaped, "i");
}

function matchAny(
  text: string,
  terms: readonly string[],
): { matched: string[]; first?: string } {
  const matched: string[] = [];
  for (const t of terms) {
    if (buildPattern(t).test(text)) matched.push(t);
  }
  return { matched, first: matched[0] };
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

/**
 * Run the deterministic heuristic on one product. Pure function —
 * no I/O, no Prisma. Safe to call from server actions, batch
 * iteration loops, or test code.
 *
 * Output is sized so it can serialize directly onto
 * Product.ipRiskReasons (the reasons array) and Product.ipRiskStatus
 * (the status string). Score / matchedTerms / recommendation are
 * for the UI; we don't persist them.
 */
export function assessProductIpRisk(
  input: ProductForRiskCheck,
): IpRiskAssessment {
  // Combine the searchable text. Title fields get the same weight;
  // description gets the same weight too (could lower it later if
  // we see false positives from product blurbs).
  const title = [input.productName, input.originalTitle]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const desc = (input.description ?? "").toLowerCase();
  const category = (input.category ?? "").toLowerCase();
  const haystack = [title, desc, category].filter(Boolean).join(" || ");

  const reasons: string[] = [];
  const matchedTerms: string[] = [];
  let score = 0;
  let highest: IpRiskStatus = "low";

  function bump(to: IpRiskStatus, points: number) {
    score += points;
    if (STATUS_RANK[to] > STATUS_RANK[highest]) highest = to;
  }

  // --- 1. Imitation phrases. Strongest signal — almost always
  //        counterfeit intent. Single hit → high.
  const imitation = matchAny(haystack, IMITATION_PHRASES);
  if (imitation.matched.length > 0) {
    bump("high", 60);
    for (const m of imitation.matched) {
      reasons.push(`Contains imitation phrase: "${m.trim()}"`);
      matchedTerms.push(m.trim());
    }
  }

  // --- 2. Famous brands. Adjusted by compatibility context.
  const brand = matchAny(haystack, FAMOUS_BRANDS);
  if (brand.matched.length > 0) {
    const compat = matchAny(haystack, COMPATIBILITY_QUALIFIERS);
    const falseClaim = matchAny(haystack, FALSE_OFFICIAL_CLAIMS);
    // Spec: compatibility qualifier + brand = lower risk. False
    // "official" / "authentic" claim + brand = higher risk.
    if (falseClaim.matched.length > 0) {
      bump("high", 50);
      for (const m of brand.matched) {
        reasons.push(
          `Claims affiliation with famous brand: "${m}" + "${falseClaim.first}"`,
        );
        matchedTerms.push(m);
      }
    } else if (compat.matched.length > 0) {
      bump("medium", 25);
      for (const m of brand.matched) {
        reasons.push(
          `Mentions compatibility with brand: "${m}" (qualifier: "${compat.first?.trim()}"). Review whether the product uses brand logos or claims to be official.`,
        );
        matchedTerms.push(m);
      }
    } else {
      bump("high", 45);
      for (const m of brand.matched) {
        reasons.push(`Contains famous brand term: "${m}"`);
        matchedTerms.push(m);
      }
    }
  }

  // --- 3. Character / franchise references. Hits → high; this is
  //        almost always protected IP.
  const character = matchAny(haystack, CHARACTER_FRANCHISES);
  if (character.matched.length > 0) {
    bump("high", 50);
    for (const m of character.matched) {
      reasons.push(`May reference protected character/franchise: "${m}"`);
      matchedTerms.push(m);
    }
  }

  // --- 4. Logo / pattern terms. Medium on their own; high when
  //        they appear alongside a brand or character hit.
  const logo = matchAny(haystack, LOGO_PATTERN_TERMS);
  if (logo.matched.length > 0) {
    const escalate =
      brand.matched.length > 0 || character.matched.length > 0;
    bump(escalate ? "high" : "medium", escalate ? 25 : 15);
    for (const m of logo.matched) {
      reasons.push(`Contains logo/pattern-related term: "${m.trim()}"`);
      matchedTerms.push(m.trim());
    }
  }

  // --- Normalise score to 0-100 and pick final status.
  score = Math.min(100, score);
  // Cast through the rank table to dodge TS's literal-narrowing of
  // `highest` (it sees the initializer as "low" and refuses to
  // compare against other variants even though bump() mutates).
  const highestRank = STATUS_RANK[highest as IpRiskStatus];
  let status: IpRiskStatus;
  if (reasons.length === 0) {
    status = "low";
    score = 0;
  } else if (highestRank >= STATUS_RANK.high) {
    status = "high";
  } else if (highestRank >= STATUS_RANK.medium) {
    status = "medium";
  } else {
    // Two or three soft hits without a clear strong signal — punt
    // to the user.
    status = score >= 20 ? "needs_manual_review" : "medium";
  }

  const recommendation: IpRiskAssessment["recommendation"] =
    status === "high"
      ? "reject"
      : status === "needs_manual_review" || status === "medium"
        ? "review"
        : "approve";

  // Dedupe reasons while preserving order — the same brand name can
  // appear in multiple lists and we don't want the chip tooltip
  // showing it twice.
  const seenReasons = new Set<string>();
  const dedupedReasons = reasons.filter((r) => {
    if (seenReasons.has(r)) return false;
    seenReasons.add(r);
    return true;
  });
  const seenTerms = new Set<string>();
  const dedupedTerms = matchedTerms.filter((t) => {
    const lc = t.toLowerCase();
    if (seenTerms.has(lc)) return false;
    seenTerms.add(lc);
    return true;
  });

  return {
    status,
    score,
    reasons: dedupedReasons,
    matchedTerms: dedupedTerms,
    recommendation,
  };
}

// ---------------------------------------------------------------------
// Merge — combine deterministic + AI verdicts. Conservative rule:
// the HIGHER risk score wins. If the AI is more cautious than the
// heuristic, we trust the AI. If the heuristic catches something
// the AI missed (a brand name in a slang spelling, for example),
// the heuristic wins.
// ---------------------------------------------------------------------

/**
 * Combine two assessments. Either input may be null when only one
 * layer ran (e.g. user has no AI provider configured → only
 * heuristic). Returns the merged verdict with both sets of reasons
 * concatenated.
 */
export function mergeIpRisk(
  heuristic: IpRiskAssessment | null,
  ai: IpRiskAssessment | null,
): IpRiskAssessment {
  if (!heuristic && !ai) {
    return {
      status: "unchecked",
      score: 0,
      reasons: [],
      matchedTerms: [],
      recommendation: "approve",
    };
  }
  if (!ai) return heuristic!;
  if (!heuristic) return ai;

  const winnerStatus: IpRiskStatus =
    STATUS_RANK[ai.status] > STATUS_RANK[heuristic.status]
      ? ai.status
      : heuristic.status;

  return {
    status: winnerStatus,
    score: Math.max(heuristic.score, ai.score),
    // Concatenate, with AI reasons clearly tagged so the user
    // knows which layer flagged what.
    reasons: [
      ...heuristic.reasons,
      ...ai.reasons.map((r) =>
        r.toLowerCase().startsWith("ai:") ? r : `AI: ${r}`,
      ),
    ],
    matchedTerms: [...heuristic.matchedTerms, ...ai.matchedTerms],
    recommendation:
      winnerStatus === "high"
        ? "reject"
        : winnerStatus === "needs_manual_review" ||
            winnerStatus === "medium"
          ? "review"
          : "approve",
  };
}

// ---------------------------------------------------------------------
// Persistence helpers — Product.ipRiskReasons is a JSON-encoded
// string[] (SQLite has no array type). decodeJson keeps the column
// shape consistent with hashtags.
// ---------------------------------------------------------------------

/** Decode the ipRiskReasons JSON column. Safe on null / malformed
 *  input — returns an empty array. */
export function decodeIpRiskReasons(
  encoded: string | null | undefined,
): string[] {
  if (!encoded) return [];
  const decoded = parseJson<string[]>(encoded);
  return Array.isArray(decoded) ? decoded : [];
}

/** All valid IpRiskStatus values, for runtime validation. */
export const IP_RISK_STATUSES: ReadonlySet<IpRiskStatus> = new Set([
  "unchecked",
  "low",
  "medium",
  "high",
  "needs_manual_review",
]);

/** "Risky" = excluded from generation by default. The
 *  GenerateImagesPanel filter uses this. */
export function isRiskyStatus(status: string): boolean {
  return status === "high" || status === "needs_manual_review";
}
