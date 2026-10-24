// Phase 1 — NVDA per-model DCF bridge (deterministic, production-isolated).
//
// Recomputes the exact discounted-cash-flow mechanics that produce the published
// fair value, so every step (cash-flow path by year, discount rate, terminal
// growth, terminal value, PV of explicit flows, PV of terminal value, enterprise
// value, net cash, equity value, diluted shares, per-share value, and the
// Bear/Base/Bull construction) is bridged number-by-number.
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders } from "../tests/helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
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
  const researchPolicyUrl = dataUrl(await transpile("research-policy.ts"));
  const researchFirewallUrl = dataUrl(await transpile("research-firewall.ts"));
  const researchCheckUrl = dataUrl(await transpile("research-check.ts"));
  const researchValidateUrl = dataUrl(await transpile("research-validate.ts", [
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
  ]));
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
  const researchToolsUrl = dataUrl(await transpile("research-tools.ts", [
    ['from "./valuation-data"', `from "${packUrl}"`],
  ]));
  const valuationAiUrl = dataUrl(await transpile("valuation-ai.ts", [
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./valuation-data"', `from "${packUrl}"`],
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./research-compiler"', `from "${researchCompilerUrl}"`],
    ['from "./research-check"', `from "${researchCheckUrl}"`],
    ['from "./research-firewall"', `from "${researchFirewallUrl}"`],
    ['from "./research-tools"', `from "${researchToolsUrl}"`],
    ['from "./research-policy"', `from "${researchPolicyUrl}"`],
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
    ['from "./research-validate"', `from "${researchValidateUrl}"`],
  ]));

  const engine = await import(valuationUrl);
  const packMod = await import(packUrl);
  const researchCompiler = await import(researchCompilerUrl);
  const valuationAi = await import(valuationAiUrl);
  return { engine, packMod, researchCompiler, valuationAi };
}

installProviders();

const m = await loadAll();
const pack = await m.packMod.buildAutomatedValuationPack("NVDA");
const price = pack.quote?.price ?? null;

const plan = m.valuationAi.deterministicResearchPlan(pack);
const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
const output = m.engine.runValuationProfile(compiled.profile, { currentPrice: price });

const a = compiled.profile.baseline;
const equityBasis = a.cashFlowBasis === "cfo_capex_proxy" || a.cashFlowBasis === "fcfe_equity";
const rate = equityBasis ? a.costOfEquity : a.wacc;
const g = a.terminalGrowth;
const sharesB = a.dilutedSharesB;
const netCashB = a.netCashB ?? null;
const cashFlows = a.cashFlows ?? [];

const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? "n/a" : Number(v).toFixed(2);
const pct = (v) => (v === null || v === undefined) ? "n/a" : (Number(v) * 100).toFixed(2) + "%";

const discountFactors = cashFlows.map((_, i) => (1 + rate) ** (i + 1));
const pvs = cashFlows.map((cf, i) => cf / discountFactors[i]);
const pvExplicit = pvs.reduce((s, v) => s + v, 0);
const terminalCashFlow = cashFlows.length ? cashFlows.at(-1) * (1 + g) : 0;
const terminalValue = terminalCashFlow / (rate - g);
const pvTerminal = terminalValue / (1 + rate) ** cashFlows.length;
const enterpriseValue = pvExplicit + pvTerminal;
const equityValue = equityBasis ? (pvExplicit + pvTerminal) : (pvExplicit + pvTerminal + netCashB);
const perShare = equityValue / sharesB;

console.log("=============== NVDA — deterministic DCF bridge ===============\n");
console.log(`model family        : ${compiled.profile.classification.modelFamily}`);
console.log(`primary method      : ${plan.primaryMethod}  (aggregation: ${plan.aggregationRule})`);
console.log(`cash-flow basis     : ${a.cashFlowBasis}  ${equityBasis ? "(EQUITY basis — discounts at cost of equity, NO net-cash bridge)" : "(UNLEVERED basis — discounts at WACC + net-cash bridge)"}`);
console.log(`current price       : $${fmt(price)}`);
console.log(`\n-- cash-flow path (${cashFlows.length} years) --`);
console.log("year | cashFlow(B) | discount factor | PV(B)");
for (let i = 0; i < cashFlows.length; i += 1) {
  console.log(`  ${String(i + 1).padEnd(3)} | ${String(fmt(cashFlows[i])).padEnd(11)} | ${discountFactors[i].toFixed(6).padEnd(15)} | ${fmt(pvs[i])}`);
}
console.log(`\ndiscount rate       : ${pct(rate)}  ${equityBasis ? "(cost of equity)" : "(WACC)"}`);
console.log(`terminal growth g   : ${pct(g)}`);
console.log(`terminal cash flow  : ${fmt(terminalCashFlow)} B  (= last CF ${fmt(cashFlows.at(-1))} × (1+g))`);
console.log(`terminal value      : ${fmt(terminalValue)} B  (= terminal CF / (r − g) = ${fmt(terminalCashFlow)} / ${(rate - g).toFixed(4)})`);
console.log(`PV of explicit CFs  : ${fmt(pvExplicit)} B`);
console.log(`PV of terminal value: ${fmt(pvTerminal)} B  (= ${fmt(terminalValue)} / (1+r)^${cashFlows.length})`);
console.log(`enterprise value    : ${fmt(enterpriseValue)} B  (= PV explicit + PV terminal)`);
if (!equityBasis) {
  console.log(`net cash (bridge)   : ${fmt(netCashB)} B`);
  console.log(`equity value        : ${fmt(equityValue)} B  (= EV + net cash)`);
} else {
  console.log(`net cash            : (not bridged — already inside levered stream)`);
  console.log(`equity value        : ${fmt(equityValue)} B  (= PV explicit + PV terminal, equity basis)`);
}
console.log(`diluted shares      : ${fmt(sharesB)} B`);
console.log(`per-share DCF       : $${fmt(perShare)}  (= equity value / shares)`);
console.log(`\nengine fair value   : $${fmt(output.ensemble.fairValue)}  (must equal per-share DCF)`);

console.log(`\n-- Bear / Base / Bull construction --`);
const dist = output.ensemble.probabilityDistribution;
console.log(`Monte Carlo            : simulateValuationDistribution "business_input_sensitivity_v1", 25,000 draws`);
console.log(`family uncertainty u   : 0.25 (ai_compute_platform policy)`);
console.log(`sampled DCF inputs     : annual CF growth log-shift ±5.00%, cash-conversion ±12.5%, cost of equity ±0.75pp, terminal growth ±0.25pp`);
console.log(`correlations           : growth/conversion 0.50 · rate/multiple −0.35 (only inputs used by the DCF affect the result)`);
console.log(`distribution p10/p50/p90 = $${fmt(dist?.p10)} / $${fmt(dist?.p50)} / $${fmt(dist?.p90)}`);
console.log(`published scenarios       = bear $${fmt(output.ensemble.scenarios.bear)} / base $${fmt(output.ensemble.scenarios.base)} / bull $${fmt(output.ensemble.scenarios.bull)}`);
console.log(`construction             : base = deterministic fair value ($${fmt(output.ensemble.fairValue)}, the model blend); bear = p10; bull = p90 of the Monte Carlo distribution`);

console.log(`\n-- per-model deterministic output --`);
for (const mm of output.models) {
  const weight = mm.effectiveWeight ?? 0;
  console.log(`  ${mm.model.padEnd(16)} value=$${fmt(mm.value)}  effWeight=${fmt(weight)}  status=${mm.status}  missing=[${(mm.missingInputs ?? []).join(",")}]`);
  if (mm.explanation) console.log(`      ${mm.explanation}`);
}

console.log(`\n-- evidence assumptions feeding the DCF --`);
console.log(`forwardRevenueB = ${fmt(a.forwardRevenueB)} · fcfMargin = ${pct(a.fcfMargin)} · costOfEquity = ${pct(a.costOfEquity)} · wacc = ${pct(a.wacc)} · terminalGrowth = ${pct(a.terminalGrowth)}`);
console.log(`netCashB = ${fmt(a.netCashB)} · dilutedSharesB = ${fmt(a.dilutedSharesB)} · cashFlowBasis = ${a.cashFlowBasis}`);
