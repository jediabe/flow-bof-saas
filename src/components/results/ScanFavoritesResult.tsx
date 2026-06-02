import { flowAbsUrl } from "@/lib/flow-urls";
import { parseJson, prettyJson } from "@/lib/json-column";
import StatusChip from "@/components/StatusChip";
import Panel from "@/components/ui/Panel";
import MetricCard from "@/components/ui/MetricCard";

/**
 * Friendly renderer for `scan_favorited_images` job results.
 *
 * Expected shape (from src/agent_api.py:_handle_scan_favorited_images
 * in the agent repo):
 *
 *   {
 *     chrome_reachable: bool,
 *     flow_reachable:   bool,
 *     flow_url:         string,
 *     tiles_scanned:    number,
 *     favorited_images_count: number,
 *     favorited_videos_count: number,
 *     items: [
 *       { media_id, tile_id, edit_id, tile_href, kind, favorited, thumbnail_src }
 *     ],
 *   }
 *
 * The job row's `result` column is a JSON-encoded string (SQLite),
 * so we parse defensively. Any field that's missing renders as a
 * graceful "—".
 */

interface ScanItem {
  media_id?: string;
  tile_id?: string;
  edit_id?: string;
  tile_href?: string;
  kind?: string;
  favorited?: boolean;
  thumbnail_src?: string;
  // Optional base64 PNG; agent returns this only when the job's
  // payload requested include_thumbnail_data_urls. Self-contained —
  // doesn't need the user's Flow session cookie.
  thumbnail_data_url?: string | null;
  thumbnail_error?: string | null;
}

interface ScanResult {
  chrome_reachable?: boolean;
  flow_reachable?: boolean;
  flow_url?: string;
  flow_probe_note?: string;
  tiles_scanned?: number;
  favorited_images_count?: number;
  favorited_videos_count?: number;
  items?: ScanItem[];
}

export default function ScanFavoritesResult({
  result,
}: {
  result: unknown;
}) {
  // result comes in either as the JSON string from the DB column or
  // an already-parsed object. parseJson handles the string case;
  // we then narrow to ScanResult.
  const parsed: ScanResult =
    (typeof result === "string" ? (parseJson(result) as ScanResult) : (result as ScanResult)) ?? {};

  const items = parsed.items ?? [];

  return (
    <div className="space-y-6">
      {/* Summary card --------------------------------------------------- */}
      <Panel
        title="Scan summary"
        action={
          parsed.flow_url && (
            <a
              href={flowAbsUrl(parsed.flow_url)}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Open project in Flow ↗
            </a>
          )
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <MetricCard
            label="Chrome"
            value={parsed.chrome_reachable ? "Connected" : "Not connected"}
            tone={parsed.chrome_reachable ? "ok" : "bad"}
          />
          <MetricCard
            label="Flow"
            value={parsed.flow_reachable ? "Connected" : "Not connected"}
            tone={parsed.flow_reachable ? "ok" : "bad"}
          />
          <MetricCard
            label="Tiles scanned"
            value={parsed.tiles_scanned ?? "—"}
          />
          <MetricCard
            label="Favorited images"
            value={parsed.favorited_images_count ?? "—"}
            tone={parsed.favorited_images_count ? "ok" : "muted"}
          />
          <MetricCard
            label="Favorited videos"
            value={parsed.favorited_videos_count ?? "—"}
            tone={parsed.favorited_videos_count ? "accent" : "muted"}
          />
        </div>
      </Panel>

      {/* Items grid ----------------------------------------------------- */}
      <section className="space-y-3">
        <div className="section-header">
          <h2 className="section-title">Items returned ({items.length})</h2>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            No items in the result. If you expected favorites, double-check
            that you have hearted images in the Flow tab the runner is
            connected to.
          </p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((it, i) => (
              <TileCard key={it.tile_id || it.media_id || String(i)} item={it} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function TileCard({ item }: { item: ScanItem }) {
  // Prefer the self-contained base64 PNG the agent provides when the
  // job payload asked for it. Flow's CDN URLs (item.thumbnail_src)
  // require the user's Google session cookie which the SaaS origin
  // doesn't have — they'll render as broken images. We do NOT fall
  // back to thumbnail_src here; better a "Preview unavailable"
  // placeholder than a broken image icon.
  const thumbDataUrl = item.thumbnail_data_url || "";
  const editHref = flowAbsUrl(item.tile_href);
  const kind = item.kind || "image";

  return (
    <li className="panel overflow-hidden">
      {thumbDataUrl ? (
        <a
          href={editHref || undefined}
          target="_blank"
          rel="noreferrer"
          className="block aspect-[9/16] bg-bg overflow-hidden"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbDataUrl}
            alt={item.media_id || "favorited tile"}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </a>
      ) : (
        <div
          className="aspect-[9/16] bg-bg flex flex-col items-center justify-center text-xs text-muted px-3 text-center"
          title={item.thumbnail_error ?? undefined}
        >
          <div className="text-text/70">Preview unavailable</div>
          {item.thumbnail_error && (
            <div className="mt-1 text-muted/80 line-clamp-2">
              {item.thumbnail_error}
            </div>
          )}
        </div>
      )}
      <div className="p-3 space-y-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip
            label={kind}
            variant={kind === "video" ? "warn" : "muted"}
          />
          {item.favorited && <StatusChip label="favorited" variant="ok" />}
          {editHref && (
            <a
              href={editHref}
              target="_blank"
              rel="noreferrer"
              className="text-accent ml-auto"
            >
              Open in Flow ↗
            </a>
          )}
        </div>
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted hover:text-text transition-colors select-none">
            Developer details
          </summary>
          <div className="mt-2 space-y-1">
            <KV k="media_id" v={item.media_id} />
            <KV k="tile_id"  v={item.tile_id} />
            <KV k="edit_id"  v={item.edit_id} />
          </div>
        </details>
      </div>
    </li>
  );
}

function KV({ k, v }: { k: string; v?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted shrink-0">{k}:</span>
      <span className="id-mono text-text/80">{v || "—"}</span>
    </div>
  );
}

/**
 * Re-export prettyJson here so the page can collapse the raw envelope
 * underneath this view without importing twice.
 */
export { prettyJson };
