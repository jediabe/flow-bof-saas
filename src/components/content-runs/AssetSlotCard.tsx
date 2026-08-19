import StatusChip from "@/components/StatusChip";
import type { ManagedSlotRecord, QaStatus } from "@/lib/content-runs/types";

export interface QaHistoryEntry {
  id: string;
  decision: string;
  score: number;
  hasHardFailure: boolean;
  rubricVersion: string;
  providerModel: string;
  createdAt: string;
}

export type AssetStorageView =
  | {
      state: "available";
      url: string;
      contentType: string;
      bytes: number;
      sha256: string;
    }
  | { state: "legacy" | "unavailable" };

export interface AssetAttemptView {
  assetId: string;
  attempt: number;
  qaStatus: QaStatus;
  selected: boolean;
  mediaType: "image" | "video";
  storage: AssetStorageView;
  qaHistory: QaHistoryEntry[];
}

export interface AssetSlotView
  extends Omit<ManagedSlotRecord, "attempts"> {
  attempts: AssetAttemptView[];
}

const SLOT_LABELS: Record<AssetSlotView["slot"], string> = {
  scene_1_store_image: "Scene 1 · Store image",
  scene_1_store_video: "Scene 1 · Store video",
  scene_2_home_image: "Scene 2 · Home image",
  scene_2_home_video: "Scene 2 · Home video",
};

function qaVariant(status: QaStatus): "ok" | "warn" | "bad" | "muted" {
  if (status === "APPROVED") return "ok";
  if (status === "FAILED") return "bad";
  if (["QA_RUNNING", "REGEN_IN_FLIGHT", "HUMAN_REVIEW", "REGEN_NEEDED"].includes(status)) {
    return "warn";
  }
  return "muted";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ManagedPreview({ attempt, slot }: { attempt: AssetAttemptView; slot: string }) {
  if (attempt.storage.state !== "available") {
    return (
      <div className="rounded-xl border border-dashed border-border bg-bg/50 px-4 py-8 text-center text-xs text-muted">
        {attempt.storage.state === "legacy" ? "Legacy / unavailable" : "Object preview unavailable"}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {attempt.mediaType === "image" ? (
        // Signed object URLs are dynamic and cannot be allow-listed in next/image.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attempt.storage.url}
          alt={`${slot}, attempt ${attempt.attempt}`}
          className="max-h-[28rem] w-full rounded-xl border border-border bg-black/20 object-contain"
        />
      ) : (
        <video
          src={attempt.storage.url}
          controls
          preload="metadata"
          className="max-h-[28rem] w-full rounded-xl border border-border bg-black"
        >
          Video preview is not supported by this browser.
        </video>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <a
          href={attempt.storage.url}
          download
          className="text-accent hover:underline"
        >
          Download object
        </a>
        <span>{attempt.storage.contentType}</span>
        <span>{formatBytes(attempt.storage.bytes)}</span>
        <span title={attempt.storage.sha256}>
          sha256 {attempt.storage.sha256.slice(0, 12)}…
        </span>
      </div>
    </div>
  );
}

export default function AssetSlotCard({ slot }: { slot: AssetSlotView }) {
  const selected = slot.attempts.find((attempt) => attempt.selected);

  return (
    <article className="panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
        <div>
          <h3 className="section-title">{SLOT_LABELS[slot.slot]}</h3>
          <p className="mt-1 text-[11px] text-muted">{slot.assetType}</p>
        </div>
        {selected ? (
          <StatusChip label={selected.qaStatus} variant={qaVariant(selected.qaStatus)} />
        ) : (
          <StatusChip label="awaiting" variant="muted" />
        )}
      </header>

      <div className="space-y-4 p-5">
        {!selected ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
            Awaiting asset
          </div>
        ) : (
          <ManagedPreview attempt={selected} slot={SLOT_LABELS[slot.slot]} />
        )}

        {slot.attempts.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Asset attempts
            </h4>
            {slot.attempts.map((attempt) => (
              <div key={attempt.assetId} className="rounded-xl border border-border bg-bg/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>
                    Attempt {attempt.attempt}{attempt.selected ? " · selected" : ""}
                  </span>
                  <StatusChip label={attempt.qaStatus} variant={qaVariant(attempt.qaStatus)} />
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  asset <code className="id-mono">{attempt.assetId}</code>
                </div>
                <div className="mt-3 space-y-2">
                  <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    QA history ({attempt.qaHistory.length})
                  </h5>
                  {attempt.qaHistory.length === 0 ? (
                    <p className="text-xs text-muted">No QA attempts recorded.</p>
                  ) : (
                    <ol className="space-y-2">
                      {attempt.qaHistory.map((qa) => (
                        <li key={qa.id} className="border-l-2 border-border pl-3 text-xs">
                          <div className="flex flex-wrap gap-x-2">
                            <strong>{qa.decision}</strong>
                            <span>score {qa.score}</span>
                            {qa.hasHardFailure && <span className="text-bad">hard failure</span>}
                          </div>
                          <div className="mt-1 text-[11px] text-muted">
                            {qa.rubricVersion} · {qa.providerModel} · {qa.createdAt}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
