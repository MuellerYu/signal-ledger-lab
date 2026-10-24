"use client";

import Link from "next/link";
import { isLaunchTicker } from "@/lib/launch-universe";
import { useEffect, useMemo, useState } from "react";
import ProAccessPanel from "./pro-access-panel";
import Disclaimer from "./disclaimer";
import "./equity-research-detail.css";

type Row = Record<string, any>;

function pickText(row: Row | undefined, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickNumber(row: Row | undefined, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[$,%\s,]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function dollars(value: number | null, decimals = 2) {
  return value === null
    ? "Pending"
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function percent(value: number | null) {
  return value === null ? "Pending" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function etTime(value: string) {
  if (!value) return "Timestamp pending";
  return `${new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} ET`;
}

function findTicker(rows: Row[] | undefined, symbol: string) {
  return (rows ?? []).find(
    (row) => pickText(row, ["ticker", "symbol"]).toUpperCase() === symbol,
  );
}

function EvidenceTag({ children }: { children: React.ReactNode }) {
  return <span className="evidence-tag">{children}</span>;
}

export default function EquityResearchDetail({ symbol, tier }: { symbol: string; tier: "FREE" | "PRO" }) {
  const [dashboard, setDashboard] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/dashboard", { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Live research feed returned ${response.status}`);
        return response.json();
      })
      .then((payload) => setDashboard(payload))
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Operator detail stays in the console: an HTTP status or provider string
        // is not public copy, and the page renders a fixed sentence instead.
        console.warn("[equity] live research feed unavailable:", error instanceof Error ? error.message : error);
        setLoadError("Live fields are temporarily unavailable.");
      });
    return () => controller.abort();
  }, []);

  const quote = useMemo(() => findTicker(dashboard?.latestQuotes, symbol), [dashboard, symbol]);
  const eventForecast = useMemo(
    () => findTicker(dashboard?.earningsPriceForecasts, symbol),
    [dashboard, symbol],
  );
  const financialForecast = useMemo(
    () => findTicker(dashboard?.earningsForecasts, symbol),
    [dashboard, symbol],
  );

  if (symbol !== "ORCL") {
    return (
      <main className="equity-detail-page">
        <nav className="detail-nav" aria-label="Research coverage"><span className="detail-nav-note">Coverage queue</span><div><Link href="/fair-value">Open the free stock summary →</Link></div></nav>
        <section className="unsupported-equity"><span>RESEARCH COVERAGE</span><h1>{symbol}</h1><p>{isLaunchTicker(symbol)
          ? "Business revenue and published forecast scenarios are available on the company research page."
          : "This security remains in the coverage queue."}</p>
          {isLaunchTicker(symbol) ? <Link href={`/companies/${symbol.toLowerCase()}`}>Open {symbol} company research →</Link>
            : <Link href="/equities/orcl">Open ORCL research →</Link>}</section>
      </main>
    );
  }

  const currentPrice = pickNumber(quote, ["price"]);
  const priceChange = pickNumber(quote, ["percentageChange", "percentage_change"]);
  const marketStatus = pickText(quote, ["marketStatus", "market_status"]);
  const quoteTime = pickText(quote, ["quoteAsOfAt", "quote_as_of_at"]);
  const eventTarget = pickNumber(eventForecast, ["predictedPostPrice", "predicted_post_price"]);
  const eventMove = pickNumber(eventForecast, ["predictedChangePct", "predicted_change_pct"]);
  const referencePrice = pickNumber(eventForecast, ["referencePrice", "reference_price"]);
  const cutoff = pickText(eventForecast, ["informationCutoffAt", "information_cutoff_at"]);
  const status = pickText(eventForecast, ["status"]) || "open";
  const revenueEstimate = pickNumber(financialForecast, ["revenueEstimate", "revenue_estimate"]);
  const epsEstimate = pickNumber(financialForecast, ["epsEstimate", "eps_estimate"]);
  const actualRevenue = pickNumber(financialForecast, ["actualRevenue", "actual_revenue"]);
  const actualEps = pickNumber(financialForecast, ["actualEps", "actual_eps"]);
  const resultsReported = pickText(financialForecast, ["status"]).toLowerCase() === "resolved";
  const amplitude = eventForecast?.source?.evidence?.historicalEarningsAmplitude ?? {};
  const historicalSample = pickNumber(amplitude, ["sampleCount", "sample_count"]);
  const medianMove = pickNumber(amplitude, ["medianAbsMovePct", "median_abs_move_pct"]);

  return (
    <main className="equity-detail-page">
      <nav className="detail-nav" aria-label="On this page">
        <span className="detail-nav-note">On this page</span>
        <div><a href="#valuation">Valuation</a><a href="#earnings-research">Earnings</a><a href="#archive">Archive</a><a href="#track-record">Track record</a></div>
      </nav>

      {loadError ? <div className="detail-feed-warning" role="status">{loadError} The dated research record below remains visible.</div> : null}

      <header className="equity-masthead">
        <div className="company-identity"><span>{resultsReported ? "POST-EARNINGS REVIEW · REPORTED" : "INITIATING COVERAGE · PRELIMINARY"}</span><h1>Oracle Corporation <small>ORCL</small></h1><p>Enterprise software · Cloud infrastructure · September 10, 2026</p></div>
        <div className="masthead-rating"><span>RATING</span><strong>WATCH</strong><small>Research confidence: preliminary / low</small></div>
      </header>

      <section className="headline-grid" aria-label="Oracle research headline metrics">
        <article><span>Current price</span><strong>{dollars(currentPrice)}</strong><em className={(priceChange ?? 0) >= 0 ? "positive" : "negative"}>{percent(priceChange)}</em><small>{marketStatus || "Live status pending"} · {etTime(quoteTime)}</small></article>
        <article className="withheld"><span>Signal Ledger fair value</span><strong>Not published</strong><small>Cash-return and capital-structure gate not cleared</small></article>
        <article className="withheld"><span>12-month target</span><strong>Not published</strong><small>No long-horizon target is inferred from an earnings call</small></article>
        <article className="withheld"><span>Expected return</span><strong>Not published</strong><small>Requires a published 12-month target</small></article>
        <article className="event-metric"><span>Next-session event target</span><strong>{dollars(eventTarget)}</strong><em>{percent(eventMove)}</em><small>Frozen at {dollars(referencePrice)} · status: {status}</small></article>
      </section>

      <section className="investment-conclusion">
        <div><span>INVESTMENT CONCLUSION</span><h2>WATCH: the growth surprise is real; the equity-return bridge still needs proof.</h2></div>
        <p>Oracle reported Q1 FY2027 revenue of $19.3B, up 30%, with cloud infrastructure revenue of $7.4B, up 121%, and RPO of $664B. The print confirms unusually strong AI infrastructure demand and backlog conversion. The remaining valuation question is whether that growth produces adequate post-capex free cash flow after financing costs and dilution.</p>
        <aside><strong>Action</strong><span>Raise operating estimates, but do not convert an excellent quarter into a 12-month target until the financing, capex and cash-return bridge is sourced.</span></aside>
      </section>

      {tier === "PRO" ? (
        <>
          <section className="detail-section" id="valuation">
        <header><div><span>VALUATION</span><h2>Valuation framework and publication gate</h2></div><p>Fair value is a present-value estimate. The 12-month target adds the next year of execution, catalysts and risk. Neither is the same as a one-session earnings target.</p></header>
        <div className="valuation-layout">
          <div className="valuation-table-wrap"><table className="valuation-table"><thead><tr><th>Method</th><th>Role</th><th>Weight now</th><th>Required evidence</th></tr></thead><tbody>
            <tr><th>DCF / FCFF</th><td>Primary intrinsic-value method</td><td>0% · gated</td><td>Post-capex FCF, financing cost and dilution schedule</td></tr>
            <tr><th>Forward P/E</th><td>Earnings cross-check</td><td>0% · gated</td><td>Comparable GAAP EPS and recurring earnings bridge</td></tr>
            <tr><th>EV / EBITDA</th><td>Capital-structure cross-check</td><td>0% · gated</td><td>Net debt after planned financing and normalized EBITDA</td></tr>
            <tr><th>EV / Revenue</th><td>Growth-scenario cross-check only</td><td>0% · gated</td><td>Cloud mix, margin path and peer-consistent definitions</td></tr>
          </tbody></table></div>
          <aside className="valuation-gate"><EvidenceTag>PUBLICATION GATE</EvidenceTag><h3>No false precision</h3><p>A positive target requires a fully sourced share count, net-debt bridge, capex path and cash-return framework. The page exposes the missing inputs instead of hiding them behind a multiple.</p><dl><div><dt>Fair value</dt><dd>WITHHELD</dd></div><div><dt>12M target</dt><dd>WITHHELD</dd></div><div><dt>Buy zone</dt><dd>NOT SET</dd></div></dl></aside>
        </div>
        <div className="buy-zone"><div><span>BUY ZONE</span><strong>Not published until the valuation gate clears</strong></div><div className="buy-zone-scale"><i>STRONG BUY</i><i>BUY</i><i>ACCUMULATE</i><i>WATCH</i><i>OVERVALUED</i></div><p>A price band without a defensible Fair Value and 12M Target would be false precision. The reusable zone is visible now; its thresholds will publish with the first completed valuation.</p></div>
      </section>

      <section className="detail-section" id="valuation-bridge">
        <header><div><span>VALUATION BRIDGE</span><h2>How the target changes</h2></div><p>The bridge isolates operating estimates, selected valuation multiples, net debt and dilution.</p></header>
        <div className="bridge-grid"><article><span>Previous 12M target</span><strong>Not published</strong><p>No legacy target is being retrofitted into the record.</p></article><article><span>Operating estimate revision</span><strong>Positive</strong><p>$19.3B of revenue exceeded the frozen $17.52B model; OCI growth reached 121%.</p></article><article><span>Capital and multiple revision</span><strong>Still gated</strong><p>Financing mix, net debt, dilution and post-capex cash returns remain the controlling evidence.</p></article><article><span>New 12M target</span><strong>Not published</strong><p>Operational upside alone does not clear the financed-growth valuation gate.</p></article></div>
      </section>

      <section className="detail-section">
        <header><div><span>RESULTS VS. FROZEN MODEL</span><h2>The quarter changed the operating case</h2></div><p>Reported GAAP, company non-GAAP and Signal Ledger model figures remain explicitly separated.</p></header>
        <div className="assumption-grid">
          <article><span>Reported total revenue</span><strong>{actualRevenue === null ? "$19.30B" : `$${(actualRevenue / 1e9).toFixed(2)}B`}</strong><p>Up 30% year over year; consolidated company revenue.</p></article>
          <article><span>Cloud infrastructure revenue</span><strong>$7.40B</strong><p>Up 121%; the quarter&apos;s central upside driver.</p></article>
          <article><span>Remaining performance obligations</span><strong>$664B</strong><p>Contracted backlog, not current-period revenue or cash flow.</p></article>
          <article><span>Signal Ledger revenue model</span><strong>{revenueEstimate === null ? "Pending" : `$${(revenueEstimate / 1e9).toFixed(2)}B`}</strong><p>Frozen before release; underestimated reported revenue by roughly 9.2% of actual.</p></article>
          <article><span>Reported GAAP EPS / model</span><strong>{dollars(actualEps)} / {dollars(epsEstimate)}</strong><p>The frozen GAAP EPS model overestimated the reported result.</p></article>
          <article><span>Reported non-GAAP EPS</span><strong>$1.92</strong><p>Company-adjusted basis; not scored against the GAAP model or an unverified provider basis.</p></article>
        </div>
      </section>

      <section className="detail-section scenario-section">
        <header><div><span>THESIS RANGE</span><h2>What makes the case better or worse</h2></div><p>Scenarios are decision rules, not probability decoration.</p></header>
        <div className="scenario-grid"><article className="bear"><span>BEAR</span><h3>Growth decelerates; funding pressure rises</h3><p>OCI growth slows before new capacity earns an adequate return, while higher financing needs weaken per-share value and delay free-cash-flow recovery.</p></article><article className="base"><span>BASE</span><h3>Backlog converts, but cash proof lags</h3><p>Cloud growth remains strong and estimates rise, while capex and financing keep the stock in a WATCH posture pending post-capex cash-return evidence.</p></article><article className="bull"><span>BULL</span><h3>Growth persists with disciplined funding</h3><p>RPO converts into sustained OCI growth, capacity utilization rises and financing becomes less dilutive. That evidence would clear the path toward a published 12-month valuation.</p></article></div>
      </section>

      <section className="detail-section" id="earnings-research">
        <header><div><span>EARNINGS RESEARCH</span><h2>Q1 FY2027 event ledger</h2></div><p>Release: September 10 after market close · target session: September 11 close.</p></header>
        <div className="earnings-ledger">
          <article><span>WHAT HAPPENED</span><h3>Broad top-line beat led by OCI</h3><p>Total revenue reached $19.3B, OCI revenue reached $7.4B and RPO rose to $664B. The parser&apos;s earlier $1.4B figure was Services revenue and has been corrected.</p></article>
          <article><span>WHAT CHANGED</span><h3>Backlog conversion accelerated</h3><p>Revenue growth of 30% and OCI growth of 121% clear the prior company growth ranges. Operating estimates move higher; the demand thesis strengthened.</p></article>
          <article><span>VALUATION IMPACT</span><h3>Growth support rises; funding discount remains</h3><p>Higher revenue supports earnings power, but planned debt/equity financing and heavy datacenter investment still prevent a defensible Fair Value or 12-month target.</p></article>
        </div>
        <div className="event-callout"><div><span>FROZEN EVENT CALL</span><strong>{dollars(referencePrice)} → {dollars(eventTarget)}</strong></div><p>This is a next-session close forecast, frozen before earnings at {etTime(cutoff)}. It is not Fair Value, a 12-month target or a recommendation to trade.</p></div>
      </section>

      <section className="detail-section" id="archive">
        <header><div><span>RESEARCH ARCHIVE</span><h2>Published views are preserved</h2></div><p>New evidence creates a new dated note; it does not overwrite the old judgment.</p></header>
        <div className="archive-list"><article><time>SEP 10, 2026</time><div><EvidenceTag>RESULTS REVIEW</EvidenceTag><h3>Q1 FY2027: OCI acceleration confirms operating upside</h3><p>Revenue $19.3B · GAAP EPS $1.56 · OCI $7.4B · RPO $664B. Rating remains WATCH pending valuation evidence.</p></div><a href="https://investor.oracle.com/files/content_files/1q27-pressrelease-September_FINAL.pdf" target="_blank" rel="noreferrer">Official release ↗</a></article><article><time>SEP 10, 2026</time><div><EvidenceTag>PRE-EARNINGS</EvidenceTag><h3>Q1 FY2027: backlog conversion and financing test</h3><p>Frozen event target: {dollars(eventTarget)}. Fair value and 12M target were not published.</p></div><a href="/api/reports/signal-ledger-orcl-q1-fy2027-preview.pdf" download>PDF ↓</a></article><article><time>JUN 10, 2026</time><div><EvidenceTag>RESULTS REVIEW</EvidenceTag><h3>FY2026 Q4: cloud acceleration paired with negative free cash flow</h3><p>Research note retained as prior evidence. It did not contain a published fair value or 12-month target.</p></div><a href="https://www.oracle.com/news/announcement/q4fy26-earnings-release-2026-06-10/" target="_blank" rel="noreferrer">Official release ↗</a></article></div>
      </section>

      <section className="detail-section" id="track-record">
        <header><div><span>TRACK RECORD</span><h2>Count decisions, not impressions</h2></div><p>The historical stock-move sample is an amplitude reference—not Signal Ledger prediction accuracy.</p></header>
        <div className="track-grid"><article><span>Published valuation targets</span><strong>0</strong><p>No fair value or 12M target has cleared the evidence gate.</p></article><article><span>Open event forecasts</span><strong>{status === "open" ? "1" : "0"}</strong><p>The Q1 FY2027 next-session call is awaiting settlement.</p></article><article><span>Historical earnings moves sampled</span><strong>{historicalSample ?? "3"}</strong><p>Median absolute move: {medianMove === null ? "10.2%" : `${medianMove.toFixed(1)}%`}.</p></article><article><span>Current rating</span><strong>WATCH</strong><p>Preliminary confidence until valuation inputs are complete.</p></article></div>
      </section>

      <section className="detail-section source-register" id="sources">
        <header><div><span>SOURCE REGISTER</span><h2>Primary evidence and market data</h2></div><p>Every source retains its original role and timestamp.</p></header>
        <ul>
          <li><a href="https://www.oracle.com/news/announcement/q4fy26-earnings-release-2026-06-10/" target="_blank" rel="noreferrer">Oracle FY2026 Q4 results and Q1 FY2027 guidance ↗</a><span>Management results, guidance, backlog and financing disclosures</span></li>
          <li><a href="https://investor.oracle.com/files/content_files/1q27-pressrelease-September_FINAL.pdf" target="_blank" rel="noreferrer">Oracle Q1 FY2027 earnings release ↗</a><span>Reported revenue, EPS, cloud metrics, RPO and updated guidance</span></li>
          <li><a href="https://investor.oracle.com/investor-news/news-details/2026/Oracle-Sets-the-Date-for-its-First-Quarter-Fiscal-Year-2027-Earnings-Announcement/default.aspx" target="_blank" rel="noreferrer">Oracle earnings date announcement ↗</a><span>Company-confirmed event timing</span></li>
          <li><a href="https://data.sec.gov/api/xbrl/companyfacts/CIK0001341439.json" target="_blank" rel="noreferrer">SEC Company Facts ↗</a><span>Historical GAAP/XBRL model inputs</span></li>
          <li><a href="https://api.nasdaq.com/api/quote/ORCL/info?assetclass=stocks" target="_blank" rel="noreferrer">Nasdaq ORCL quote endpoint ↗</a><span>Current price and quote timestamp</span></li>
        </ul>
      </section>

        </>
      ) : (
        <section className="detail-section detail-pro-lock">
          <ProAccessPanel
            kicker="SIGNAL LEDGER PRO"
            title="Research report"
            description="The summary above is free. Pro opens the working behind it: the valuation framework and bridge, results measured against the frozen model, the thesis range, the earnings ledger, the full archive and report downloads."
            features={[
              "Full valuation framework and bridge",
              "Results vs. the frozen model",
              "Thesis range and scenarios",
              "Complete research archive",
              "Historical report downloads",
            ]}
            cta="COMPARE FREE & PRO"
          />
        </section>
      )}

      <footer className="detail-footer">
        <Link href="/fair-value">Open the free stock summary →</Link>
        <p>Independent equity research · Valuation · Forecast accountability.</p>
        <Disclaimer />
      </footer>
    </main>
  );
}
