import type { Config } from "tailwindcss";

/**
 * Dark graphite palette tuned to feel like a creative automation
 * cockpit. Two layers of surface (bg, panel) + a hover layer (panel-2)
 * give the UI depth without using heavy shadows. The accent is a
 * soft cyan with a complementary pink that we only use for
 * destructive / failure highlights and the occasional decorative dot.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:       "#070a10",   // body background (under the radial gradient)
        panel:    "#0f141c",   // primary panel surface
        panel2:   "#141a25",   // hover / nested-panel surface
        border:   "#1d2433",   // hairline
        "border-strong": "#283044",
        muted:    "#7a8499",
        muted2:   "#5e6679",
        text:     "#e6e9f2",
        accent:   "#38bdf8",   // cyan
        "accent-soft": "#0ea5e9",
        pink:     "#f472b6",
        ok:       "#34d399",
        warn:     "#fbbf24",
        bad:      "#f87171",
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
        "glow-accent":  "0 0 0 1px rgba(56,189,248,0.30), 0 0 24px -8px rgba(56,189,248,0.45)",
        "glow-ok":      "0 0 0 1px rgba(52,211,153,0.30), 0 0 24px -8px rgba(52,211,153,0.45)",
        "glow-bad":     "0 0 0 1px rgba(248,113,113,0.35), 0 0 24px -8px rgba(248,113,113,0.55)",
        // A flat, deeper card lift for floating elements.
        "lift":         "0 12px 32px -16px rgba(0,0,0,0.6)",
      },
      backgroundImage: {
        // Radial gradient used as the page backdrop. Subtle — gives a
        // "centred lighting" feel without dominating the UI.
        "radial-glow":
          "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(56,189,248,0.07), transparent 60%), " +
          "radial-gradient(ellipse 50% 40% at 100% 100%, rgba(244,114,182,0.05), transparent 60%)",
      },
    },
  },
  plugins: [],
};

export default config;
