"use client";

import SiteNav from "../../site-nav";
import ProAccessPanel from "../../pro-access-panel";
import { ContributionChart, DrawdownChart, type HistoryPoint } from "../charts";
import PortfolioComparisonChart, { type ComparisonSeries } from "../portfolio-comparison-chart";
import { formatNav, signedPct } from "@/lib/portfolio-format";
import type { MemberState } from "@/lib/member-session";

export type PortfolioHolding = {
  ticker: string;
  initialWeight: number;
  currentWeight: number;
  shares: number;
  price: number;
  returnPct: number;
  contributionPoints: number;
  fairValue: number | null;
  fvUpsidePct: number | null;
  view: "BUY" | "WATCH" | "SELL" | null;
};

export type PortfolioViewSummary = {
  slug: string;
  displayName: string;
  subtitle: string;
  status: string;
  inceptionDate: string;
  asOfDate: string;
  sessions: number;
  nav: number;
  cumulativeReturn: number;
  benchmarkLabel: string;
  benchmarkNav: number;
  benchmarkCumulativeReturn: number;
  excessCumulativeReturn: number;
  currentDrawdown: number;
  maxDrawdown: number;
  maxDrawdownDate: string | null;
  volatility: number | null;
  methodologyVersion: string;
  priceSource: string;
  priceDataAsOf: string | null;
  lastRebalanceDate: string | null;
  rebalanceCount: number;
  persisted: boolean;
  disclosure: string;
};

const tone = (value: number) => (value > 0 ? "gain" : value < 0 ? "loss" : "");
const money = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `$${value.toFixed(value >= 100 ? 0 : 2)}`;
const percent = (value: number | null) =>
  value === null || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;

function Metric({ label, value, className, note }: { label: string; value: string; className?: string; note?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={className}>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

export default function PortfolioView({
  summary,
  history,
  holdings,
  contributions,
  member,
}: {
  summary: PortfolioViewSummary;
  history: HistoryPoint[];
  holdings: PortfolioHolding[];
  contributions: PortfolioHolding[];
  member: MemberState;
}) {
  // Both series share one date domain and one Y axis, so relative
  // outperformance is read directly off the chart.
  const comparisonSeries: ComparisonSeries[] = [
    { id: "ny", label: "Pick-NY", points: history.map((point) => ({ date: point.date, value: point.nav })) },
    { id: "spy", label: "S&P 500 / SPY", points: history.map((point) => ({ date: point.date, value: point.benchmarkNav })) },
  ];
  const rebalancePolicy = summary.rebalanceCount > 0 ? `${summary.rebalanceCount} event(s)` : "Event-driven (none since inception)";

  return (
    <div className="picks-page">
      <SiteNav current="/picks" member={member} />
      <header className="picks-hero">
        <div>
          <span className="picks-eyebrow">SIGNAL LEDGER PICKS</span>
          <h1>
            PICK-NY <small>{summary.subtitle}</small>
          </h1>
          <div className="header-chips">
            <span className="tier-chip tier-chip-free">FREE · PUBLIC PERFORMANCE</span>
            <span className="tier-chip tier-chip-pro">PRO · HOLDINGS &amp; ATTRIBUTION</span>
          </div>
        </div>
        <dl className="picks-trust">
          <div><dt>Inception</dt><dd>{summary.inceptionDate}</dd></div>
          <div><dt>Last updated</dt><dd>{summary.asOfDate}</dd></div>
          <div><dt>Benchmark</dt><dd>{summary.benchmarkLabel}</dd></div>
          <div><dt>Rebalance policy</dt><dd>{rebalancePolicy}</dd></div>
          <div><dt>Track record</dt><dd>Public and auditable</dd></div>
          <div><dt>Methodology version</dt><dd>{summary.methodologyVersion}</dd></div>
        </dl>
      </header>

      <section className="picks-metrics" aria-label="Pick-NY headline performance">
        <Metric label="NAV" value={formatNav(summary.nav)} />
        <Metric label="Return" value={signedPct(summary.cumulativeReturn)} className={tone(summary.cumulativeReturn)} />
        <Metric label="S&amp;P 500" value={signedPct(summary.benchmarkCumulativeReturn)} className={tone(summary.benchmarkCumulativeReturn)} />
        <Metric label="Excess" value={signedPct(summary.excessCumulativeReturn)} className={tone(summary.excessCumulativeReturn)} />
        <Metric label="Max drawdown" value={signedPct(summary.maxDrawdown)} className="loss" note={summary.maxDrawdownDate ?? undefined} />
        <Metric label="Current drawdown" value={signedPct(summary.currentDrawdown)} className={summary.currentDrawdown < 0 ? "loss" : ""} />
      </section>

      <section className="panel picks-section picks-section-chart" aria-label="Growth of 100">
        <h2>GROWTH OF $100</h2>
        {history.length >= 2 ? <PortfolioComparisonChart series={comparisonSeries} /> : null}
      </section>

      {member.tier === "PRO" ? (
        <>
          <section className="panel picks-section" aria-label="Current holdings">
            <h2>Current Holdings</h2>
            {holdings.length ? (
              <div className="picks-table-wrap">
                <table className="picks-table picks-table-holdings">
                  <thead>
                    <tr>
                      <th scope="col">Ticker</th>
                      <th scope="col">Initial weight</th>
                      <th scope="col">Current weight</th>
                      <th scope="col">Price</th>
                      <th scope="col">Return</th>
                      <th scope="col">Contribution</th>
                      <th scope="col">Signal Ledger FV</th>
                      <th scope="col">FV upside</th>
                      <th scope="col">View</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((row) => (
                      <tr key={row.ticker}>
                        <th scope="row">{row.ticker}</th>
                        <td>{(row.initialWeight * 100).toFixed(0)}%</td>
                        <td>{(row.currentWeight * 100).toFixed(1)}%</td>
                        <td>${row.price.toFixed(2)}</td>
                        <td className={tone(row.returnPct)}>{signedPct(row.returnPct)}</td>
                        <td className={tone(row.contributionPoints)}>{percent(row.contributionPoints)} pts</td>
                        <td>{money(row.fairValue)}</td>
                        <td className={tone(row.fvUpsidePct ?? 0)}>{row.fvUpsidePct === null ? "—" : percent(row.fvUpsidePct)}</td>
                        <td className={`picks-view picks-view-${(row.view ?? "none").toLowerCase()}`}>{row.view ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <p className="picks-note">
              Weights start at the published targets and are allowed to drift, because the portfolio is never rebalanced daily.
            </p>
          </section>

          <section className="panel picks-section" aria-label="Contribution">
            <h2>Contribution</h2>
            {contributions.length ? (
              <>
                <ContributionChart rows={contributions} />
                <p className="picks-note">
                  Contribution is measured in percentage points of portfolio return since inception, and sums to the published
                  total return.
                </p>
              </>
            ) : null}
          </section>
        </>
      ) : (
        <section className="panel picks-section" aria-label="Portfolio attribution">
          <ProAccessPanel
            kicker="SIGNAL LEDGER PRO"
            title="Portfolio attribution"
            description="The value, chart and drawdown above stay free. Pro opens the position detail behind that headline: which holdings drove the result, how much each contributed, and the reasoning recorded when the portfolio was set."
            features={[
              "Current and initial weights",
              "Per-position return and contribution",
              "Signal Ledger fair value and upside",
              "Rebalance and trade rationale",
            ]}
            cta="COMPARE FREE & PRO"
          />
        </section>
      )}

      <section className="panel picks-section" aria-label="Drawdown">
        <h2>Drawdown</h2>
        {history.length >= 2 ? <DrawdownChart points={history} /> : null}
      </section>

      <section className="panel picks-section" aria-label="Portfolio history">
        <h2>Portfolio History</h2>
        {history.length ? (
          <div className="picks-history-scroll">
            <table className="picks-table">
              <thead>
                <tr><th scope="col">Date</th><th scope="col">NAV</th><th scope="col">S&amp;P 500</th><th scope="col">Drawdown</th></tr>
              </thead>
              <tbody>
                {[...history].reverse().slice(0, 40).map((point) => (
                  <tr key={point.date}>
                    <th scope="row">{point.date}</th>
                    <td>{formatNav(point.nav)}</td>
                    <td>{formatNav(point.benchmarkNav)}</td>
                    <td className={point.drawdown < 0 ? "loss" : ""}>{signedPct(point.drawdown)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="picks-note">Showing the most recent 40 of {history.length} published sessions.</p>
          </div>
        ) : null}
      </section>

      <section className="panel picks-section" aria-label="Methodology">
        <h2>Methodology</h2>
        <ol className="picks-method">
          <li>Both series start at 100 on {summary.inceptionDate}, the first US session on or after 2026-01-01 where every holding traded.</li>
          <li>Capital is allocated by target weight, and fractional model shares are bought once and held. The portfolio is never rebalanced daily.</li>
          <li>NAV is the sum of model shares × adjusted close. Adjusted closes already reflect splits, reverse splits and distributions.</li>
          <li>The benchmark uses {summary.benchmarkLabel}, normalised to 100 on the same inception session.</li>
          <li>A stored session is never rewritten. Corrections are published as new events rather than silent edits.</li>
        </ol>
        <details className="picks-provenance">
          <summary>Advanced · model audit</summary>
          <dl>
            <div><dt>Price source</dt><dd>{summary.priceSource}</dd></div>
            <div><dt>Price data as of</dt><dd>{summary.priceDataAsOf ?? summary.asOfDate}</dd></div>
            <div><dt>Sessions</dt><dd>{summary.sessions}</dd></div>
            <div><dt>Annualised volatility</dt><dd>{summary.volatility === null ? "—" : signedPct(summary.volatility)}</dd></div>
            <div><dt>Rebalances since inception</dt><dd>{summary.rebalanceCount}</dd></div>
            <div><dt>Last rebalance</dt><dd>{summary.lastRebalanceDate ?? "None since inception"}</dd></div>
            <div><dt>Methodology version</dt><dd>{summary.methodologyVersion}</dd></div>
            <div><dt>Daily series storage</dt><dd>{summary.persisted ? "Persisted" : "Deterministic backtest"}</dd></div>
          </dl>
        </details>
      </section>

      <section className="panel picks-section picks-disclosure" aria-label="Disclosure">
        <h2>Disclosure</h2>
        <p>{summary.disclosure}</p>
      </section>
    </div>
  );
}
