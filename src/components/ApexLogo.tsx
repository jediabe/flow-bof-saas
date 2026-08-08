import Logo from "./Logo";

/**
 * ApexLogo — thin backwards-compat adapter over the new Logo
 * component. Preserves the sm|md|lg + subline API that existing
 * callsites (Nav, dashboard hero) use, so the v2 redesign
 * doesn't require chasing every import.
 *
 * The mark itself now matches the operator's reference image:
 * three slanted parallelogram stripes (cyan / purple / red)
 * followed by the bold-italic "APEX" wordmark. See Logo.tsx
 * for the actual implementation.
 */

const SIZES = {
  sm: { px: 26 }, // nav rail
  md: { px: 40 }, // default
  lg: { px: 56 }, // hero / dashboard
} as const;

export type ApexLogoSize = keyof typeof SIZES;

export interface ApexLogoProps {
  size?: ApexLogoSize;
  /** Optional single-line caption rendered below the wordmark
   *  (e.g. "TikTok Shop hub" in the dashboard hero). */
  subline?: string;
  /** Extra classes on the outer wrapper. */
  className?: string;
}

export default function ApexLogo({
  size = "md",
  subline,
  className = "",
}: ApexLogoProps) {
  const px = SIZES[size].px;
  if (!subline) {
    return <Logo size={px} className={className} />;
  }
  return (
    <span className={`inline-flex flex-col items-start gap-1 ${className}`}>
      <Logo size={px} />
      <span className="eyebrow ml-1">{subline}</span>
    </span>
  );
}
