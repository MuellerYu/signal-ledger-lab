import Link from "next/link";
import AccountControl from "./account-control";
import type { MemberState } from "@/lib/member-session";

/**
 * The one internal navigation bar. Every page renders this rather than its own
 * markup, so no page can drift into a plain anchor and force a full document
 * reload on the way back to Research.
 *
 * It takes the already-resolved member state as a prop so the server page can
 * fill it in on first paint (no client fetch, no flash), while remaining safe to
 * render from a client component (a portfolio view) that received the same
 * serializable state from its server parent.
 *
 * Bitcoin is a first-class product now, sitting beside U.S. Equities rather than
 * grouped under Intelligence. Intelligence is a small dropdown holding the two
 * market briefs (Daily Brief + Live Market Feed); both stay one click away. The
 * Bitcoin and Live Market Feed entries deep-link into the dashboard via `?view=`.
 */
type NavItem = {
  href: string;
  label: string;
  children?: Array<{ href: string; label: string }>;
};

const LINKS: NavItem[] = [
  { href: "/", label: "Research" },
  { href: "/fair-value", label: "Valuation" },
  { href: "/companies", label: "Companies" },
  { href: "/?view=btc", label: "Bitcoin" },
  { href: "/options", label: "Options" },
  { href: "/picks", label: "Picks" },
  {
    href: "/daily-brief",
    label: "Intelligence",
    children: [
      { href: "/daily-brief", label: "Daily Brief" },
      { href: "/?view=world", label: "Live Market Feed" },
    ],
  },
  { href: "/track-record", label: "Track Record" },
  { href: "/pricing", label: "Pricing" },
];

const ANONYMOUS: MemberState = {
  authenticated: false,
  userId: null,
  email: null,
  tier: "FREE",
};

export default function SiteNav({
  current,
  member = ANONYMOUS,
}: {
  current?: string;
  member?: MemberState;
}) {
  return (
    <header className="site-nav">
      <Link href="/" className="site-nav-brand"><span>SL</span><strong>Signal Ledger</strong></Link>
      <nav aria-label="Research navigation">
        {LINKS.map((link) =>
          link.children ? (
            <details
              key={link.href}
              className="site-nav-group"
              data-current={current === link.href || link.children.some((child) => child.href === current) ? "true" : undefined}
            >
              <summary className={current === link.href || link.children.some((child) => child.href === current) ? "site-nav-current" : undefined}>
                {link.label}
              </summary>
              <div className="site-nav-group-menu">
                {link.children.map((child) => (
                  <Link key={child.href} href={child.href} aria-current={current === child.href ? "page" : undefined}>
                    {child.label}
                  </Link>
                ))}
              </div>
            </details>
          ) : (
            <Link key={link.href} href={link.href} aria-current={current === link.href ? "page" : undefined}>
              {link.label}
            </Link>
          ),
        )}
      </nav>
      <AccountControl member={member} />
    </header>
  );
}
