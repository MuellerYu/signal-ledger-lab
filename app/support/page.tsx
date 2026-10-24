import type { Metadata } from "next";
import Link from "next/link";
import { getBindings } from "@/lib/runtime";
import { resolveMember } from "@/lib/member-session";
import { SUPPORT_EMAIL } from "@/lib/site-config";
import SiteNav from "../site-nav";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Support | Signal Ledger",
  description:
    "How to contact Signal Ledger for account, billing and subscription questions.",
};

export default async function SupportPage() {
  const member = await resolveMember();
  const supportEmail = getBindings().SUPPORT_EMAIL?.trim() || SUPPORT_EMAIL;

  return (
    <div className="legal-page">
      <SiteNav member={member} />
      <main className="legal-shell">
        <header className="legal-hero">
          <span className="pricing-eyebrow">SIGNAL LEDGER</span>
          <h1>Signal Ledger Support</h1>
        </header>

        <article className="legal-body">
          <p>
            For account, subscription, billing, or product questions, contact us
            at{" "}
            <a href={`mailto:${supportEmail}`} rel="noopener">
              {supportEmail}
            </a>
            .
          </p>

          <h2>Contact us</h2>
          <p>
            Email{" "}
            <a href={`mailto:${supportEmail}`} rel="noopener">
              {supportEmail}
            </a>{" "}
            and include the email address on your account so we can find it
            quickly.
          </p>

          <h2>Billing and cancellation</h2>
          <p>
            You can cancel your PRO subscription at any time from the{" "}
            <Link href="/account">account page</Link>. Cancellation stops the
            next renewal while your access continues through the end of the paid
            period. See the <Link href="/refund-policy">refund policy</Link> for
            details on refunds.
          </p>
        </article>
      </main>
    </div>
  );
}
