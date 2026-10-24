import { resolveMember } from "@/lib/member-session";
import SiteNav from "./site-nav";

/**
 * Shared shell for the public legal pages (/privacy, /terms, /refund-policy).
 *
 * Legal pages are public: they render for anonymous visitors with no auth gate,
 * and they reuse the same SiteNav header as the rest of the site so a merchant
 * reviewer navigates them exactly as a customer would. The member state is
 * resolved only so the header shows ACCOUNT · PRO consistently for signed-in
 * readers; it never gates the content.
 */
export default async function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  const member = await resolveMember();

  return (
    <div className="legal-page">
      <SiteNav member={member} />
      <main className="legal-shell">
        <header className="legal-hero">
          <span className="pricing-eyebrow">SIGNAL LEDGER</span>
          <h1>{title}</h1>
          <p className="legal-updated">Last updated: {updated}</p>
        </header>
        <article className="legal-body">{children}</article>
      </main>
    </div>
  );
}
