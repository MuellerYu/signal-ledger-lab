import Link from "next/link";
import {
  BUSINESS_DESCRIPTION,
  RESEARCH_DISCLAIMER,
  SITE_NAME,
} from "@/lib/site-config";

/**
 * The one global legal footer, rendered from the root layout so every public
 * page carries the same navigation and disclosure. It is deliberately compact —
 * a brand line, one row of links, and a single-sentence disclaimer — and reuses
 * the navy brand so it reads as the bookend to the header, not a second content
 * block.
 */
const FOOTER_LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/refund-policy", label: "Refund Policy" },
  { href: "/support", label: "Support" },
];

export default function SiteFooter() {
  return (
    <footer className="site-legal-footer">
      <div className="site-legal-footer-inner">
        <div className="site-legal-footer-brand">
          <Link href="/" className="site-legal-footer-name">
            <span aria-hidden="true">SL</span>
            <strong>{SITE_NAME}</strong>
          </Link>
          <p>{BUSINESS_DESCRIPTION}</p>
        </div>

        <nav aria-label="Site and legal">
          <Link href="/examples">Free walkthroughs</Link>
          <Link href="/account">Account</Link>
          {FOOTER_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>

        <p className="site-legal-footer-disclaimer">{RESEARCH_DISCLAIMER}</p>
      </div>
    </footer>
  );
}
