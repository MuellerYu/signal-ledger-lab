// DEBUG ONLY (read-only): reproduce the NVDA compile→value step deterministically
// from the plan captured in research-live-run-report.json. No OpenAI call, no
// production write. Prints the compiled baseline, per-model outputs, and the
// dataQuality checks that gate fairValue, to find why fairValue is null.
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders, TICKERS, QUOTES, SPCX_FILING_TEXT } from "../tests/helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const SEC_HEADERS = { accept: "application/json", "user-agent": "Signal Ledger/1.0 owner@example.com" };

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// Same surgical shim as research-live-run.mjs (real SEC for NVDA, no OpenAI needed here).
let realFetch;
async function getTickerDirectory() {
  let real = {};
  try {
    const res = await realFetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
    real = await res.json();
  } catch { real = {}; }
  const dir = { ...real };
  const known = { AMD: 2488, NVDA: 1045810, OKLO: 1849056, SPCX: 1900001 };
  let next = Math.max(-1, ...Object.keys(dir).map(Number)) + 1;
  for (const [ticker, cik] of Object.entries(known)) {
    const hit = Object.entries(dir).find(([, v]) => v && v.ticker === ticker);
    if (hit) dir[hit[0]] = { cik_str: cik, ticker, title: hit[1].title };
    else dir[String(next++)] = { cik_str: cik, ticker, title: ticker };
  }
  return dir;
}

async function loadAll() {
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
  const researchPlanUrl = dataUrl(await transpile("research-plan.ts"));
  const researchCheckUrl = dataUrl(await transpile("research-check.ts"));
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
  ]));
  const researchCompilerUrl = dataUrl(await transpile("research-compiler.ts", [
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./research-hash"', `from "${researchHashUrl}"`],
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
  ]));
  const engine = await import(valuationUrl);
  const packMod = await import(packUrl);
  const researchCompiler = await import(researchCompilerUrl);
  return { engine, packMod, researchCompiler };
}

realFetch = globalThis.fetch.bind(globalThis);
installProviders();
const fixtureFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://www.sec.gov/files/company_tickers.json")) return Response.json(await getTickerDirectory());
  const isSpcx = url.includes("1900001");
  const isSec = url.startsWith("https://data.sec.gov/") || url.startsWith("https://www.sec.gov/Archives/");
  if (isSec && !isSpcx) return realFetch(input, init);
  return fixtureFetch(input, init);
};

const { engine, packMod, researchCompiler } = await loadAll();

const report = JSON.parse(await readFile(new URL("../tests/fixtures/research-live-run-report.json", import.meta.url), "utf8"));
const plan = report.tickers.NVDA.plan;

const pack = await packMod.buildAutomatedValuationPack("NVDA");
console.log("=== pack.profile.classification.modelFamily ===", pack.profile.classification.modelFamily);
console.log("=== pack.profile.capitalCost ===", JSON.stringify(pack.profile.capitalCost));
console.log("=== pack.evidenceAssumptions (key scalars) ===", JSON.stringify({
  wacc: pack.evidenceAssumptions.wacc,
  costOfEquity: pack.evidenceAssumptions.costOfEquity,
  terminalGrowth: pack.evidenceAssumptions.terminalGrowth,
  netCashB: pack.evidenceAssumptions.netCashB,
  dilutedSharesB: pack.evidenceAssumptions.dilutedSharesB,
  fcfMargin: pack.evidenceAssumptions.fcfMargin,
  forwardRevenueB: pack.evidenceAssumptions.forwardRevenueB,
  cashFlowBasis: pack.evidenceAssumptions.cashFlowBasis,
  cashFlows: pack.evidenceAssumptions.cashFlows,
}));

let compiled;
try {
  compiled = researchCompiler.compileResearchPlan(pack, plan);
} catch (e) {
  console.log("=== compileResearchPlan THREW ===", e.message);
  process.exit(1);
}
console.log("=== compiled.baseline (key scalars) ===", JSON.stringify({
  wacc: compiled.profile.baseline.wacc,
  costOfEquity: compiled.profile.baseline.costOfEquity,
  terminalGrowth: compiled.profile.baseline.terminalGrowth,
  netCashB: compiled.profile.baseline.netCashB,
  dilutedSharesB: compiled.profile.baseline.dilutedSharesB,
  fcfMargin: compiled.profile.baseline.fcfMargin,
  forwardRevenueB: compiled.profile.baseline.forwardRevenueB,
  cashFlows: compiled.profile.baseline.cashFlows,
  normalizedCashFlows: compiled.profile.baseline.normalizedCashFlows,
}));

const output = engine.runValuationProfile(compiled.profile, { currentPrice: pack.quote?.price ?? null });
console.log("=== output.ensemble.fairValue ===", output.ensemble.fairValue);
console.log("=== output.ensemble.scenarios ===", JSON.stringify(output.ensemble.scenarios));
console.log("=== output.dataQuality.status ===", output.dataQuality.status);
console.log("=== output.dataQuality.valuationRelease ===", output.dataQuality.valuationRelease);
console.log("=== output.engine ===", JSON.stringify(output.engine));
console.log("=== per-model outputs ===");
for (const mm of output.models ?? []) {
  console.log(`  ${mm.model} (${mm.role}) value=${mm.value} status=${mm.status} applicability=${mm.applicability} effectiveWeight=${mm.effectiveWeight} missing=[${mm.missingInputs.join(",")}]`);
}
console.log("=== dataQuality checks ===");
for (const c of output.dataQuality.checks) {
  console.log(`  [${c.status}] ${c.id}: ${c.detail}`);
}
