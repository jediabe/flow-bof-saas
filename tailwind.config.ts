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
        // Palette calibrated against the APEX curriculum PDFs.
        // Background is a slightly warmer/deeper navy that reads
        // "matte studio backdrop" rather than the pure black many
        // dark themes drift toward. Panels get a subtle lift.
        bg:       "#0A1020",   // body background — deep APEX navy
        panel:    "#101830",   // primary panel surface
        panel2:   "#171F3A",   // hover / nested-panel surface
        border:   "#232D4A",   // hairline
        "border-strong": "#2E3A5A",
        muted:    "#8892AA",
        muted2:   "#6C7690",
        text:     "#EEF1F8",   // near-white
        // Primary accent — the top stripe of the //APEX logo.
        // Bright saturated blue with a cyan lean, matches the
        // "//APEX" mark + the accented word ("&", "Hashtags") in
        // the PDF headers.
        accent:   "#338FEA",
        "accent-soft": "#1F73CE",
        // Secondary accent — the bottom stripe of the //APEX logo.
        // Bright saturated red used for urgency, section-number
        // chips ("01", "02"), and destructive actions.
        "accent-red":      "#E93441",
        "accent-red-soft": "#C42128",
        // Legacy pink kept as an alias to accent-red so nothing
        // referencing text-pink / bg-pink breaks during the re-skin.
        pink:     "#E93441",
        ok:       "#34D399",
        warn:     "#FBBF24",
        // bad and accent-red are the same colour — one destructive
        // hue across the app.
        bad:      "#E93441",
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
        "glow-accent":  "0 0 0 1px rgba(51,143,234,0.30), 0 0 24px -8px rgba(51,143,234,0.55)",
        "glow-red":     "0 0 0 1px rgba(233,52,65,0.35), 0 0 24px -8px rgba(233,52,65,0.60)",
        "glow-ok":      "0 0 0 1px rgba(52,211,153,0.30), 0 0 24px -8px rgba(52,211,153,0.45)",
        "glow-bad":     "0 0 0 1px rgba(233,52,65,0.35), 0 0 24px -8px rgba(233,52,65,0.60)",
        // A flat, deeper card lift for floating elements.
        "lift":         "0 12px 32px -16px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        // Radial gradient used as the page backdrop. Twin glows —
        // blue top-centre + red bottom-right — echo the APEX
        // logotype bars without being loud.
        "radial-glow":
          "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(51,143,234,0.08), transparent 60%), " +
          "radial-gradient(ellipse 50% 40% at 100% 100%, rgba(233,52,65,0.06), transparent 60%)",
      },
    },
  },
  plugins: [],
};

export default config;
