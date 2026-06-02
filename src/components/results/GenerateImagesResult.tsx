import { parseJson } from "@/lib/json-column";
import Panel from "@/components/ui/Panel";
import MetricCard from "@/components/ui/MetricCard";
import StatusChip from "@/components/StatusChip";

/**
 * Friendly renderer for `generate_flow_images` job results.
 *
 * Expected envelope shape from the local runner (see
 * flow-bof-automation/src/agent_api.py:_handle_generate_flow_images):
 *
 *   {
 *     processed:        number,
 *     submitted:        number,
 *     failed:           number,
 *     skipped:          number,
 *     wait_mode:        "submit_only" | "capture",
 *     automation_mode:  "safe" | "balanced" | "fast",
 *     elapsed_seconds:  number,
 *     items: [
 *       { item_id, product_name, status, error, ... }
 *     ],
 *   }
 *
 * The runner is the source of truth for field names; if it adds
 * thumbnail data URLs or media IDs later, drop them under the
 * per-item Developer details disclosure.
 */

interface ImageItem {
  item_id?: string;
  product_name?: string;
  status?: string;
  error?: { code?: string; message?: string } | string | null;
  media_id?: string;
  tile_id?: string;
  edit_id?: string;
}

interface ImageResult {
  processed?: number;
  submitted?: number;
  failed?: number;
  skipped?: number;
  wait_mode?: string;
  automation_mode?: string;
  elapsed_seconds?: number;
  items?: ImageItem[];
}

const ITEM_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  submitted: "ok",
  captured:  "ok",
  failed:    "bad",
  skipped:   "warn",
  pending:   "muted",
};

export default function GenerateImagesResult({
  result,
}: {
  result: unknown;
}) {
  const parsed: ImageResult =
    (typeof result === "string"
      ? (parseJson(result) as ImageResult)
      : (result as ImageResult)) ?? {};

  const items = parsed.items ?? [];
  const submitted = parsed.submitted ?? 0;
  const failed    = parsed.failed ?? 0;
  const skipped   = parsed.skipped ?? 0;
  const processed = parsed.processed ?? items.length;

  return (
    <div className="space-y-6">
      <Panel title="Image generation summary">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label="Processed" value={processed} />
          <MetricCard label="Submitted" value={submitted} tone="ok" />
          <MetricCard
            label="Skipped"
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
          {parsed.wait_mode && <span>Wait mode: {parsed.wait_mode}</span>}
          {parsed.automation_mode && (
            <span>Automation: {parsed.automation_mode}</span>
          )}
          {parsed.elapsed_seconds !== undefined && (
            <span>Elapsed: {parsed.elapsed_seconds.toFixed(1)}s</span>
          )}
        </div>
      </Panel>

      <Panel title={`Items (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">No per-item rows in the result.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it, i) => (
              <ItemRow
                key={it.item_id ?? `${it.product_name ?? "item"}-${i}`}
                item={it}
              />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ItemRow({ item }: { item: ImageItem }) {
  const status = item.status ?? "unknown";
  const variant = ITEM_VARIANT[status] ?? "muted";
  const err = item.error;
  const errMessage =
    !err ? null
    : typeof err === "string" ? err
    : err.message ?? err.code ?? "unknown";

  return (
    <li className="py-3 text-sm space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <StatusChip label={status} variant={variant} />
        <span className="text-text font-medium truncate">
          {item.product_name ?? item.item_id ?? "—"}
        </span>
      </div>
      {errMessage && <div className="text-xs text-bad">{errMessage}</div>}
      {(item.item_id || item.media_id || item.tile_id || item.edit_id) && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted hover:text-text transition-colors select-none">
            Developer details
          </summary>
          <div className="mt-1.5 space-y-0.5 text-muted">
            {item.item_id && (
              <div>item <code className="id-mono">{item.item_id}</code></div>
            )}
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
