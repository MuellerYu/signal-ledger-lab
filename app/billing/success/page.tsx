import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentEntitlement } from "@/lib/access";
import BillingSuccessPoll from "./poll";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment received | Signal Ledger",
  robots: { index: false },
};

/**
 * The post-checkout page. It deliberately claims nothing until the server has
 * resolved PRO from a webhook-confirmed subscription: the redirect here grants
 * nothing. Until that resolves it shows the restrained "we're confirming" state
 * and polls a bounded number of times.
 */
export default async function BillingSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ check?: string }>;
}) {
  const params = await searchParams;
  const check = Math.max(0, Number(params.check ?? 0) || 0);
  const entitlement = await getCurrentEntitlement();
  const confirmed = entitlement.tier === "PRO";

  return (
    <main className="account-shell">
      <div className="account-head">
        <Link href="/" className="account-head-brand">
          <span className="brand-mark" aria-hidden="true">
            SL
          </span>
          <span className="brand-name">Signal Ledger</span>
        </Link>
        <Link href="/account" className="account-head-back">
          ← Account
        </Link>
      </div>

      <h1 className="account-title">Payment received</h1>

      <section className="account-card account-section">
        <header className="account-section-head">
          <h2>{confirmed ? "PRO is active" : "Confirming your subscription"}</h2>
        </header>
        <p className="account-copy">
          {confirmed
            ? "Your PRO subscription is live. Full access to the research desk is unlocked."
            : "We've received your payment and are confirming it with your billing provider. Your access unlocks the moment that confirmation lands."}
        </p>
        {!confirmed ? <BillingSuccessPoll check={check} /> : null}
        <div style={{ marginTop: 20 }}>
          <Link
            className="pricing-plan-cta pricing-plan-cta-pro"
            href={confirmed ? "/" : "/account"}
          >
            {confirmed ? "OPEN THE RESEARCH DESK" : "GO TO ACCOUNT"}
          </Link>
        </div>
      </section>
    </main>
  );
}
