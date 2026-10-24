import Link from "next/link";

import { getCurrentEntitlement } from "@/lib/access";
import { readEmailPreferences } from "@/lib/email-preferences";
import { resolveMember } from "@/lib/member-session";
import { getMembershipD1 } from "@/lib/membership-db";
import SignInForm from "../sign-in-form";
import AccountPanel from "./account-panel";
import SiteNav from "../site-nav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Account | Signal Ledger",
  description: "Membership and email settings for your Signal Ledger account.",
};

/**
 * The account console. Anonymous visitors get a sign-in prompt; authenticated
 * members get membership, email, Daily Brief and sign-out sections. Entitlement
 * and preferences are both read server-side here, never from the browser.
 */
export default async function AccountPage() {
  const member = await resolveMember();

  if (!member.authenticated || !member.userId) {
    return (
      <><SiteNav current="/account" member={member} /><main className="account-guest-shell">
        <section className="account-card account-guest-card">
          <header className="continue-brand">
            <span className="brand-mark" aria-hidden="true">
              SL
            </span>
            <span className="brand-name">Signal Ledger</span>
          </header>
          <h1 className="account-title">Your account</h1>
          <p className="account-lede">
            Sign in to manage your plan and email preferences. You do not need an account to explore free stock summaries or research walkthroughs.
          </p>
          <SignInForm />
          <p className="account-back">
            <Link href="/examples">Explore free walkthroughs</Link> · <Link href="/pricing">Compare Free &amp; Pro</Link>
          </p>
        </section>
      </main></>
    );
  }

  const d1 = getMembershipD1();
  const prefs = d1 ? await readEmailPreferences(d1, member.userId) : null;
  const entitlement = await getCurrentEntitlement();

  const subscription = d1 && entitlement.subscriptionId
    ? await d1.prepare("SELECT provider FROM subscriptions WHERE id = ? AND user_id = ? LIMIT 1").bind(entitlement.subscriptionId, member.userId).first<{ provider: string }>()
    : null;

  return (
    <><SiteNav current="/account" member={member} /><AccountPanel
      billingProvider={subscription?.provider ?? null}
      email={member.email}
      tier={member.tier}
      dailyBriefEnabled={prefs?.dailyBriefEnabled ?? false}
      accessUntil={entitlement.accessUntil}
      cancelAtPeriodEnd={entitlement.cancelAtPeriodEnd}
      cancelAt={entitlement.cancelAt}
    /></>
  );
}
