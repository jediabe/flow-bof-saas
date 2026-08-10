/**
 * Human-readable labels for the MCP tool names surfaced in the
 * chat transcript. The raw tool names ("local_get_product_context",
 * "google_flow_generate_image") are implementation detail — the
 * operator sees the mapped short phrase instead.
 *
 * Unknown tool names fall back to a generic phrase based on
 * their prefix (google_flow_* → "Google Flow step", local_* →
 * "Reading batch data", other → "Working").
 */

const EXACT: Record<string, string> = {
  // Local (batch-scoped) tools
  local_list_workspace_products: "Looking up batch products",
  local_get_product_context: "Reading product details",
  local_list_saved_videos_for_product: "Checking existing videos",
  local_save_generated_video: "Saving generated video",

  // Google Flow — Nano Banana image generation
  google_flow_generate_image: "Generating scene image",
  google_flow_edit_image: "Editing image",

  // Google Flow — Veo video generation
  google_flow_generate_video: "Rendering video",
  google_flow_get_job: "Polling job status",
  google_flow_cancel_job: "Cancelling job",
  google_flow_list_jobs: "Listing jobs",

  // Google Flow — asset management
  google_flow_upload_asset: "Uploading reference",
  google_flow_get_asset: "Fetching asset URL",
  google_flow_delete_asset: "Deleting asset",
  google_flow_list_assets: "Listing assets",

  // Google Flow — projects / accounts
  google_flow_list_projects: "Listing Flow projects",
  google_flow_get_project: "Reading project",
  google_flow_create_project: "Creating project",
  google_flow_delete_project: "Deleting project",
  google_flow_list_accounts: "Listing Flow accounts",
  google_flow_get_account: "Reading Flow account",
};

export function friendlyToolLabel(name: string): string {
  const hit = EXACT[name];
  if (hit) return hit;
  if (name.startsWith("google_flow_")) return "Google Flow step";
  if (name.startsWith("local_")) return "Reading batch data";
  // Absolute last resort — take everything after the last _ and
  // title-case it. "some_new_tool" → "New tool".
  const stem = name.split("_").slice(1).join(" ").trim() || name;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
