import SiteNav from "../site-nav";
import Link from "next/link";
import PlanBoundary from "../research-guide";
import { resolveMember } from "@/lib/member-session";
import { PORTFOLIO_INDEX } from "@/lib/pick-ny";
import { getPortfolioSummary } from "@/lib/pick-ny-store";
import { Sparkline, type HistoryPoint } from "./charts";
import { formatNav, signedPct } from "@/lib/portfolio-format";
import "./picks.css";

export const dynamic = "force-dynamic";

const tone = (value: number) => (value > 0 ? "gain" : value < 0 ? "loss" : "");

export default async function PicksIndexPage() {
  const member = await resolveMember();
  const summaries = await Promise.all(
    PORTFOLIO_INDEX.map(async (entry) => ({ entry, result: await getPortfolioSummary(entry.slug) })),
  );

  return (
    <div className="picks-page">
      <SiteNav current="/picks" member={member} />
      <header className="picks-hero">
        <div>
          <span className="picks-eyebrow">SIGNAL LEDGER PICKS</span>
          <h1>Model Portfolios</h1>
          <p className="picks-lede">
            Public research model portfolios with an auditable daily track record. Published sessions are never
            rewritten. Headline performance — NAV, inception return, benchmark and excess return — is free. Holdings,
            weights and attribution are Signal Ledger PRO.
          </p>
          <div className="header-chips">
            <span className="tier-chip tier-chip-free">FREE · PUBLIC PERFORMANCE</span>
            <span className="tier-chip tier-chip-pro">PRO · HOLDINGS &amp; ATTRIBUTION</span>
          </div>
        </div>
      </header>

      <PlanBoundary />

      <section className="picks-index" aria-label="Published portfolios">
        {summaries.map(({ entry, result }) => (
          <article key={entry.slug} className="panel picks-index-card">
            <header>
              <div>
                <h2>{entry.displayName}</h2>
                <p>{entry.subtitle}</p>
              </div>
              <span className={`picks-status picks-status-${entry.status}`}>{entry.status.toUpperCase()}</span>
            </header>

            {result.ok ? (
              <>
                <div className="picks-panel-metrics">
                  <div><span>NAV</span><strong>{formatNav(result.value.nav)}</strong></div>
                  <div><span>Since inception</span><strong className={tone(result.value.cumulativeReturn)}>{signedPct(result.value.cumulativeReturn)}</strong></div>
                  <div><span>S&amp;P 500</span><strong className={tone(result.value.benchmarkCumulativeReturn)}>{signedPct(result.value.benchmarkCumulativeReturn)}</strong></div>
                  <div><span>Excess return</span><strong className={tone(result.value.excessCumulativeReturn)}>{signedPct(result.value.excessCumulativeReturn)}</strong></div>
                </div>
                <footer>
                  <Sparkline points={result.value.sparkline as HistoryPoint[]} />
                  <Link className="button button-dark" href={`/picks/${entry.slug}`}>View {entry.displayName.replace("Signal Ledger ", "")} →</Link>
                </footer>
              </>
            ) : (
              <p className="picks-unavailable">{result.error}</p>
            )}
          </article>
        ))}
      </section>

      <p className="picks-note">
        Only portfolios with a published track record are listed. The index is built so further picks can be added
        without changing this page.
      </p>
    </div>
  );
}
