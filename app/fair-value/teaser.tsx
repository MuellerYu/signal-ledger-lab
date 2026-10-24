import type { MemberState } from "@/lib/member-session";
import Link from "next/link";
import { isLaunchTicker } from "@/lib/launch-universe";
import type { TeaserSnapshot } from "@/lib/valuation-teaser";
import SiteNav from "../site-nav";
import ProAccessPanel from "../pro-access-panel";
import Disclaimer from "../disclaimer";
import { FreeExamples, ResearchGuide } from "../research-guide";

const money = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

const signedPct = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

/**
 * The FREE fair-value summary. It renders only the fields a free reader may see
 * — ticker, current price, fair value, rating and upside — and then a single
 * PRO lock for the rest. The Bear/Base/Bull range, model weights, assumptions,
 * market-implied expectations and valuation history are never placed in this
 * component (or its HTML), so there is nothing to blur or hide.
 */
export default function ValuationTeaser({
  snapshot,
  member,
}: {
  snapshot: TeaserSnapshot;
  member: MemberState;
}) {
  const rating = snapshot.ratingLabel ?? snapshot.rating ?? "—";
  const price = snapshot.marketPrice ?? snapshot.quote?.price ?? null;
  const priceAsOf = snapshot.marketPriceTimestamp ?? snapshot.quote?.asOf ?? null;
  const priceSource = snapshot.quote?.source ?? "Signal Ledger market data";

  return (
    <main className="uv-app">
      <SiteNav current="/fair-value" member={member} />

      <div className="uv-shell">
        {isLaunchTicker(snapshot.ticker) && <p className="uv-provenance"><Link href={`/companies/${snapshot.ticker.toLowerCase()}`}>View {snapshot.ticker} business research →</Link></p>}
        <form className="research-search" action="/fair-value"><label htmlFor="summary-ticker">Look up another stock</label><div><input id="summary-ticker" name="ticker" placeholder="Ticker, e.g. MSFT" required maxLength={8} /><button type="submit">View free summary</button></div></form>
        <section className="uv-teaser" aria-label="Fair value summary">
          <div className="uv-teaser-head">
            <div>
              <span className="uv-teaser-ticker">{snapshot.ticker}</span>
              <h1>{snapshot.company}</h1>
              {snapshot.sector ? <p className="uv-teaser-sector">{snapshot.sector}</p> : null}
            </div>
            <span className="uv-teaser-free-tag">FREE</span>
          </div>

          <dl className="uv-teaser-grid">
            <div><dt>Current price</dt><dd>{money(price)}</dd><small>{priceSource}{priceAsOf ? ` · ${priceAsOf}` : ""}</small></div>
            <div><dt>Signal Ledger fair value</dt><dd>{money(snapshot.fairValue, 0)}</dd><small>Estimated value per share, not a price guarantee</small></div>
            <div><dt>Rating</dt><dd className={`uv-teaser-rating uv-rating-${String(rating).toLowerCase().replaceAll(" ", "-")}`}>{rating}</dd><small>{signedPct(snapshot.upsidePct)} to fair value</small></div>
            <div><dt>Confidence</dt><dd>{snapshot.fairValue === null ? "—" : `${Math.round(snapshot.confidence * 100)}%`}</dd><small>{snapshot.confidenceLabel ?? ""}</small></div>
          </dl>
        </section>

        <ResearchGuide />
        <FreeExamples />

        <ProAccessPanel
          kicker="SIGNAL LEDGER PRO"
          title={`Why is ${snapshot.ticker} worth this?`}
          description="Your summary above is free. Pro opens this company's scenarios, assumptions, valuation methods and supporting evidence so you can assess the reasoning. The free walkthroughs show how to read that research before you subscribe."
          features={[
            "Bear / Base / Bull scenario range",
            "Model weights and valuation methods",
            "DCF and relative valuation detail",
            "Market-implied expectations",
            "Key assumptions and drivers",
            "Supporting evidence",
            "Valuation history",
          ]}
          cta="COMPARE FREE & PRO"
          href="/pricing"
        />

        <Disclaimer className="uv-teaser-disclaimer" />
      </div>
    </main>
  );
}
