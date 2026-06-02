import { flowAbsUrl } from "@/lib/flow-urls";
import { parseJson } from "@/lib/json-column";
import StatusChip from "@/components/StatusChip";
import Panel from "@/components/ui/Panel";
import MetricCard from "@/components/ui/MetricCard";

/**
 * Friendly renderer for `generate_flow_videos_from_favorites` results.
 *
 * Expected shape (from src/agent_api.py:_handle_generate_flow_videos_from_favorites):
 *
 *   {
 *     favorited_images_found:     number,
 *     processed:                  number,
 *     submitted:                  number,
 *     skipped_already_submitted:  number,
 *     failed:                     number,
 *     blanket_video_prompt_used:  string,
 *     blanket_prompt_source:      string,
 *     elapsed_seconds:            number,
 *     items: [
 *       { media_id, tile_id, edit_id, status, error }
 *     ],
 *   }
 *
 * Counts come from the agent's structured envelope, so the renderer
 * is just shaping them into chips + a per-item table.
 */

interface VideoItem {
  media_id?: string;
  tile_id?: string;
  edit_id?: string;
  status?: string;
  error?: { code?: string; message?: string } | null;
}

interface VideoResult {
  favorited_images_found?: number;
  processed?: number;
  submitted?: number;
  skipped_already_submitted?: number;
  failed?: number;
  blanket_video_prompt_used?: string;
  blanket_prompt_source?: string;
  elapsed_seconds?: number;
  items?: VideoItem[];
}

export default function VideoFavoritesResult({
  result,
}: {
  result: unknown;
}) {
  const parsed: VideoResult =
    (typeof result === "string"
      ? (parseJson(result) as VideoResult)
      : (result as VideoResult)) ?? {};

  const submitted = parsed.submitted ?? 0;
  const failed = parsed.failed ?? 0;
  const skipped = parsed.skipped_already_submitted ?? 0;
  const found = parsed.favorited_images_found ?? 0;
  const items = parsed.items ?? [];

  // The hint the spec asks for: when every favorite was skipped
  // because the agent already submitted them, surface the
  // "Include already submitted" option in plain language.
  const allSkipped = skipped > 0 && submitted === 0 && failed === 0;

  return (
    <div className="space-y-6">
      <Panel title="Video run summary">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Favorited images found" value={found} />
          <MetricCard label="Submitted" value={submitted} tone="ok" />
          <MetricCard
            label="Skipped (already submitted)"
            value={skipped}
            tone={skipped > 0 ? "warn" : "muted"}
          />
          <MetricCard
            label="Failed"
            value={failed}
            tone={failed > 0 ? "bad" : "muted"}
          />
        </div>
        <div className="mt-4 text-xs text-muted flex flex-wrap gap-x-5 gap-y-1">
          {parsed.processed !== undefined && (
            <span>Processed: {parsed.processed}</span>
          )}
          {parsed.elapsed_seconds !== undefined && (
            <span>Elapsed: {parsed.elapsed_seconds.toFixed(1)}s</span>
          )}
          {parsed.blanket_prompt_source && (
            <span>Prompt source: {parsed.blanket_prompt_source}</span>
          )}
        </div>
      </Panel>

      {allSkipped && (
        <div className="rounded-2xl border border-warn/40 bg-warn/[0.06] text-sm text-warn px-5 py-3">
          These favorites were skipped because they were already submitted.
          Re-run with{" "}
          <strong>"Include already submitted favorites"</strong> enabled to
          submit them again.
        </div>
      )}

      {parsed.blanket_video_prompt_used && (
        <Panel title="Blanket video prompt used">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">
            {parsed.blanket_video_prompt_used}
          </p>
        </Panel>
      )}

      <Panel title={`Items (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            No per-item rows in the result.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it, i) => (
              <ItemRow key={it.tile_id || it.media_id || String(i)} item={it} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ItemRow({ item }: { item: VideoItem }) {
  const status = item.status || "unknown";
  const variant =
    status === "submitted"                  ? "ok"   :
    status === "skipped_already_submitted"  ? "muted":
    status === "failed"                     ? "bad"  : "muted";
  const editHref = flowAbsUrl(item.edit_id ? `/fx/edit/${item.edit_id}` : "");
  return (
    <li className="py-3 text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label={status} variant={variant} />
        {editHref && (
          <a
            href={editHref}
            target="_blank"
            rel="noreferrer"
            className="text-accent ml-auto hover:underline"
          >
            Open in Flow ↗
          </a>
        )}
      </div>
      {item.error && (
        <div className="text-bad">
          {item.error.code ?? "ERROR"}: {item.error.message ?? "unknown"}
        </div>
      )}
      {(item.media_id || item.tile_id || item.edit_id) && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted hover:text-text transition-colors select-none">
            Developer details
          </summary>
          <div className="mt-1.5 space-y-0.5 text-muted">
            {item.media_id && (
              <div>media <code className="id-mono">{item.media_id}</code></div>
            )}
            {item.tile_id && (
              <div>tile <code className="id-mono">{item.tile_id}</code></div>
            )}
            {item.edit_id && (
              <div>edit <code className="id-mono">{item.edit_id}</code></div>
            )}
          </div>
        </details>
      )}
    </li>
  );
}
