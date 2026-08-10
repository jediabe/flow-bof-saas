import {
  getBatchPromptsState,
  listRecentPromptBatches,
} from "./actions";
import PromptsHubClient from "./PromptsHubClient";

/**
 * /prompts — APEX Hooks & Prompts hub.
 *
 * URL state: `?batch=<id>` picks the active batch. When set, the
 * server pre-loads the batch's full state so the client renders
 * immediately without an initial fetch flash. When absent, we
 * load a small list of recent batches so operators can jump back
 * into an in-flight review.
 */

export const dynamic = "force-dynamic";

export default async function PromptsPage({
  searchParams,
}: {
  // Next.js 15 — searchParams is async.
  searchParams: Promise<{ batch?: string }>;
}) {
  const sp = await searchParams;
  const batchId = sp.batch?.trim() || null;

  const [initialState, recentBatches] = await Promise.all([
    batchId ? getBatchPromptsState(batchId) : Promise.resolve(null),
    listRecentPromptBatches(5),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h-page">
          APEX <span className="text-accent">Automator</span>
        </h1>
        <p className="text-sm text-muted mt-1">
          Chat with the agent, import Kalodata sheets or paste TikTok URLs, and
          hand off generated videos to your phone — all in one surface.
        </p>
      </header>

      <PromptsHubClient
        initialState={initialState?.ok ? initialState : null}
        recentBatches={recentBatches}
      />
    </div>
  );
}
