import { PORTFOLIO_INDEX, isKnownPortfolio } from "@/lib/pick-ny";
import { getPortfolioHistory, getPortfolioHoldings, getPortfolioSummary } from "@/lib/pick-ny-store";
import { resolveMember, type MemberState } from "@/lib/member-session";
import SiteNav from "../../site-nav";
import PortfolioView, { type PortfolioHolding } from "./portfolio-view";
import "../picks.css";

export const dynamic = "force-dynamic";

function Holder({ slug, member }: { slug: string; member: MemberState }) {
  return (
    <div className="picks-page">
      <SiteNav current="/picks" member={member} />
      <section className="panel picks-section">
        <h1>No published portfolio for “{slug}”</h1>
        <p className="picks-unavailable">
          Signal Ledger Picks currently publishes {PORTFOLIO_INDEX.map((entry) => entry.slug.toUpperCase()).join(", ")}.
        </p>
      </section>
    </div>
  );
}

function Unavailable({ message, code, member }: { message: string; code: string; member: MemberState }) {
  return (
    <div className="picks-page">
      <SiteNav current="/picks" member={member} />
      <section className="panel picks-section">
        <h1>Pick-NY is unavailable</h1>
        <p className="picks-unavailable">
          {message}
          <small>
            The portfolio is published only when real adjusted closes are available. It shows nothing rather than a
            fabricated NAV. ({code})
          </small>
        </p>
      </section>
    </div>
  );
}

export default async function PortfolioPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const member = await resolveMember();
  const key = slug.toLowerCase();
  if (!isKnownPortfolio(key)) return <Holder slug={key} member={member} />;

  const entry = PORTFOLIO_INDEX.find((candidate) => candidate.slug === key)!;
  const summary = await getPortfolioSummary(key);
  if (!summary.ok) return <Unavailable message={summary.error} code={summary.code} member={member} />;

  // Holdings and attribution are PRO-only. For FREE we do not fetch them, so
  // the position weights, contribution and Signal Ledger fair values never
  // reach the free client (they are not rendered server-side either).
  const history = await getPortfolioHistory(key, "SI");
  const holdings = member.tier === "PRO" ? await getPortfolioHoldings(key) : null;

  const holdingRows: PortfolioHolding[] = holdings?.ok ? holdings.value : [];
  const contributions: PortfolioHolding[] = holdingRows;

  return (
    <PortfolioView
      member={member}
      summary={{
        slug: key,
        displayName: summary.value.displayName,
        subtitle: entry.subtitle,
        status: summary.value.status,
        inceptionDate: summary.value.inceptionDate,
        asOfDate: summary.value.asOfDate,
        sessions: summary.value.sessions,
        nav: summary.value.nav,
        cumulativeReturn: summary.value.cumulativeReturn,
        benchmarkLabel: summary.value.benchmarkLabel,
        benchmarkNav: summary.value.benchmarkNav,
        benchmarkCumulativeReturn: summary.value.benchmarkCumulativeReturn,
        excessCumulativeReturn: summary.value.excessCumulativeReturn,
        currentDrawdown: summary.value.currentDrawdown,
        maxDrawdown: summary.value.maxDrawdown,
        maxDrawdownDate: summary.value.maxDrawdownDate,
        volatility: summary.value.volatility,
        methodologyVersion: summary.value.methodologyVersion,
        priceSource: summary.value.priceSource,
        priceDataAsOf: summary.value.priceDataAsOf,
        lastRebalanceDate: summary.value.lastRebalanceDate,
        rebalanceCount: summary.value.rebalanceCount,
        persisted: summary.value.persisted,
        disclosure: summary.value.disclosure,
      }}
      history={history.ok ? history.value : []}
      holdings={holdingRows}
      contributions={contributions}
    />
  );
}
