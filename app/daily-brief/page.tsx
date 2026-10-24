import type { Metadata } from "next";
import { resolveMember } from "@/lib/member-session";
import SiteNav from "../site-nav";
import ProAccessPanel, { ProActivePanel } from "../pro-access-panel";
import Disclaimer from "../disclaimer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Daily Brief | Signal Ledger",
  description: "Explore the format of the Signal Ledger post-close research brief and compare Free and Pro access.",
};

const FREE_SECTIONS = [
  { title: "TODAY IN 30 SECONDS", body: "A concise recap of the session's dominant market move and the one number that mattered, in about thirty seconds." },
  { title: "THE MOVE THAT MATTERED", body: "A short preview of the single move that defined the session — expanded in full for PRO." },
];

const PRO_SECTIONS = [
  "WHY THE MARKET MOVED",
  "LEADERS & LAGGARDS",
  "STOCKS THAT MATTERED",
  "PICK-NY TODAY",
  "VALUATION WATCH",
  "AFTER THE BELL",
];

/**
 * The Daily Brief page is a deterministic view of the same canonical brief the
 * Worker publishes post-close. It is a structural preview here — the full brief
 * is generated and stored by the Worker, not the Pages app — so this page never
 * runs a second AI pass and never fabricates a session's figures.
 */
export default async function DailyBriefPage() {
  const member = await resolveMember();
  const isPro = member.tier === "PRO";

  return (
    <div className="daily-brief-page">
      <SiteNav current="/daily-brief" member={member} />
      <main className="daily-brief-shell">
        <header className="daily-brief-masthead">
          <span className="pricing-eyebrow">DAILY BRIEF</span>
          <h1>The post-close research brief.</h1>
          <p>
            Understand what moved, why it matters and what to watch next. This page previews the report format; it is not today's market report. The complete post-close brief is a Pro feature.
          </p>
        </header>

        <p className="research-label">FORMAT PREVIEW · NOT TODAY'S REPORT</p>
        <div className="daily-brief-preview">
          {FREE_SECTIONS.map((section) => (
            <section className="brief-section" key={section.title}>
              <div className="brief-section-head">
                <h2>{section.title}</h2>
                <span className="brief-free-tag">FREE</span>
              </div>
              <p>{section.body}</p>
            </section>
          ))}
        </div>

        <ul className="daily-brief-locked">
          {PRO_SECTIONS.map((section) => (
            <li key={section}>
              <span>{section}</span>
              <span className="brief-lock-tag">PRO</span>
            </li>
          ))}
        </ul>

        {isPro ? (
          <ProActivePanel
            title="Your Daily Brief is included"
            description="Every section listed above is included in your plan. Delivery is controlled from your account, and turning it off never affects your access."
          />
        ) : (
          <ProAccessPanel
            kicker="SIGNAL LEDGER PRO"
            title="Daily Brief"
            description="The format above is free to read. Pro delivers the complete post-close brief for each session: WHY THE MARKET MOVED, LEADERS & LAGGARDS, STOCKS THAT MATTERED, PICK-NY TODAY, VALUATION WATCH and AFTER THE BELL."
            features={PRO_SECTIONS}
            cta="COMPARE FREE & PRO"
            href="/pricing"
          />
        )}

        <Disclaimer className="daily-brief-disclaimer" />
      </main>
    </div>
  );
}
