import StatusChip from "@/components/StatusChip";
import Panel from "@/components/ui/Panel";
import type { ContentRunProjection, ContentRunState } from "@/lib/content-runs/types";
import AssetSlotCard, { type AssetSlotView } from "./AssetSlotCard";

export interface OperationView {
  id: string;
  kind: string;
  sceneLabel: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  errorCode?: string;
}

function runVariant(status: ContentRunState): "ok" | "warn" | "bad" | "muted" {
  if (status === "ready") return "ok";
  if (status === "failed") return "bad";
  if (["generating", "qa_running", "human_review"].includes(status)) return "warn";
  return "muted";
}

function describeNextAction(action: ContentRunProjection["requiredNextAction"]): string {
  switch (action.type) {
    case "GENERATE_IMAGE":
      return `Generation pending for ${action.slot}`;
    case "GENERATE_VIDEO":
      return `Video generation pending for ${action.slot}`;
    case "RUN_QA":
      return `QA pending for ${action.slot}`;
    case "GENERATE_VOICEOVER":
      return "Final voiceover generation pending";
    case "ASSEMBLE_FINAL":
      return `Final assembly pending for ${action.finalVideoId}`;
    case "RUN_FINAL_QA":
      return `Final QA pending for ${action.finalVideoId}`;
    case "WAIT_FOR_OPERATION":
      return `Waiting for operation ${action.operationId}`;
    case "HUMAN_REVIEW":
      return action.reason;
    case "FAILED":
      return action.reason;
    case "COMPLETE":
      return "All four assets are approved.";
  }
}

function terminalReasonLabel(reason: string): string {
  try {
    const parsed: unknown = JSON.parse(reason);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
  } catch {
    // Projection reasons may also be fixed, human-safe domain text.
  }
  return reason;
}

export default function RunTimeline({
  projection,
  productName,
  slots,
  operations,
}: {
  projection: ContentRunProjection;
  productName: string;
  slots: AssetSlotView[];
  operations: OperationView[];
}) {
  return (
    <div className="space-y-6">
      <Panel
        title="Frozen run snapshot"
        action={<StatusChip label={projection.status} variant={runVariant(projection.status)} />}
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Product</dt>
            <dd className="mt-1 font-medium">{productName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Objective</dt>
            <dd className="mt-1 font-medium">{projection.objective}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Specification</dt>
            <dd className="mt-1 font-medium">{projection.specVersion}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Image model</dt>
            <dd className="mt-1 font-medium">{projection.modelSnapshot.imageModel}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Video model</dt>
            <dd className="mt-1 font-medium">{projection.modelSnapshot.videoModel}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Run ID</dt>
            <dd className="id-mono mt-1 break-all">{projection.id}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Authoritative operation state">
        <div className="space-y-3">
          <p className="text-sm">{describeNextAction(projection.requiredNextAction)}</p>
          {projection.activeOperation && (
            <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-xs">
              Active {projection.activeOperation.kind} · {projection.activeOperation.slot} ·{" "}
              {projection.activeOperation.status}
            </div>
          )}
          {operations.length === 0 ? (
            <p className="text-xs text-muted">No provider operations recorded.</p>
          ) : (
            <ol className="space-y-2">
              {operations.map((operation) => (
                <li key={operation.id} className="border-l-2 border-border pl-3 text-xs">
                  <div className="flex flex-wrap gap-x-2">
                    <strong>{operation.kind}</strong>
                    <span>{operation.sceneLabel}</span>
                    <span>{operation.status}</span>
                    {operation.errorCode && <span className="text-bad">{operation.errorCode}</span>}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">
                    {operation.createdAt}
                    {operation.completedAt ? ` · completed ${operation.completedAt}` : ""}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </Panel>

      {projection.terminalReason && (
        <Panel title="Terminal reason" className="border-bad/40">
          <p className="text-sm text-bad">{terminalReasonLabel(projection.terminalReason)}</p>
        </Panel>
      )}

      <section aria-labelledby="content-run-slots" className="space-y-3">
        <div>
          <h2 id="content-run-slots" className="h-section">Four-slot timeline</h2>
          <p className="mt-1 text-xs text-muted">
            Read-only projection of persisted assets and QA history.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {slots.map((slot) => (
            <AssetSlotCard key={slot.slot} slot={slot} />
          ))}
        </div>
      </section>
    </div>
  );
}
