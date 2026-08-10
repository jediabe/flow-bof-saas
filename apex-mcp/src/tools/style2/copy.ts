/**
 * Style 2 SOP §6 — copy validator.
 *
 * Pure gate. Given a market + the four copy fields (hook,
 * benefit, CTA, voiceover), enforce every rule from §6 and
 * return the violations with severity, field, detail, and a
 * concrete fix.
 *
 * Design bias: prefer false positives. A missed violation gets a
 * video pulled — as the SOP notes, the eye-cream cautionary
 * example. A false positive is a five-second rewrite.
 *
 * "Match on intent, not just a word list" — for result-claim
 * detection we go beyond keywords, but keywords still catch the
 * high-signal cases ("lighter", "fuller", "gone"). Extending the
 * list is easier than debugging why a claim slipped through.
 */

export const MARKETS = ["UK", "US"] as const;
export type Market = (typeof MARKETS)[number];

export type Severity = "high" | "medium" | "low";
export type Field = "hook" | "benefit" | "cta" | "voiceover" | "cross";

export interface Violation {
  rule: string;
  severity: Severity;
  field: Field;
  detail: string;
  fix: string;
}

export interface ValidateCopyInput {
  market: Market;
  hook_text: string;
  benefit_text: string;
  cta_text: string;
  voiceover: string;
  /** SOP §6 exempts "discontinuing"-style scarcity IF it is
   *  actually true. The caller confirms; default false so
   *  fabricated scarcity is caught by default. */
  scarcity_is_true?: boolean;
}

export interface ValidateCopyOutput {
  passed: boolean;
  violations: Violation[];
  /** Actual computed word count for the voiceover, always
   *  returned so the caller sees what the validator counted. */
  voiceover_word_count: number;
}

/* ------------------------------------------------------------------
 * Regexes and word lists
 * ---------------------------------------------------------------- */

// Any Unicode digit — matches ASCII 0-9 and full-width variants
// used to try to sneak numbers past a naive check.
const DIGIT_ANY = /\p{Nd}/u;

// Currency symbols. Cover the common ones plus £/$ specifically
// because they show up in Kalodata-scraped prices.
const CURRENCY = /[£$€¥₩₹]/;

// Percent sign — trivial but explicit for readability.
const PERCENT = /%/;

// Emoji regex: Extended_Pictographic covers most emoji. Combining
// modifiers (skin tone, ZWJ sequences) attach to the base and
// shouldn't inflate the count.
const EMOJI = /\p{Extended_Pictographic}/gu;

/**
 * Result-claim words. Every entry is a word or short phrase that,
 * placed anywhere in a claim, reads as a before/after or
 * improvement statement — the exact language SOP §6 bans. Word-
 * boundary matched so "fuller" flags but "carefully" does not.
 *
 * Not exhaustive — add on the next removed video. Better to
 * false-positive here than let a claim through.
 */
const RESULT_CLAIM_WORDS = [
  // Comparative "-er" adjectives applied to a body part in the copy
  "lighter",
  "brighter",
  "fuller",
  "plumper",
  "smoother",
  "clearer",
  "firmer",
  "tighter",
  "younger",
  "healthier",
  "shinier",
  "thicker",
  "stronger",
  // Verbs that describe an outcome
  "reduces",
  "reduced",
  "fades",
  "faded",
  "clears",
  "cleared",
  "erases",
  "erased",
  "removes",
  "removed",
  "eliminates",
  "eliminated",
  "corrects",
  "corrected",
  "restores",
  "restored",
  "reverses",
  "reversed",
  "diminishes",
  "diminished",
  "vanishes",
  "vanished",
  // Result nouns / phrases
  "gone",
  "disappeared",
  "results",
  "result",
  "improvement",
  "improved",
  "transformation",
  "transformed",
  "before and after",
  "before-and-after",
  "wrinkles gone",
  "dark circles",
  "dark spots",
  "younger looking",
  "younger-looking",
  "anti-aging",
  "anti-ageing",
];

/** Medical / absolute claims — a broader list because there are
 *  fewer edge cases here. */
const MEDICAL_ABSOLUTE_WORDS = [
  "cures",
  "cure",
  "heals",
  "heal",
  "treats",
  "prevents",
  "prevent",
  "guarantee",
  "guaranteed",
  "clinically proven",
  "dermatologist recommended",
  "doctor recommended",
  "medically proven",
  "permanent",
  "permanently",
  "100%",
  "one hundred percent",
  "miracle",
  "miraculous",
];

/** Fabricated pricing-error framing. The SOP calls this out
 *  specifically because operators reach for it as a hook. */
const GLITCH_WORDS = [
  "pricing error",
  "pricing mistake",
  "priced wrong",
  "priced by mistake",
  "glitch",
  "made a mistake",
  "tiktok made",
  "tiktok slipped",
  "someone slipped up",
  "accidentally listed",
];

/** Fake scarcity — only enforced when scarcity_is_true is false. */
const SCARCITY_WORDS = [
  "discontinuing",
  "discontinued",
  "gone forever",
  "won't be back",
  "wont be back",
  "last chance ever",
  "never restocking",
  "never coming back",
];

/** Profanity — including censored forms. Small list; extend as
 *  needed. Word-boundary matched. */
const PROFANITY_PATTERNS = [
  /\bfuc?k\b/i,
  /\bf\*+ck\b/i,
  /\bshit\b/i,
  /\bsh\*+t\b/i,
  /\bs\*+t\b/i,
  /\bbitch\b/i,
  /\bb\*+tch\b/i,
  /\bdamn\b/i,
  /\bass(es|holes?)?\b/i,
  /\bcunt\b/i,
];

/* ------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------- */

export function validateCopyPure(input: ValidateCopyInput): ValidateCopyOutput {
  const violations: Violation[] = [];

  // Market deal rule.
  runMarketDealRule(input, violations);

  // Universal prohibitions — apply to every text field.
  const fields: Array<{ field: Field; text: string }> = [
    { field: "hook", text: input.hook_text },
    { field: "benefit", text: input.benefit_text },
    { field: "cta", text: input.cta_text },
    { field: "voiceover", text: input.voiceover },
  ];
  for (const { field, text } of fields) {
    runResultClaimRule(field, text, violations);
    runMedicalAbsoluteRule(field, text, violations);
    runGlitchFramingRule(field, text, violations);
    runProfanityRule(field, text, violations);
    if (!input.scarcity_is_true) {
      runScarcityRule(field, text, violations);
    }
  }

  // Voiceover length.
  const wordCount = countWords(input.voiceover);
  runVoiceoverLengthRule(wordCount, violations);

  // On-screen text limits.
  runBenefitLimitRule(input.benefit_text, violations);
  runCtaLimitRule(input.cta_text, violations);
  runEmojiLimitRule("hook", input.hook_text, violations);
  runEmojiLimitRule("benefit", input.benefit_text, violations);
  runEmojiLimitRule("cta", input.cta_text, violations);

  // Emoji-pushed-out-word warning (§9 final-checks list).
  runEmojiTruncationWarning("hook", input.hook_text, violations);
  runEmojiTruncationWarning("benefit", input.benefit_text, violations);
  runEmojiTruncationWarning("cta", input.cta_text, violations);

  const passed = !violations.some((v) => v.severity === "high" || v.severity === "medium");
  return { passed, violations, voiceover_word_count: wordCount };
}

/* ------------------------------------------------------------------
 * Individual rules
 * ---------------------------------------------------------------- */

function runMarketDealRule(input: ValidateCopyInput, out: Violation[]): void {
  const allText = [input.hook_text, input.benefit_text, input.cta_text, input.voiceover].join("\n");
  if (input.market === "US") {
    // US: no digit, no percent, no currency ANYWHERE.
    const offenders: Array<{ field: Field; text: string }> = [
      { field: "hook", text: input.hook_text },
      { field: "benefit", text: input.benefit_text },
      { field: "cta", text: input.cta_text },
      { field: "voiceover", text: input.voiceover },
    ];
    for (const { field, text } of offenders) {
      if (DIGIT_ANY.test(text) || PERCENT.test(text) || CURRENCY.test(text)) {
        out.push({
          rule: "us_no_numbers",
          severity: "high",
          field,
          detail:
            "US market copy must not contain any digit, %, or currency symbol (SOP §6 deal rule). US is number-free — say \"on sale\" or \"voucher to claim at checkout\" instead.",
          fix:
            "Rewrite the field without any digit, %, or £/$. Use \"on sale\" or \"voucher to claim at checkout\" and point to the cart.",
        });
      }
    }
    return;
  }

  // UK: no £/$ prices anywhere.
  if (CURRENCY.test(allText)) {
    out.push({
      rule: "uk_no_currency_price",
      severity: "high",
      field: "cross",
      detail:
        "UK market copy must not contain a £/$ price (SOP §6 deal rule). State the discount % instead.",
      fix: "Remove the currency symbol and price. Use the discount % from the listing (e.g. \"21% off\") or, if none, say \"voucher\" with no number.",
    });
  }

  // UK: require % OR the word "voucher" somewhere.
  const hasPercent = PERCENT.test(allText);
  const hasVoucher = /voucher/i.test(allText);
  if (!hasPercent && !hasVoucher) {
    out.push({
      rule: "uk_deal_missing",
      severity: "medium",
      field: "cross",
      detail:
        "UK market copy must state either the discount % (e.g. \"21% off\") or the word \"voucher\" — SOP §6. Neither was found.",
      fix: "Add the exact discount % from the live listing to at least the hook or CTA. If there is no %, say \"voucher\" with no number.",
    });
  }
}

function runResultClaimRule(field: Field, text: string, out: Violation[]): void {
  const t = text.toLowerCase();
  for (const kw of RESULT_CLAIM_WORDS) {
    // Word-boundary for single words; substring for multi-word phrases.
    const pat = kw.includes(" ")
      ? new RegExp(escapeRegex(kw), "i")
      : new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (pat.test(t)) {
      out.push({
        rule: "result_claim",
        severity: "high",
        field,
        detail: `Contains a result/improvement/before-after word or phrase: "${kw}". SOP §6 bans result claims — an AI avatar rendering a result is a manipulated visual that overstates performance and gets videos removed.`,
        fix: "Rewrite the claim as an experiential, in-the-moment benefit — how it looks/feels IN THE MOMENT (texture, tint, glide, comfort, colour). Never a result.",
      });
      return; // one per field is enough — the fix rewrites the field
    }
  }
}

function runMedicalAbsoluteRule(field: Field, text: string, out: Violation[]): void {
  const t = text.toLowerCase();
  for (const kw of MEDICAL_ABSOLUTE_WORDS) {
    const pat = kw.includes(" ")
      ? new RegExp(escapeRegex(kw), "i")
      : new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (pat.test(t)) {
      out.push({
        rule: "medical_or_absolute_claim",
        severity: "high",
        field,
        detail: `Contains a medical or absolute claim ("${kw}"). SOP §6 bans these.`,
        fix: "Drop the medical/absolute wording. Speak only about how it feels or looks in the moment.",
      });
      return;
    }
  }
}

function runGlitchFramingRule(field: Field, text: string, out: Violation[]): void {
  const t = text.toLowerCase();
  for (const kw of GLITCH_WORDS) {
    if (t.includes(kw)) {
      out.push({
        rule: "fake_pricing_error",
        severity: "high",
        field,
        detail: `Frames the sale as a pricing mistake, glitch, or error ("${kw}"). SOP §6 explicitly bans this — it's a normal sale.`,
        fix: "Say it's on sale / a voucher / a % off. Never claim a mistake or glitch.",
      });
      return;
    }
  }
}

function runProfanityRule(field: Field, text: string, out: Violation[]): void {
  for (const pat of PROFANITY_PATTERNS) {
    if (pat.test(text)) {
      out.push({
        rule: "profanity",
        severity: "high",
        field,
        detail: "Contains profanity (including censored forms). SOP §6 bans all profanity, even censored.",
        fix: "Remove the profanity and rewrite the line.",
      });
      return;
    }
  }
}

function runScarcityRule(field: Field, text: string, out: Violation[]): void {
  const t = text.toLowerCase();
  for (const kw of SCARCITY_WORDS) {
    if (t.includes(kw)) {
      out.push({
        rule: "fake_scarcity",
        severity: "high",
        field,
        detail: `Fake scarcity language ("${kw}") — SOP §6 forbids this unless it's true. Pass scarcity_is_true=true if the item is genuinely being discontinued.`,
        fix: "Remove the scarcity framing, or pass scarcity_is_true=true if it's actually being discontinued.",
      });
      return;
    }
  }
}

function runVoiceoverLengthRule(wordCount: number, out: Violation[]): void {
  if (wordCount >= 70 && wordCount <= 75) return; // pass
  if (wordCount < 65) {
    out.push({
      rule: "voiceover_too_short",
      severity: "high",
      field: "voiceover",
      detail: `Voiceover has ${wordCount} words. SOP §6 says a script under 65 words is WRONG — never output a short 20–45 word script. Add more benefit detail until it reaches 70–75.`,
      fix: "Add a second experiential benefit, more texture/feel detail, or a longer opener. Target 70–75 words.",
    });
    return;
  }
  if (wordCount < 70) {
    out.push({
      rule: "voiceover_under_70",
      severity: "medium",
      field: "voiceover",
      detail: `Voiceover has ${wordCount} words. SOP §6 requires 70–75. Add more benefit detail.`,
      fix: "Add one more experiential benefit or extend the opener. Target 70–75 words.",
    });
    return;
  }
  // wordCount > 75
  out.push({
    rule: "voiceover_over_75",
    severity: "medium",
    field: "voiceover",
    detail: `Voiceover has ${wordCount} words. SOP §6 caps at 75 — it won't fit the ~19s window over N2–N7.`,
    fix: "Trim to 70–75 words. Cut the least-specific benefit clause first.",
  });
}

function runBenefitLimitRule(text: string, out: Violation[]): void {
  const n = countWords(text);
  if (n > 8) {
    out.push({
      rule: "benefit_too_long",
      severity: "medium",
      field: "benefit",
      detail: `Benefit card is ${n} words. SOP §6 caps it at 8 words so it reads on the screen at demo speed.`,
      fix: "Trim to ≤8 words. Keep only the sensory word (texture, glide, tint, feel).",
    });
  }
}

function runCtaLimitRule(text: string, out: Violation[]): void {
  const n = countWords(text);
  if (n >= 10) {
    out.push({
      rule: "cta_too_long",
      severity: "medium",
      field: "cta",
      detail: `CTA card is ${n} words. SOP §6 requires under 10.`,
      fix: "Trim to <10 words. State the deal + tap the basket/cart.",
    });
  }
}

function runEmojiLimitRule(field: Field, text: string, out: Violation[]): void {
  const emojiCount = (text.match(EMOJI) ?? []).length;
  if (emojiCount > 1) {
    out.push({
      rule: "too_many_emojis",
      severity: "medium",
      field,
      detail: `${emojiCount} emojis found. SOP §6 caps on-screen cards at 1 emoji.`,
      fix: "Keep the single most-relevant emoji; drop the rest.",
    });
  }
}

/**
 * SOP §9 warning: an emoji ended up so wide it pushed the final
 * letter off the card ("21% of" instead of "21% off"). Heuristic:
 * the text ends with an emoji preceded by a very short trailing
 * word (1-3 letters) that looks like a truncation of a common
 * completion. Low severity — advisory.
 */
function runEmojiTruncationWarning(field: Field, text: string, out: Violation[]): void {
  const trimmed = text.trim();
  if (!EMOJI.test(trimmed)) return;
  // Match: <word 1..3 letters><whitespace?><emoji><trailing whitespace/emojis>
  const match = /(\b\w{1,3})\s*\p{Extended_Pictographic}[\s\p{Extended_Pictographic}]*$/u.exec(trimmed);
  if (!match) return;
  const tail = match[1]?.toLowerCase();
  if (!tail) return;
  // Only warn on tails that look like a plausible truncation of
  // a common word.
  const truncations: Record<string, string> = {
    of: "off",
    or: "for/or",
    a: "and",
    ha: "have",
    ne: "new",
    fr: "from",
    to: "today",
  };
  const suggestion = truncations[tail];
  if (!suggestion) return;
  out.push({
    rule: "emoji_pushed_out_word",
    severity: "low",
    field,
    detail: `Text ends with "${tail}" then an emoji — likely truncated (e.g. "of" should be "${suggestion}"). Emojis on TikTok can eat the last character on narrow phones.`,
    fix: `Confirm the word: is "${tail}" the full word, or should it be "${suggestion}"? Move the emoji earlier if the word truncated.`,
  });
}

/* ------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */

/**
 * Word count that treats an ellipsis (unicode "…" or three dots)
 * as a pause marker rather than a word — the SOP writes voice-
 * overs with "…" for phrasing and we shouldn't inflate the count
 * by counting each pause as a word. Runs of whitespace collapse
 * to one separator.
 */
function countWords(text: string): number {
  const cleaned = text
    .replace(/…/g, " ")
    .replace(/\.\.\./g, " ")
    .replace(/[\p{Extended_Pictographic}]/gu, " ");
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  return tokens.length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
