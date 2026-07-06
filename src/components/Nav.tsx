import Link from "next/link";
import { getCurrentUser } from "@/lib/workspace";
import { logoutAction } from "@/app/(auth)/actions";

/**
 * Left-rail navigation.
 *
 * Async server component so it can read the session cookie. When no
 * user is signed in (login / signup pages) the whole rail is hidden
 * and the centred auth form gets the full viewport.
 *
 * "Runner" maps to the /agents route — the Agent table stays, the
 * surfaced label is just friendlier. The visual order reflects the
 * typical daily flow: see the cockpit → manage runs → review work.
 */
const ITEMS: Array<{ href: string; label: string; icon: string }> = [
  { href: "/dashboard", label: "Dashboard",     icon: "▦" },
  { href: "/batches",   label: "My Batches",    icon: "▤" },
  // BOF Dashboard — multi-account TikTok Shop analytics. Lives at
  // /analytics so it doesn't collide with the Flow-automation
  // /dashboard cockpit that's already here.
  { href: "/analytics", label: "Shop Analytics", icon: "$" },
  { href: "/agents",    label: "Runner Setup",  icon: "◆" },
  { href: "/jobs",      label: "Jobs",          icon: "≡" },
  { href: "/settings",  label: "Settings",      icon: "⚙" },
];

export default async function Nav() {
  const user = await getCurrentUser({ optional: true });
  if (!user) return null;

  const display = user.name?.trim() || user.email;

  return (
    <aside
      className="fixed top-0 left-0 bottom-0 w-[220px] z-20
                 bg-panel/85 backdrop-blur-md
                 border-r border-border
                 flex flex-col"
    >
      <Link
        href="/dashboard"
        className="px-5 pt-5 pb-4 flex items-baseline gap-2 group"
      >
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

      <div className="mt-auto px-5 py-4 border-t border-border space-y-2">
        <div className="text-[11px] text-muted2 truncate" title={user.email}>
          {display}
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="text-[11px] text-muted hover:text-text transition-colors"
          >
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
