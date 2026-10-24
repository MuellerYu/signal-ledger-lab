import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import SiteNav from "../site-nav";
import { resolveMember } from "@/lib/member-session";
import { LAUNCH_TICKERS } from "@/lib/launch-universe";
import { loadCompanyBusinessEvidenceBatch } from "@/lib/owner-forecast-store";
import { peekInvestmentSnapshot } from "@/lib/investment-snapshot";
import { isLocalOwnerPreviewHost } from "@/lib/local-owner-preview";
import "./[ticker]/research.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Company Coverage | Signal Ledger", description: "Source-linked business revenue and valuation status for the launch coverage universe." };

const billions = (value: number) => `$${value.toFixed(value < 0.01 ? 4 : 2)}B`;
const dollars = (value: number) => `$${value.toFixed(2)}`;

export default async function CompaniesPage() {
  const localPreview = isLocalOwnerPreviewHost((await headers()).get("host"));
  const [member, evidence, snapshots] = await Promise.all([
    resolveMember(), loadCompanyBusinessEvidenceBatch(LAUNCH_TICKERS),
    localPreview ? Promise.all(LAUNCH_TICKERS.map((ticker) => peekInvestmentSnapshot(ticker))) : Promise.resolve(LAUNCH_TICKERS.map(() => null)),
  ]);
  const verified = LAUNCH_TICKERS.filter((ticker) => evidence.get(ticker)?.evidence.status === "verified").length;
  const valued = snapshots.filter((snapshot) => snapshot?.fairValue !== null && snapshot?.fairValue !== undefined).length;

  return <><SiteNav current="/companies" member={member} /><main className="co-page co-index">
    <header className="co-index-head"><div><span className="co-kicker">SIGNAL LEDGER · COMPANY COVERAGE</span>
      <h1>Twenty companies, business by business.</h1><p>SEC-reported revenue trees and the existing valuation engine in one review shelf. Reported figures, model estimates and owner scenarios remain distinct.</p></div>
      <aside><strong>{verified}/20</strong><span>SEC revenue splits verified in this local data store</span>
        {localPreview && <small>{valued}/20 valuation snapshots available</small>}</aside></header>
    {localPreview && <div className="co-index-actions"><Link href="/owner/valuation">Open editable forecast trees ↗</Link><span>Local review workspace · changes stay on this computer</span></div>}
    <div className="co-company-grid">{LAUNCH_TICKERS.map((ticker, index) => {
      const row = evidence.get(ticker);
      const reported = row?.evidence.status === "verified" ? row.evidence : null;
      const snapshot = snapshots[index];
      return <article className="co-company" key={ticker}><div className="co-company-head"><div><span className="co-kicker">{String(index + 1).padStart(2, "0")} · {ticker}</span>
        <h2>{row?.issuerName ?? ticker}</h2></div><Link href={`/companies/${ticker.toLowerCase()}`}>Company page ↗</Link></div>
        {reported ? <><div className="co-company-source"><span>{reported.periodForm} · {reported.periodEnd}</span><strong>{billions(reported.consolidatedRevenueB!)}</strong>
          <a href={reported.sourceUrl!} target="_blank" rel="noreferrer">SEC filing ↗</a></div>
          <div className="co-mini-tree">{reported.businesses.map((business) => {
            const share = Math.max(1, Math.min(100, business.revenueB / reported.consolidatedRevenueB! * 100));
            return <div className="co-mini-node" key={business.name}><div><span>{business.name}{business.basis === "derived" ? " · derived" : ""}</span><b>{billions(business.revenueB)}</b></div>
              <i style={{ width: `${share}%` }} /></div>;
          })}</div></> : <div className="co-company-pending">{row ? row.evidence.reason : "SEC business evidence has not yet been collected in this local workspace."}</div>}
        <div className="co-company-value"><span>Existing valuation engine</span>{localPreview && snapshot?.fairValue !== null && snapshot?.fairValue !== undefined
          ? <><strong>{dollars(snapshot.fairValue)} <small>per share</small></strong><p>{snapshot.statusLabel.replaceAll("_", " ")} · {snapshot.rating} · price {snapshot.quote.price === null ? "unavailable" : dollars(snapshot.quote.price)}</p>
            <small>Model {snapshot.valuationUpdatedAt.slice(0, 10)} · quote {snapshot.quote.asOf ?? "time unavailable"}</small></>
          : <p>{localPreview ? "Not decision-ready: the existing engine has not released a fair value for this ticker." : "Open the valuation workstation for its current publication status."}</p>}</div>
        <div className="co-company-links"><Link href={`/fair-value?ticker=${ticker}`}>Valuation detail ↗</Link>
          {localPreview && <Link href={`/owner/valuation?ticker=${ticker}`}>Edit business tree ↗</Link>}</div>
      </article>;
    })}</div>
  </main></>;
}
