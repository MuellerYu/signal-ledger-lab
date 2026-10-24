import type { Metadata } from "next";
import Link from "next/link";
import { resolveMember } from "@/lib/member-session";
import SiteNav from "../site-nav";
import Disclaimer from "../disclaimer";
import ProCheckout from "../pro-checkout";
import { FreeExamples } from "../research-guide";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pricing | Signal Ledger",
  description: "Signal Ledger PRO — research beyond the headline. Free research access and a PRO tier for the full valuation framework, Daily Brief and options intelligence.",
};

const FREE_FEATURES = [
  "Homepage market dashboard",
  "Ticker and company search",
  "Current prices",
  "Basic fair value and rating",
  "Two complete FREE SAMPLE analyses: AMD and SPCX",
  "Daily Brief format preview",
  "Pick-NY headline NAV and daily performance",
  "Basic options chain",
  "Latest research summary",
];

const PRO_FEATURES = [
  "Complete Bear / Base / Bull valuation",
  "Model weights, assumptions and valuation history",
  "Pick-NY holdings, weights and attribution",
  "Full 10-section post-close Daily Brief",
  "Complete research archive and report downloads",
  "Advanced options: AI Sell Put, AI Covered Call, IV / Greeks and strategy ranking",
];

const COMPARISON = [
  ["Stock research", "Price, fair-value summary and rating", "Full model, assumptions and scenarios for supported stocks"],
  ["Learn the method", "AMD and SPCX complete free analyses", "Detailed company-specific valuation research"],
  ["Options", "Basic bid / ask quotes and scenario tools", "IV, Greeks, strategy rankings and optional AI review"],
  ["Model portfolios / Pick-NY", "Headline value and daily performance", "Holdings, weights and performance attribution"],
  ["Daily Brief", "Report format preview", "Complete post-close research brief"],
];
export default async function PricingPage() {
  const member = await resolveMember();
  const isPro = member.tier === "PRO";
  const onFree = member.authenticated && !isPro;

  return (
    <div className="pricing-page">
      <SiteNav current="/pricing" member={member} />
      <main className="pricing-shell">
        <header className="pricing-hero">
          <span className="pricing-eyebrow">SIGNAL LEDGER PRO</span>
          <h1>Start free. Go deeper with Pro.</h1>
          <p>
            Free helps you understand the answer. Pro opens the assumptions, scenarios and strategy tools behind it. Explore the public walkthroughs before deciding.
          </p>
        </header>

        <div className="pricing-plans">
          <section className="pricing-plan" aria-label="Free plan">
            <span className="pricing-plan-tier">FREE</span>
            <h2>Free research</h2>
            <p className="pricing-plan-lede">For exploring stocks and learning how the research works.</p>
            <p className="pricing-plan-price"><strong>$0</strong> <span>/ forever</span></p>
            <p className="pricing-plan-subprice">No card. No trial. No expiry.</p>
            <ul className="pricing-plan-features">
              {FREE_FEATURES.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            {onFree ? (
              <span className="pricing-plan-cta pricing-plan-cta-disabled">CURRENT PLAN</span>
            ) : (
              <Link className="pricing-plan-cta pricing-plan-cta-free" href="/">START FREE</Link>
            )}
          </section>

          <section className="pricing-plan pricing-plan-pro" aria-label="Signal Ledger PRO plan">
            <span className="pricing-plan-flag">FULL RESEARCH</span>
            <span className="pricing-plan-tier">PRO</span>
            <h2>Signal Ledger PRO</h2>
            <p className="pricing-plan-lede">For comparing assumptions, exploring trades and following the full research record.</p>
            <p className="pricing-plan-price"><strong>$19.99</strong> <span>/ month</span></p>
            <p className="pricing-plan-subprice"><b>$179 / year</b> · SAVE 25%</p>
            <ul className="pricing-plan-features">
              {PRO_FEATURES.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            {isPro ? (
              <span className="pricing-plan-cta pricing-plan-cta-disabled">CURRENT PLAN</span>
            ) : onFree ? (
              <ProCheckout />
            ) : (
              <>
                <Link className="pricing-plan-cta pricing-plan-cta-pro" href="/account">SIGN IN TO UPGRADE</Link>
                <p className="pricing-plan-note">Sign in with your email to start checkout.</p>
              </>
            )}
          </section>
        </div>

        <section className="plan-comparison" aria-labelledby="compare-title">
          <h2 id="compare-title">Exactly what changes when you upgrade</h2>
          <div className="plan-table-scroll" tabIndex={0} role="region" aria-label="Free and Pro feature comparison"><table><caption>Same research foundation. Different depth of access.</caption><thead><tr><th scope="col">Feature</th><th scope="col">Free · $0</th><th scope="col">Pro · $19.99/month or $179/year</th></tr></thead><tbody>{COMPARISON.map(([feature, free, pro]) => <tr key={feature}><th scope="row">{feature}</th><td>{free}</td><td>{pro}</td></tr>)}</tbody></table></div>
          <p>Coverage depends on available evidence and market data. Pro does not guarantee a valuation for every security, real-time exchange quotes or profitable trades.</p>
        </section>
        <FreeExamples />
        <section className="plan-faq" aria-label="Plan questions"><h2>Before you decide</h2>
          <details><summary>Is Free a trial?</summary><p>No. Public summaries and walkthroughs remain free. You can explore them without a card or an account.</p></details>
          <details><summary>Are the free examples complete live Pro reports?</summary><p>AMD and SPCX are complete FREE SAMPLE analyses — full public examples of the research, published without hiding the scenarios, assumptions or evidence. Every other supported company shows a free summary, with the full analysis opening in Pro.</p></details>
          <details><summary>Does Pro give a different fair value?</summary><p>No. Upgrading opens more detail, not a more favorable result. A model estimate is not a promised future price, and confidence is not a probability of profit.</p></details>
          <details><summary>How do I manage or cancel Pro?</summary><p>Use Account to manage billing or cancel automatic renewal. Plans renew until canceled. Cancellation stops the next renewal; access continues through the paid period. See the <Link href="/refund-policy">refund policy</Link>.</p></details>
          <details><summary>Do I connect a brokerage account?</summary><p>No broker credentials are needed to browse. Signal Ledger provides research and scenario tools; it does not execute trades.</p></details>
        </section>
        <div className="pricing-footnote">
          <p>
            Both tiers use the same research foundation. PRO never changes a valuation, a
            portfolio calculation or the Daily Brief — it unlocks the full record those systems already produce.
          </p>
          <p>
            PRO is a recurring subscription: the monthly and annual plans renew automatically until
            canceled. You can cancel anytime from your account — cancellation stops the next renewal while
            your access continues through the end of the paid period. See the{" "}
            <Link href="/refund-policy">refund policy</Link> for details.
          </p>
          <Disclaimer />
        </div>
      </main>
    </div>
  );
}
