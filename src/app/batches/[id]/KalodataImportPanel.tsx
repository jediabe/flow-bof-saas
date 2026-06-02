"use client";

import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  importKalodataXlsx,
  type KalodataImportReport,
} from "../actions";

/**
 * Kalodata XLSX import surface. User picks a `.xlsx` file → the
 * server action parses the workbook, creates one Product per row, and
 * downloads each row's image into `public/uploads/batches/<id>/`.
 *
 * The action is intentionally synchronous (no progress events yet) —
 * a 50-row import typically lands in a few seconds because image
 * downloads run sequentially. If batch sizes grow we'll lift this to
 * the streaming dispatch path the way generate_flow_images works.
 */
export default function KalodataImportPanel({
  batchId,
}: {
  batchId: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [pending, startTransition] = useTransition();
  const [report, setReport] = useState<KalodataImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!file) return;
    setError(null);
    setReport(null);
    const fd = new FormData();
    fd.set("batchId", batchId);
    fd.set("file", file);
    startTransition(async () => {
      try {
        const r = await importKalodataXlsx(fd);
        setReport(r);
        if (!r.ok) setError(r.message);
      } catch (e) {
        setError((e as Error).message || "import failed");
      }
    });
  }

  return (
    <section className="panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">Import from Kalodata</div>
          <p className="text-xs text-muted mt-1">
            Upload a Kalodata <code className="id-mono">.xlsx</code>{" "}
            export. The SaaS reads the <code className="id-mono">LIST_PRODUCT</code>{" "}
            sheet (or the first worksheet as fallback), creates one
            Product per row, and downloads each row's image to local
            dev storage.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="text-xs text-text file:btn file:btn-ghost file:mr-3"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!file || pending}
          onClick={submit}
        >
          {pending ? "Importing…" : "Import workbook"}
        </button>
        {file && (
          <span className="text-[11px] text-muted truncate max-w-[300px]">
            {file.name}
          </span>
        )}
      </div>

      {error && <div className="text-xs text-bad">⚠ {error}</div>}

      {report && (
        <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={report.ok ? "imported" : "failed"}
              variant={report.ok ? "ok" : "bad"}
            />
            <span className="text-xs text-text">{report.message}</span>
            {report.sheetName && (
              <span className="text-[11px] text-muted ml-auto">
                sheet: <code className="id-mono">{report.sheetName}</code>
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Stat label="Rows found" value={report.productsFound} />
            <Stat
              label="Products created"
              value={report.productsCreated}
              tone="ok"
            />
            <Stat
              label="Images downloaded"
              value={report.imagesDownloaded}
              tone="ok"
            />
            <Stat
              label="Images failed"
              value={report.imagesFailed}
              tone={report.imagesFailed > 0 ? "bad" : "muted"}
            />
          </div>
          {report.failures.length > 0 && (
            <details className="text-[11px]">
              <summary className="cursor-pointer text-muted hover:text-text transition-colors">
                Failures ({report.failures.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {report.failures.map((f, i) => (
                  <li key={i} className="text-muted">
                    <span className="text-text">{f.productName}</span>{" "}
                    — {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "bad" | "muted";
}) {
  const cls =
    tone === "ok"  ? "text-ok"
    : tone === "bad" ? "text-bad"
    : tone === "muted" ? "text-muted"
    : "text-text";
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}
