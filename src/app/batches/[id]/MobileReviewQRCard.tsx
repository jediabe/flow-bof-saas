/**
 * Server component that renders the Mobile Review QR card on the
 * batch detail page.
 *
 * Behaviour:
 *   - When the batch has NO reviewToken yet, render a "Generate QR"
 *     button that triggers getOrCreateBatchReviewToken().
 *   - When the batch HAS a reviewToken, render the QR (data-URL PNG
 *     generated server-side via the `qrcode` package), the full URL,
 *     a Copy-to-clipboard button (client-side helper), and a
 *     "Rotate token" form that mints a new one.
 *
 * No external network calls — `qrcode.toDataURL` is pure local
 * encoding. Lives in a server component so the QR generation
 * happens once per page render rather than per-client.
 */

import QRCode from "qrcode";
import { rotateBatchReviewToken } from "../actions";
import GenerateReviewTokenButton from "./GenerateReviewTokenButton";
import CopyReviewUrlButton from "./CopyReviewUrlButton";

export default async function MobileReviewQRCard({
  batchId,
  reviewToken,
  reviewBaseUrl,
  needsReviewCount,
}: {
  batchId: string;
  reviewToken: string | null;
  /**
   * Origin to prefix the relative review path with. Comes from
   * NEXT_PUBLIC_APP_URL or req.headers.host on the server side. We
   * accept it as a prop so the parent page can decide.
   */
  reviewBaseUrl: string;
  needsReviewCount: number;
}) {
  return (
    <div className="rounded-2xl border border-border bg-panel2 p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">Mobile Product Review</div>
          <p className="text-xs text-muted mt-1">
            Scan with your phone to approve / reject / maybe / delete
            products without sitting at the desktop.
            {needsReviewCount > 0 && (
              <span className="text-warn">
                {" "}{needsReviewCount} product{needsReviewCount === 1 ? "" : "s"}{" "}
                still need review.
              </span>
            )}
          </p>
        </div>
      </div>

      {reviewToken ? (
        <ActiveTokenView
          batchId={batchId}
          token={reviewToken}
          fullUrl={`${reviewBaseUrl.replace(/\/+$/, "")}/mobile-review/${reviewToken}`}
        />
      ) : (
        <GenerateReviewTokenButton batchId={batchId} />
      )}
    </div>
  );
}

async function ActiveTokenView({
  batchId,
  token,
  fullUrl,
}: {
  batchId: string;
  token: string;
  fullUrl: string;
}) {
  // Generate the QR server-side as a data URL. Margin 1 + scale 4
  // produces ~196×196 PNG (small + crisp). Error-correction "M" is
  // the default — fine for an unprinted-on-screen QR.
  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(fullUrl, {
      margin: 1,
      scale: 4,
      // Match the dark theme: light dots on a dark background.
      // Inverted from default, but most phone scanners handle it
      // fine (they look at contrast, not which colour is "on").
      color: {
        dark:  "#e6e6e6",
        light: "#252526",
      },
    });
  } catch {
    qrDataUrl = "";
  }

  return (
    <div className="flex flex-col sm:flex-row items-start gap-4">
      <div className="shrink-0">
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="Mobile review QR"
            width={196}
            height={196}
            className="rounded-xl bg-panel2"
          />
        ) : (
          <div className="w-[196px] h-[196px] rounded-xl bg-bg flex items-center justify-center text-xs text-muted">
            QR encode failed
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <div className="text-[11px] text-muted uppercase tracking-wide mb-1">
            Review URL
          </div>
          <code className="block id-mono text-xs text-text bg-bg/40 rounded-lg px-2.5 py-2 break-all">
            {fullUrl}
          </code>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyReviewUrlButton url={fullUrl} />
          <a
            href={fullUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost text-xs"
          >
            Open ↗
          </a>
          <form action={rotateBatchReviewToken}>
            <input type="hidden" name="batchId" value={batchId} />
            <button
              type="submit"
              className="btn btn-ghost text-xs"
              title="Mint a new token and invalidate the existing URL. Anyone with the old link loses access."
            >
              Rotate token
            </button>
          </form>
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Anyone with this link can review every product in this batch.
          No login required. Click <strong>Rotate token</strong> to
          revoke the URL if you ever need to.
        </p>
      </div>
    </div>
  );
}
