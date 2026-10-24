import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import UniversalValuationWorkstation from "./workstation";
import ValuationTeaser from "./teaser";
import SiteNav from "../site-nav";
import type { UniversalValuationOutput } from "@/lib/universal-valuation";
import { getInvestmentSnapshot } from "@/lib/investment-snapshot";
import { resolveMember } from "@/lib/member-session";
import { isPublicSampleTicker } from "@/lib/public-samples";
import { teaserSnapshot } from "@/lib/valuation-teaser";
import type { ValuationPipelineStage } from "@/lib/valuation-data";
import { isLaunchTicker } from "@/lib/launch-universe";
import { isLocalOwnerPreviewHost } from "@/lib/local-owner-preview";
import { getBindings } from "@/lib/runtime";
import "./fair-value.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Universal Valuation Engine",
  description: "Company-specific valuation routing, market-implied expectations and auditable fair-value distributions.",
};

export default async function FairValuePage({
  searchParams,
}: {
  searchParams: Promise<{ ticker?: string }>;
}) {
  const { ticker } = await searchParams;
  const symbol = (ticker ?? "AMD").trim().toUpperCase();

  // One canonical path: the valuation page reads the same reconciled snapshot
  // that the homepage cards, the earnings desk and the options desk consume.
  // A retired curated-baseline fallback used to fill this in and would have
  // disagreed with every other surface, so an outage now degrades honestly.
  const snapshot = await getInvestmentSnapshot(symbol).catch(() => null);
  const member = await resolveMember();
  const host = (await headers()).get("host");
  const localPreview = isLocalOwnerPreviewHost(host);
  const amd2030Preview = getBindings().AMD_2030_PREVIEW === "1" && /^(?:127\.0\.0\.1|localhost):4175$/.test(host ?? "");
  if (!snapshot) {
    return (
      <main className="uv-app">
        <SiteNav current="/fair-value" member={member} />
        <div className="uv-shell">
          <section className="uv-unavailable" role="status">
            <span className="research-label">NO VERIFIED SNAPSHOT</span>
            <h1>No published estimate for {symbol}</h1>
            <p>
              Signal Ledger publishes an estimate only from its reconciled public snapshot. This security has no
              verified snapshot right now, so nothing is shown rather than a stale or invented number.
            </p>
            <p>The rest of the site is unaffected. Try another ticker, or read a free walkthrough.</p>
            <form className="research-search" action="/fair-value">
              <label htmlFor="uv-missing-ticker">Try another ticker</label>
              <div>
                <input id="uv-missing-ticker" name="ticker" placeholder="Ticker, e.g. MSFT" required maxLength={8} />
                <button type="submit">View free summary</button>
              </div>
            </form>
            <p><Link href="/examples">Read a free walkthrough →</Link></p>
            {isLaunchTicker(symbol) && <p><Link href={`/companies/${symbol.toLowerCase()}`}>View {symbol} business research →</Link></p>}
          </section>
        </div>
      </main>
    );
  }

  const initialData: UniversalValuationOutput & { schema?: string; generatedAt?: string; pipeline?: ValuationPipelineStage[] } = {
    schema: "signal-ledger.valuation.v3",
    generatedAt: snapshot.valuationUpdatedAt,
    pipeline: snapshot.pipeline,
    ...snapshot.output,
  };

  // The two public sample tickers are explicit, narrow exceptions: a FREE reader
  // receives the complete stored valuation for AMD and SPCX so they can see a
  // full PRO analysis end to end. Every other ticker keeps the structural gate.
  const isSample = isPublicSampleTicker(symbol);
  const freeSample = isSample && member.tier !== "PRO" && !localPreview;

  // FREE readers get the teaser summary. The teaser is projected from the full
  // snapshot server-side (`teaserSnapshot`), so the Bear/Base/Bull range, model
  // weights, assumptions and evidence never reach a FREE client — not even in
  // the serialized component payload, because the full object is never passed.
  if (member.tier !== "PRO" && !isSample && !localPreview) {
    return <ValuationTeaser snapshot={teaserSnapshot(snapshot)} member={member} />;
  }

  return <UniversalValuationWorkstation initialData={initialData} member={member} freeSample={freeSample} amd2030Preview={amd2030Preview} />;
}
