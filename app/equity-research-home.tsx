"use client";

import { useMemo } from "react";
import "./equity-research-home.css";

type Row = Record<string, unknown>;

function text(row: Row | undefined, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function number(row: Row | undefined, keys: string[]) {
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

/**
 * Research record only. The homepage hero, coverage cards and dynamic shelves
 * are owned by the valuation desk, so this section never duplicates fair value
 * and never hardcodes a single issuer as the primary homepage item.
 */
export default function EquityResearchHome({
  latestQuotes,
  earningsPriceForecasts,
}: {
  latestQuotes: Row[];
  earningsPriceForecasts: Row[];
}) {
  const record = useMemo(() => {
    const resolved = earningsPriceForecasts.filter((row) => text(row, ["status"]).toLowerCase() === "resolved");
    const directionHits = resolved.filter((row) => row.directionHit === true || row.direction_hit === true).length;
    const errored = resolved
      .map((row) => ({
        ticker: text(row, ["ticker", "symbol"]).toUpperCase(),
        error: number(row, ["priceErrorPct", "price_error_pct"]),
      }))
      .filter((row) => row.ticker && row.error !== null)
      .sort((left, right) => Math.abs(left.error!) - Math.abs(right.error!));
    const medianError = errored.length ? errored[Math.floor(errored.length / 2)].error : null;
    const tracked = new Set([
      ...earningsPriceForecasts.map((row) => text(row, ["ticker", "symbol"]).toUpperCase()),
      ...latestQuotes.map((row) => text(row, ["ticker", "symbol"]).toUpperCase()),
    ].filter(Boolean));
    return { resolved: resolved.length, directionHits, medianError, tracked: [...tracked].sort() };
  }, [earningsPriceForecasts, latestQuotes]);

  return (
    <section className="equity-research-home" aria-labelledby="equity-home-title">
      <div className="research-home-lower">
        <section className="latest-research" aria-labelledby="latest-research-title">
          <div className="research-section-heading">
            <div>
              <span>RESEARCH RECORD</span>
              <h2 id="latest-research-title">Every published view stays on the record</h2>
            </div>
            <p>Forecasts are frozen before the event and graded afterwards. Open calls and repeated observations never count as wins.</p>
          </div>
          <article>
            <time>METHOD</time>
            <h3>Valuation first, then the event call</h3>
            <p>
              Company valuations run through the company-specific model router on the valuation page. Earnings and event records below are stored separately,
              so a price-reaction call is never relabeled as a fair value or a 12-month target.
            </p>
          </article>
          <article>
            <time>TRACKED NAMES</time>
            <h3>{record.tracked.length ? record.tracked.join(" · ") : "Coverage follows the live research feed"}</h3>
            <p>
              Names appear here only when the feed contains a real quote or a recorded earnings forecast. Search any U.S. ticker in the valuation engine above to
              run a company-specific model outside this list.
            </p>
          </article>
        </section>
        <aside className="research-track-record" aria-labelledby="track-record-title">
          <span>RESEARCH TRACK RECORD</span>
          <h2 id="track-record-title">Evidence before claims</h2>
          <dl>
            <div><dt>Resolved price forecasts</dt><dd>{record.resolved}</dd></div>
            <div><dt>Direction results</dt><dd>{record.resolved ? `${record.directionHits}/${record.resolved}` : "Not enough data"}</dd></div>
            <div><dt>Median absolute target error</dt><dd>{record.medianError === null ? "Not enough data" : `${Math.abs(record.medianError).toFixed(1)}%`}</dd></div>
            <div><dt>Live quotes in feed</dt><dd>{latestQuotes.length}</dd></div>
          </dl>
          <p>
            Track-record statistics use only completed, independently settled forecasts. A settled result is published even when the call was wrong, and no sample
            data is substituted for a missing live value.
          </p>
        </aside>
      </div>
    </section>
  );
}
