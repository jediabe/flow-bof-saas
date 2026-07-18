import Link from "next/link";
import { getCurrentUser } from "@/lib/workspace";
import { logoutAction } from "@/app/(auth)/actions";
import ApexLogo from "@/components/ApexLogo";

/**
 * Left-rail navigation — APEX layout.
 *
 * Two groups:
 *   PRIMARY — the everyday surfaces (hub landing, shop analytics,
 *             hook & prompt generation). What a creator lives in.
 *   TOOLS   — image-gen automation and its supporting cast
 *             (batches, runner setup, jobs). Kept working but
 *             visually demoted; image gen is now secondary to the
 *             analytics + prompt hub.
 *
 * Settings sits at the bottom, above the user chip, so it's always
 * one click regardless of which group is active.
 *
 * Async server component so it can read the session cookie. When
 * no user is signed in (login / signup pages) the whole rail is
 * hidden and the centred auth form gets the full viewport.
 */
interface NavItem {
  href: string;
  label: string;
  icon: string;
}

const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Hub",              icon: "▦" },
  { href: "/analytics", label: "Shop Analytics",   icon: "$" },
  // /prompts is the new hook & caption generation surface —
  // wired in phase 5 of the APEX revamp. Nav entry lands first
  // so returning users see the new route immediately.
  { href: "/prompts",   label: "Hooks & Prompts",  icon: "✎" },
];

const TOOLS: NavItem[] = [
  { href: "/batches",   label: "Image Gen",        icon: "▤" },
  { href: "/agents",    label: "Runner Setup",     icon: "◆" },
  { href: "/jobs",      label: "Jobs",             icon: "≡" },
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
        className="px-5 pt-5 pb-4 flex items-baseline justify-between group"
      >
        <ApexLogo size="sm" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-muted">
          alpha
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 pt-2 pb-4 flex flex-col gap-4">
        <NavGroup items={PRIMARY} />
        <NavGroup label="Tools" items={TOOLS} subdued />
      </nav>

      <div className="px-3 pb-3">
        <Link
          href="/settings"
          className="group flex items-center gap-3 px-3 py-2 rounded-xl
                     text-sm text-muted hover:text-text hover:bg-panel2
                     transition-colors"
        >
          <span className="w-4 text-center text-muted2 group-hover:text-accent transition-colors">
            ⚙
          </span>
          <span>Settings</span>
        </Link>
      </div>

      <div className="px-5 py-4 border-t border-border space-y-2">
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

/**
 * A single vertical stack of nav links, optionally prefaced with a
 * subdued group label. Used twice in the rail — once for primary
 * surfaces, once for demoted tools. The `subdued` variant renders
 * items slightly smaller and paler so the eye reads them as
 * "here if you need them" rather than "look here first".
 */
function NavGroup({
  label,
  items,
  subdued = false,
}: {
  label?: string;
  items: NavItem[];
  subdued?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-[0.16em] text-muted2">
          {label}
        </div>
      )}
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={`group flex items-center gap-3 px-3 py-2 rounded-xl
                     transition-colors
                     ${
                       subdued
                         ? "text-[13px] text-muted2 hover:text-text hover:bg-panel2"
                         : "text-sm text-muted hover:text-text hover:bg-panel2"
                     }`}
        >
          <span className="w-4 text-center text-muted2 group-hover:text-accent transition-colors">
            {it.icon}
          </span>
          <span>{it.label}</span>
        </Link>
      ))}
    </div>
  );
}
