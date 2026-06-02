/**
 * Helpers for the JSON-as-String columns the skeleton uses on SQLite.
 *
 * Prisma's `Json` column type isn't supported by the SQLite connector,
 * so `Job.payload` / `Job.result` / `Job.error` / `JobEvent.details`
 * are declared as `String` in schema.prisma. Server actions stringify
 * before writing; page renderers parse before displaying.
 *
 * On a future Postgres migration, switch those columns back to `Json`
 * and the only changes needed are removing the .encode/.parse calls
 * — the rest of the code reads JSON-shaped values either way.
 */

/** JSON.stringify with a tolerant nullable contract. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Parse a stringified-JSON column. Returns null on null/empty input. */
export function parseJson<T = unknown>(s: string | null | undefined): T | null {
  if (s === null || s === undefined || s === "") return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/**
 * Pretty-print a value for the JSON code blocks on detail pages.
 * Handles both "raw JSON string from the DB" and "already-parsed
 * object" inputs so call sites don't need to care.
 */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}
