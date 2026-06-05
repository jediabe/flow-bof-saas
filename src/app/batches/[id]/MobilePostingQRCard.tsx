/**
 * Server component that renders the Mobile Posting Assist QR card
 * on the batch detail page.
 *
 * Mirrors MobileReviewQRCard but with a separate token field
 * (Batch.postingToken) so rotating one doesn't invalidate the
 * other. The mobile posting page lives at /mobile-posting/[token]
 * and shows hook / caption / hashtags / productDescription with
 * copy buttons + a posting-status toggle.
 */

import QRCode from "qrcode";
import { rotateBatchPostingToken } from "../actions";
import GeneratePostingTokenButton from "./GeneratePostingTokenButton";
import CopyReviewUrlButton from "./CopyReviewUrlButton";

export default async function MobilePostingQRCard({
  batchId,
  postingToken,
  postingBaseUrl,
  needsPostingCount,
  approvedCount,
}: {
  batchId: string;
  postingToken: string | null;
  postingBaseUrl: string;
  /** Count of products with postingStatus === "needs_posting" AND
   *  reviewStatus === "approved" — i.e. the workload remaining on
   *  the mobile posting page. */
  needsPostingCount: number;
  /** Count of products with reviewStatus === "approved". Used to
   *  surface a hint when there's nothing to post yet. */
  approvedCount: number;
}) {
  return (
    <div className="rounded-2xl border border-border bg-panel2 p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">Mobile Posting Assist</div>
          <p className="text-xs text-muted mt-1">
            Scan with your phone to copy each product&apos;s hook,
            caption, hashtags, and description directly into TikTok
            as you post manually-downloaded Flow videos.
            {approvedCount === 0 ? (
              <span className="text-warn">
                {" "}No approved products yet — approve some first on
                the desktop or via the Mobile Review QR.
              </span>
            ) : needsPostingCount > 0 ? (
              <span className="text-warn">
                {" "}{needsPostingCount} product{needsPostingCount === 1 ? "" : "s"}{" "}
                still need posting.
              </span>
            ) : (
              <span className="text-ok">
                {" "}All approved products posted (or skipped).
              </span>
            )}
          </p>
        </div>
      </div>

      {postingToken ? (
        <ActiveTokenView
          batchId={batchId}
          token={postingToken}
          fullUrl={`${postingBaseUrl.replace(/\/+$/, "")}/mobile-posting/${postingToken}`}
        />
      ) : (
        <GeneratePostingTokenButton batchId={batchId} />
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
  let qrDataUrl: string;
  try {
    qrDataUrl = await QRCode.toDataURL(fullUrl, {
      margin: 1,
      scale: 4,
      color: { dark: "#e6e6e6", light: "#252526" },
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
            alt="Mobile posting QR"
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
            Posting URL
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
          <form action={rotateBatchPostingToken}>
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
          Anyone with this link can mark products posted / skipped.
          No login required. Click <strong>Rotate token</strong> to
          revoke the URL if you ever need to.
        </p>
      </div>
    </div>
  );
}
