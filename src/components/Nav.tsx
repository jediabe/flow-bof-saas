import Link from "next/link";

/**
 * Left-rail navigation.
 *
 * "Runner" maps to the /agents route — the Agent table stays, the
 * surfaced label is just friendlier. The visual order reflects the
 * typical daily flow: see the cockpit → manage runs → review work.
 */
const ITEMS: Array<{ href: string; label: string; icon: string }> = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/batches",   label: "Batches",   icon: "▤" },
  { href: "/agents",    label: "Runner",    icon: "◆" },
  { href: "/jobs",      label: "Jobs",      icon: "≡" },
  { href: "/settings",  label: "Settings",  icon: "⚙" },
];

export default function Nav() {
  return (
    <aside className="fixed top-0 left-0 bottom-0 w-[220px] z-20
                      bg-panel/85 backdrop-blur-md
                      border-r border-border
                      flex flex-col">
      <Link href="/dashboard"
            className="px-5 pt-5 pb-4 flex items-baseline gap-2 group">
        <span className="text-accent text-lg leading-none drop-shadow-[0_0_8px_rgba(56,189,248,0.6)]">
          ◇
        </span>
        <span className="font-semibold tracking-tight text-text group-hover:text-accent transition-colors">
          Flow BOF
        </span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted ml-auto">
          alpha
        </span>
      </Link>

      <nav className="px-3 pt-2 pb-4 flex flex-col gap-1">
        {ITEMS.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className="group flex items-center gap-3 px-3 py-2 rounded-xl
                       text-sm text-muted hover:text-text hover:bg-panel2
                       transition-colors"
          >
            <span className="w-4 text-center text-muted2 group-hover:text-accent transition-colors">
              {it.icon}
            </span>
            <span>{it.label}</span>
          </Link>
        ))}
      </nav>

      <div className="mt-auto px-5 py-4 border-t border-border text-[11px] text-muted2">
        <div>SaaS · skeleton</div>
        <div>brain to local agent's hands</div>
      </div>
    </aside>
  );
}
