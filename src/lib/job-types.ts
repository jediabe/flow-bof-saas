/**
 * Friendly labels + UI metadata for job types. One source of truth so
 * the dashboard, batch page, jobs list, and job detail page all show
 * the same human-readable names.
 *
 * Adding a new job type: add an entry here, drop a renderer under
 * `src/components/results/`, and wire it into `app/jobs/[id]/page.tsx`.
 */

export const FRIENDLY_JOB_TYPE: Record<string, string> = {
  health_check:                          "Runner Health Check",
  check_flow_connection:                 "Flow Connection Check",
  scan_favorited_images:                 "Scan Favorites",
  generate_flow_images:                  "Generate Images",
  generate_flow_videos_from_favorites:   "Generate Videos",
};

/** Best-effort friendly label. Falls through to the raw type if unknown. */
export function friendlyJobType(type: string): string {
  return FRIENDLY_JOB_TYPE[type] ?? type;
}
