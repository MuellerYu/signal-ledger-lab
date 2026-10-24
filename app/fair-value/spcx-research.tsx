"use client";

import { useState } from "react";
import type { SpcxValuation } from "@/lib/spcx-valuation";

/**
 * The public SPCX research page.
 *
 * Seven blocks, in reading order: what the company is worth, where that value
 * comes from, the three cases, what the market price requires, the operating
 * forecast, Starship, and the risks. Everything technical lives in the
 * collapsed Advanced section rendered by the caller.
 */

const money = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value.toFixed(digits)}`;
const billions = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value.toFixed(digits)}B`;
const percent = (value: number | null | undefined, digits = 0, signed = false) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : `${signed && value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;

const COMPONENT_ORDER = ["AI", "Connectivity", "Starship", "Net cash", "Other optionality", "Space Core"] as const;

type Segment = "AI" | "Connectivity" | "Space";

const FORECAST_ROWS: Record<Segment, Array<{ label: string; value: (row: SpcxValuation["forecast"][number]) => string }>> = {
  AI: [
    { label: "Revenue", value: (row) => billions(row.aiRevenue) },
    { label: "EBITDA", value: (row) => billions(row.aiEbitda) },
    { label: "EBITDA margin", value: (row) => percent(row.aiEbitdaMargin, 0) },
    { label: "Capex", value: (row) => billions(row.aiCapex) },
    { label: "Capacity", value: (row) => (row.aiCapacityGw === undefined ? "—" : `${row.aiCapacityGw.toFixed(1)} GW`) },
    { label: "Utilisation", value: (row) => percent(row.aiUtilisation, 0) },
  ],
  Connectivity: [
    { label: "Revenue", value: (row) => billions(row.connectivityRevenue) },
    { label: "EBITDA", value: (row) => billions(row.connectivityEbitda) },
    { label: "EBITDA margin", value: (row) => percent(row.connectivityRevenue > 0 ? row.connectivityEbitda / row.connectivityRevenue : null, 0) },
    { label: "Capex (fleet share)", value: (row) => billions(row.capex * 0.6) },
  ],
  Space: [
    { label: "Revenue", value: (row) => billions(row.spaceRevenue) },
    { label: "EBITDA", value: (row) => billions(row.spaceEbitda) },
    { label: "EBITDA margin", value: (row) => percent(row.spaceRevenue > 0 ? row.spaceEbitda / row.spaceRevenue : null, 0) },
    { label: "Capex (launch share)", value: (row) => billions(row.capex * 0.4) },
  ],
};

export default function SpcxResearchPage({
  spcx,
  currentPrice,
  confidence,
  rating,
  baseFairValue,
}: {
  spcx: SpcxValuation;
  currentPrice: number | null;
  confidence: number;
  rating: string;
  baseFairValue: number | null;
}) {
  const [segment, setSegment] = useState<Segment>("AI");

  const base = spcx.cases.find((item) => item.name === "BASE EXECUTION CASE") ?? spcx.cases.find((item) => item.published);
  const core = spcx.cases.find((item) => item.name === "CORE CASE");
  const vision = spcx.cases.find((item) => item.name === "VISION CASE");
  const fairValue = baseFairValue ?? spcx.fairValue;
  const gap = currentPrice !== null && fairValue !== null ? fairValue / currentPrice - 1 : null;

  const contributions = COMPONENT_ORDER.map((name, index) => {
    const row = spcx.valuationContribution.find((item) => item.component === name);
    return { name, perShare: row?.perShare ?? 0, valueB: row?.valueB ?? 0, tone: index };
  }).filter((item) => item.perShare !== 0);
  const contributionTotal = contributions.reduce((sum, item) => sum + Math.max(0, item.perShare), 0);

  const anchor = spcx.forecast[2];
  const aiAnchorMultiple = spcx.segments.find((item) => item.segment === "AI")?.anchorMultiple2028 ?? null;
  const implied = spcx.marketImplied;

  const marketRows = [
    { metric: "2028E AI revenue", base: billions(anchor?.aiRevenue), market: billions(implied.requiredAi2028RevenueB) },
    { metric: "2028E AI EBITDA margin", base: percent(anchor?.aiEbitdaMargin, 0), market: percent(implied.requiredAi2028EbitdaMargin, 0) },
    { metric: "2028E Connectivity revenue", base: billions(anchor?.connectivityRevenue), market: billions(implied.requiredConnectivity2028RevenueB) },
    { metric: "Starship expected value", base: billions(spcx.starship.expectedValueB), market: billions(implied.requiredStarshipExpectedB) },
    { metric: "AI EV / 2028E EBITDA", base: aiAnchorMultiple === null ? "—" : `${aiAnchorMultiple.toFixed(0)}×`, market: implied.requiredAi2028Multiple === null ? "—" : `${implied.requiredAi2028Multiple.toFixed(0)}×` },
  ];

  const reportedCapex = spcx.forecast[0];
  const risks = [
    { title: "AI monetisation", line: `Base case holds 2028E AI EBITDA at ${percent(anchor?.aiEbitdaMargin, 0)}; the price requires ${percent(implied.requiredAi2028EbitdaMargin, 0)}.` },
    { title: "Connectivity execution", line: `Base case ${billions(anchor?.connectivityRevenue)} of 2028E revenue; the price requires ${billions(implied.requiredConnectivity2028RevenueB)}.` },
    { title: "Starship execution", line: `Scenario-weighted ${billions(spcx.starship.expectedValueB)} across four outcomes; the price requires ${billions(implied.requiredStarshipExpectedB)}.` },
    { title: "Capex and dilution", line: `${billions(reportedCapex?.capex)} of reported annualised capital expenditure against ${spcx.shareBridge.fullyDilutedSharesCurrentB.toFixed(3)}B fully diluted shares.` },
  ];

  return (
    <section className="spcx" aria-label="SPCX research summary">
      {/* 1 · HERO */}
      <header className="spcx-hero">
        <div className="spcx-hero-id">
          <span className="spcx-ticker">SPCX</span>
          <h1>Space Exploration Technologies</h1>
          <p>Current price implies execution closer to the Vision case than the Signal Ledger Base case.</p>
        </div>
        <dl className="spcx-hero-metrics">
          <div><dt>Current price</dt><dd>{money(currentPrice)}</dd></div>
          <div className="is-base"><dt>Signal Ledger fair value</dt><dd>{money(fairValue)}</dd></div>
          <div><dt>Base gap</dt><dd className={(gap ?? 0) >= 0 ? "gain" : "loss"}>{percent(gap, 1, true)}</dd></div>
          <div><dt>Vision case</dt><dd className="is-vision">{money(vision?.value ?? null)}</dd></div>
          <div><dt>Confidence</dt><dd>{percent(confidence, 0)}</dd></div>
          <div><dt>View</dt><dd className="spcx-view">{rating}</dd></div>
        </dl>
      </header>

      {/* 2 · WHERE THE VALUE COMES FROM */}
      <section className="spcx-block" aria-label="Where the fair value comes from">
        <h2>Where the {money(fairValue, 0)} comes from</h2>
        <div className="spcx-waterfall" role="img" aria-label="Per-share contribution to fair value">
          {contributions.map((item) => (
            <span
              key={item.name}
              className={`spcx-bar spcx-bar-${item.tone}`}
              style={{ flexGrow: Math.max(0.4, item.perShare) }}
              title={`${item.name} ${money(item.perShare)}`}
            >
              <b>{money(item.perShare, 0)}</b>
            </span>
          ))}
        </div>
        <ul className="spcx-waterfall-legend">
          {contributions.map((item) => (
            <li key={item.name}>
              <i className={`spcx-swatch spcx-bar-${item.tone}`} />
              <span>{item.name}</span>
              <b>{money(item.perShare)}</b>
              <em>{contributionTotal > 0 ? percent(item.perShare / contributionTotal, 0) : "—"}</em>
            </li>
          ))}
          <li className="spcx-waterfall-total">
            <i />
            <span>Fair value</span>
            <b>{money(fairValue)}</b>
            <em>100%</em>
          </li>
        </ul>
      </section>

      {/* 3 · CORE / BASE / VISION */}
      <section className="spcx-block" aria-label="Core, base and vision cases">
        <h2>Core, base and vision</h2>
        <div className="spcx-cases">
          <article className="spcx-case is-core">
            <span>Core</span>
            <strong>{money(core?.value ?? null)}</strong>
            <p>Existing businesses execute conservatively and optionality earns little credit.</p>
          </article>
          <article className="spcx-case is-base">
            <span>Base · published</span>
            <strong>{money(base?.value ?? fairValue)}</strong>
            <p>2028E AI {billions(anchor?.aiRevenue)}, connectivity {billions(anchor?.connectivityRevenue)}, Starship {billions(spcx.starship.expectedValueB)} of scenario-weighted value.</p>
          </article>
          <article className="spcx-case is-vision">
            <span>Vision · high execution</span>
            <strong>{money(vision?.value ?? null)}</strong>
            <p>AI and connectivity scale faster and Starship reaches full reusability.</p>
          </article>
        </div>
      </section>

      {/* 4 · WHAT THE PRICE REQUIRES */}
      <section className="spcx-block" aria-label="What the current price requires">
        <h2>What does {money(currentPrice, 0)} require?</h2>
        <table className="spcx-table">
          <thead>
            <tr><th scope="col">Metric</th><th scope="col">Signal Ledger base</th><th scope="col">Market-implied</th></tr>
          </thead>
          <tbody>
            {marketRows.map((row) => (
              <tr key={row.metric}>
                <th scope="row">{row.metric}</th>
                <td>{row.base}</td>
                <td className="is-market">{row.market}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="spcx-callout">
          At the current price the market is already pricing a substantial portion of the Vision case. No single lever
          closes the gap: it takes higher AI revenue at a higher margin, more connectivity scale and more Starship value
          together.
        </p>
      </section>

      {/* 5 · OPERATING FORECAST */}
      <section className="spcx-block" aria-label="Operating forecast">
        <h2>Operating forecast</h2>
        <div className="spcx-tabs" role="tablist">
          {(["AI", "Connectivity", "Space"] as Segment[]).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={name === segment}
              className={name === segment ? "active" : ""} onClick={() => setSegment(name)}>
              {name}
            </button>
          ))}
        </div>
        <div className="spcx-table-scroll">
          <table className="spcx-table">
            <thead>
              <tr><th scope="col" />{spcx.forecast.map((row) => <th key={row.year} scope="col">{row.year}E</th>)}</tr>
            </thead>
            <tbody>
              {FORECAST_ROWS[segment].map((line) => (
                <tr key={line.label}>
                  <th scope="row">{line.label}</th>
                  {spcx.forecast.map((row) => <td key={row.year}>{line.value(row)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 6 · STARSHIP */}
      <section className="spcx-block" aria-label="Starship scenario tree">
        <h2>Starship scenario tree</h2>
        <div className="spcx-starship">
          {spcx.starship.scenarios.map((scenario) => (
            <article key={scenario.name}>
              <span>{scenario.name}</span>
              <strong>{billions(scenario.npvB, 0)}</strong>
              <small>{percent(scenario.probability, 0)} probability · weighted {billions(scenario.npvB * scenario.probability)}</small>
              <p>{scenario.note.split(";")[0]}.</p>
            </article>
          ))}
        </div>
        <p className="spcx-starship-total">
          Starship expected value <strong>{billions(spcx.starship.expectedValueB)}</strong> ·{" "}
          <strong>{money(spcx.starship.perShare)}</strong> per share · probabilities sum to {percent(spcx.starship.probabilitySum, 0)}
        </p>
      </section>

      {/* 7 · KEY RISKS */}
      <section className="spcx-block" aria-label="Key risks">
        <h2>Key risks</h2>
        <div className="spcx-risks">
          {risks.map((risk) => (
            <article key={risk.title}>
              <strong>{risk.title}</strong>
              <p>{risk.line}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
