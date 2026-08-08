import type { Config } from "tailwindcss";

/**
 * APEX design system v2 — near-black surfaces, hairline
 * white-tint borders, brand gradient (cyan → purple → red) used
 * sparingly on the wordmark + one headline word per section.
 *
 * Role split:
 *   accent (blue)     : primary CTAs, active states, focus rings,
 *                       numbered eyebrow labels (01, 02...),
 *                       thin left-edge bar on active cards
 *   accent-purple     : middle stop of the brand gradient. Used
 *                       inside the gradient — not a solid fill
 *                       colour on its own.
 *   accent-red        : urgency, destructive confirms, right-most
 *                       gradient stop
 *   accent-gradient   : cyan → purple → red at 100deg. Wordmark,
 *                       one headline word per section, small
 *                       icon accents. NEVER a full background.
 *   ok / warn         : semantic status (unchanged)
 *   bad               : maps to accent-red
 *
 * Naming stays stable (bg / panel / panel2 / border / etc.) so
 * every page using the tokens picks up the new values through
 * the Tailwind cascade without per-page edits.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Near-black base — warm enough to feel matte rather than
        // pure OLED black. #0A0A0B per the design spec.
        bg:              "#0A0A0B",
        // Card surface. Single tone — no navy tint. Borders do
        // the separation work, not shadows.
        panel:           "#141416",
        // Slightly lighter surface for hover / nested-panel
        // states. Not much contrast to keep the hairline feel.
        panel2:          "#1A1A1D",
        // Hairline borders — subtle white tint at 8% opacity so
        // they read on the near-black base without competing.
        border:          "rgba(255,255,255,0.08)",
        "border-strong": "rgba(255,255,255,0.16)",
        // Text — near-white primary, muted grays that map to the
        // spec's --text-secondary and --text-tertiary.
        text:            "#FFFFFF",
        muted:           "#9A9AA2",
        muted2:           "#6B6B72",
        // Primary solid accent — cyan #2AB8F5, leftmost gradient
        // stop. Active states, primary buttons, focus rings,
        // 4px left-edge bar on active/highlighted cards, numbered
        // labels ("01" chips).
        accent:          "#2AB8F5",
        "accent-soft":   "#1A9EDB",
        // Middle gradient stop. Rarely used alone — mostly as a
        // gradient waypoint. Kept as a named token for the odd
        // case where a solid purple accent reads better than
        // pure cyan (e.g. inside the gradient chip).
        "accent-purple": "#6C4FF0",
        // Rightmost gradient stop. Solid usage: urgency, deal
        // callouts, destructive actions.
        "accent-red":      "#E4405F",
        "accent-red-soft": "#C22A47",
        // Legacy pink kept as an alias so any old text-pink /
        // bg-pink references don't crash. Same colour as
        // accent-red now.
        pink:            "#E4405F",
        ok:              "#34D399",
        warn:            "#FBBF24",
        bad:             "#E4405F",
      },
      fontFamily: {
        // Body: clean sans, no editorial flair.
        sans: [
          "var(--font-inter)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Display: bold italic condensed impact face. Kanit is
        // the closest Google Fonts match to the APEX wordmark
        // (technical / editorial, not soft SaaS). Loaded via
        // next/font in layout.tsx.
        display: [
          "var(--font-kanit)",
          "Barlow Condensed",
          "Impact",
          "Haettenschweiler",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "JetBrains Mono",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "monospace",
        ],
      },
      borderRadius: {
        // 16px on cards per spec. Tailwind's default rounded-2xl
        // is 1rem = 16px, so we keep that native. rounded-full
        // still handles pills.
        "2xl": "1rem",
      },
      boxShadow: {
        // Retained for glow-CTAs (buttons + focus ring). Cards
        // now use borders for separation per spec — no drop
        // shadows on cards themselves.
        "glow-accent":
          "0 0 0 1px rgba(42,184,245,0.30), 0 0 24px -8px rgba(42,184,245,0.55)",
        "glow-red":
          "0 0 0 1px rgba(228,64,95,0.35), 0 0 24px -8px rgba(228,64,95,0.60)",
        "glow-ok":
          "0 0 0 1px rgba(52,211,153,0.30), 0 0 24px -8px rgba(52,211,153,0.45)",
        "glow-bad":
          "0 0 0 1px rgba(228,64,95,0.35), 0 0 24px -8px rgba(228,64,95,0.60)",
        // Kept for popovers / modals only. Never on a plain card.
        "lift":
          "0 12px 32px -16px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        // The brand gradient. cyan → purple → red at 100deg.
        // Applied ONLY to text (wordmark, one headline word per
        // section) and small icon accents. Never a full-page
        // wash — that's what the near-black bg is for.
        "brand-gradient":
          "linear-gradient(100deg, #2AB8F5 0%, #6C4FF0 55%, #E4405F 100%)",
        // Retained for now — a very-low-opacity radial glow
        // behind the body content. Kept restrained so it doesn't
        // fight the flat near-black spec. Toned way down vs the
        // navy version.
        "radial-glow":
          "radial-gradient(ellipse 60% 40% at 50% 0%, rgba(42,184,245,0.04), transparent 70%), " +
          "radial-gradient(ellipse 40% 30% at 100% 100%, rgba(228,64,95,0.03), transparent 70%)",
      },
    },
  },
  plugins: [],
};

export default config;
