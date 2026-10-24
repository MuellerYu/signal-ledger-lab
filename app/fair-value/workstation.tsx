"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import SpcxResearchPage from "./spcx-research";
import Amd2030Research from "./amd-2030";
import SiteNav from "../site-nav";
import type { UniversalValuationOutput, ValuationAssumptions } from "@/lib/universal-valuation";
import type { ValuationPipelineStage } from "@/lib/valuation-data";
import type { AiValuationOrchestration } from "@/lib/valuation-ai";
import type { MemberState } from "@/lib/member-session";
import { ResearchGuide } from "../research-guide";
import { isLaunchTicker } from "@/lib/launch-universe";

type ApiOutput = UniversalValuationOutput & {
  schema?: string;
  generatedAt?: string;
  pipeline?: ValuationPipelineStage[];
  identity?: { securityTicker: string; issuerTicker: string; issuerName: string; cik: string; relatedShareClasses: string[] };
  aiOrchestration?: AiValuationOrchestration;
};

const RATING_SCALE = "STRONG BUY / BUY / WATCH / REDUCE / SELL";
const RECENT_TICKERS_KEY = "signal-ledger:valuation:recent";
const RECENT_TICKERS_MAX = 6;

function readRecentTickers() {
  try {
    const stored = window.localStorage.getItem(RECENT_TICKERS_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9.\-]{0,7}$/.test(value)) : [];
  } catch {
    return [];
  }
}

function rememberTicker(ticker: string) {
  try {
    const next = [ticker, ...readRecentTickers().filter((value) => value !== ticker)].slice(0, RECENT_TICKERS_MAX);
    window.localStorage.setItem(RECENT_TICKERS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [ticker];
  }
}
const ROUTER_COVERAGE = [
  ["AI Compute Platform", "DCF · Forward P/E · EV/FCF · EV/Sales · REVERSE DCF"],
  ["AI Semiconductor", "DCF · Forward P/E · EV/FCF · EV/Sales · REVERSE DCF"],
  ["Mature Semiconductor", "Normalized cycle · DCF · P/E · EV/FCF"],
  ["Consumer Tech Platform", "Normalized DCF · P/E · EV/FCF"],
  ["Digital Platform", "Normalized DCF · P/E · EV/FCF"],
  ["Stablecoin Network", "Reserve-economics SOTP required · P/E · EV/Sales"],
  ["SaaS Growth", "Normalized DCF · EV/Sales · EV/FCF"],
  ["Cloud / Software Hybrid", "Normalized DCF · P/E · SOTP"],
  ["Bank", "Residual income · P/TBV · P/E"],
  ["REIT", "NAV · AFFO · DCF"],
  ["Biotech", "rNPV · DCF · EV/Sales"],
  ["Auto + Optionality", "SOTP · DCF · P/E"],
  ["Private Aerospace", "SOTP · EV/Sales · DCF · liquidity risk"],
  ["Oil & Gas", "Commodity scenarios · DCF · EV/EBITDA"],
  ["Insurance", "Residual income · P/TBV · earnings"],
  ["Asset Manager", "AUM earnings · DCF · P/E"],
  ["Utilities", "Regulated DCF · P/E · dividend capacity"],
  ["Airline", "Cycle-normalized DCF · EV/EBITDA"],
  ["Telecom", "Normalized DCF · EV/EBITDA · FCF"],
  ["Retail / Consumer", "Normalized DCF · P/E · EV/EBITDA"],
  ["Pharma / Medtech", "DCF · P/E · rNPV where applicable"],
  ["General Equity", "Normalized DCF · P/E · EV/FCF · EV/Sales"],
];

const PIPELINE = [
  { id: "security", label: "Security identified" },
  { id: "issuer", label: "Issuer resolved" },
  { id: "quote", label: "Market data refreshed" },
  { id: "financials", label: "SEC financials refreshed" },
  { id: "issuer_profile", label: "Loading issuer intelligence" },
  { id: "forecast", label: "Building forecasts" },
  { id: "models", label: "Running valuation models" },
  { id: "applicability", label: "Checking model applicability" },
  { id: "monte_carlo", label: "Monte Carlo" },
  { id: "publish", label: "Publishing" },
];

const READINESS_LABEL: Record<UniversalValuationOutput["status"], string> = {
  "decision-grade": "DECISION GRADE",
  provisional: "PROVISIONAL · INTERNAL FORECAST",
  screening: "LIMITED-DATA SCREEN",
  "high-uncertainty": "HIGH UNCERTAINTY",
  unavailable: "UNAVAILABLE",
};

function number(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function money(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function percent(value: number | null | undefined, digits = 1, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${signed && value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function billions(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(Math.abs(value) < 1 ? 2 : 1)}B`;
}

function compactDate(value: string | null | undefined) {
  if (!value) return "Timestamp unavailable";
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function assumptionText(assumptions: ValuationAssumptions) {
  const items: string[] = [];
  const path = assumptions.normalizedCashFlows ?? assumptions.cashFlows;
  if (path?.length) items.push(`${assumptions.cashFlowBasis === "cfo_capex_proxy" || assumptions.cashFlowBasis === "fcfe_equity" ? "Equity cash flow" : "Cash flow"} ${billions(path[0])} → ${billions(path.at(-1))}`);
  if (assumptions.forwardEps) items.push(`EPS ${money(assumptions.forwardEps, 2)}`);
  if (assumptions.forwardPe) items.push(`${assumptions.forwardPe.toFixed(1)}× P/E`);
  if (assumptions.wacc) items.push(`${percent(assumptions.wacc)} WACC`);
  if (assumptions.terminalGrowth !== undefined) items.push(`${percent(assumptions.terminalGrowth)} terminal growth`);
  return items.length ? items.join(" · ") : "Fundamental inputs are not yet complete.";
}

function Distribution({ values, price }: { values: UniversalValuationOutput["ensemble"]["probabilityDistribution"]; price: number | null }) {
  const points = [values.p10, values.p25, values.p50, values.p75, values.p90].filter((value): value is number => typeof value === "number");
  if (!points.length) return <div className="uv-empty-inline">A sensitivity range is not available. Check the model inputs and simulation audit below; no range is invented for missing evidence.</div>;
  const min = Math.min(...points, price ?? Infinity) * 0.9;
  const max = Math.max(...points, price ?? -Infinity) * 1.1;
  if (Math.max(...points) - Math.min(...points) < 0.000001) return <div className="uv-empty-inline">All input draws produce {money(points[0])}. This is a fixed-input sensitivity result, not evidence that the company has no valuation risk.</div>;
  const position = (value: number) => `${Math.max(2, Math.min(98, ((value - min) / Math.max(1, max - min)) * 100))}%`;
  return (
    <div className="uv-distribution" aria-label={`Fair-value distribution from ${money(values.p10)} to ${money(values.p90)}`}>
      <div className="uv-range" />
      {(["p10", "p25", "p50", "p75", "p90"] as const).map((key) => values[key] === null ? null : (
        <div className={`uv-marker ${key === "p50" ? "median" : ""}`} style={{ left: position(values[key]!) }} key={key}>
          <i /><span>{key.toUpperCase()}</span><strong>{money(values[key])}</strong>
        </div>
      ))}
      {price === null ? null : <div className="uv-marker price" style={{ left: position(price) }}><i /><span>PRICE</span><strong>{money(price)}</strong></div>}
    </div>
  );
}

export default function UniversalValuationWorkstation({ initialData, member, freeSample = false, amd2030Preview = false }: { initialData: ApiOutput; member: MemberState; freeSample?: boolean; amd2030Preview?: boolean }) {
  const [ticker, setTicker] = useState(initialData.ticker);
  const [tickerInput, setTickerInput] = useState(initialData.ticker);
  const [data, setData] = useState<ApiOutput>(initialData);
  const [manualPrice, setManualPrice] = useState("");
  const [growthDelta, setGrowthDelta] = useState(0);
  const [marginDelta, setMarginDelta] = useState(0);
  const [multipleDelta, setMultipleDelta] = useState(0);
  const [loading, setLoading] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [popular, setPopular] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => setRecent(readRecentTickers()));
    fetch("/api/valuation/snapshot?scope=home", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        const tickers = payload?.sections?.mostViewed;
        setPopular(Array.isArray(tickers) ? tickers.filter((value: unknown): value is string => typeof value === "string") : []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const executeEngine = useCallback(async (symbol: string, controls: { price: number | null; growthDelta: number; marginDelta: number; multipleDelta: number }) => {
    const next = symbol.trim().toUpperCase();
    if (!next || loading) return;
    // A free sample is a complete read-only example. The engine on demand is PRO.
    if (freeSample) {
      setMessage("This is a complete free example. Running the engine on another ticker is part of Signal Ledger PRO.");
      return;
    }
    setTicker(next);
    setTickerInput(next);
    setRecent(rememberTicker(next));
    window.history.replaceState({}, "", `/fair-value?ticker=${encodeURIComponent(next)}`);
    setLoading(true);
    setProgressIndex(0);
    setMessage("");
    const timer = window.setInterval(() => setProgressIndex((current) => Math.min(PIPELINE.length - 2, current + 1)), 650);
    try {
      const response = await fetch("/api/valuation/run", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ ticker: next, ...(controls.price === null ? {} : { price: controls.price }), growthDelta: controls.growthDelta, marginDelta: controls.marginDelta, multipleDelta: controls.multipleDelta }),
      });
      const payload = await response.json() as ApiOutput & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The valuation engine could not complete this security.");
      setProgressIndex(PIPELINE.length - 1);
      setData(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Valuation unavailable.");
    } finally {
      window.clearInterval(timer);
      setLoading(false);
    }
  }, [loading, freeSample]);

  const chooseTicker = (symbol: string) => {
    setManualPrice("");
    setGrowthDelta(0);
    setMarginDelta(0);
    setMultipleDelta(0);
    void executeEngine(symbol, { price: null, growthDelta: 0, marginDelta: 0, multipleDelta: 0 });
  };

  const submitTicker = (event: FormEvent) => {
    event.preventDefault();
    void executeEngine(tickerInput, { price: number(manualPrice), growthDelta, marginDelta, multipleDelta });
  };

  const resetView = () => {
    setGrowthDelta(0);
    setMarginDelta(0);
    setMultipleDelta(0);
    setManualPrice("");
  };

  const rerunView = () => void executeEngine(ticker, { price: number(manualPrice), growthDelta, marginDelta, multipleDelta });

  const implied = data.marketImpliedExpectations;
  const qualityIssues = data.dataQuality.checks.filter((check) => check.status !== "passed");
  // A published value is a published value: the internal release taxonomy
  // ("screening only" versus "released") stays in the model audit and never
  // becomes the headline label.
  const valueLabel = data.dataQuality.valuationRelease === "withheld" || data.releaseGate === "model_check_required"
    ? "Fair value withheld"
    : "Signal Ledger Fair Value";
  const assumptionDelta = useMemo(() => [
    { label: "Growth path", value: percent(growthDelta, 1, true) },
    { label: "FCF margin", value: `${marginDelta >= 0 ? "+" : ""}${(marginDelta * 100).toFixed(1)} pts` },
    { label: "Justified multiples", value: percent(multipleDelta, 1, true) },
  ], [growthDelta, marginDelta, multipleDelta]);
  const aiPlanAvailable = data.aiOrchestration?.status === "active";
  const engineLabel = data.aiOrchestration?.aiUsed === true
    ? `${data.aiOrchestration?.model ?? data.aiOrchestration?.plannerModel ?? "AI"} reviewed this valuation`
    : "Deterministic models from the stored company profile";
  // A precise number is only presented as authoritative above the confidence bar.
  const lowConfidence = data.ensemble.confidence < 0.4 && data.ensemble.fairValue !== null;
  const evidenceDate = useMemo(() => {
    const dates = Object.values(data.aiBaseline.inputSources ?? {}).map((source) => source?.asOf).filter((value): value is string => Boolean(value));
    return dates.length ? dates.sort().at(-1)! : "not dated";
  }, [data.aiBaseline.inputSources]);
  // Which statements the forecast was built from, plus the verified SEC entity.
  const reportingBasis = data.pipeline?.find((stage) => stage.id === "financials")?.detail ?? "SEC-reported statements";
  const sotpSegments = data.aiBaseline.assumptions.sotpSegments ?? [];
  const segmentTotalB = sotpSegments.reduce((sum, segment) => sum + segment.metricValueB * segment.multiple * (segment.probability ?? 1), 0);
  // Scenario terminology: only claim probability weighting where explicit
  // scenario probabilities are actually used.
  const scenarioTerminology = data.valuationScenarios.method === "segment_sotp" ? "Probability-weighted scenario" : "Sensitivity";
  // For blended routes the enterprise value is the equity value less net cash.
  const recon = useMemo(() => {
    const segmentBased = data.reconciliation.segmentValueB !== null;
    const netCashB = data.aiBaseline.assumptions.netCashB ?? null;
    const equityValueB = data.reconciliation.equityValueB ?? (data.ensemble.fairValue !== null && data.reconciliation.dilutedSharesB ? data.ensemble.fairValue * data.reconciliation.dilutedSharesB : null);
    const enterpriseValueB = segmentBased
      ? data.reconciliation.segmentValueB
      : equityValueB !== null && netCashB !== null ? equityValueB - netCashB : null;
    return { isSegmentBased: segmentBased, enterpriseValueB };
  }, [data.reconciliation, data.aiBaseline.assumptions.netCashB, data.ensemble.fairValue]);

  return (
    <main className="uv-app">
      <SiteNav current="/fair-value" member={member} />

      <div className="uv-shell">
        <ResearchGuide />
        {isLaunchTicker(data.ticker) && <p className="uv-provenance"><Link href={`/companies/${data.ticker.toLowerCase()}`}>View {data.ticker} business research and owner scenario →</Link></p>}
        <p className="uv-provenance" role="status">How this estimate was produced: <strong>{engineLabel}</strong>. Every input below is shown so you can check it.</p>
        {freeSample ? <p className="uv-sample-banner" role="status"><strong>FREE SAMPLE</strong> — this is a complete public example of a Signal Ledger PRO analysis. Read every section; nothing is hidden. Running the engine on another ticker is a PRO feature.</p> : null}
        <section className="uv-toolbar" aria-label="Valuation company selector">
          <form onSubmit={submitTicker}>
            <label htmlFor="uv-ticker">Ticker</label>
            <div>
              <input id="uv-ticker" value={tickerInput} onChange={(event) => setTickerInput(event.target.value.toUpperCase())} maxLength={8} aria-label="Ticker" placeholder="Ticker" autoComplete="off" />
              <button type="submit" disabled={loading}>{loading ? "Running…" : "Run engine"}</button>
            </div>
            <p className="uv-market-price">
              Market price: <strong>{money(data.currentPrice.value, 2)}</strong> · automatic
              <small>{data.currentPrice.source}{data.currentPrice.asOf ? ` · ${compactDate(data.currentPrice.asOf)}` : ""}</small>
            </p>
            <details className="uv-advanced">
              <summary>Advanced</summary>
              <label className="uv-override">
                <span>Override market price</span>
                <input className="uv-price-input" inputMode="decimal" value={manualPrice} onChange={(event) => setManualPrice(event.target.value)} placeholder="Leave blank to use the automatic price" aria-label="Override market price" />
                <small>A manual price only changes the price input for this session; it never changes the model’s fundamentals.</small>
              </label>
            </details>
          </form>
          <div className="uv-quick" aria-label="Dynamically generated ticker shortcuts">
            {recent.length > 0 && <div className="uv-quick-group"><span>Recent</span>{recent.map((symbol) => <button className={ticker === symbol ? "active" : ""} onClick={() => chooseTicker(symbol)} type="button" key={`recent-${symbol}`}>{symbol}</button>)}</div>}
            {popular.length > 0 && <div className="uv-quick-group"><span>Popular</span>{popular.map((symbol) => <button className={ticker === symbol ? "active" : ""} onClick={() => chooseTicker(symbol)} type="button" key={`popular-${symbol}`}>{symbol}</button>)}</div>}
            {recent.length === 0 && popular.length === 0 && <p className="uv-quick-empty">Recent and popular names appear here after the engine has been used. Type any U.S. ticker to value a company outside this list.</p>}
          </div>
          <div className="uv-route"><span>ROUTER</span><strong>{data.classification.businessModel}</strong><small>→ {data.engine.family.label}</small></div>
        </section>

        {loading ? <section className="uv-run-progress" aria-live="polite"><div><span>Running valuation</span><strong>{PIPELINE[progressIndex].label}</strong></div><ol>{PIPELINE.map((stage, index) => <li className={index < progressIndex ? "done" : index === progressIndex ? "active" : ""} key={stage.id}><i />{stage.label}</li>)}</ol></section> : null}

        {message ? <section className="uv-error" role="alert"><strong>{freeSample ? "Signal Ledger PRO" : "Valuation unavailable"}</strong><p>{message}</p></section> : null}

        <section className="uv-answer" aria-busy={loading}>
          <header className="uv-identity">
            <h1>{data.classification.companyName}</h1>
            <span className="uv-ticker-chip">{data.ticker}</span>
            {freeSample ? <span className="uv-free-sample"><b>FREE SAMPLE</b><small>Complete public analysis</small></span> : null}
            <span className="uv-identity-meta">{data.classification.sector}
              {data.qualityReview && data.qualityReview.status !== "passed" ? <b className="uv-gate-badge">{data.qualityReview.status.replaceAll("_", " ")}</b> : null}
            </span>
            <p>{data.classification.rationale}</p>
          </header>

          <div className="uv-primary-grid">
            <article><span>Current price</span><strong>{money(data.currentPrice.value, 2)}</strong><small>{data.currentPrice.source} · {compactDate(data.currentPrice.asOf)}</small></article>
            <article className="fair-value">
              <span>{valueLabel}</span>
              <strong>{loading ? "Calculating…" : money(data.ensemble.fairValue)}</strong>
              <small>{loading
                ? PIPELINE[progressIndex].label
                : `Scenario range ${money(data.ensemble.scenarios.bear)} – ${money(data.ensemble.scenarios.bull)} (core to vision)`}</small>
            </article>
            <article><span>Upside / downside</span><strong className={(data.ensemble.expectedReturn ?? 0) >= 0 ? "gain" : "loss"}>{percent(data.ensemble.expectedReturn, 1, true)}</strong><small>Fair value versus current price</small></article>
            <article className={`rating-cell rating-${data.rating.value.toLowerCase().replaceAll(" ", "-")}`}><span>Rating</span><strong>{data.rating.value}</strong><small>{data.rating.rationale}</small></article>
            <article className={lowConfidence ? "confidence-cell low" : "confidence-cell"}><span>Confidence</span><strong>{percent(data.ensemble.confidence, 0)}</strong><small>{data.confidenceLabel} · {data.engine.modelsIncluded} of {data.engine.valuationModelsRouted} routed models included</small>
              <small className="uv-confidence-parts">
                Data {percent(data.confidenceBreakdown.dataQuality, 0)} · Forecast {percent(data.confidenceBreakdown.forecastQuality, 0)} · Agreement {percent(data.confidenceBreakdown.modelAgreement, 0)} · Provenance {percent(data.confidenceBreakdown.sourceProvenance, 0)} · Freshness {percent(data.confidenceBreakdown.evidenceFreshness, 0)}
              </small>
            </article>
          </div>

          <div className="uv-scenario-grid">
            <article><span>Bear</span><strong>{money(data.ensemble.scenarios.bear)}</strong><small title={data.valuationScenarios.bear.assumptions}>{scenarioTerminology} downside</small></article>
            <article><span>Base</span><strong>{money(data.ensemble.scenarios.base)}</strong><small title={data.valuationScenarios.base.assumptions}>Reported evidence case</small></article>
            <article><span>Bull</span><strong>{money(data.ensemble.scenarios.bull)}</strong><small title={data.valuationScenarios.bull.assumptions}>{scenarioTerminology} upside</small></article>
            <article className="zone"><span>Buy zone</span><strong>{money(data.rating.buyZone)}</strong><small>{data.valuationScenarios.method === "segment_sotp" ? `Case weights ${Math.round(data.valuationScenarios.weights.bear * 100)}/${Math.round(data.valuationScenarios.weights.base * 100)}/${Math.round(data.valuationScenarios.weights.bull * 100)}` : "Family risk buffer applied"}</small></article>
            <article className="zone strong"><span>Strong buy zone</span><strong>{money(data.rating.strongBuyZone)}</strong><small>Higher uncertainty haircut</small></article>
          </div>
        </section>

        {amd2030Preview && data.ticker === "AMD" ? <Amd2030Research currentPrice={data.currentPrice.value} priceAsOf={data.currentPrice.asOf} existingFairValue={data.ensemble.fairValue} /> : null}

        {sotpSegments.length ? (
          <details className="uv-advanced-block"><summary>Advanced model audit</summary>
          <section className="uv-sotp" aria-label="Sum-of-the-parts components">
            <div className="uv-sectional-head">
              <h2>Sum-of-the-parts components</h2>
              <p>Each segment carries its own driver, multiple and delivery probability. Bear, base and bull cases re-price these same segments; unproven optionality is never fully credited.</p>
            </div>
            <div className="uv-table-scroll" tabIndex={0}>
              <table>
                <thead><tr><th>Segment</th><th>Driver / forecast metric</th><th>Method</th><th>Forecast metric</th><th>Multiple / assumption</th><th>Probability</th><th>Segment value</th><th>Per share</th></tr></thead>
                <tbody>{sotpSegments.map((segment, index) => {
                  const probability = segment.probability ?? 1;
                  const method = segment.method ?? (segment.metricValueB < 0
                    ? "equity_claim"
                    : /option|probab|adoption|success/i.test(segment.metric)
                      ? "probability_weighted_option"
                      : segment.multiple === 1 ? "capital_based" : "revenue_multiple");
                  const methodLabel = method.replaceAll("_", " ");
                  return <tr key={`${segment.name}-${index}`}>
                    <td><strong>{segment.name}</strong></td>
                    <td>{segment.metric}<small className="uv-seg-source">{segment.driverSource === "reported" ? "reported driver" : "model-derived driver"}</small></td>
                    <td>{methodLabel}</td>
                    <td>{billions(segment.metricValueB)}</td>
                    <td>{segment.multiple.toFixed(1)}×{segment.marginAssumption !== undefined ? ` · ${percent(segment.marginAssumption, 0)} margin` : ""}{segment.discountRate !== undefined ? ` · ${percent(segment.discountRate)} discount` : ""}</td>
                    <td>{probability >= 1 ? "Reported basis" : percent(probability, 0)}</td>
                    <td>{billions(segment.metricValueB * segment.multiple * probability)}</td>
                    <td>{data.reconciliation.dilutedSharesB ? money((segment.metricValueB * segment.multiple * probability) / data.reconciliation.dilutedSharesB, 2) : "—"}</td>
                  </tr>;
                })}</tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={6}>Segment total {sotpSegments.some((segment) => segment.probability !== undefined && segment.probability < 1) ? "(probability weighted)" : "(reported basis)"}</th>
                    <td>{billions(segmentTotalB)}</td>
                    <td>{data.reconciliation.dilutedSharesB ? money(segmentTotalB / data.reconciliation.dilutedSharesB, 2) : "—"}</td>
                  </tr>
                  <tr>
                    <th scope="row" colSpan={6}>+ cash and investments − debt (net cash used by the models)</th>
                    <td>{billions(data.aiBaseline.assumptions.netCashB)}</td>
                    <td>{data.reconciliation.dilutedSharesB && data.aiBaseline.assumptions.netCashB !== undefined ? money(data.aiBaseline.assumptions.netCashB / data.reconciliation.dilutedSharesB, 2) : "—"}</td>
                  </tr>
                  <tr className="uv-sotp-total">
                    <th scope="row" colSpan={6}>= Equity value ÷ {data.reconciliation.dilutedSharesB?.toFixed(3) ?? "—"}B diluted shares = published fair value</th>
                    <td>{billions(data.reconciliation.equityValueB)}</td>
                    <td>{money(data.ensemble.fairValue, 2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="uv-sotp-foot">
              Enterprise-to-equity bridge: {billions(data.aiBaseline.assumptions.netCashB)} net cash / (debt) · {data.aiBaseline.assumptions.dilutedSharesB?.toFixed(2) ?? "—"}B diluted shares. Corporate items are applied once, after the segments.
            </p>
          </section>
          </details>
        ) : null}

        {data.qualityReview ? (
          <details className="uv-advanced-block"><summary>Advanced valuation gates</summary>
          <section className={`uv-quality-gates status-${data.qualityReview.status.toLowerCase()}`} aria-label="Valuation quality control">
            <div>
              <p className="uv-kicker">Valuation quality control</p>
              <h2>{data.dataQuality.valuationRelease === "screening_only" ? "Provisional screening estimate" : data.qualityReview.status === "passed" ? "Data, model and sanity gates passed" : data.qualityReview.status === "MODEL_DIVERGENCE_REVIEW" ? "MODEL DIVERGENCE REVIEW" : "MODEL REVIEW REQUIRED"}</h2>
              <p>{data.qualityReview.publishable && data.dataQuality.valuationRelease === "released"
                ? "This value passed the data, model and sanity gates, so it is published as research."
                : data.dataQuality.valuationRelease === "screening_only"
                  ? "This is a provisional screening estimate. Passing arithmetic checks does not make the underlying forecasts decision-ready."
                : `The preliminary value${data.qualityReview.preliminaryFairValue === null ? "" : ` of ${money(data.qualityReview.preliminaryFairValue, 2)}`} is held in the Model Audit until the failing gate is resolved. No buy zone and no directional rating are published.`}</p>
            </div>
            <ul>{data.qualityReview.gates.map((gate) => <li key={gate.id} className={gate.status}><b>{gate.label}: {gate.status}</b><span>{gate.detail}</span></li>)}</ul>
            <div className="uv-quality-details">
              <p><strong>Implied multiples on the published value</strong> EV / 2028E revenue {data.qualityReview.impliedMultiples.fairValueEvRevenue === null ? "—" : `${data.qualityReview.impliedMultiples.fairValueEvRevenue.toFixed(2)}×`} · EV / 2028E EBITDA {data.qualityReview.impliedMultiples.fairValueEvEbitda === null ? "—" : `${data.qualityReview.impliedMultiples.fairValueEvEbitda.toFixed(1)}×`} · FCF yield {data.qualityReview.impliedMultiples.fairValueFcfYieldPct === null ? "—" : `${data.qualityReview.impliedMultiples.fairValueFcfYieldPct.toFixed(1)}%`}</p>
              <p><strong>Market implies</strong> EV / 2028E revenue {data.qualityReview.impliedMultiples.marketEvRevenue === null ? "—" : `${data.qualityReview.impliedMultiples.marketEvRevenue.toFixed(2)}×`} · EV / 2028E EBITDA {data.qualityReview.impliedMultiples.marketEvEbitda === null ? "—" : `${data.qualityReview.impliedMultiples.marketEvEbitda.toFixed(1)}×`}{data.qualityReview.divergence.gapPct === null ? "" : ` · value gap ${data.qualityReview.divergence.gapPct.toFixed(1)}%`}</p>
              {data.qualityReview.impliedMultiples.flags.map((flag) => <p key={flag} className="warn">{flag}</p>)}
            </div>
          </section>
          </details>
        ) : null}

        {data.spcx ? (() => {
          const spcx = data.spcx!;
          return (
          <>
          <SpcxResearchPage
            spcx={spcx}
            currentPrice={data.currentPrice.value}
            confidence={data.ensemble.confidence}
            rating={data.rating.value}
            baseFairValue={data.ensemble.fairValue}
          />
          <section className="uv-spcx uv-advanced" aria-label="SPCX model audit">
            <details className="uv-subsection">
              <summary>Advanced model details</summary>
            <div className="uv-spcx-layers">
              {(["Space", "Connectivity", "AI"] as const).map((segment) => {
                const values = segment === "Space" ? spcx.space : segment === "Connectivity" ? spcx.connectivity : { revenueB: spcx.ai.revenueB, ebitdaB: spcx.ai.ebitdaB, enterpriseValueB: spcx.ai.enterpriseValueB, perShare: spcx.ai.perShare };
                return <div key={segment}>
                  <span>{segment} segment</span>
                  <strong>{billions(values.enterpriseValueB)}</strong>
                  <small>{money(values.perShare, 2)} / share · reported revenue {billions(values.revenueB)} · reported EBITDA {billions(values.ebitdaB)}</small>
                </div>;
              })}
              <div><span>Starship scenario tree</span><strong>{billions(spcx.starship.expectedValueB)}</strong><small>{money(spcx.starship.perShare, 2)} / share · probabilities sum to {(spcx.starship.probabilitySum * 100).toFixed(0)}%</small></div>
              <div><span>Net corporate (cash − debt − leases)</span><strong>{billions(spcx.netCorporateB)}</strong><small>{money(spcx.netCorporateB / spcx.shareBridge.fullyDilutedSharesCurrentB, 2)} / share</small></div>
            </div>
            <details className="uv-subsection" open>
              <summary>Reported segment anchors and valuation method</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Segment</th><th>Reported revenue</th><th>Reported adj. EBITDA</th><th>Reported margin</th><th>2028E revenue</th><th>2028E EBITDA</th><th>2028E margin</th><th>2028E multiple</th><th>Method</th><th>Enterprise value</th><th>Per share</th></tr></thead>
                  <tbody>{spcx.segments.map((segment) => <tr key={segment.segment}>
                    <td><strong>{segment.segment}</strong></td>
                    <td>{billions(segment.revenueBaseB)}</td>
                    <td>{billions(segment.ebitdaBaseB)}</td>
                    <td>{percent(segment.ebitdaMarginBase, 0)}</td>
                    <td>{billions(segment.anchorRevenue2028B)}</td>
                    <td>{billions(segment.anchorEbitda2028B)}</td>
                    <td>{percent(segment.anchorMargin2028, 0)}</td>
                    <td>{segment.anchorMultiple2028.toFixed(0)}×</td>
                    <td className="uv-spcx-driver">{segment.method}</td>
                    <td>{billions(segment.enterpriseValueB)}</td>
                    <td>{money(segment.perShare, 2)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </details>
            <details className="uv-subsection" open>
              <summary>Where the fair value comes from, component by component</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Component</th><th>Value</th><th>Per share</th><th>Share of total</th></tr></thead>
                  <tbody>
                    {spcx.valuationContribution.map((row) => <tr key={row.component}>
                      <td><strong>{row.component}</strong></td>
                      <td>{billions(row.valueB)}</td>
                      <td>{money(row.perShare, 2)}</td>
                      <td>{spcx.valuationContributionTotalB > 0 ? percent(row.valueB / spcx.valuationContributionTotalB, 1) : "—"}</td>
                    </tr>)}
                    <tr>
                      <td><strong>Total equity value</strong></td>
                      <td><b>{billions(spcx.valuationContributionTotalB)}</b></td>
                      <td><b>{money(spcx.fairValue, 2)}</b></td>
                      <td>÷ {spcx.shareBridge.fullyDilutedSharesCurrentB.toFixed(3)}B fully diluted shares</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
            <details className="uv-subsection">
              <summary>Explicit segment forecast (2026E–2030E)</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Year</th><th>Space revenue</th><th>Connectivity revenue</th><th>AI revenue</th><th>Space adj. EBITDA</th><th>Connectivity adj. EBITDA</th><th>AI adj. EBITDA</th><th>Capital expenditure</th><th>Segment free cash flow</th><th>Total revenue</th></tr></thead>
                  <tbody>{spcx.forecast.map((row) => <tr key={row.year}>
                    <td><strong>{row.year}E</strong></td>
                    <td>{billions(row.spaceRevenue)}</td>
                    <td>{billions(row.connectivityRevenue)}</td>
                    <td>{billions(row.aiRevenue)}</td>
                    <td>{billions(row.spaceEbitda)}</td>
                    <td>{billions(row.connectivityEbitda)}</td>
                    <td>{billions(row.aiEbitda)}</td>
                    <td>{billions(row.capex)}</td>
                    <td>{billions(row.segmentFcf)}</td>
                    <td>{billions(row.spaceRevenue + row.connectivityRevenue + row.aiRevenue)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">Revenue, margin and capital intensity come from the case calibration; EBITDA, capital expenditure, capacity, depreciation and free cash flow are computed. 2028E is the anchor year for the primary valuation, so 2027E and 2029E–2030E are shown for the ramp and the DCF rather than being valuation anchors.</p>
            </details>
            <details className="uv-subsection">
              <summary>Connectivity built from subscribers × ARPU plus the reported sub-lines</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Year</th><th>Consumer subscribers</th><th>Monthly ARPU</th><th>Consumer revenue</th><th>Enterprise &amp; Government</th><th>Starshield</th><th>Direct-to-device</th><th>Connectivity revenue</th><th>EBITDA margin</th></tr></thead>
                  <tbody>{spcx.forecast.map((row) => <tr key={`conn-${row.year}`}>
                    <td><strong>{row.year}E</strong></td>
                    <td>{row.consumerSubscribersM === undefined ? "—" : `${row.consumerSubscribersM.toFixed(1)}M`}</td>
                    <td>{money(row.consumerArpuMonthly, 0)}</td>
                    <td>{billions(row.consumerRevenue)}</td>
                    <td>{billions(row.enterpriseRevenue)}</td>
                    <td>{billions(row.starshieldRevenue)}</td>
                    <td>{billions(row.directToDeviceRevenue)}</td>
                    <td><b>{billions(row.connectivityRevenue)}</b></td>
                    <td>{percent(row.connectivityEbitdaMargin, 0)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">Consumer and Enterprise &amp; Government are reported sub-lines from the filed 10-Q; subscribers, ARPU and the Starshield and direct-to-device rows are labelled model assumptions. Consumer revenue is subscribers × ARPU, so the Connectivity forecast is built rather than asserted.</p>
            </details>
            <details className="uv-subsection">
              <summary>AI capacity, power, utilisation and depreciation</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Year</th><th>AI capex</th><th>Deployed AI capital</th><th>Capacity</th><th>Contracted power</th><th>Utilisation</th><th>Revenue yield per $</th><th>AI revenue</th><th>Depreciation</th><th>EBITDA</th><th>EBITDA margin</th></tr></thead>
                  <tbody>{spcx.forecast.map((row) => <tr key={`ai-${row.year}`}>
                    <td><strong>{row.year}E</strong></td>
                    <td>{billions(row.aiCapex)}</td>
                    <td>{billions(row.aiDeployedCapitalB)}</td>
                    <td>{row.aiCapacityGw === undefined ? "—" : `${row.aiCapacityGw.toFixed(1)} GW`}</td>
                    <td>{row.aiPowerContractedGw === undefined ? "—" : `${row.aiPowerContractedGw.toFixed(1)} GW`}</td>
                    <td>{percent(row.aiUtilisation, 0)}</td>
                    <td>{row.aiRevenueYield === undefined ? "—" : row.aiRevenueYield.toFixed(2)}</td>
                    <td>{billions(row.aiRevenue)}</td>
                    <td>{billions(row.aiDepreciationB)}</td>
                    <td>{billions(row.aiEbitda)}</td>
                    <td>{percent(row.aiEbitdaMargin, 0)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">Reported AI depreciation implies the capital already in service, and the plan deploys the build with a one-year lag. Capacity is expressed in gigawatts from a stated $9B of deployed capital per GW and 15% power headroom; utilisation is stated per case. AI is an existing reportable business, so no success probability is applied to it — risk enters through the revenue, margin, utilisation and capital assumptions, once.</p>
            </details>
            <details className="uv-subsection">
              <summary>Starship scenario tree (probabilities sum to 100%)</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Scenario</th><th>Probability</th><th>Launches per year</th><th>Revenue per launch</th><th>Launch cost</th><th>Commercial revenue</th><th>Government</th><th>Starlink deployment saving</th><th>Orbital infrastructure</th><th>Total at scale</th><th>FCF margin</th><th>Development capital</th><th>Present value</th><th>Scenario value</th></tr></thead>
                  <tbody>{spcx.starship.scenarios.map((scenario) => <tr key={scenario.name}>
                    <td><strong>{scenario.name}</strong></td>
                    <td>{percent(scenario.probability, 0)}</td>
                    <td>{scenario.launchCadencePerYear}</td>
                    <td>{money(scenario.revenuePerLaunchM, 0)}M</td>
                    <td>{money(scenario.launchCostM, 0)}M</td>
                    <td>{billions(scenario.commercialRevenueB)}</td>
                    <td>{billions(scenario.governmentRevenueB)}</td>
                    <td>{billions(scenario.internalSavingsB)}</td>
                    <td>{billions(scenario.orbitalInfrastructureRevenueB)}</td>
                    <td>{billions(scenario.revenueAtScaleB)}</td>
                    <td>{percent(scenario.fcfMargin, 0)}</td>
                    <td>{billions(scenario.developmentCapitalB)}</td>
                    <td>{billions(scenario.presentValueB)}</td>
                    <td>{billions(scenario.npvB)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <ul className="uv-dense-list">{spcx.starship.scenarios.map((scenario) => <li key={`note-${scenario.name}`}><b>{scenario.name}</b> {percent(scenario.probability, 0)} — {scenario.note}</li>)}</ul>
              <p className="uv-dense-note">Every scenario value is computed from its drivers rather than typed in: launch cadence × revenue per launch, government demand, the measurable Starlink deployment saving reuse creates, and the orbital infrastructure economics the platform opens, capitalised and discounted back six years, less the development capital. Probabilities sum to {(spcx.starship.probabilitySum * 100).toFixed(0)}% and no further haircut is applied to the expected value.</p>
            </details>
            <details className="uv-subsection" open>
              <summary>Model triangulation: SOTP primary, DCF and forward multiples as cross-checks</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Model</th><th>Business value</th><th>Per share</th><th>Applicability weight</th><th>Inputs</th><th>Why it is weighted this way</th></tr></thead>
                  <tbody>
                    <tr>
                      <td><strong>SOTP (published)</strong></td>
                      <td>{billions(spcx.crossChecks.sotp.enterpriseValueB)}</td>
                      <td>{money(spcx.crossChecks.sotp.perShare, 2)}</td>
                      <td>{percent(spcx.crossChecks.sotp.weight, 0)}</td>
                      <td className="uv-spcx-driver">Reported segment anchors, scenario trees, corporate bridge</td>
                      <td className="uv-spcx-driver">{spcx.crossChecks.sotp.note}</td>
                    </tr>
                    <tr>
                      <td><strong>Consolidated DCF</strong></td>
                      <td>{billions(spcx.crossChecks.dcf.enterpriseValueB)}</td>
                      <td>{money(spcx.crossChecks.dcf.perShare, 2)}</td>
                      <td>{percent(spcx.crossChecks.dcf.weight, 0)}</td>
                      <td className="uv-spcx-driver">{spcx.crossChecks.dcf.inputs}</td>
                      <td className="uv-spcx-driver">{spcx.crossChecks.dcf.note}</td>
                    </tr>
                    <tr>
                      <td><strong>Forward multiple</strong></td>
                      <td>{billions(spcx.crossChecks.forwardMultiple.enterpriseValueB)}</td>
                      <td>{money(spcx.crossChecks.forwardMultiple.perShare, 2)}</td>
                      <td>{percent(spcx.crossChecks.forwardMultiple.weight, 0)}</td>
                      <td className="uv-spcx-driver">{spcx.crossChecks.forwardMultiple.inputs}</td>
                      <td className="uv-spcx-driver">{spcx.crossChecks.forwardMultiple.note}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="uv-dense-note">Discount rate used across segments {percent(spcx.crossChecks.blendedDiscountRate, 1)} · terminal multiple {spcx.crossChecks.blendedTerminalMultiple.toFixed(1)}×. {spcx.crossChecks.weightsNote}</p>
            </details>
            <details className="uv-subsection" open>
              <summary>Market-implied expectations: what the current price requires</summary>
              <p className="uv-dense-note">{spcx.marketImplied.headline}</p>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Lever held on its own</th><th>Requirement to justify the market price</th></tr></thead>
                  <tbody>
                    <tr><td><strong>2028E AI revenue</strong></td><td>{spcx.marketImplied.requiredAi2028RevenueB === null ? "—" : `$${spcx.marketImplied.requiredAi2028RevenueB.toFixed(0)}B`} <small>against {billions(spcx.segments.find((segment) => segment.segment === "AI")?.anchorRevenue2028B)} modelled</small></td></tr>
                    <tr><td><strong>2028E AI EBITDA margin</strong></td><td>{spcx.marketImplied.requiredAi2028EbitdaMargin === null ? "—" : percent(spcx.marketImplied.requiredAi2028EbitdaMargin, 0)} <small>against 38% modelled</small></td></tr>
                    <tr><td><strong>2028E AI EV/EBITDA multiple</strong></td><td>{spcx.marketImplied.requiredAi2028Multiple === null ? "—" : `${spcx.marketImplied.requiredAi2028Multiple.toFixed(1)}×`} <small>against 20× modelled</small></td></tr>
                    <tr><td><strong>2028E Connectivity revenue</strong></td><td>{spcx.marketImplied.requiredConnectivity2028RevenueB === null ? "—" : `$${spcx.marketImplied.requiredConnectivity2028RevenueB.toFixed(0)}B`} <small>against {billions(spcx.segments.find((segment) => segment.segment === "Connectivity")?.anchorRevenue2028B)} modelled</small></td></tr>
                    <tr><td><strong>Starship scenario value</strong></td><td>{spcx.marketImplied.requiredStarshipExpectedB === null ? "—" : billions(spcx.marketImplied.requiredStarshipExpectedB)} <small>against {billions(spcx.starship.expectedValueB)} modelled</small></td></tr>
                    <tr><td><strong>Direct-to-device value</strong></td><td>{spcx.marketImplied.requiredDirectToDeviceValueB === null ? "—" : billions(spcx.marketImplied.requiredDirectToDeviceValueB)} <small>on top of the modelled Connectivity business</small></td></tr>
                  </tbody>
                </table>
              </div>
              {spcx.marketImplied.combination.length ? (
                <ul className="uv-dense-list">{spcx.marketImplied.combination.map((line) => <li key={line}>{line}</li>)}</ul>
              ) : null}
              {spcx.marketImplied.equalSplit.length ? (
                <ul className="uv-dense-list">
                  {spcx.marketImplied.equalSplit.map((row) => <li key={row.lever}><b>{row.lever}</b>: {row.requirement}</li>)}
                </ul>
              ) : null}
            </details>
            <div className="uv-spcx-grid">
              <div>
                <p className="uv-kicker">Cases</p>
                <ul className="uv-dense-list">{spcx.cases.map((item) => <li key={item.name}><b>{item.name} {money(item.value, 2)}</b>{item.published ? " — this is the published fair value" : ""} — {item.assumptions}</li>)}</ul>
                <p className="uv-kicker">Buy zone</p>
                {spcx.buyZone
                  ? <p className="uv-dense-note">Buy {money(spcx.buyZone.buyPrice, 2)} · Strong buy {money(spcx.buyZone.strongBuyPrice, 2)} · required return {(spcx.buyZone.requiredReturn * 100).toFixed(0)}%/{(spcx.buyZone.strongBuyRequiredReturn * 100).toFixed(0)}% · {spcx.buyZone.holdingPeriodYears}-year holding · {spcx.buyZone.method}</p>
                  : <p className="uv-dense-note warn">No buy zone is published while the data, model or sanity gate has not passed.</p>}
                <p className="uv-kicker">Confidence (display only)</p>
                <p className="uv-dense-note">Reported data {percent(spcx.confidence.reportedData, 0)} · Connectivity forecast {percent(spcx.confidence.connectivityForecast, 0)} · AI forecast {percent(spcx.confidence.aiForecast, 0)} · Starship {percent(spcx.confidence.starshipOptionality, 0)} · Overall {percent(spcx.confidence.overall, 0)}. Confidence never reduces the value.</p>
              </div>
              <div>
                <p className="uv-kicker">Why are we different?</p>
                <div className="uv-table-scroll" tabIndex={0}>
                  <table className="uv-spcx-table">
                    <thead><tr><th>Metric</th><th>Signal Ledger</th><th>Market</th><th>Public research</th></tr></thead>
                    <tbody>{data.qualityReview?.whyDifferent.map((row) => <tr key={row.metric}><td><strong>{row.metric}</strong></td><td>{row.signalLedger}</td><td>{row.market}</td><td>{row.publicResearch}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
              <div>
                <p className="uv-kicker">Wall Street comparison (assumptions, never targets in the calculation)</p>
                <div className="uv-table-scroll" tabIndex={0}>
                  <table className="uv-spcx-table">
                    <thead><tr><th>Institution</th><th>Reported target</th><th>Versus Signal Ledger base</th><th>What would have to differ</th></tr></thead>
                    <tbody>{data.qualityReview?.externalResearch.map((entry) => <tr key={`${entry.institution}-${entry.target}`}>
                      <td><strong>{entry.institution}</strong><small>{entry.date}</small></td>
                      <td>{entry.target === null ? "—" : money(entry.target, 0)}</td>
                      <td>{entry.target === null || data.ensemble.fairValue === null ? "—" : `${((entry.target / data.ensemble.fairValue - 1) * 100).toFixed(0)}% above our base`}</td>
                      <td className="uv-spcx-driver">{entry.assumptions ?? "not captured"}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
                <p className="uv-dense-note">Public targets are recorded for comparison only and are never averaged into Signal Ledger fair value. The differences that explain a higher institutional number are the AI revenue ramp, long-run AI margins, the Starship terminal value, the forecast horizon and terminal multiples — the same levers the market-implied table above quantifies.</p>
                <p className="uv-kicker">Captured research notes</p>
                {data.qualityReview?.externalResearch.length
                  ? <ul className="uv-dense-list">{data.qualityReview.externalResearch.map((entry) => <li key={`${entry.institution}-${entry.date}`}><b>{entry.institution}</b> {entry.date} · target {entry.target === null ? "—" : money(entry.target, 2)} · {entry.method ?? "method not public"}{entry.sourceUrl ? <> · <a href={entry.sourceUrl} target="_blank" rel="noreferrer">source ↗</a></> : null}</li>)}</ul>
                  : <p className="uv-dense-note">No external research has been captured for this issuer yet. The comparison layer is stored separately and is never averaged into Signal Ledger fair value.</p>}
                <p className="uv-kicker">Share count bridge</p>
                <ul className="uv-dense-list">
                  <li>Basic current {spcx.shareBridge.basicSharesCurrentB?.toFixed(4) ?? "—"}B → fully diluted current <b>{spcx.shareBridge.fullyDilutedSharesCurrentB.toFixed(4)}B</b> (as of {spcx.shareBridge.shareCountAsOfDate ?? "—"})</li>
                  {spcx.shareBridge.components.filter((component) => component.sharesB !== null).map((component) => <li key={component.label}>{component.label}: {component.sharesB?.toFixed(4)}B <em>({(component.sourceType ?? "").replaceAll("_", " ").toLowerCase()})</em></li>)}
                </ul>
              </div>
            </div>
            </details>
          </section>
          </>
          );
        })() : null}


        {data.mu ? (() => {
          const mu = data.mu!;
          const gap = mu.weightedFairValue !== null && mu.sanity.price ? mu.weightedFairValue / mu.sanity.price - 1 : null;
          return (
          <section className="uv-spcx" aria-label="Micron structural and cyclical memory valuation">
            <div className="uv-sectional-head">
              <h2>MU valuation: HBM, legacy DRAM and NAND modelled separately</h2>
              <p>Reported product revenue, gross margin, operating income, tax rate and capital expenditure anchor the model. Legacy DRAM and NAND normalise one year at a time; HBM keeps a structural margin premium because the latest 10-Q reports take-or-pay agreements with binding volumes and floor pricing. Confidence is metadata and never reduces the value.</p>
            </div>
            <div className="uv-spcx-layers">
              <div><span>Current price</span><strong>{money(mu.sanity.price, 2)}</strong><small>Market quote used for the reverse solve</small></div>
              <div><span>Base fair value</span><strong>{money(mu.weightedFairValue, 2)}</strong><small>{gap === null ? "No market comparison" : `${percent(gap, 1, true)} versus market`}</small></div>
              {mu.cases.map((item) => <div key={item.name}><span>{item.name} case</span><strong>{money(item.value, 2)}</strong><small>{item.name === "BASE" ? "This is the published fair value" : item.assumptions.slice(0, 110)}</small></div>)}
            </div>
            <details className="uv-subsection" open>
              <summary>FY2026–FY2030 forecast (reported anchor plus annual normalisation)</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Year</th><th>Revenue</th><th>HBM</th><th>Legacy DRAM</th><th>NAND</th><th>Gross margin</th><th>EBITDA</th><th>EPS</th><th>Free cash flow</th><th>Capital expenditure</th><th>Margin driver</th></tr></thead>
                  <tbody>{mu.forecast.map((row) => <tr key={row.year}>
                    <td><strong>FY{row.year}</strong></td>
                    <td>{billions(row.revenueB)}</td>
                    <td>{billions(row.hbmRevenueB)}</td>
                    <td>{billions(row.legacyDramRevenueB)}</td>
                    <td>{billions(row.nandRevenueB)}</td>
                    <td>{percent(row.grossMargin, 1)}</td>
                    <td>{billions(row.ebitdaB)}</td>
                    <td>{money(row.eps, 2)}</td>
                    <td>{billions(row.fcfB)}</td>
                    <td>{billions(row.capexB)} <small>{percent(row.capexIntensity, 0)} of revenue</small></td>
                    <td className="uv-spcx-driver">{row.marginDriver}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </details>
            <details className="uv-subsection">
              <summary>HBM, legacy DRAM and NAND drivers (bit growth, ASP, margin)</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Year</th><th>HBM share of DRAM</th><th>HBM volume growth</th><th>HBM ASP change</th><th>DRAM bit growth</th><th>DRAM ASP change</th><th>NAND bit growth</th><th>NAND ASP change</th><th>HBM margin</th><th>DRAM margin</th><th>NAND margin</th></tr></thead>
                  <tbody>{mu.forecast.map((row) => <tr key={`drivers-${row.year}`}>
                    <td><strong>FY{row.year}</strong></td>
                    <td>{percent(row.hbmShareOfDram, 0)}</td>
                    <td>{row.hbmVolumeGrowth === null ? "anchor" : percent(row.hbmVolumeGrowth, 0, true)}</td>
                    <td>{row.hbmAspChange === null ? "anchor" : percent(row.hbmAspChange, 0, true)}</td>
                    <td>{row.dramBitGrowth === null ? "anchor" : percent(row.dramBitGrowth, 0, true)}</td>
                    <td>{row.dramAspChange === null ? "anchor" : percent(row.dramAspChange, 0, true)}</td>
                    <td>{row.nandBitGrowth === null ? "anchor" : percent(row.nandBitGrowth, 0, true)}</td>
                    <td>{row.nandAspChange === null ? "anchor" : percent(row.nandAspChange, 0, true)}</td>
                    <td>{percent(row.hbmGrossMargin, 0)}</td>
                    <td>{percent(row.legacyDramGrossMargin, 0)}</td>
                    <td>{percent(row.nandGrossMargin, 0)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">{mu.hbm.note}</p>
              <p className="uv-dense-note">{mu.legacy.note}</p>
            </details>
            <details className="uv-subsection">
              <summary>Segment view of the same engine (FY{mu.segmentBreakdown.year} EBITDA at {mu.segmentBreakdown.multiple.toFixed(1)}×)</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Segment</th><th>Revenue</th><th>Segment EBITDA</th><th>EBITDA margin</th><th>Enterprise value</th><th>Per share</th><th>Basis</th></tr></thead>
                  <tbody>{mu.segmentBreakdown.segments.map((segment) => <tr key={segment.name}>
                    <td><strong>{segment.name}</strong></td>
                    <td>{billions(segment.revenueB)}</td>
                    <td>{billions(segment.ebitdaB)}</td>
                    <td>{percent(segment.ebitdaMargin, 0)}</td>
                    <td>{billions(segment.enterpriseValueB)}</td>
                    <td>{money(segment.perShare, 2)}</td>
                    <td className="uv-spcx-driver">{segment.note}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">Segment enterprise value {billions(mu.segmentBreakdown.enterpriseValueB)} plus the corporate bridge gives {billions(mu.segmentBreakdown.equityValueB)} of equity value, or {money(mu.segmentBreakdown.perShare, 2)} per share. Same engine as the published value, shown as a segment cross-check.</p>
            </details>
            <details className="uv-subsection">
              <summary>Valuation methods and weights</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Method</th><th>Importance</th><th>Weight</th><th>Inputs</th><th>Value</th><th>Why</th></tr></thead>
                  <tbody>{mu.methods.map((method) => <tr key={method.method}>
                    <td><strong>{method.method}</strong></td>
                    <td>{method.importance}</td>
                    <td>{percent(method.weight, 0)}</td>
                    <td className="uv-spcx-driver">{method.inputs}</td>
                    <td>{money(method.value, 2)}</td>
                    <td className="uv-spcx-driver">{method.note}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">Weighted base fair value {money(mu.weightedFairValue, 2)}. Revenue multiples carry the smallest weight because they cannot see memory margins.</p>
              <p className="uv-kicker">Buy zone (expected-return based)</p>
              {mu.buyZone
                ? <p className="uv-dense-note">Buy {money(mu.buyZone.buyPrice, 2)} · Strong buy {money(mu.buyZone.strongBuyPrice, 2)} · future fair value {money(mu.buyZone.expectedFutureValue, 2)} compounding at {percent(mu.buyZone.expectedValueCagr, 1)} · required return {(mu.buyZone.requiredReturn * 100).toFixed(0)}%/{(mu.buyZone.strongBuyRequiredReturn * 100).toFixed(0)}% · {mu.buyZone.holdingPeriodYears}-year holding. {mu.buyZone.method}</p>
                : <p className="uv-dense-note warn">No buy zone is published while a data, model or sanity gate has not passed.</p>}
            </details>
            <details className="uv-subsection">
              <summary>Sanity checks: forward EPS, implied multiples and cash-flow yield</summary>
              <ul className="uv-dense-list">
                <li>Fair value ÷ FY2027 EPS <b>{mu.sanity.fairValueOverEps27?.toFixed(1) ?? "—"}×</b> · fair value ÷ FY2028 EPS <b>{mu.sanity.fairValueOverEps28?.toFixed(1) ?? "—"}×</b> · fair value ÷ normalized EPS <b>{mu.sanity.fairValueOverNormalizedEps?.toFixed(1) ?? "—"}×</b></li>
                <li>EV / FY2027 EBITDA <b>{mu.sanity.evEbitda27?.toFixed(1) ?? "—"}×</b> · EV / FY2028 EBITDA <b>{mu.sanity.evEbitda28?.toFixed(1) ?? "—"}×</b></li>
                <li>Free cash flow yield at fair value <b>{mu.sanity.fcfYieldAtFairValuePct === null ? "—" : `${mu.sanity.fcfYieldAtFairValuePct.toFixed(1)}%`}</b> · at the market price <b>{mu.sanity.fcfYieldAtPricePct === null ? "—" : `${mu.sanity.fcfYieldAtPricePct.toFixed(1)}%`}</b></li>
                <li>Forward EPS FY2027 <b>{money(mu.sanity.forwardEps27, 2)}</b>, FY2028 <b>{money(mu.sanity.forwardEps28, 2)}</b>, peak <b>{money(mu.sanity.peakEps, 2)}</b>, normalized <b>{money(mu.sanity.normalizedEps, 2)}</b> — {mu.sanity.normalizedEpsMethod}</li>
              </ul>
              <p className="uv-kicker">Why the implied P/E is justified</p>
              <ul className="uv-dense-list">{mu.sanity.lowMultipleJustification.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              {mu.sanity.flags.length ? <ul className="uv-dense-list">{mu.sanity.flags.map((flag) => <li key={flag} className="warn">{flag}</li>)}</ul> : null}
            </details>
            <details className="uv-subsection" open>
              <summary>Market-implied expectations: what the current price requires</summary>
              <ul className="uv-dense-list">{mu.marketImplied.explanation.map((line) => <li key={line}>{line}</li>)}</ul>
              <p className="uv-dense-note">{mu.consensus.note}</p>
            </details>
            <details className="uv-subsection">
              <summary>Structural change assessment and reported evidence</summary>
              <div className="uv-table-scroll" tabIndex={0}>
                <table className="uv-spcx-table">
                  <thead><tr><th>Driver</th><th>Reported evidence</th><th>Effect on the model</th></tr></thead>
                  <tbody>{mu.structuralChange.drivers.map((driver) => <tr key={driver.driver}>
                    <td><strong>{driver.driver}</strong></td>
                    <td className="uv-spcx-driver">{driver.evidence}</td>
                    <td className="uv-spcx-driver">{driver.effect}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <p className="uv-dense-note">{mu.structuralChange.historicalAverageNote}</p>
              <p className="uv-dense-note">Reported anchors: {mu.gateDetail.data}</p>
            </details>
          </section>
          );
        })() : null}

        <section className="uv-reconciliation" aria-label="Enterprise-to-equity reconciliation">
          <div className="uv-sectional-head">
            <h2>Enterprise-to-equity reconciliation</h2>
            <p>Every published fair value is reproducible from these lines. Dilution and stock compensation are shown when the model carries them, and the per-share check ties to the published fair value.</p>
          </div>
          <div className="uv-recon-grid">
            <dl className="uv-recon-lines">
              <div><dt>{recon.isSegmentBased ? "Segment / enterprise value" : "Implied enterprise value"}</dt><dd>{recon.enterpriseValueB === null ? "—" : billions(recon.enterpriseValueB)}</dd></div>
              <div><dt>+ Cash and investments</dt><dd>{data.capitalBridge ? billions(data.capitalBridge.cashB + data.capitalBridge.investmentsB) : "Not itemized"}</dd></div>
              <div><dt>− Debt</dt><dd>{data.capitalBridge ? billions(-data.capitalBridge.debtB) : "Not itemized"}</dd></div>
              <div><dt>− Other claims / preferreds</dt><dd>{data.capitalBridge?.otherClaimsB ? billions(-data.capitalBridge.otherClaimsB) : "None reported"}</dd></div>
              <div><dt>− Dilution / stock compensation</dt><dd>{data.reconciliation.dilutionB === null ? "Not modelled for this route" : billions(-data.reconciliation.dilutionB)}</dd></div>
              <div className="total"><dt>= Equity value</dt><dd>{data.reconciliation.equityValueB === null ? "—" : billions(data.reconciliation.equityValueB)}</dd></div>
              <div><dt>Diluted shares</dt><dd>{data.reconciliation.dilutedSharesB === null ? "—" : `${data.reconciliation.dilutedSharesB.toFixed(3)}B`}</dd></div>
              <div className="total"><dt>= Fair value per share</dt><dd>{money(data.reconciliation.perShare, 2)}</dd></div>
            </dl>
            <div className="uv-recon-check">
              <p className={data.reconciliation.matchesFairValue ? "ok" : "warn"}>
                {data.reconciliation.matchesFairValue
                  ? "Reconciles to the published fair value"
                  : data.reconciliation.perShare === null
                    ? "This route publishes a blended model average; the bridge is shown for the enterprise inputs it uses"
                    : `Bridge value ${money(data.reconciliation.perShare, 2)} differs from the published ${money(data.ensemble.fairValue, 2)} because the ensemble also blends ${data.engine.modelsIncluded} model outputs`}
              </p>
              <p>Net cash used by the models: {billions(data.aiBaseline.assumptions.netCashB)}. Stock compensation run-rate: {data.capitalBridge?.stockCompB ? `${billions(data.capitalBridge.stockCompB)}/year` : "not reported"}.</p>
            </div>
          </div>
        </section>

        <section className="uv-method-strip" aria-label="Valuation methods, drivers and sensitivities">
          <div>
            <p className="uv-kicker">Valuation methods and weights</p>
            <ul className="uv-weight-list">{data.models.filter((item) => item.role === "valuation").map((item) => <li key={item.model}>
              <span>{item.label}</span>
              <b>{item.status === "input_required" ? "no input" : percent(item.effectiveWeight, 0)}</b>
              <small>{item.status === "input_required" ? `needs ${item.missingInputs.join(", ") || "evidence"}` : `${percent(item.confidence, 0)} confidence · ${percent(item.priorReliability, 0)} prior weight`}</small>
            </li>)}</ul>
          </div>
          <div>
            <p className="uv-kicker">Key assumptions and drivers</p>
            <p className="uv-dense-copy">{assumptionText(data.aiBaseline.assumptions)}</p>
            <ul className="uv-dense-list">{data.classification.valuationDrivers.slice(0, 6).map((driver) => <li key={driver}>{driver}</li>)}</ul>
            {data.aiExposure ? <p className="uv-dense-note">
              AI exposure: {data.aiExposure.materiality.toLowerCase()} materiality, {data.aiExposure.exposureType.replaceAll("_", " ").toLowerCase()}.
              {data.aiExposure.standaloneSegments.length ? ` Standalone segment${data.aiExposure.standaloneSegments.length === 1 ? "" : "s"}: ${data.aiExposure.standaloneSegments.join(", ")} at ${data.aiExposure.probability !== null ? `${Math.round(data.aiExposure.probability * 100)}% delivery probability` : "modelled probability"}.` : " AI enters through the operating drivers already in the forecast, so no standalone AI value is added."}
              {" "}{data.aiExposure.doubleCountCheckPassed ? "Double-count check passed." : "DOUBLE-COUNT CHECK FAILED."}
            </p> : null}
            <p className="uv-dense-note">Driver schema: {data.engine.formula}</p>
          </div>
          <div>
            <p className="uv-kicker">Largest sensitivities</p>
            <ul className="uv-dense-list">
              {[...data.models].filter((item) => item.role === "valuation").sort((left, right) => right.effectiveWeight - left.effectiveWeight).slice(0, 2).map((item) => <li key={`s-${item.model}`}><b>{item.label}</b> carries the largest ensemble weight ({percent(item.effectiveWeight, 0)}).</li>)}
              {data.models.filter((item) => item.status === "input_required").map((item) => <li key={`m-${item.model}`}><b>{item.label}</b> produced no output: {item.missingInputs.join(", ") || "insufficient input"}.</li>)}
              <li>Reverse-DCF implied growth at the current price: <b>{percent(data.marketImpliedExpectations.impliedFcfCagr)}</b>.</li>
            </ul>
            <p className="uv-kicker">Evidence freshness</p>
            <ul className="uv-dense-list">
              <li>Price: {compactDate(data.currentPrice.asOf)} · {data.currentPrice.source}</li>
              <li>Model evidence: {evidenceDate} · {reportingBasis}</li>
              <li>{data.confidenceLabel} · {data.dataQuality.checks.filter((check) => check.status === "passed").length}/{data.dataQuality.checks.length} release checks passed</li>
            </ul>
          </div>
        </section>

        <section className={`uv-quality quality-${data.dataQuality.status}`}>
          <div><p className="uv-kicker">Model audit</p><h2>{data.dataQuality.status === "passed" ? "Inputs passed the current release checks" : data.dataQuality.status === "warning" ? "Use as a provisional screen only" : "Valuation withheld pending repair"}</h2></div>
          <div>{qualityIssues.length ? qualityIssues.slice(0, 4).map((check) => <p key={check.id}><strong>{check.label}</strong><span>{check.detail}</span></p>) : <p><strong>Release posture</strong><span>Units, periods, company route and primary model anchor passed.</span></p>}</div>
        </section>

        <section className="uv-implied">
          <div><p className="uv-kicker">Market-implied expectations</p><h2>What is the market already pricing in?</h2><p>{implied.headline}</p></div>
          <div className="uv-implied-metrics">
            <article><span>Implied FCF CAGR</span><strong>{percent(implied.impliedFcfCagr)}</strong></article>
            <article><span>Terminal FCF</span><strong>{billions(implied.terminalFcfB)}</strong></article>
            <article><span>Implied revenue</span><strong>{billions(implied.impliedRevenueB)}</strong></article>
            <article><span>Price / baseline EPS</span><strong>{implied.impliedForwardPe === null ? "—" : `${implied.impliedForwardPe.toFixed(1)}×`}</strong></article>
          </div>
        </section>

        <section className="uv-view-grid">
          <article className="baseline"><p className="uv-kicker">AI baseline</p><h2>Evidence before opinion</h2><strong>{data.dataQuality.valuationRelease === "withheld" ? "Company-specific operating inputs are incomplete; fallback assumptions are not released." : assumptionText(data.aiBaseline.assumptions)}</strong><p>Source posture: {data.aiBaseline.sourcePosture.replaceAll("_", " ")}. Baseline facts and forecasts are preserved separately from the research view.</p></article>
          <article className="thesis"><div><p className="uv-kicker">Signal Ledger view</p><h2>Adjust the assumptions, not the answer</h2></div><div className="uv-thesis-inputs">
            <label><span>Growth path Δ</span><input type="number" value={(growthDelta * 100).toFixed(1)} step="0.5" min="-20" max="20" onChange={(event) => setGrowthDelta(Number(event.target.value) / 100)} /><small>percent</small></label>
            <label><span>FCF margin Δ</span><input type="number" value={(marginDelta * 100).toFixed(1)} step="0.5" min="-15" max="15" onChange={(event) => setMarginDelta(Number(event.target.value) / 100)} /><small>points</small></label>
            <label><span>Multiple Δ</span><input type="number" value={(multipleDelta * 100).toFixed(1)} step="1" min="-50" max="50" onChange={(event) => setMultipleDelta(Number(event.target.value) / 100)} /><small>percent</small></label>
          </div><div className="uv-delta-line">{assumptionDelta.map((item) => <span key={item.label}>{item.label} <strong>{item.value}</strong></span>)}<button type="button" onClick={rerunView} disabled={loading}>Apply & rerun</button><button type="button" onClick={resetView}>Reset view</button></div><p>{data.signalLedgerThesis.adjustments.note}</p></article>
        </section>

        {aiPlanAvailable && data.aiOrchestration?.plan ? (
          <section className="uv-ai-review">
            <div>
              <p className="uv-kicker">AI model plan</p>
              <h2>Understood the issuer before choosing the math</h2>
              <p>{data.aiOrchestration.plan.rationale}</p>
              <small>{data.identity?.securityTicker ?? data.ticker} security → {data.identity?.issuerTicker ?? data.ticker} issuer · {data.aiOrchestration.routeOverrideApplied ? "route changed" : "route confirmed"}{data.aiOrchestration.cached ? " · cached review" : ""}</small>
            </div>
            <div>
              <span>VALUE DRIVERS</span>
              <ul>{data.aiOrchestration.plan.drivers.slice(0, 5).map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            {data.aiOrchestration.review ? <div>
              <span>INDEPENDENT REVIEW</span>
              <ul>{data.aiOrchestration.review.reviewNotes.slice(0, 4).map((item) => <li key={item}>{item}</li>)}</ul>
            </div> : null}
          </section>
        ) : null}

        <section className="uv-models">
          <div className="uv-section-head"><div><p className="uv-kicker">Valuation model breakdown</p><h2>How the ensemble earns its weight</h2></div><p>Effective weight = base weight × applicability × confidence × prior reliability weight. Missing or rejected models receive zero weight.</p></div>
          <div className="uv-table-scroll" tabIndex={0}><table><thead><tr><th>Model</th><th>Output</th><th>Base</th><th>Applicability</th><th>Confidence</th><th>Prior reliability</th><th>Effective</th><th>Role / evidence</th></tr></thead><tbody>{data.models.map((item) => <tr key={item.model} className={item.status === "input_required" ? "muted" : ""}><td><strong>{item.label}</strong><small>{item.model.replaceAll("_", " ")}</small></td><td>{item.role === "diagnostic" ? "Diagnostic" : money(item.value)}</td><td>{item.role === "diagnostic" ? "—" : percent(item.baseWeight, 0)}</td><td>{percent(item.applicability, 0)}</td><td>{percent(item.confidence, 0)}</td><td>{percent(item.priorReliability, 0)}</td><td>{item.role === "diagnostic" ? "—" : percent(item.effectiveWeight, 0)}</td><td>{item.status === "input_required" ? `Needs: ${item.missingInputs.join(", ") || "supporting data"}` : item.explanation}</td></tr>)}</tbody></table></div>
        </section>

        <section className="uv-probability">
          <div className="uv-section-head"><div><p className="uv-kicker">Assumption sensitivity, not a price forecast</p><h2>{data.engine.simulation?.reference === "routed_cross_checks" ? "Cross-check model sensitivity" : "Fair-value distribution"}</h2></div><span>{(data.engine.simulation?.validDraws ?? 0).toLocaleString("en-US")} valid input draws</span></div>
          <Distribution values={data.ensemble.probabilityDistribution} price={data.currentPrice.value} />
          {data.engine.simulation ? <details className="uv-technical">
            <summary>Simulation assumptions and limitations</summary>
            <div className="uv-empty-inline">
              <p>{data.engine.simulation.validDraws.toLocaleString("en-US")} valid / {data.engine.simulation.requestedDraws.toLocaleString("en-US")} requested · {data.engine.simulation.rejectedDraws.toLocaleString("en-US")} rejected · {data.engine.simulation.zeroEquityDraws.toLocaleString("en-US")} zero-equity outcomes retained. Seed: {data.engine.simulation.seed}.</p>
              <p>Varied inputs: {data.engine.simulation.sampledInputs.join(" · ") || "No eligible variable inputs"}.</p>
              <ul>{data.engine.simulation.limitations.map((note) => <li key={note}>{note}</li>)}</ul>
            </div>
          </details> : null}
        </section>

        <details className="uv-technical">
          <summary>Discount rates: evidence versus assumptions</summary>
          {data.engine.capitalCost ? <div className="uv-technical-grid">
            <section>
              <p className="uv-kicker">Observed rate</p>
              <h3>Treasury 10-year: {percent(data.engine.capitalCost.riskFree.value)}</h3>
              <p>As of {data.engine.capitalCost.riskFree.asOf}. Par yield used as a risk-free proxy.</p>
              <a href={data.engine.capitalCost.riskFree.url} target="_blank" rel="noreferrer">Treasury source ↗</a>
            </section>
            <section>
              <p className="uv-kicker">Calculated from returns</p>
              <h3>Beta: {data.engine.capitalCost.beta.value.toFixed(2)}</h3>
              <p>{data.engine.capitalCost.beta.observations} matched returns · {data.engine.capitalCost.beta.start}–{data.engine.capitalCost.beta.end} · R² {percent(data.engine.capitalCost.beta.rSquared)}.</p>
              <p>{data.engine.capitalCost.beta.source}</p>
            </section>
            <section>
              <p className="uv-kicker">Explicit assumptions</p>
              <h3>WACC {percent(data.engine.capitalCost.wacc)} · Equity cost {percent(data.engine.capitalCost.costOfEquity)}</h3>
              <p>Policy equity-risk premium: {percent(data.engine.capitalCost.equityRiskPremium.value)}. Policy credit spread: {percent(data.engine.capitalCost.creditSpread.value)}. Neither is an observed issuer quote.</p>
              <p>Weights use market equity {billions(data.engine.capitalCost.marketEquityB)} and book debt {billions(data.engine.capitalCost.bookDebtB)} as a debt market-value proxy.</p>
              <ul>{data.engine.capitalCost.warnings.map((note) => <li key={note}>{note}</li>)}</ul>
            </section>
          </div> : <div className="uv-empty-inline">
            <p>Model assumptions: WACC {percent(data.aiBaseline.assumptions.wacc ?? null)} · equity cost {percent(data.aiBaseline.assumptions.costOfEquity ?? null)}.</p>
            <p>{data.dataQuality.checks.find((check) => check.id === "capital-cost-source")?.detail ?? "These are model-specific assumptions. Sourced risk-free rate and historical beta are not available for this calculation."}</p>
          </div>}
        </details>

        <section className="uv-investor-grid">
          <article><p className="uv-kicker">Variant path</p><h2>What must outperform</h2><p>{data.investorRead.variantPath}</p></article>
          <article><p className="uv-kicker">What breaks first</p><h2>Downside mechanism</h2><p>{data.investorRead.downsideMechanism}</p></article>
          <article><p className="uv-kicker">What changes the view</p><h2>What changes the view</h2><p>{data.investorRead.evidenceGate}</p></article>
        </section>

        <details className="uv-technical">
          <summary>Model router, raw assumptions and evidence gaps</summary>
          <div className="uv-technical-grid">
            <section><p className="uv-kicker">Router coverage</p>{ROUTER_COVERAGE.map(([family, models]) => <div className="uv-family" key={family}><strong>{family}</strong><span>{models}</span></div>)}</section>
            <section><p className="uv-kicker">Selected route</p><dl><div><dt>Sector</dt><dd>{data.classification.sector}</dd></div><div><dt>Growth stage</dt><dd>{data.classification.growthStage}</dd></div><div><dt>Profitability</dt><dd>{data.classification.profitability}</dd></div><div><dt>Capital intensity</dt><dd>{data.classification.capitalIntensity}</dd></div><div><dt>Key drivers</dt><dd>{data.classification.valuationDrivers.join(" · ")}</dd></div><div><dt>Rating scale</dt><dd>{RATING_SCALE}</dd></div><div><dt>Baseline inputs</dt><dd>{assumptionText(data.aiBaseline.assumptions)}</dd></div><div><dt>Capital bridge</dt><dd>Net cash / (debt) {billions(data.aiBaseline.assumptions.netCashB)} · diluted shares {data.aiBaseline.assumptions.dilutedSharesB?.toFixed(2) ?? "—"}B</dd></div></dl></section>
            <section><p className="uv-kicker">Sources & evidence gaps</p><ul className="uv-source-list">{Object.entries(data.aiBaseline.inputSources ?? {}).slice(0, 8).map(([field, source]) => source ? <li key={field}><strong>{field.replaceAll("_", " ")}</strong><span>{source.kind.replaceAll("_", " ")} · {source.label}</span><span className="uv-source-provenance">{source.sourceType ? `${source.sourceType} · ` : ""}{source.unit ? `${source.unit} · ` : ""}{source.asOf ? `as of ${source.asOf} · ` : ""}confidence {percent(source.confidence ?? 0.5, 0)}</span>{source.transformation ? <span className="uv-source-chain">{source.transformation}</span> : null}</li> : null)}</ul><ul>{data.investorRead.evidenceMissing.map((item) => <li key={item}>{item}</li>)}</ul><p className="uv-disclaimer">Internal forecasts are derived from reported evidence and labeled explicitly. The engine does not claim access to proprietary trading systems.</p></section>
          </div>
        </details>

        <footer className="uv-footer"><strong>Signal Ledger</strong><p>Transparent valuation research. The Rating Engine is separate from Fair Value, and no model output places a trade or constitutes investment advice.</p><a href={`/api/valuation/${data.ticker}`} target="_blank" rel="noreferrer">Open valuation API ↗</a></footer>
      </div>
    </main>
  );
}
