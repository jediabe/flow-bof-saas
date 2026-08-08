/** Shared constants for the Google Flow MCP server. */

export const SERVER_NAME = "google-flow-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** useapi.net Google Flow v1 base URL. */
export const API_BASE_URL = "https://api.useapi.net/v1/google-flow";

/**
 * Maximum characters in a single tool text response. Larger payloads are
 * trimmed with an explicit truncation notice so the agent knows data is missing.
 */
export const CHARACTER_LIMIT = 25_000;

/** Default timeout for a useapi.net request (ms). Async submissions return fast. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Timeout for synchronous (async=false) generation calls. Google Flow itself
 * gives up after ~600s, so allow a little more than that.
 */
export const SYNC_GENERATION_TIMEOUT_MS = 660_000;

/** Timeout for raw binary asset uploads (up to 100 MB MP4). */
export const UPLOAD_TIMEOUT_MS = 300_000;

/** Video generation models accepted by POST /videos. */
export const VIDEO_MODELS = [
  "veo-3.1-quality",
  "veo-3.1-fast",
  "veo-3.1-lite",
  "veo-3.1-lite-low-priority",
  "omni-flash",
] as const;

/** POST /videos/extend does not support omni-flash. */
export const EXTEND_MODELS = [
  "veo-3.1-quality",
  "veo-3.1-fast",
  "veo-3.1-lite",
  "veo-3.1-lite-low-priority",
] as const;

/** Image generation models accepted by POST /images. */
export const IMAGE_MODELS = [
  "nano-banana-2-lite",
  "nano-banana-2",
  "nano-banana-pro",
  // Deprecated but still accepted upstream.
  "nano-banana",
  "imagen-4",
] as const;

export const VIDEO_ASPECT_RATIOS = [
  "landscape",
  "portrait",
  "1:1",
  "4:3",
  "3:4",
] as const;

export const IMAGE_ASPECT_RATIOS = [
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "auto",
  "landscape",
  "portrait",
] as const;

/** MIME types accepted by POST /assets/{email}. */
export const UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
] as const;

/** The 30 built-in Google Flow voices, exact capitalization. */
export const SYSTEM_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede",
  "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome",
  "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda",
  "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

/** Terminal + non-terminal job states returned by GET /jobs/{jobId}. */
export const JOB_STATUSES = ["created", "started", "completed", "failed"] as const;
