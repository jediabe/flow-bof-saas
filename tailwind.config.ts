import type { Config } from "tailwindcss";

/**
 * APEX Initiative brand palette — deep navy background with the
 * two APEX bar colors (bright blue + bold red) doing real UI work.
 *
 * Role split:
 *   accent (blue)  : primary CTAs, links, informational card bars,
 *                    "positive" chips
 *   accent-red     : urgency (scarcity/deal hooks), destructive
 *                    confirms, section-marker chips (01/02 style)
 *   ok / warn      : semantic status (unchanged from before)
 *   bad            : maps to accent-red — one destructive colour
 *
 * "accent-soft" is a slightly darker variant used for filled
 * button backgrounds so hovers/focus rings still read.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:       "#0A1220",   // body background — APEX navy
        panel:    "#111A2C",   // primary panel surface
        panel2:   "#172035",   // hover / nested-panel surface
        border:   "#23304A",   // hairline
        "border-strong": "#2F3D5C",
        muted:    "#8B95AD",
        muted2:   "#6E7893",
        text:     "#E8EDF6",   // near-white
        // Primary accent — APEX bright blue.
        accent:   "#4A9EFF",
        "accent-soft": "#2B7BE0",
        // Secondary accent — APEX red. Used for urgency / destructive.
        "accent-red":      "#EF3B41",
        "accent-red-soft": "#C82C33",
        // Legacy pink kept as an alias to accent-red so nothing
        // referencing text-pink / bg-pink breaks during the re-skin.
        pink:     "#EF3B41",
        ok:       "#34D399",
        warn:     "#FBBF24",
        // bad and accent-red are the same colour — one destructive
        // hue across the app.
        bad:      "#EF3B41",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system",
               "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["ui-monospace", "JetBrains Mono", "SFMono-Regular", "Menlo",
               "Monaco", "Consolas", "Liberation Mono", "Courier New", "monospace"],
      },
      borderRadius: {
        // Slightly larger than tailwind's defaults — sets the
        // "rounded panel" vocabulary.
        "2xl": "1.1rem",
      },
      boxShadow: {
        // Subtle inner-glow halo for accent panels + buttons.
        "glow-accent":  "0 0 0 1px rgba(74,158,255,0.30), 0 0 24px -8px rgba(74,158,255,0.55)",
        "glow-red":     "0 0 0 1px rgba(239,59,65,0.35), 0 0 24px -8px rgba(239,59,65,0.60)",
        "glow-ok":      "0 0 0 1px rgba(52,211,153,0.30), 0 0 24px -8px rgba(52,211,153,0.45)",
        "glow-bad":     "0 0 0 1px rgba(239,59,65,0.35), 0 0 24px -8px rgba(239,59,65,0.60)",
        // A flat, deeper card lift for floating elements.
        "lift":         "0 12px 32px -16px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        // Radial gradient used as the page backdrop. Twin glows —
        // blue top-centre + red bottom-right — echo the APEX
        // logotype bars without being loud.
        "radial-glow":
          "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(74,158,255,0.08), transparent 60%), " +
          "radial-gradient(ellipse 50% 40% at 100% 100%, rgba(239,59,65,0.06), transparent 60%)",
      },
    },
  },
  plugins: [],
};

export default config;
