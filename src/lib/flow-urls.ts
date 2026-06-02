/**
 * Flow tiles and edit URLs come back from the agent as relative paths
 * (e.g. ``/fx/api/trpc/media.getMediaUrlRedirect?name=...`` or
 * ``/fx/edit/<id>``). Prefix them with the Flow Labs origin so they
 * render in an <img> / <a> tag.
 *
 * Already-absolute URLs (http:// or https://) pass through unchanged.
 * Empty / null inputs return an empty string so it's safe to call on
 * any item field without a guard.
 */
const FLOW_ORIGIN = "https://labs.google";

export function flowAbsUrl(href: string | null | undefined): string {
  if (!href) return "";
  const h = String(href).trim();
  if (!h) return "";
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("/")) return `${FLOW_ORIGIN}${h}`;
  return `${FLOW_ORIGIN}/${h}`;
}
