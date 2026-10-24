"use client";

import { useEffect, useState } from "react";
import { Sparkline, type HistoryPoint } from "./picks/charts";
import Link from "next/link";
import { formatNav, signedPct } from "@/lib/portfolio-format";
import "./picks/picks.css";

type Summary = {
  slug: string;
  displayName: string;
  inceptionDate: string;
  asOfDate: string;
  nav: number;
  cumulativeReturn: number;
  benchmarkCumulativeReturn: number;
  excessCumulativeReturn: number;
  sparkline: HistoryPoint[];
};

const tone = (value: number) => (value > 0 ? "gain" : value < 0 ? "loss" : "");

/**
 * Homepage module. It reads the cached summary plus a capped sparkline, so the
 * first paint never triggers a full-history portfolio calculation.
 */
export default function PicksPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/portfolios/ny/summary", { headers: { Accept: "application/json" }, cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) setError(typeof body?.error === "string" ? body.error : "Picks are unavailable.");
        else setSummary(body as Summary);
      } catch {
        if (!cancelled) setError("Picks could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel picks-panel" aria-label="Signal Ledger Picks">
      <div className="picks-panel-head">
        <div>
          <span className="picks-eyebrow">SIGNAL LEDGER PICKS</span>
          <h2>Pick-NY</h2>
          <p>New York Model Portfolio · since {summary?.inceptionDate ?? "inception"}</p>
        </div>
        <div className="picks-panel-side">
          {summary ? <Sparkline points={summary.sparkline} /> : null}
          <Link className="button" href="/picks/ny">View Pick-NY →</Link>
        </div>
      </div>

      {loading ? (
        <p className="picks-state">Loading the model portfolio…</p>
      ) : error || !summary ? (
        <p className="picks-state picks-unavailable">{error || "Picks are unavailable."}</p>
      ) : (
        <div className="picks-panel-metrics">
          <div><span>NAV</span><strong>{formatNav(summary.nav)}</strong></div>
          <div><span>Since inception</span><strong className={tone(summary.cumulativeReturn)}>{signedPct(summary.cumulativeReturn)}</strong></div>
          <div><span>S&amp;P 500</span><strong className={tone(summary.benchmarkCumulativeReturn)}>{signedPct(summary.benchmarkCumulativeReturn)}</strong></div>
          <div><span>Excess return</span><strong className={tone(summary.excessCumulativeReturn)}>{signedPct(summary.excessCumulativeReturn)}</strong></div>
        </div>
      )}
    </section>
  );
}
