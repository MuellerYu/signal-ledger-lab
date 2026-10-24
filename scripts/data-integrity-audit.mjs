// Data-integrity audit — trace every SEC fact the deterministic engine uses, for
// NVDA and AMD, against REAL companyfacts (read-only SEC EDGAR fetch, no synthetic
// fixture, no production D1 mutation). This is the "Section 1–5" trace the user
// asked for: source function → concept → accession → filing → period → frame →
// units → raw value → normalized value.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function loadValuationData() {
  const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = {};"]]));
  const snapshotCacheUrl = dataUrl(await transpile("snapshot-cache.ts"));
  const issuerUrl = dataUrl(await transpile("issuer-intelligence.ts", [['from "./runtime"', `from "${runtimeUrl}"`]]));
  const aiExposureUrl = dataUrl(await transpile("ai-exposure.ts"));
  const spcxUrl = dataUrl(await transpile("spcx-valuation.ts"));
  const muUrl = dataUrl(await transpile("mu-valuation.ts"));
  const capitalCostUrl = dataUrl(await transpile("valuation-capital-cost.ts", [
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
    ['import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";', 'const configuredFeed = () => "iex"; const fetchDailyAdjustedBars = async () => new Map();'],
  ]));
  const valuationUrl = dataUrl(await transpile("universal-valuation.ts", [
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./mu-valuation"', `from "${muUrl}"`],
  ]));
  const researchHashUrl = dataUrl(await transpile("research-hash.ts"));
  const packUrl = dataUrl(await transpile("valuation-data.ts", [
    ['import { calculateCapitalCost, loadCapitalCostMarketInputs } from "./valuation-capital-cost";', `import { calculateCapitalCost, loadCapitalCostMarketInputs as loadMarketInputs } from "${capitalCostUrl}";
const loadCapitalCostMarketInputs = (ticker) => globalThis.__capitalIntegrationMarket ? Promise.resolve(globalThis.__capitalIntegrationMarket) : loadMarketInputs(ticker);`],
    ['from "./valuation-capital-cost"', `from "${capitalCostUrl}"`],
    ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./ai-exposure"', `from "${aiExposureUrl}"`],
    ['from "./spcx-valuation"', `from "${spcxUrl}"`],
    ['from "./mu-valuation"', `from "${muUrl}"`],
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./research-hash"', `from "${researchHashUrl}"`],
    // Expose the internal fact-selection helpers so the lineage can be traced.
    ['function deriveAssumptions(', 'export function deriveAssumptions('],
    ['function latestDurationShares(', 'export function latestDurationShares('],
    ['function latestInstant(', 'export function latestInstant('],
    ['function latestAnnual(', 'export function latestAnnual('],
    ['function annualSeries(', 'export function annualSeries('],
    ['function trailingPoint(', 'export function trailingPoint('],
    ['function units(', 'export function units('],
  ]));
  return import(packUrl);
}

const SEC_HEADERS = { accept: "application/json", "user-agent": "Signal Ledger/1.0 owner@example.com" };
async function fetchFacts(cik) {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`;
  const r = await fetch(url, { headers: SEC_HEADERS });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

const m = await loadValuationData();
const audit = (ticker, cik, family) => ({ ticker, cik, family, facts: fetchFacts(cik) });
const NVDA = audit("NVDA", 1045810, "ai_compute_platform");
const AMD = audit("AMD", 2488, "ai_semiconductor");

for (const target of [NVDA, AMD]) {
  const facts = await target.facts;
  const derived = m.deriveAssumptions(facts, target.family);
  const a = derived.assumptions;
  const equityBasis = a.cashFlowBasis === "cfo_capex_proxy" || a.cashFlowBasis === "fcfe_equity";
  const rate = equityBasis ? a.costOfEquity : a.wacc;
  const g = a.terminalGrowth;
  const sharesB = a.dilutedSharesB;
  const netCashB = equityBasis ? 0 : (a.netCashB ?? null);
  const cashFlows = a.cashFlows ?? [];
  const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "n/a" : Number(v).toFixed(2);
  const pct = (v) => (v === null || v === undefined) ? "n/a" : (Number(v) * 100).toFixed(2) + "%";
  const pvs = cashFlows.map((cf, i) => cf / (1 + rate) ** (i + 1));
  const pvExplicit = pvs.reduce((s, v) => s + v, 0);
  const terminalCashFlow = cashFlows.length ? cashFlows.at(-1) * (1 + g) : 0;
  const terminalValue = terminalCashFlow / (rate - g);
  const pvTerminal = terminalValue / (1 + rate) ** cashFlows.length;
  const enterpriseValue = pvExplicit + pvTerminal;
  const equityValue = equityBasis ? enterpriseValue : enterpriseValue + netCashB;
  const perShare = equityValue / sharesB;

  console.log(`\n================ ${target.ticker} (${target.family}) ================`);
  console.log(`entityName        : ${facts.entityName}`);
  console.log(`cashFlowBasis     : ${derived.cashFlowBasis}${equityBasis ? "  (EQUITY — cost of equity, NO net-cash bridge)" : "  (UNLEVERED — WACC + net-cash bridge)"}`);
  console.log(`  useFcffBridge   : ${derived.useFcffBridge}   useFcffBeforeNwc: ${derived.useFcffBeforeNwc}   nwcChangeReported: ${derived.nwcChangeReported}`);
  console.log(`  effectiveTaxRate: ${(derived.effectiveTaxRate * 100).toFixed(1)}%  (basis: ${derived.taxRateBasis})  cashTaxRate: ${derived.cashTaxRate === null ? "n/a" : (derived.cashTaxRate * 100).toFixed(1) + "%"}`);
  console.log(`  costOfEquity    : ${(derived.costOfEquity * 100).toFixed(2)}%  (${derived.costOfEquitySource})  wacc: ${(a.wacc * 100).toFixed(2)}%  terminalGrowth: ${(a.terminalGrowth * 100).toFixed(2)}%`);
  console.log(`  latestRevenueB  : ${fmt(derived.latestRevenueB)}  nextGrowth: ${(derived.nextGrowth * 100).toFixed(2)}%  forwardMargin: ${(derived.forwardMargin * 100).toFixed(2)}%`);
  console.log(`  latestFiled     : ${derived.latestFiled}  periodBasis: ${derived.periodBasis}  hasFullFiscalYear: ${derived.hasFullFiscalYear}`);

  console.log(`\n-- Section 1: share-count lineage (raw → normalized) --`);
  const wa = m.latestDurationShares(facts, ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"]);
  const os = m.latestInstant(facts, ["EntityCommonStockSharesOutstanding"], "shares", "dei");
  const ann = m.latestAnnual(facts, ["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares");
  console.log(`  durationDiluted  : ${wa ? (wa.value / 1e9).toFixed(3) + "B  end=" + wa.end + " days=" + wa.days : "null"}`);
  console.log(`  outstanding      : ${os ? (os.value / 1e9).toFixed(3) + "B  end=" + os.end + " form=" + os.form : "null"}`);
  console.log(`  annualDiluted    : ${ann ? (ann.value / 1e9).toFixed(3) + "B  end=" + ann.end : "null"}`);
  console.log(`  SELECTED sharesB : ${fmt(a.dilutedSharesB)} B   (weightedAvgDiluted=${fmt(derived.weightedAverageDilutedSharesB)}  weightedAvgBasic=${fmt(derived.weightedAverageBasicSharesB)}  periodEndBasic=${fmt(derived.periodEndBasicSharesB)})`);
  for (const f of (facts.facts?.["us-gaap"]?.["WeightedAverageNumberOfDilutedSharesOutstanding"]?.units?.shares ?? []).slice().sort((x, y) => (x.end ?? "").localeCompare(y.end ?? "")).slice(-3)) {
    console.log(`      raw: val=${f.val} ${f.start}..${f.end} form=${f.form} fy=${f.fy} fp=${f.fp} accn=${f.accn} units=shares`);
  }

  console.log(`\n-- Section 2 & 7: DCF bridge --`);
  console.log(`  discount rate     : ${pct(rate)}  (${equityBasis ? "cost of equity" : "WACC"})`);
  console.log(`  year | cashFlow(B) | discount factor | PV(B)`);
  for (let i = 0; i < cashFlows.length; i += 1) {
    console.log(`    ${i + 1}  | ${String(fmt(cashFlows[i])).padEnd(11)} | ${(1 + rate) ** (i + 1).toFixed(6)} | ${fmt(pvs[i])}`);
  }
  console.log(`  PV explicit       : ${fmt(pvExplicit)} B`);
  console.log(`  terminal cash flow: ${fmt(terminalCashFlow)} B  (= last CF ${fmt(cashFlows.at(-1))} × (1+g))`);
  console.log(`  terminal value    : ${fmt(terminalValue)} B  (= ${fmt(terminalCashFlow)} / (${(rate - g).toFixed(4)}))`);
  console.log(`  PV of terminal    : ${fmt(pvTerminal)} B  (= ${fmt(terminalValue)} / (1+r)^${cashFlows.length})`);
  console.log(`  enterprise value  : ${fmt(enterpriseValue)} B`);
  console.log(`  net cash (bridge) : ${equityBasis ? "(none — levered stream)" : fmt(netCashB) + " B"}`);
  console.log(`  equity value      : ${fmt(equityValue)} B`);
  console.log(`  diluted shares    : ${fmt(sharesB)} B`);
  console.log(`  per-share DCF     : $${fmt(perShare)}  (= equity / shares)`);
}
