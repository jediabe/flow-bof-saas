import { prettyJson } from "@/lib/json-column";

/**
 * Collapsed JSON inspector. Default label is "Developer details" so
 * the technical payload stays out of the way until someone asks for
 * it. Pass `label` to customise.
 *
 * Renders nothing when `value` is null/undefined/empty so call sites
 * don't need an outer guard.
 */
export default function JsonDetails({
  value,
  label = "Developer details",
  className = "",
}: {
  value: unknown;
  label?: string;
  className?: string;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <details className={`text-xs ${className}`}>
      <summary className="cursor-pointer text-muted hover:text-text transition-colors select-none">
        {label}
      </summary>
      <pre className="mt-2 overflow-x-auto bg-bg/80 border border-border rounded-xl p-3 text-[11px] leading-relaxed">
{prettyJson(value)}
      </pre>
    </details>
  );
}
