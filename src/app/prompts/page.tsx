import Link from "next/link";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";

/**
 * Hooks & Prompts — placeholder.
 *
 * Real UI ships in Phase 5 of the APEX revamp: pick a product
 * (same TikTokProduct table image gen uses), generate all seven
 * hook families, browse + copy per hook, hashtag block below.
 *
 * This stub exists so the nav rail's "Hooks & Prompts" entry
 * doesn't 404 in the gap between the Nav restructure landing and
 * the real page shipping. Kept dead simple; will be replaced
 * wholesale.
 */

export const dynamic = "force-dynamic";

export default function PromptsPlaceholderPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="h-page">Hooks &amp; Prompts</h1>
        <p className="text-sm text-muted mt-1">
          One-shot hook, caption, and hashtag generation for UK
          TikTok Shop videos.
        </p>
      </header>

      <Panel title="Coming next" variant="ghost">
        <EmptyState
          icon="✎"
          title="Hook generator lands here"
          hint="Pick a product, add an optional discount %, and get all seven hook families (I'm So Sorry, Wait, POV, Curiosity, Scarcity, Deal, Social Proof) with the APEX-compliant caption and hashtag block. In the meantime you can still generate through the Batches flow."
          action={
            <Link href="/batches" className="btn btn-primary text-xs">
              Go to Batches
            </Link>
          }
        />
      </Panel>
    </div>
  );
}
