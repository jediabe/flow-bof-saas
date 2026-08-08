/**
 * APEX logo — three slanted parallelogram stripes (cyan, purple,
 * red) followed by the bold-italic "APEX" wordmark.
 *
 * Matches the reference image the operator supplied. The three
 * stripes correspond to the brand gradient stops:
 *   cyan   #2AB8F5 (accent)
 *   purple #6C4FF0 (accent-purple)
 *   red    #E4405F (accent-red)
 *
 * Sizing: `size` prop controls the rendered height in px. The
 * SVG viewBox + wordmark scale together so the whole lockup
 * grows uniformly. Default 40px works in the top-of-nav slot.
 *
 * Accessibility: `aria-label` on the outer element ("APEX")
 * describes the mark. Decorative stripes are aria-hidden.
 */

export interface LogoProps {
  /** Rendered height of the whole lockup, in px. */
  size?: number;
  /** Whether to render the wordmark next to the stripes.
   *  Default true. Set false for a stripes-only mark (e.g.
   *  favicon / small avatar contexts). */
  showWordmark?: boolean;
  /** Extra classes for the outer wrapper. */
  className?: string;
}

export default function Logo({
  size = 40,
  showWordmark = true,
  className = "",
}: LogoProps) {
  // Height-driven layout: SVG stripes are the same height as the
  // wordmark; wordmark font-size scales with the outer height so
  // ascender/descender + stripes line up without magic-number
  // baseline tweaks.
  const stripesWidth = Math.round(size * 1.5);
  return (
    <span
      aria-label="APEX"
      className={`inline-flex items-center gap-2 ${className}`}
      style={{ height: size }}
    >
      <svg
        viewBox="0 0 60 40"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        style={{ height: size, width: stripesWidth * 0.42 }}
      >
        {/* Three slanted parallelograms. Slant ~22° gives the
            "italic" lean without being aggressive. Each stripe
            is offset so they overlap slightly visually — matches
            the tight-packed feel of the reference image. */}
        <polygon points="0,38 10,2 20,2 10,38" fill="#2AB8F5" />
        <polygon points="18,38 28,2 38,2 28,38" fill="#6C4FF0" />
        <polygon points="36,38 46,2 56,2 46,38" fill="#E4405F" />
      </svg>
      {showWordmark && (
        <span
          className="font-display font-bold italic text-text tracking-tight leading-none select-none"
          style={{
            fontSize: Math.round(size * 0.95),
            // Slight negative letter-spacing tightens A-P-E-X so
            // it hugs the stripes more like the reference.
            letterSpacing: "-0.02em",
            // Kanit italic sits a touch high; nudge down by a
            // fraction of the font size so the baseline aligns
            // visually with the stripes' bottom.
            transform: "translateY(2%)",
          }}
        >
          APEX
        </span>
      )}
    </span>
  );
}
