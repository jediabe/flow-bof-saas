/**
 * APEX Initiative logotype — two forward-slash parallelograms
 * (bright blue stripe on top, bold red on bottom) followed by
 * the "APEX" wordmark in bold italic. Mirrors the //APEX mark
 * used across the UK TikTok Shop curriculum PDFs.
 *
 * Props:
 *   size    — "sm" (nav rail), "md" (default), "lg" (hero)
 *   subline — small caption below the wordmark, e.g. "TikTok Shop hub"
 *   as      — semantic HTML element wrapping the whole thing;
 *             defaults to <span> so the parent can decide layout.
 *
 * The whole thing is a single inline block so it never breaks
 * across lines. Colours pull from theme("colors.accent") /
 * theme("colors.accent-red") via Tailwind, so a future palette
 * swap flows through automatically.
 */

const SIZES = {
  sm: {
    slashW: 12,
    slashH: 16,
    wordSize: "text-lg",
    gap: "gap-1.5",
  },
  md: {
    slashW: 16,
    slashH: 22,
    wordSize: "text-2xl",
    gap: "gap-2",
  },
  lg: {
    slashW: 26,
    slashH: 36,
    wordSize: "text-4xl",
    gap: "gap-3",
  },
} as const;

export default function ApexLogo({
  size = "md",
  subline,
}: {
  size?: keyof typeof SIZES;
  subline?: string;
}) {
  const cfg = SIZES[size];
  // Each "slash" is a parallelogram rendered as an inline SVG with
  // two stacked stripes. Slant angle chosen to feel like the PDF —
  // shallow enough to read as forward-slashes, steep enough to
  // avoid looking like a hyphen pair.
  const slash = (
    <svg
      width={cfg.slashW}
      height={cfg.slashH}
      viewBox="0 0 16 22"
      fill="none"
      aria-hidden
    >
      {/* Top (blue) stripe */}
      <polygon points="6,0 16,0 10,10 0,10" fill="currentColor" className="text-accent" />
      {/* Bottom (red) stripe */}
      <polygon points="5,12 15,12 9,22 -1,22" fill="currentColor" className="text-accent-red" />
    </svg>
  );

  return (
    <span className={`inline-flex items-baseline ${cfg.gap} leading-none`}>
      <span className="inline-flex items-end gap-[2px]" style={{ transform: "translateY(2px)" }}>
        {slash}
        {slash}
      </span>
      <span className={`${cfg.wordSize} font-black tracking-tight italic text-text`}>
        APEX
      </span>
      {subline && (
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted ml-2 not-italic font-normal">
          {subline}
        </span>
      )}
    </span>
  );
}
