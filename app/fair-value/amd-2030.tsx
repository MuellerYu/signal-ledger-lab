import { AMD_2025_ANALYST_DAY, AMD_2030_AS_OF, AMD_2030_ASSUMPTIONS, AMD_Q2_2026_FILING, computeAmd2030Case } from "@/lib/amd-2030";
import "./amd-2030.css";

const dollars = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const billions = (value: number, digits = 1) => `$${value.toFixed(digits)}B`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const ratePct = (value: number) => `${(value * 100).toFixed(1)}%`;

export default function Amd2030Research({ currentPrice, priceAsOf, existingFairValue }: {
  currentPrice: number | null;
  priceAsOf: string | null;
  existingFairValue: number | null;
}) {
  const model = computeAmd2030Case(currentPrice);
  const a = AMD_2030_ASSUMPTIONS;
  const q2TotalB = model.rows.reduce((sum, row) => sum + row.q2RevenueB, 0);
  const priceGap = currentPrice === null ? null : (model.end2030PriceUsd / currentPrice - 1) * 100;

  return <section className="amd2030" aria-label="AMD 2030 business and stock research">
    <div className="amd2030-top">
      <div><span className="amd2030-eyebrow">AMD · 2030 WORKING CASE · {AMD_2030_AS_OF}</span>
        <h2>Two forecasts. One visible bridge.</h2>
        <p>Operating output and shipment assumptions come first. Today&apos;s sum-of-the-parts fair value and a conditional 2030 stock-price case are calculated separately.</p></div>
      <span className="amd2030-status">LOCAL PREVIEW · UNAPPROVED RESEARCH CASE</span>
    </div>
    <nav className="amd2030-nav" aria-label="AMD 2030 sections"><a href="#amd2030-business">01 · Fundamentals &amp; shipments</a><a href="#amd2030-value">02 · Fair value &amp; stock price</a></nav>

    <div className="amd2030-section" id="amd2030-business">
      <div className="amd2030-section-head"><div><span className="amd2030-eyebrow">01 / OPERATING CASE</span><h3>What needs to ship by 2030?</h3></div>
        <p>AMD reports Data Center, Client, Gaming and Embedded revenue. It does not report absolute Instinct unit shipments, so the accelerator volume and realized revenue per equivalent unit below are explicit research assumptions.</p></div>
      <div className="amd2030-metrics">
        <article><span>Instinct-equivalent units</span><strong>{a.acceleratorEquivalentUnitsM.toFixed(1)}M</strong><small>2030 analyst assumption; not reported shipments</small></article>
        <article><span>Revenue per equivalent</span><strong>${Math.round(a.acceleratorRevenuePerUnitUsd / 1000)}k</strong><small>Blended 2030 analyst assumption</small></article>
        <article><span>Accelerator revenue</span><strong>{billions(model.acceleratorRevenueB, 0)}</strong><small>Volume × realized revenue; inside Data Center</small></article>
        <article><span>Company revenue</span><strong>{billions(model.revenue2030B, 0)}</strong><small>Sum of four businesses in 2030</small></article>
      </div>
      <div className="amd2030-table-wrap" tabIndex={0}><table><thead><tr><th scope="col">Business</th><th scope="col">Q2 2026 reported</th><th scope="col">Q2 annualized*</th><th scope="col">2030 case</th><th scope="col">2030 FCFF</th><th scope="col">Operating driver</th></tr></thead>
        <tbody>{model.rows.map((row) => <tr key={row.id}><th scope="row">{row.name}</th><td>{billions(row.q2RevenueB, 3)}</td><td>{billions(row.annualizedQ2RevenueB)}</td><td>{billions(row.revenue2030B)}</td><td>{billions(row.fcff2030B)}</td><td>{row.driver}</td></tr>)}</tbody>
        <tfoot><tr><th scope="row">Total</th><td>{billions(q2TotalB, 3)}</td><td>{billions(q2TotalB * 4)}</td><td>{billions(model.revenue2030B)}</td><td>{billions(model.fcff2030B)}</td><td>2030 revenue and cash flow are model estimates</td></tr></tfoot></table></div>
      <p className="amd2030-note">* Four times Q2 is a scale reference, not AMD&apos;s FY2026 forecast. Data Center&apos;s {billions(model.rows[0].revenue2030B, 0)} consists of {billions(model.acceleratorRevenueB, 0)} modeled accelerator revenue plus {billions(a.dataCenterOtherRevenueB, 0)} modeled EPYC, networking and other revenue; the accelerator line is counted only once. Cash-flow margins, including {pct(model.rows[0].terminalFcffMargin)} for Data Center, are analyst assumptions after allocated central costs. No absolute EPYC or Ryzen shipment count is claimed.</p>
      <p className="amd2030-source">Reported Q2 segment revenue: <a href={AMD_Q2_2026_FILING} target="_blank" rel="noreferrer">AMD 10-Q, filed Aug 5, 2026 ↗</a>. Management&apos;s multiyear targets of &gt;35% company revenue CAGR and &gt;60% Data Center CAGR are ambition and context, not reported 2030 results: <a href={AMD_2025_ANALYST_DAY} target="_blank" rel="noreferrer">AMD Financial Analyst Day ↗</a>.</p>
    </div>

    <div className="amd2030-section" id="amd2030-value">
      <div className="amd2030-section-head"><div><span className="amd2030-eyebrow">02 / VALUATION &amp; PRICE</span><h3>What is that business worth today, and what could the stock trade at in 2030?</h3></div>
        <p>The first number discounts each business&apos;s 2027–2030 cash flow and terminal value to today. The second applies a stated 2030 market multiple. They answer different questions and are never added together.</p></div>
      <div className="amd2030-value-grid">
        <article className="amd2030-value-card"><span>SUM-OF-THE-PARTS · VALUE TODAY</span><strong>{dollars(model.fairValueNowUsd)}<small> / share</small></strong><p>{billions(model.enterpriseValueNowB)} discounted business value + {billions(model.reported.netCashB)} reported net cash, divided by {model.reported.dilutedSharesB.toFixed(3)}B reported Q2 diluted shares.</p></article>
        <article className="amd2030-value-card amd2030-stock-card"><span>2030 STOCK CASE · CONDITIONAL</span><strong>{dollars(model.end2030PriceUsd)}<small> / share</small></strong><p>{billions(model.fcff2030B)} modeled 2030 FCFF × {a.exitEvFcfMultiple}× EV/FCFF, plus net cash held constant, divided by {a.end2030SharesB.toFixed(2)}B assumed 2030 shares.</p></article>
      </div>
      <div className="amd2030-table-wrap" tabIndex={0}><table><thead><tr><th scope="col">Business</th><th scope="col">2030 FCFF margin</th><th scope="col">2027–2030 FCFF PV</th><th scope="col">Terminal PV</th><th scope="col">Value today</th><th scope="col">Per share</th></tr></thead>
        <tbody>{model.rows.map((row) => <tr key={row.id}><th scope="row">{row.name}</th><td>{pct(row.terminalFcffMargin)}</td><td>{billions(row.interimValueB)}</td><td>{billions(row.terminalValueB)}</td><td>{billions(row.presentValueB)}</td><td>{dollars(row.perShareUsd)}</td></tr>)}</tbody>
        <tfoot><tr><th scope="row">Businesses + net cash</th><td>{ratePct(a.wacc)} WACC / {ratePct(a.terminalGrowth)} terminal growth</td><td colSpan={2}>Net cash +{billions(model.reported.netCashB)}</td><td>{billions(model.equityValueNowB)}</td><td>{dollars(model.fairValueNowUsd)}</td></tr></tfoot></table></div>
      <div className="amd2030-price-read">
        <div><span>MARKET REFERENCE</span><strong>{currentPrice === null ? "Unavailable" : dollars(currentPrice)}</strong><small>{priceAsOf ?? "Price timestamp unavailable"}</small></div>
        <div><span>2030 CASE VS. REFERENCE</span><strong>{priceGap === null ? "—" : `${priceGap >= 0 ? "+" : ""}${priceGap.toFixed(1)}%`}</strong><small>Cumulative price difference; not an annual return forecast</small></div>
        <div><span>10% ANNUAL RETURN HURDLE</span><strong>{model.hurdleMultiple === null ? "—" : `${model.hurdleMultiple.toFixed(1)}×`}</strong><small>2030 EV/FCFF needed at the current price, with {a.end2030SharesB.toFixed(2)}B shares</small></div>
      </div>
      <div className="amd2030-exits"><h4>2030 price sensitivity · same operating case</h4><div>{model.exitPrices.map((item) => <article key={item.multiple}><span>{item.multiple}× EV / FCFF</span><strong>{dollars(item.priceUsd)}</strong></article>)}</div></div>
      <p className="amd2030-note">The separate reported-evidence engine currently displays {existingFairValue === null ? "no fair value" : dollars(existingFairValue)} per share. This higher-growth 2030 case assumes {billions(model.fcff2030B)} annual FCFF; its operating path and valuation method differ from the current engine, so the two values should not be blended. A full vesting of the two customer warrant programs could add up to 320M shares; holding business value fixed would reduce this case&apos;s value today to {dollars(model.fullWarrantFairValueUsd)} per share. Vesting depends on purchase and stock-price/performance milestones, so neither zero nor full vesting is a reported 2030 share count.</p>
      <p className="amd2030-method">Method: 2027–2030 business revenue interpolates from Q2 2026 annualized scale to the 2030 assumptions; cash-flow margins follow a stated model path. Each business&apos;s FCFF and 2031 growing-perpetuity value are discounted at {ratePct(a.wacc)}; terminal growth is {ratePct(a.terminalGrowth)}. Net cash is added once as a simplifying assumption. The 2030 stock case holds net cash constant and uses an assumed share count and exit multiple; it does not model buybacks, interim distributions, warrant vesting timing, a full stock-compensation bridge or market sentiment. These gaps keep the case at screening grade.</p>
      <p className="amd2030-source">Cash, debt, diluted shares and customer warrants: <a href={AMD_Q2_2026_FILING} target="_blank" rel="noreferrer">AMD Q2 2026 10-Q ↗</a>. Discount rate and terminal growth are research assumptions; AMD does not disclose its own WACC or a 2030 share price.</p>
    </div>
  </section>;
}
