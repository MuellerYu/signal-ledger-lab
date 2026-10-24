import SiteNav from "../site-nav";
import Link from "next/link";
import { resolveMember } from "@/lib/member-session";
import { PORTFOLIO_INDEX } from "@/lib/pick-ny";
import { getPortfolioSummary } from "@/lib/pick-ny-store";
import { formatNav, signedPct } from "@/lib/portfolio-format";
import "../picks/picks.css";

export const dynamic = "force-dynamic";

const tone = (value: number) => (value > 0 ? "gain" : value < 0 ? "loss" : "");

export default async function TrackRecordPage() {
  const member = await resolveMember();
  const portfolioRecords = await Promise.all(
    PORTFOLIO_INDEX.map(async (entry) => ({ entry, result: await getPortfolioSummary(entry.slug) })),
  );

  return (
    <div className="picks-page">
      <SiteNav current="/track-record" member={member} />
      <header className="picks-hero">
        <div>
          <span className="picks-eyebrow">SIGNAL LEDGER</span>
          <h1>Track Record</h1>
          <p className="picks-lede">
            Two separate records are published: frozen earnings forecasts, and the model portfolios. Neither is
            rewritten after the fact.
          </p>
        </div>
      </header>

      <section className="panel picks-section" aria-label="Earnings forecast track record">
        <h2>Earnings Forecast Track Record</h2>
        <p>
          Every earnings call is frozen before the release with its information cutoff, then graded against the reported
          result and the recorded target-session close. The ledger lives on the research dashboard so it stays next to
          the evidence it grades.
        </p>
        <p className="picks-note">
          Frozen probabilities, Brier scores, direction hits and relative returns are published in the Earnings Desk and
          the Full Forecast Scorecard on the research dashboard.
        </p>
        <Link className="button" href="/#amd-case-study">Open the earnings ledger →</Link>
      </section>

      <section className="panel picks-section" aria-label="Model portfolio track record">
        <h2>Model Portfolio Track Record</h2>
        <table className="picks-table">
          <thead>
            <tr>
              <th scope="col">Portfolio</th>
              <th scope="col">Inception</th>
              <th scope="col">NAV</th>
              <th scope="col">Total return</th>
              <th scope="col">Benchmark</th>
              <th scope="col">Excess</th>
              <th scope="col">Max drawdown</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {portfolioRecords.map(({ entry, result }) => (
              <tr key={entry.slug}>
                <th scope="row">{entry.displayName}</th>
                {result.ok ? (
                  <>
                    <td>{result.value.inceptionDate}</td>
                    <td>{formatNav(result.value.nav)}</td>
                    <td className={tone(result.value.cumulativeReturn)}>{signedPct(result.value.cumulativeReturn)}</td>
                    <td className={tone(result.value.benchmarkCumulativeReturn)}>{signedPct(result.value.benchmarkCumulativeReturn)}</td>
                    <td className={tone(result.value.excessCumulativeReturn)}>{signedPct(result.value.excessCumulativeReturn)}</td>
                    <td className="loss">{signedPct(result.value.maxDrawdown)}</td>
                    <td><Link href={`/picks/${entry.slug}`}>Open →</Link></td>
                  </>
                ) : (
                  <td colSpan={7} className="picks-unavailable">{result.error}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="picks-note">
          The benchmark is the S&amp;P 500 total-return proxy, normalised to 100 on the same inception session as each
          portfolio.
        </p>
      </section>

      <section className="panel picks-section picks-disclosure">
        <h2>Disclosure</h2>
        <p>
          Signal Ledger Picks are research model portfolios, not brokerage accounts, investment funds, or personalized
          investment advice. Model performance may differ from real-world investable returns.
        </p>
      </section>
    </div>
  );
}
