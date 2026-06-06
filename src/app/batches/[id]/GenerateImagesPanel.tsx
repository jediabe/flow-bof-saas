"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import StatusChip from "@/components/StatusChip";
import { createSampleJob } from "../../jobs/actions";

export interface ImageGenAgent {
  id: string;
  name: string;
  status: string;
}

export interface ImageGenProduct {
  id: string;
  productName: string;
  /** SaaS-hosted reference URL (preferred). Absolute or `/uploads/...`.
   *  This is the primary cache; multi-ref payload prefers `images`. */
  referenceImageUrl: string | null;
  /** Local override path (debug/fallback only). */
  referenceImagePathLocal: string | null;
  imagePrompt: string | null;
  /**
   * Phase 1 mobile-review status. Default eligibility now filters
   * to "approved" only; the panel exposes a checkbox to override
   * for the "I want to generate before doing the phone review"
   * workflow. Values: "needs_review" | "approved" | "rejected"
   * | "maybe".
   */
  reviewStatus: string;
  /**
   * Phase 3 — full reference-image list (up to 3 roles: primary /
   * ref2 / ref3). Sent as `reference_images: [{role, url, path}]` in
   * the runner payload. The runner attaches them in role order via
   * Flow's "add image to prompt" path.
   *
   * Empty list = use the legacy single-image fields. A runner that
   * predates Phase 3 will ignore this array; the legacy fields keep
   * working.
   */
  images?: Array<{
    role: "primary" | "ref2" | "ref3";
    url: string | null;
    pathLocal: string | null;
  }>;
  /**
   * Phase 9 — IP risk gating.
   *   - "high" + "needs_manual_review" rows are EXCLUDED by default
   *     unless ipRiskOverride is true (with a reason logged).
   *   - "low" / "medium" / "unchecked" pass through unchanged.
   *
   * The spec is explicit: do NOT allow high-risk products to be
   * generated "silently". Inclusion requires the user to have
   * explicitly approved the override per-product on the card.
   */
  ipRiskStatus: "unchecked" | "low" | "medium" | "high" | "needs_manual_review";
  ipRiskOverride: boolean;
}

export interface LastImageJobSummary {
  jobId: string;
  createdAt: string;
  submitted: number;
  failed: number;
  total: number;
}

type WaitMode = "submit_only" | "capture";
type AutomationMode = "safe" | "balanced" | "fast";

/**
 * "Generate Product Images" workbench section. Collects the eligible
 * products in this batch (those with both a local reference path and a
 * prompt) and dispatches a generate_flow_images job to the chosen
 * runner.
 *
 * The whole call goes through the existing createSampleJob action so
 * we get the same streaming + JobEvent persistence as the video flow.
 */
export default function GenerateImagesPanel({
  batchId,
  agents,
  products,
  lastJob,
  agentAssetBaseUrl,
}: {
  batchId: string;
  agents: ImageGenAgent[];
  products: ImageGenProduct[];
  lastJob: LastImageJobSummary | null;
  /**
   * Externally-reachable URL prefix the runner uses to fetch reference
   * images stored under public/uploads/. Comes from
   * AGENT_ASSET_BASE_URL on the server side; passed in so this client
   * component doesn't reach into process.env.
   */
  agentAssetBaseUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [waitMode, setWaitMode] = useState<WaitMode>("submit_only");
  const [automationMode, setAutomationMode] = useState<AutomationMode>("balanced");
  const [limit, setLimit] = useState<number>(30);
  const [lastError, setLastError] = useState<string | null>(null);
  // Phase 1: default to approved-only generation. Checkbox below
  // lets the user bypass when they want to test prompts before
  // doing the phone-review pass.
  const [includeNotApproved, setIncludeNotApproved] = useState(false);

  // Phase-1 + Phase-9 eligibility:
  //   - has an imagePrompt
  //   - has a reference source (URL or local-override path)
  //   - reviewStatus is "approved", OR the not-approved override is on
  //   - ipRiskStatus is not "high"/"needs_manual_review" UNLESS
  //     ipRiskOverride is true (per-product). Spec: "Do NOT allow
  //     high-risk products to be included silently."
  const hasUsableRefAndPrompt = (p: ImageGenProduct) =>
    !!p.imagePrompt &&
    (!!p.referenceImageUrl || !!p.referenceImagePathLocal);

  const isBlockedByIpRisk = (p: ImageGenProduct): boolean =>
    (p.ipRiskStatus === "high" ||
      p.ipRiskStatus === "needs_manual_review") &&
    !p.ipRiskOverride;

  const eligible = useMemo(
    () =>
      products.filter(
        (p) =>
          hasUsableRefAndPrompt(p) &&
          (includeNotApproved || p.reviewStatus === "approved") &&
          !isBlockedByIpRisk(p),
      ),
    [products, includeNotApproved],
  );

  // Counts shown next to the eligibility chip so the user sees
  // *why* the eligible count is what it is.
  const approvedCount = products.filter(
    (p) => p.reviewStatus === "approved",
  ).length;
  const needsReviewCount = products.filter(
    (p) => p.reviewStatus === "needs_review",
  ).length;
  const heldByReviewCount = products.filter(
    (p) =>
      hasUsableRefAndPrompt(p) && p.reviewStatus !== "approved",
  ).length;
  const heldByIpRiskCount = products.filter((p) =>
    hasUsableRefAndPrompt(p) && isBlockedByIpRisk(p),
  ).length;

  const missingPrompt = products.filter((p) => !p.imagePrompt).length;
  const missingRef = products.filter(
    (p) => !p.referenceImageUrl && !p.referenceImagePathLocal,
  ).length;
  const disabled =
    pending || !agentId || eligible.length === 0;

  function makeAbsolute(relOrAbs: string): string {
    if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
    const base = agentAssetBaseUrl.replace(/\/+$/, "");
    return relOrAbs.startsWith("/") ? `${base}${relOrAbs}` : `${base}/${relOrAbs}`;
  }

  function submit() {
    setLastError(null);
    const items = eligible.slice(0, limit).map((p) => {
      // Phase 3 — multi-reference image set. Filter to entries that
      // resolve to either a URL or a path; cap at 3. The runner caps
      // too, but matching the cap here keeps the count in
      // `images.length` accurate for the prompt-augmentation check
      // below.
      const refs = (p.images ?? [])
        .filter((img) => img.url || img.pathLocal)
        .slice(0, 3);
      const refCount = refs.length;

      // When a product has more than one reference image, prepend
      // the multi-ref guidance so Flow understands the references
      // describe ONE product, not several. Wording mirrors what's
      // documented in the v0.7 roadmap memory's "Multi-reference
      // prompt addendum" (PART 9).
      //
      // Single-ref products keep the prompt unchanged so the
      // existing image-output behaviour is byte-for-byte identical
      // for the 1-image case.
      let finalPrompt = p.imagePrompt!;
      if (refCount > 1) {
        const multiRefPreamble =
          "Use all provided reference images together to understand " +
          "the same product. Treat them as different views or details " +
          "of one product, not separate products. Combine the " +
          "consistent product design, packaging, color, shape, and " +
          "visible branding into one realistic product display. Do " +
          "not create a collage. Do not show multiple variants unless " +
          "the product is naturally sold as a set.\n\n";
        finalPrompt = multiRefPreamble + finalPrompt;
      }

      const item: Record<string, unknown> = {
        item_id:      p.id,
        product_name: p.productName,
        image_prompt: finalPrompt,
      };
      if (p.referenceImageUrl) {
        item.reference_image_url = makeAbsolute(p.referenceImageUrl);
      }
      if (p.referenceImagePathLocal) {
        // Send both when set — the runner prefers the path when it
        // exists, falls back to the URL otherwise. Useful when a
        // power user has cached a local copy.
        item.reference_image_path = p.referenceImagePathLocal;
      }
      // Phase 3 — full multi-reference array. The legacy fields
      // above stay populated (= the primary image) for back-compat
      // with older runners; new runners prefer this array. Roles are
      // sent in canonical order ("primary" first) so a runner that
      // walks the list left-to-right attaches the hero shot before
      // ref2/ref3. URLs are made absolute here, same as the legacy
      // path, so the runner doesn't need to know about
      // AGENT_ASSET_BASE_URL.
      if (refCount > 0) {
        item.reference_images = refs.map((img) => ({
          role: img.role,
          url:  img.url ? makeAbsolute(img.url) : null,
          path: img.pathLocal,
        }));
      }
      return item;
    });
    const payload = {
      items,
      limit,
      wait_mode:        waitMode,
      automation_mode:  automationMode,
    };
    startTransition(async () => {
      const r = await createSampleJob({
        jobType: "generate_flow_images",
        agentId,
        batchId,
        payload,
      });
      // Stay on the batch page. The result is surfaced inline by the
      // LatestTaskResult panel keyed on ?job=<id>. The job detail
      // page is still reachable via "View technical details" for
      // debugging.
      if (r.jobId) {
        // Land at the top of the batch page so the LatestTaskResult
        // panel (which reads ?job=<id>) is what the user sees
        // first. Earlier this pushed with #activity which scrolled
        // the browser to the bottom of the page on every click.
        router.push(`/batches/${batchId}?job=${r.jobId}`, { scroll: true });
      }
      if (!r.ok) {
        setLastError(r.message);
      }
    });
  }

  return (
    <section className="panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">Generate Product Images</div>
          <p className="text-xs text-muted mt-1">
            Submit each ready product to Google Flow using the chosen
            runner. The runner reads the reference image from the local
            filesystem path you set on the product.
          </p>
        </div>
        <span className="text-[11px] text-muted">
          generate_flow_images
        </span>
      </div>

      {/* Readiness counts ------------------------------------------- */}
      <div className="flex flex-wrap gap-2 text-xs">
        <StatusChip
          label={`${eligible.length} ready`}
          variant={eligible.length > 0 ? "ok" : "muted"}
        />
        <StatusChip
          label={`${approvedCount} approved`}
          variant={approvedCount > 0 ? "ok" : "muted"}
        />
        {needsReviewCount > 0 && (
          <StatusChip
            label={`${needsReviewCount} need review`}
            variant="warn"
          />
        )}
        {missingPrompt > 0 && (
          <StatusChip label={`${missingPrompt} missing prompt`} variant="warn" />
        )}
        {missingRef > 0 && (
          <StatusChip
            label={`${missingRef} missing reference`}
            variant="warn"
          />
        )}
        {lastJob && (
          <Link
            href={`/jobs/${lastJob.jobId}`}
            className="text-accent hover:underline ml-auto"
          >
            View last run ({lastJob.submitted}/{lastJob.total} submitted) →
          </Link>
        )}
      </div>

      {/* Approved-only override -------------------------------------- */}
      <label className="flex items-start gap-2 text-xs text-text cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={includeNotApproved}
          onChange={(e) => setIncludeNotApproved(e.target.checked)}
        />
        <span>
          <span className="font-medium">
            Include products that have not been approved yet
          </span>
          <span className="block text-muted mt-0.5">
            {includeNotApproved
              ? `Off-default: also queuing ${heldByReviewCount} non-approved product(s) that have a prompt + reference.`
              : `Default: only approved products generate. ${heldByReviewCount} eligible product(s) are currently held by the review gate.`}
          </span>
        </span>
      </label>

      {/* Phase 9 — IP risk gate banner. Surfaces the count of
          products held back by the high / needs_manual_review
          status. The override is per-product on the card (not a
          bulk toggle here) — the spec is explicit that high-risk
          inclusion must be explicit per product, not silent. */}
      {heldByIpRiskCount > 0 && (
        <div className="rounded-2xl border border-warn/40 bg-warn/[0.06] text-xs text-warn px-4 py-3 leading-snug">
          <span className="font-semibold">
            {heldByIpRiskCount} product{heldByIpRiskCount === 1 ? "" : "s"}
          </span>{" "}
          with high or needs-review IP risk are excluded from this run.
          To include them, expand the product card and approve the override
          with a written reason.
        </div>
      )}

      {/* Controls --------------------------------------------------- */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className="block">
          <span className="label">Runner</span>
          <select
            className="field mt-1"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.status}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Wait mode</span>
          <select
            className="field mt-1"
            value={waitMode}
            onChange={(e) => setWaitMode(e.target.value as WaitMode)}
          >
            <option value="submit_only">submit_only</option>
            <option value="capture">capture</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Automation mode</span>
          <select
            className="field mt-1"
            value={automationMode}
            onChange={(e) =>
              setAutomationMode(e.target.value as AutomationMode)
            }
          >
            <option value="safe">safe</option>
            <option value="balanced">balanced</option>
            <option value="fast">fast</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Limit</span>
          <input
            type="number"
            className="field mt-1"
            min={1}
            max={100}
            value={limit}
            onChange={(e) =>
              setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
            }
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={submit}
        >
          {pending ? "Submitting…" : "Generate Images"}
        </button>
        <span className="text-[11px] text-muted">
          {eligible.length === 0
            ? "Add a reference image and prompt to at least one product."
            : `Will submit ${Math.min(eligible.length, limit)} of ${eligible.length} ready products.`}
        </span>
      </div>

      {lastError && (
        <div className="text-xs text-bad">⚠ {lastError}</div>
      )}
    </section>
  );
}
