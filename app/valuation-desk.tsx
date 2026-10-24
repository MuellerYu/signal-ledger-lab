"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { FREE_RESEARCH_EXAMPLES } from "./research-guide";
import { isPublicSampleTicker } from "@/lib/public-samples";
import type { InvestmentSnapshot } from "@/lib/investment-snapshot";
import "./valuation-desk.css";

type Row = Record<string, unknown>;

/**
 * Public status rule: a normal card states a view and a confidence. Engine
 * lifecycle statuses (provisional, screening, high uncertainty) are internal
 * and live under Advanced · model audit on the ticker page, never on the card.
 * A badge appears only when something is genuinely exceptional.
 */
type PublicView = "BUY" | "WATCH" | "SELL";

export function publicView(snapshot: InvestmentSnapshot): PublicView {
  const label = String(snapshot.ratingLabel ?? snapshot.rating ?? "").toUpperCase();
  if (label === "STRONG_BUY" || label === "UNDERVALUED") return "BUY";
  if (label === "OVERVALUED") return "SELL";
  return "WATCH";
}

export function publicBadge(snapshot: InvestmentSnapshot): "MODEL REVIEW" | "VALUATION WITHHELD" | null {
  if (snapshot.releaseGate === "model_check_required") return "MODEL REVIEW";
  if (snapshot.fairValue === null || snapshot.valuationStatus === "unavailable") return "VALUATION WITHHELD";
  return null;
}

const money = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

const signedPct = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

function text(row: Row | undefined, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function num(row: Row | undefined, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/[$,%\s,]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function compactUsd(value: number | null) {
  if (value === null) return "—";
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return money(value);
}

function relativeTime(value: string) {
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return "Timestamp unavailable";
  const minutes = Math.max(0, Math.round((Date.now() - stamp) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

function tone(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? "flat" : value > 0 ? "up" : value < 0 ? "down" : "flat";
}

/**
 * The homepage first screen. Kept deliberately lean: one headline, one line of
 * orientation and a compact ticker search. The product cards below answer
 * "what can I do here?"; membership copy is a single light line, never the full
 * Free vs Pro comparison (that lives on /pricing, locked PRO states and /account).
 */
function LandingHero({ onSearch }: { onSearch: (ticker: string) => void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ticker = query.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(ticker)) {
      setError("Enter a valid U.S. ticker or company symbol.");
      return;
    }
    setError("");
    onSearch(ticker);
  }

  return (
    <header className="landing-hero">
      <p className="valuation-hero-brand">SIGNAL LEDGER</p>
      <h1>Independent equity and digital-asset research.</h1>
      <p className="landing-hero-intro">Valuation, options strategy, model portfolios and a frozen 30-day Bitcoin outlook — each researched, documented and preserved against its own record.</p>
      <form className="valuation-hero-form" onSubmit={submit} role="search">
        <label htmlFor="valuation-hero-input" className="valuation-hero-label">Start with a stock</label>
        <div className="valuation-hero-row">
          <input
            id="valuation-hero-input"
            value={query}
            onChange={(event) => setQuery(event.target.value.toUpperCase())}
            placeholder="e.g. AMD, ORCL or TSLA"
            autoComplete="off"
            maxLength={12}
          />
          <button type="submit">View free summary</button>
        </div>
        <small>{error || "Free: price, estimated fair value and rating. No account required."}</small>
      </form>
    </header>
  );
}

const PRODUCT_ENTRIES = [
  { title: "U.S. Equities", description: "Stock research & valuation", href: "#stock-summaries", badge: null },
  { title: "Bitcoin", description: "30-Day Outlook", href: "/?view=btc", badge: "FREE" },
  { title: "Options", description: "Chain & strategy analytics", href: "/options", badge: "PRO" },
  { title: "Picks", description: "Model portfolios", href: "/picks", badge: "PRO" },
] as const;

function ProductEntries() {
  return (
    <section className="product-entries" aria-label="Signal Ledger products">
      {PRODUCT_ENTRIES.map((entry) => (
        <Link key={entry.title} href={entry.href} className="product-entry">
          <span className="product-entry-head">
            <strong>{entry.title}</strong>
            {entry.badge ? <em className={`product-entry-badge product-entry-badge-${entry.badge.toLowerCase()}`}>{entry.badge}</em> : null}
          </span>
          <span className="product-entry-desc">{entry.description}</span>
          <span className="product-entry-cta">Open →</span>
        </Link>
      ))}
    </section>
  );
}

function MembershipLine() {
  return (
    <p className="membership-line">
      <span>Free includes AMD &amp; SPCX complete analyses</span>
      <Link href="/pricing">See Free vs Pro →</Link>
    </p>
  );
}

function TryFree() {
  return (
    <section className="try-free" aria-label="Free sample analyses">
      <div className="try-free-head">
        <span>TRY SIGNAL LEDGER FREE</span>
        <h2>Two complete analyses, free to read.</h2>
        <p>No account required. Each is the full research — scenarios, assumptions and evidence left in.</p>
      </div>
      <div className="try-free-links">
        {FREE_RESEARCH_EXAMPLES.map(({ ticker, company, question }) => (
          <Link key={ticker} href={`/fair-value?ticker=${ticker}`}>
            <strong>{ticker} — Complete public analysis</strong>
            <span>{company} · {question}</span>
            <b>Open →</b>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SnapshotCard({ snapshot }: { snapshot: InvestmentSnapshot }) {
  const href = `/fair-value?ticker=${encodeURIComponent(snapshot.ticker)}`;
  const isSample = isPublicSampleTicker(snapshot.ticker);
  return (
    <Link className="valuation-card" href={href} aria-label={`${snapshot.ticker} valuation`}>
      <div className="valuation-card-head">
        <div>
          <strong>{snapshot.ticker}</strong>
          <span>{snapshot.company}</span>
        </div>
        {isSample ? (
          <span className="valuation-badge valuation-badge-free-sample">FREE SAMPLE</span>
        ) : publicBadge(snapshot) ? (
          <span className={`valuation-badge badge-${publicBadge(snapshot) === "MODEL REVIEW" ? "model-review" : "withheld"}`}>
            {publicBadge(snapshot)}
          </span>
        ) : null}
      </div>
      <div className="valuation-card-price">
        <span>Current price</span>
        <strong>{money(snapshot.quote.price)}</strong>
        <small>{snapshot.quote.asOf ? `${snapshot.quote.source} · ${snapshot.quote.asOf}` : snapshot.quote.source}</small>
      </div>
      <div className="valuation-card-metric">
        <span>Signal Ledger FV</span>
        <strong>{money(snapshot.fairValue, 0)}</strong>
        <small>
          <b className={tone(snapshot.upsidePct)}>{signedPct(snapshot.upsidePct)}</b>
        </small>
      </div>
      <div className="valuation-card-metric">
        <span>View</span>
        <strong className={`valuation-view view-${publicView(snapshot).toLowerCase()}`}>{publicView(snapshot)}</strong>
      </div>
      <div className="valuation-card-range">
        {snapshot.modelRange?.bear == null ? (
          isSample ? (
            <span className="free-sample-hint"><b>FREE SAMPLE</b> · complete public analysis</span>
          ) : (
            <span className="pro-lock-hint"><b>PRO</b> · full valuation framework</span>
          )
        ) : (
          <span>Model range {money(snapshot.modelRange.bear, 0)} – {money(snapshot.modelRange.bull, 0)}</span>
        )}
      </div>
      <div className="valuation-card-foot">
        <span>
          Confidence {snapshot.fairValue === null ? "—" : `${Math.round(snapshot.confidence * 100)}%`}
          {snapshot.confidenceLabel === "Low confidence" ? " · LOW" : ""}
        </span>
        <span>{relativeTime(snapshot.valuationUpdatedAt)}</span>
      </div>
    </Link>
  );
}

function Shelf({
  eyebrow,
  title,
  description,
  snapshots,
}: {
  eyebrow: string;
  title: string;
  description: string;
  snapshots: InvestmentSnapshot[];
}) {
  if (!snapshots.length) return null;
  return (
    <section className="valuation-shelf" aria-label={title}>
      <div className="valuation-shelf-head">
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <p>{description}</p>
      </div>
      <ul>
        {snapshots.map((snapshot) => (
          <li key={`${title}-${snapshot.ticker}`}>
            <Link href={`/fair-value?ticker=${encodeURIComponent(snapshot.ticker)}`}>
              <strong>{snapshot.ticker}</strong>
              <span>{snapshot.company}</span>
            </Link>
            <span className="valuation-shelf-price">{money(snapshot.quote.price)}</span>
            <span className="valuation-shelf-fv">{money(snapshot.fairValue, 0)}</span>
            <span className={`valuation-shelf-gap ${tone(snapshot.upsidePct)}`}>{signedPct(snapshot.upsidePct)}</span>
            <span className={`valuation-shelf-rating rating-${snapshot.rating.toLowerCase().replaceAll(" ", "-")}`}>{snapshot.rating}</span>
            <span className={`valuation-shelf-confidence ${snapshot.confidenceLabel === "Low confidence" ? "low" : ""}`}>{snapshot.fairValue === null ? "—" : `${Math.round(snapshot.confidence * 100)}%`}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EarningsAhead({
  forecasts,
  byTicker,
}: {
  forecasts: Row[];
  byTicker: Map<string, InvestmentSnapshot>;
}) {
  const rows = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return forecasts
      .map((forecast) => {
        const event = (forecast.earningsEvent ?? forecast.earnings_event ?? {}) as Row;
        const consensus = (forecast.analystConsensus ?? forecast.analyst_consensus ?? {}) as Row;
        const ticker = text(forecast, ["ticker", "symbol"]).toUpperCase();
        return {
          ticker,
          date: text(event, ["date"]) || text(forecast, ["earningsDate", "earnings_date"]),
          fiscalPeriod: text(forecast, ["fiscalPeriod", "fiscal_period"]),
          revenueModel: num(forecast, ["revenueEstimate", "revenue_estimate"]),
          revenueConsensus: num(consensus, ["revenue", "revenue_consensus"]),
          epsModel: num(forecast, ["epsEstimate", "eps_estimate"]),
          epsConsensus: num(consensus, ["eps", "eps_consensus"]),
        };
      })
      .filter((row) => row.ticker && row.date >= today)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(0, 4);
  }, [forecasts]);

  if (!rows.length) return null;
  return (
    <section className="valuation-shelf valuation-earnings" aria-label="Earnings ahead">
      <div className="valuation-shelf-head">
        <div>
          <span>EARNINGS AHEAD</span>
          <h2>Upcoming events with valuation context</h2>
        </div>
        <p>The pre-earnings valuation gap uses the same cached fair value as the valuation page. Model figures stay separate from consensus.</p>
      </div>
      <ul className="valuation-earnings-list">
        {rows.map((row) => {
          const snapshot = byTicker.get(row.ticker);
          return (
            <li key={`${row.ticker}-${row.date}`}>
              <div className="valuation-earnings-head">
                <strong>{row.ticker}</strong>
                <span>{row.date}{row.fiscalPeriod ? ` · ${row.fiscalPeriod}` : ""}</span>
              </div>
              <dl>
                <div><dt>Price</dt><dd>{money(snapshot?.quote.price ?? null, 0)}</dd></div>
                <div><dt>Fair value</dt><dd>{money(snapshot?.fairValue ?? null, 0)}</dd></div>
                <div><dt>Pre-earnings view</dt><dd>{snapshot?.rating ?? "—"}</dd></div>
                <div><dt>Valuation gap</dt><dd className={tone(snapshot?.upsidePct)}>{signedPct(snapshot?.upsidePct)}</dd></div>
                <div><dt>Revenue model</dt><dd>{compactUsd(row.revenueModel)}</dd></div>
                <div><dt>Consensus</dt><dd>{compactUsd(row.revenueConsensus)}</dd></div>
                <div><dt>EPS model</dt><dd>{row.epsModel === null ? "—" : money(row.epsModel)}</dd></div>
                <div><dt>Consensus</dt><dd>{row.epsConsensus === null ? "—" : money(row.epsConsensus)}</dd></div>
              </dl>
              <Link className="valuation-earnings-link" href={`/fair-value?ticker=${encodeURIComponent(row.ticker)}`}>Open valuation →</Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function ValuationDesk({
  snapshots,
  loading,
  error,
  mostViewedTickers,
  earningsForecasts,
  earningsPriceForecasts,
  tier,
  onOpenValuation,
}: {
  snapshots: InvestmentSnapshot[];
  loading: boolean;
  error: string;
  mostViewedTickers: string[];
  earningsForecasts: Row[];
  earningsPriceForecasts: Row[];
  tier: "FREE" | "PRO";
  onOpenValuation: (ticker: string) => void;
}) {
  const byTicker = useMemo(() => new Map(snapshots.map((snapshot) => [snapshot.ticker, snapshot])), [snapshots]);
  const gaps = useMemo(
    () => [...snapshots].filter((snapshot) => snapshot.upsidePct !== null).sort((left, right) => Math.abs(right.upsidePct!) - Math.abs(left.upsidePct!)).slice(0, 6),
    [snapshots],
  );
  const recent = useMemo(
    () => [...snapshots].sort((left, right) => Date.parse(right.valuationUpdatedAt) - Date.parse(left.valuationUpdatedAt)).slice(0, 6),
    [snapshots],
  );
  // Most viewed is ordered server-side from the persisted view counter; it never
  // triggers an extra valuation or AI call.
  const mostViewed = useMemo(() => {
    const ranked = mostViewedTickers.map((ticker) => byTicker.get(ticker)).filter((snapshot): snapshot is InvestmentSnapshot => Boolean(snapshot));
    const rankedTickers = new Set(ranked.map((snapshot) => snapshot.ticker));
    return [...ranked, ...snapshots.filter((snapshot) => !rankedTickers.has(snapshot.ticker))].slice(0, 6);
  }, [mostViewedTickers, snapshots, byTicker]);
  const union = earningsForecasts.length || earningsPriceForecasts.length
    ? [...earningsForecasts, ...earningsPriceForecasts]
    : [];

  return (
    <section className="valuation-desk" aria-label="Signal Ledger research">
      <LandingHero onSearch={onOpenValuation} />
      <ProductEntries />
      <MembershipLine />
      <TryFree />

      <div className="valuation-cards-head" id="stock-summaries">
        <h2>Explore stock summaries</h2>
        <p>{loading ? "Loading stock summaries…" : error || "Price is what the market pays. Fair value is our model's estimate. Open a stock for its free summary; Pro includes the full analysis."}</p>
      </div>
      {snapshots.length ? (
        <div className="valuation-cards">
          {snapshots.map((snapshot) => <SnapshotCard key={snapshot.ticker} snapshot={snapshot} />)}
        </div>
      ) : (
        <p className="valuation-cards-empty">
          {loading ? "Loading cached valuations…" : "No valuation snapshot is available yet. Search a ticker above to run the engine."}
        </p>
      )}

      <div className="valuation-shelves">
        <Shelf eyebrow="POPULAR" title="Most viewed" description="Companies readers are exploring. Popularity is not a recommendation." snapshots={mostViewed} />
        <Shelf eyebrow="PRICE VS VALUE" title="Largest valuation gaps" description="The largest differences between market price and estimated value. Check confidence before drawing a conclusion." snapshots={gaps} />
        <Shelf eyebrow="RECENT" title="Recent valuation updates" description="The latest available research estimates. Each company shows its own update time." snapshots={recent} />
        <EarningsAhead forecasts={union} byTicker={byTicker} />
      </div>
    </section>
  );
}
