import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import SiteNav from "../../site-nav";
import { resolveMember } from "@/lib/member-session";
import { isLaunchTicker, LAUNCH_TICKERS } from "@/lib/launch-universe";
import { loadCompanyBusinessEvidence, loadPublishedOwnerForecast } from "@/lib/owner-forecast-store";
import { peekInvestmentSnapshot } from "@/lib/investment-snapshot";
import { isLocalOwnerPreviewHost } from "@/lib/local-owner-preview";
import "./research.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company Research | Signal Ledger", description: "Company-level, source-linked business forecast scenarios." };

const money = (value: number) => `$${value.toFixed(2)}`;
const billions = (value: number) => `$${value.toFixed(3)}B`;
const readableExcerpt = (value: string) => value.replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, encoded: string) => {
  const codePoint = encoded[0].toLowerCase() === "x" ? Number.parseInt(encoded.slice(1), 16) : Number(encoded);
  return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff &&
    !(codePoint >= 0xd800 && codePoint <= 0xdfff) ? String.fromCodePoint(codePoint) : entity;
});

export default async function CompanyResearchPage({ params }: { params: Promise<{ ticker: string }> }) {
  const ticker = (await params).ticker.toUpperCase();
  if (!isLaunchTicker(ticker)) notFound();
  const member = await resolveMember();
  const localPreview = isLocalOwnerPreviewHost((await headers()).get("host"));
  const [publication, latestEvidence, snapshot] = await Promise.all([
    loadPublishedOwnerForecast(ticker), loadCompanyBusinessEvidence(ticker),
    localPreview ? peekInvestmentSnapshot(ticker) : Promise.resolve(null),
  ]);
  return <><SiteNav current="/fair-value" member={member} /><main className="co-page">
    <div className="co-top"><Link href="/companies">← All 20 companies</Link><Link href={`/fair-value?ticker=${encodeURIComponent(ticker)}`}>Valuation workstation ↗</Link></div>
    <nav className="co-coverage" aria-label="Company coverage">{LAUNCH_TICKERS.map((symbol) => <Link key={symbol}
      href={`/companies/${symbol.toLowerCase()}`} aria-current={symbol === ticker ? "page" : undefined}>{symbol}</Link>)}</nav>
    {localPreview && <section className="co-card co-local-valuation"><div><span className="co-kicker">EXISTING VALUATION ENGINE · LOCAL REVIEW</span>
      <h2>{ticker} valuation status</h2><p>This is the existing engine snapshot; the editable business-tree scenario is separately labelled below.</p></div>
      {snapshot?.fairValue !== null && snapshot?.fairValue !== undefined ? <div className="co-local-metrics">
        <div><span>Fair value</span><strong>{money(snapshot.fairValue)}</strong></div>
        <div><span>Market price</span><strong>{snapshot.quote.price === null ? "Unavailable" : money(snapshot.quote.price)}</strong></div>
        <div><span>Upside / downside</span><strong>{snapshot.upsidePct === null ? "Unavailable" : `${snapshot.upsidePct >= 0 ? "+" : ""}${snapshot.upsidePct.toFixed(1)}%`}</strong></div>
        <div><span>Rating & evidence</span><strong>{snapshot.rating}</strong><small>{snapshot.statusLabel.replaceAll("_", " ")} · {snapshot.valuationUpdatedAt.slice(0, 10)}</small></div>
      </div> : <p>Not decision-ready: the existing engine has not released a fair value for this ticker. <Link href={`/fair-value?ticker=${ticker}`}>Open valuation ↗</Link></p>}
      <div className="co-local-links"><Link href={`/fair-value?ticker=${ticker}`}>Open full valuation ↗</Link><Link href={`/owner/valuation?ticker=${ticker}`}>Edit business forecast tree ↗</Link></div>
    </section>}
    {!publication ? <><section className="co-unavailable"><h1>{latestEvidence?.issuerName ?? ticker}</h1><span className="co-kicker">{ticker} · FORECAST NOT PUBLISHED</span>
      <p>Financial statement evidence refreshes automatically. A business forecast appears here after the owner publishes a checked scenario.</p></section>
      {latestEvidence?.evidence.status === "verified" && <><section className="co-source"><div><span className="co-kicker">LATEST VERIFIED SEC REVENUE</span>
        <strong>{billions(latestEvidence.evidence.consolidatedRevenueB!)}</strong><span>Period ended {latestEvidence.evidence.periodEnd}</span></div>
        <div><span className="co-kicker">SOURCE</span><strong>{latestEvidence.evidence.kind?.replaceAll("_", " ")}</strong>
          <a href={latestEvidence.evidence.sourceUrl!} target="_blank" rel="noreferrer">SEC filing · {latestEvidence.evidence.accessionNumber} ↗</a></div></section>
        <section className="co-card"><span className="co-kicker">REPORTED BUSINESS VIEW</span><h2>Revenue by business</h2>
          <div className="co-tree">{latestEvidence.evidence.businesses.map((row) => <article className="co-node" key={row.name}>
            <div><span className="co-kicker">{row.basis === "derived" ? "RECONCILED DERIVATION" : "SEC REPORTED"}</span>
              <h3>{row.name}</h3><details className="co-excerpt"><summary>View SEC table excerpt</summary><p>{readableExcerpt(row.sourceExcerpt)}</p></details></div><strong>{billions(row.revenueB)}</strong></article>)}</div>
          <p className="co-method">Checked against consolidated revenue in the same SEC filing. Last collected {new Date(latestEvidence.fetchedAt).toISOString().slice(0, 10)}.</p>
        </section></>}
      {latestEvidence && latestEvidence.evidence.status !== "verified" && <section className="co-card"><span className="co-kicker">BUSINESS SPLIT PENDING</span>
        <p>{latestEvidence.evidence.reason}</p></section>}</> : <>
      <header className="co-hero"><div><span className="co-kicker">PUBLISHED OWNER SCENARIO · {ticker}</span>
        <h1>{publication.tree.issuerName}</h1><p>Business-level assumptions with an SEC revenue anchor and an explicit terminal P/E method.</p></div>
        <div className="co-value"><span>Scenario value per share</span><strong>{money(publication.result.perShareUsd!)}</strong>
          <small>Published {new Date(publication.publishedAt).toISOString().slice(0, 10)} · version {publication.revision}</small></div></header>
      <section className="co-source"><div><span className="co-kicker">SEC REPORTED ANCHOR</span><strong>{billions(publication.tree.source.consolidatedRevenueB)}</strong>
        <span>{publication.tree.source.periodForm} revenue for period ended {publication.tree.source.periodEnd}</span></div>
        <div><span className="co-kicker">BUSINESS VIEW</span><strong>{publication.tree.source.businessKind.replaceAll("_", " ")}</strong>
          <a href={publication.tree.source.url} target="_blank" rel="noreferrer">Primary filing · {publication.tree.source.accessionNumber} ↗</a></div></section>
      {latestEvidence?.evidence.accessionNumber && latestEvidence.evidence.accessionNumber !== publication.tree.source.accessionNumber &&
        <section className="co-card"><span className="co-kicker">NEWER SEC REPORT AVAILABLE</span>
          <p>The business forecast above remains the published {publication.tree.source.periodEnd} scenario. A newer filing has been collected; its business split is {latestEvidence.evidence.status}. The owner forecast has not yet been revised.</p>
          {latestEvidence.evidence.sourceUrl && <a href={latestEvidence.evidence.sourceUrl} target="_blank" rel="noreferrer">Read newer SEC filing ↗</a>}</section>}
      <section className="co-card"><span className="co-kicker">BUSINESS TREE</span><h2>What drives the scenario</h2>
        <div className="co-tree">{publication.tree.businesses.map((node) => {
          const childCount = publication.tree.businesses.filter((child) => child.parentId === node.id).length;
          let depth = 0; let parent = node.parentId;
          while (parent && depth < 5) { depth += 1; parent = publication.tree.businesses.find((item) => item.id === parent)?.parentId ?? null; }
          const forecast = publication.result.rows.find((row) => row.id === node.id);
          return <article className="co-node" key={node.id} style={{ marginLeft: `${depth * 22}px` }}><div><span className="co-kicker">{childCount ? "BUSINESS GROUP" : node.basis === "reported" ? "SEC REPORTED" : node.basis === "derived" ? "RECONCILED DERIVATION" : "OWNER ANALYTICAL SPLIT"}</span>
            <h3>{node.name}</h3><p>Reported-period revenue {billions(node.baseRevenueB)}{node.note ? ` · ${node.note}` : ""}</p></div>
            {forecast && <div className="co-node-metrics"><span>Final-year revenue <b>{billions(forecast.revenueByYearB.at(-1)!)}</b></span>
              <span>Net margin <b>{((node.netMargin ?? 0) * 100).toFixed(1)}%</b></span><span>P/E <b>{node.pe?.toFixed(1)}×</b></span>
              <span>Present value <b>{billions(forecast.presentValueB)}</b></span></div>}</article>;
        })}</div></section>
      <section className="co-card"><span className="co-kicker">CALCULATION</span><h2>From business assumptions to per-share value</h2>
        <div className="co-equation"><div><span>Business terminal earnings × P/E</span><strong>{billions(publication.result.rows.reduce((sum, row) => sum + row.terminalEquityB, 0))}</strong></div>
          <div><span>Discounted business value</span><strong>{billions(publication.result.rows.reduce((sum, row) => sum + row.presentValueB, 0))}</strong></div>
          <div><span>Current net cash / (debt)</span><strong>{billions(publication.tree.netCashB!)}</strong></div>
          <div><span>Diluted shares</span><strong>{publication.tree.dilutedSharesB!.toFixed(3)}B</strong></div></div>
        <p className="co-method">Forecast horizon {publication.tree.horizonYears} year(s); reported-period to annual factor {publication.tree.annualizationFactor}×; discount rate {(publication.tree.discountRate! * 100).toFixed(1)}%. This is a conditional terminal P/E scenario based on owner assumptions. It excludes interim cash flows and is separate from the AI baseline and the site’s other valuation models.</p></section>
    </>}
  </main></>;
}
