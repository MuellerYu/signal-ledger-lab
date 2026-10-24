import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";
import { getBindings } from "./runtime";
import { createSnapshotCache } from "./snapshot-cache";

const DAY = 86_400_000;
const TREASURY = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
const treasuryCache = createSnapshotCache({ freshMs: DAY / 2, staleMs: DAY * 3, retryMs: 300_000 });
const betaCache = createSnapshotCache({ freshMs: DAY / 2, staleMs: DAY * 3, retryMs: 300_000 });
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export type RiskFreeObservation = { value: number; asOf: string; source: string; url: string };
export type HistoricalBeta = { value: number; rSquared: number; observations: number; start: string; end: string; benchmark: "SPY"; source: string };
export type CapitalCostMarketInputs = { riskFree: RiskFreeObservation | null; beta: HistoricalBeta | null; warnings: string[] };
export type CapitalCostEstimate = {
  method: "capm_market_inputs";
  costOfEquity: number;
  wacc: number;
  preTaxCostOfDebt: number;
  riskFree: RiskFreeObservation;
  beta: HistoricalBeta;
  equityRiskPremium: { value: number; source: string };
  creditSpread: { value: number; source: string };
  marketEquityB: number;
  bookDebtB: number;
  taxRate: number;
  warnings: string[];
};

/** Treasury publishes percent units. Missing, stale and future observations are
 * rejected, not replaced with a zero-rate assumption. */
export function parseTreasury10Year(xml: string, asOf: string): RiskFreeObservation | null {
  const observations: RiskFreeObservation[] = [];
  const today = Date.parse(asOf.slice(0, 10));
  if (!Number.isFinite(today)) return null;
  for (const entry of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const date = entry[1].match(/<d:NEW_DATE\b[^>]*>([^<]+)<\/d:NEW_DATE>/)?.[1]?.slice(0, 10);
    const raw = entry[1].match(/<d:BC_10YEAR\b[^>]*>\s*([\d.]+)\s*<\/d:BC_10YEAR>/)?.[1];
    if (!date || raw === undefined) continue;
    const age = today - Date.parse(date);
    const value = Number(raw) / 100;
    if (age < 0 || age > 10 * DAY || !Number.isFinite(age) || !positive(value) || value > 0.2) continue;
    observations.push({ value, asOf: date, source: "U.S. Treasury 10-year par yield (risk-free proxy)", url: `${TREASURY}?data=daily_treasury_yield_curve&field_tdr_date_value=${date.slice(0, 4)}` });
  }
  return observations.sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null;
}

/** OLS with intercept on matched daily adjusted returns. Never bridge over a
 * missing issuer trading session or mix raw and split-adjusted prices. */
export function estimateHistoricalBeta(stock: Map<string, number>, benchmark: Map<string, number>, asOf: string): HistoricalBeta | null {
  const end = Date.parse(asOf.slice(0, 10));
  const dates = [...benchmark.keys()].filter((date) => Date.parse(date) <= end && Date.parse(date) >= end - 730 * DAY).sort();
  const pairs: Array<{ stock: number; market: number; start: string; end: string }> = [];
  for (let index = 1; index < dates.length; index += 1) {
    const prior = dates[index - 1];
    const current = dates[index];
    const s0 = stock.get(prior); const s1 = stock.get(current);
    const m0 = benchmark.get(prior); const m1 = benchmark.get(current);
    if (![s0, s1, m0, m1].every(positive) || Date.parse(current) - Date.parse(prior) > 7 * DAY) continue;
    pairs.push({ stock: s1! / s0! - 1, market: m1! / m0! - 1, start: prior, end: current });
  }
  if (pairs.length < 126 || end - Date.parse(pairs.at(-1)!.end) > 10 * DAY) return null;
  const meanS = pairs.reduce((sum, p) => sum + p.stock, 0) / pairs.length;
  const meanM = pairs.reduce((sum, p) => sum + p.market, 0) / pairs.length;
  let covariance = 0; let varianceM = 0; let varianceS = 0;
  for (const p of pairs) {
    covariance += (p.stock - meanS) * (p.market - meanM);
    varianceM += (p.market - meanM) ** 2;
    varianceS += (p.stock - meanS) ** 2;
  }
  if (varianceM < 1e-8 || varianceS < 1e-8) return null;
  const value = covariance / varianceM;
  if (!Number.isFinite(value) || value < -1 || value > 5) return null;
  return {
    value, rSquared: Math.min(1, covariance ** 2 / (varianceM * varianceS)), observations: pairs.length,
    start: pairs[0].start, end: pairs.at(-1)!.end, benchmark: "SPY",
    source: "OLS daily adjusted returns versus SPY; up to 2 years, at least 126 matched returns",
  };
}

/** Explicit policy ERP/spread are not passed off as observed market premiums.
 * Debt book value is a disclosed approximation to debt market value. */
export function calculateCapitalCost(input: {
  market: CapitalCostMarketInputs; price: number | null; sharesB: number | undefined;
  debtB: number | null; taxRate: number | undefined; terminalGrowth: number | undefined;
  equityRiskPremium?: number; creditSpread?: number;
}): CapitalCostEstimate | null {
  const { riskFree, beta } = input.market;
  const erp = input.equityRiskPremium ?? 0.045;
  const spread = input.creditSpread ?? 0.02;
  if (!riskFree || !beta || !positive(input.price) || !positive(input.sharesB)
    || input.debtB === null || !Number.isFinite(input.debtB) || input.debtB < 0
    || input.taxRate === undefined || !Number.isFinite(input.taxRate) || input.taxRate < 0 || input.taxRate > 0.6
    || !positive(erp) || erp > 0.12 || !Number.isFinite(spread) || spread < 0 || spread > 0.15) return null;
  const marketEquityB = input.price * input.sharesB;
  const costOfEquity = riskFree.value + beta.value * erp;
  const preTaxCostOfDebt = riskFree.value + spread;
  const wacc = (marketEquityB * costOfEquity + input.debtB * preTaxCostOfDebt * (1 - input.taxRate)) / (marketEquityB + input.debtB);
  if (!Number.isFinite(wacc) || wacc < 0.04 || wacc > 0.2 || costOfEquity < 0.04 || costOfEquity > 0.3
    || (input.terminalGrowth !== undefined && (!Number.isFinite(input.terminalGrowth) || Math.min(wacc, costOfEquity) <= input.terminalGrowth))) return null;
  return {
    method: "capm_market_inputs", costOfEquity, wacc, preTaxCostOfDebt, riskFree, beta,
    equityRiskPremium: { value: erp, source: "Signal Ledger policy assumption; not an observed or fitted market premium" },
    creditSpread: { value: spread, source: "Signal Ledger policy assumption; not an issuer bond quote or credit rating" },
    marketEquityB, bookDebtB: input.debtB, taxRate: input.taxRate,
    warnings: [...input.market.warnings,
      "Treasury par yield is a risk-free proxy. ERP and credit spread remain explicit policy assumptions; book debt approximates debt market value.",
      ...(beta.rSquared < 0.15 ? ["Low regression R²: the market proxy explains little of the stock's daily variation."] : []),
    ],
  };
}

async function fetchTreasury(asOf: string): Promise<RiskFreeObservation> {
  const year = Number(asOf.slice(0, 4));
  for (const candidate of [year, year - 1]) {
    const response = await fetch(`${TREASURY}?data=daily_treasury_yield_curve&field_tdr_date_value=${candidate}`, {
      headers: { accept: "application/xml" }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("TREASURY_UNAVAILABLE");
    const rate = parseTreasury10Year(await response.text(), asOf);
    if (rate) return rate;
    // Only early January needs the prior year's last trading day.
    if (asOf.slice(5, 10) > "01-10") break;
  }
  throw new Error("TREASURY_STALE_OR_MISSING");
}

export async function loadCapitalCostMarketInputs(ticker: string): Promise<CapitalCostMarketInputs> {
  const bindings = getBindings();
  if (!bindings.ALPACA_API_KEY_ID || !bindings.ALPACA_API_SECRET_KEY) return { riskFree: null, beta: null, warnings: ["Adjusted equity history is not configured; existing discount-rate assumptions are retained."] };
  const asOf = new Date().toISOString().slice(0, 10);
  const feed = configuredFeed();
  const [riskResult, betaResult] = await Promise.allSettled([
    treasuryCache("https://signal-ledger-cache.local/capital-cost/treasury-10y-v1", async () => ({ rate: await fetchTreasury(asOf) })),
    betaCache(`https://signal-ledger-cache.local/capital-cost/beta-v1/${encodeURIComponent(ticker)}?feed=${feed}`, async () => {
      const start = new Date(Date.parse(asOf) - 730 * DAY).toISOString().slice(0, 10);
      // End at today's UTC midnight, so a partial current trading day is excluded.
      const bars = await fetchDailyAdjustedBars([ticker, "SPY"], { start, end: `${asOf}T00:00:00Z`, feed });
      const beta = estimateHistoricalBeta(bars.get(ticker) ?? new Map(), bars.get("SPY") ?? new Map(), asOf);
      if (!beta) throw new Error("BETA_INSUFFICIENT_HISTORY");
      return { beta: { ...beta, source: `Alpaca ${feed.toUpperCase()}, adjustment=all. ${beta.source}` } };
    }),
  ]);
  const rateCandidate = riskResult.status === "fulfilled" ? riskResult.value.value.rate as RiskFreeObservation : null;
  const betaCandidate = betaResult.status === "fulfilled" ? betaResult.value.value.beta as HistoricalBeta : null;
  const fresh = (date: string) => Date.parse(asOf) - Date.parse(date) >= 0 && Date.parse(asOf) - Date.parse(date) <= 10 * DAY;
  const riskFree = rateCandidate && fresh(rateCandidate.asOf) ? rateCandidate : null;
  const beta = betaCandidate && fresh(betaCandidate.end) ? betaCandidate : null;
  return {
    riskFree,
    beta,
    warnings: [
      ...(!riskFree ? ["Recent Treasury 10-year observation unavailable."] : []),
      ...(!beta ? ["Insufficient or unavailable split-adjusted return history for beta."] : []),
      ...(feed === "iex" ? ["IEX is a single-venue price sample, not a consolidated market close."] : []),
    ],
  };
}
