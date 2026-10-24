// P0-R1 follow-up acceptance tests, written independently of the R1 implementation.
// Run in the ORIGINAL repository: node --test tests/p0-r1-boundary-regression.test.mjs
// Uses the supplied transpile-and-import loader and local provider fixtures.
// No network, paid AI, production D1 or authorization changes.
// R1-01/R1-02 assert price isolation; R1-C01..C10 retain the successful fixes.
// Input fixtures are synthetic and are not real-company valuations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders } from "./helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const match of [...code.matchAll(/from "(\.\/company-business\/[^"]+)"/g)]) {
    const dependency = match[1];
    code = code.replaceAll(`from "${dependency}"`, `from "${dataUrl(await transpile(`${dependency.slice(2)}.ts`))}"`);
  }
  if (code.includes('from "./research-isolation"')) {
    code = code.replaceAll('from "./research-isolation"', `from "${dataUrl(await transpile("research-isolation.ts"))}"`);
  }
  for (const dependency of ["research-schema", "research-plan", "research-validate"]) {
    if (code.includes(`from "./${dependency}"`)) code = code.replaceAll(`from "./${dependency}"`, `from "${dataUrl(await transpile(`${dependency}.ts`))}"`);
  }
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// ---------------------------------------------------------------------------
// Loader: every module, with import redirects to data-URL siblings.
// ---------------------------------------------------------------------------
let loadedPromise = null;

async function loadAll() {
  if (loadedPromise) return loadedPromise;
  loadedPromise = (async () => {
    const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = new Proxy({}, { get: (_, key) => globalThis.__p0TestBindings?.[key] });"]]));
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
    const issuer = await import(issuerUrl);
    const researchHash = await import(researchHashUrl);
    const researchPlan = await import(researchPlanUrl);
    const researchPolicy = await import(researchPolicyUrl);
    const researchFirewall = await import(researchFirewallUrl);
    const researchCheck = await import(researchCheckUrl);
    const researchCompiler = await import(researchCompilerUrl);
    const researchTools = await import(researchToolsUrl);
    const researchValidate = await import(researchValidateUrl);
    const valuationAi = await import(valuationAiUrl);

    return { engine, packMod, issuer, researchHash, researchPlan, researchPolicy, researchFirewall, researchCheck, researchCompiler, researchTools, researchValidate, valuationAi };
  })();
  return loadedPromise;
}

const mods = () => loadAll();
installProviders();

// ---------------------------------------------------------------------------
// Plan builders
// ---------------------------------------------------------------------------

/** A deterministic single-business DCF plan compiled from evidence, never a price. */
function makePlan(pack, overrides = {}) {
  const ev = pack.evidenceAssumptions ?? pack.profile.baseline;
  const filingId = pack.cache?.latestFilingId ?? "evid";
  const base = {
    policyVersion: "test-policy",
    businesses: [{
      id: "core",
      name: "Core Business",
      stage: "mature",
      economicMeaning: "core operating economics",
      segmentationBasis: "reported_segment",
      revenueDriver: { formula: "reported_segment", params: {}, evidenceId: filingId },
      costDrivers: [],
      disclosedData: [{ label: "Revenue", value: ev?.forwardRevenueB ?? null, unit: "USD billions", evidenceId: filingId }],
      forecastAssumptions: [],
      growthConstraints: [],
      forecastYears: [
        { year: 2027, fcfB: 10 },
        { year: 2028, fcfB: 11 },
        { year: 2029, fcfB: 12 },
      ],
      valuationMethod: "dcf",
      multiple: null,
      rationale: "test business",
      applicabilityConditions: [],
      overlaps: [],
    }],
    capitalRequirements: [],
    financing: [],
    dilution: [],
    valuationMethods: [{ model: "dcf", purpose: "valuation", appliesToBusinessIds: ["core"], rationale: "test" }],
    scenarios: [],
    probabilitiesCheck: { owners: [], note: "" },
    sources: [{ id: filingId, kind: "filing", label: "test filing" }],
    missingEvidence: [],
    primaryMethod: "dcf",
    aggregationRule: "single_model",
    crossChecks: [],
    thesisChanges: [],
    revisionRecords: [],
  };
  return { ...base, ...overrides };
}

/** A two-business SOTP plan where the first business carries a segment-level probability. */
function makeSotpPlan(pack, { probability = 0.5 } = {}) {
  const filingId = pack.cache?.latestFilingId ?? "evid";
  const biz = (id, name, revenueB) => ({
    id, name,
    stage: "mature",
    economicMeaning: `${name} operating economics`,
    segmentationBasis: "reported_segment",
    revenueDriver: { formula: "constant", params: { value: revenueB * 1e9 }, evidenceId: filingId },
    costDrivers: [],
    disclosedData: [{ label: "Revenue", value: revenueB, unit: "USD billions", evidenceId: filingId }],
    forecastAssumptions: [],
    growthConstraints: [],
    forecastYears: [],
    valuationMethod: "ev_sales",
    multiple: 4,
    rationale: "test business",
    applicabilityConditions: [],
    overlaps: [],
  });
  return {
    policyVersion: "test-policy",
    businesses: [biz("b1", "Alpha", 20), biz("b2", "Beta", 30)],
    capitalRequirements: [],
    financing: [],
    dilution: [],
    valuationMethods: [{ model: "sotp", purpose: "valuation", appliesToBusinessIds: ["b1", "b2"], rationale: "test" }],
    scenarios: [{ id: "s1", name: "Alpha delivery", description: "probability-weighted optionality", probability, appliesTo: "segment", businessIds: ["b1"] }],
    probabilitiesCheck: { owners: [{ uncertaintyId: "b1", owner: "segment" }], note: "" },
    sources: [{ id: filingId, kind: "filing", label: "test filing" }],
    missingEvidence: [],
    primaryMethod: "sotp",
    aggregationRule: "sotp",
    crossChecks: [],
    thesisChanges: [],
    revisionRecords: [],
  };
}

async function withFakeAi(m, pack, plan, action, { failReview = false } = {}) {
  const provider = globalThis.fetch;
  const payloads = [];
  globalThis.__p0TestBindings = { AI_VALUATION_ENABLED: 'true', OPENAI_API_KEY: 'isolated-test-key' };
  globalThis.fetch = async (input, init) => {
    if (String(input) !== 'https://api.openai.com/v1/responses') return provider(input, init);
    const body = JSON.parse(init.body); payloads.push(body);
    const name = body.text.format.name;
    if (failReview && name === 'research_reviewer') return new Response('unavailable', { status: 503 });
    let response;
    if (name === 'research_draft') response = { ...plan, toolRequests: [] };
    else if (name === 'research_finalize') response = plan;
    else if (name === 'research_reviewer') response = { revisions: [] };
    else if (name === 'valuation_plan') response = {
      recommendedFamily: pack.profile.classification.modelFamily, businessModel: 'Operating business', growthStage: 'mature', capitalIntensity: 'high', drivers: ['revenue'], confidence: .7,
      modelApplicability: [{ model: 'dcf', score: 1, action: 'use', reason: 'cash flow' }],
      forecastAdjustments: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, rationale: 'unchanged' }, missingEvidence: [], reviewFocus: [], rationale: 'operating inputs',
    };
    else if (name === 'valuation_review') response = { modelReviews: [], overallConfidenceAdjustment: 0, reviewNotes: [] };
    else throw new Error(`unexpected AI request ${name}`);
    return Response.json({ output_text: JSON.stringify(response) });
  };
  try { return await action(payloads); }
  finally { globalThis.fetch = provider; delete globalThis.__p0TestBindings; }
}

function trustedPlan(m, pack) {
  const plan = makePlan(pack);
  const id = `evidence:${pack.cache.evidenceVersion}`;
  plan.sources = [{ id, kind: 'filing', label: 'fixture evidence pack' }];
  plan.businesses[0].revenueDriver.evidenceId = id;
  plan.businesses[0].disclosedData[0].evidenceId = id;
  return plan;
}




async function auditPack(id) {
  const m = await mods();
  const p = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  p.issuerProfile.issuerId = `independent-audit-${id}`;
  p.evidenceAssumptions = {
    ...p.evidenceAssumptions, cashFlowBasis: 'analyst_fcff', cashFlows: [10,11,12],
    normalizedCashFlows: [10,11,12], wacc: .1, costOfEquity: .12, terminalGrowth: .03,
    netCashB: 8, dilutedSharesB: 2, forwardRevenueB: 100, fcfMargin: .1,
    forwardEps: 1, forwardFcfB: 10,
  };
  p.profile.capitalCost = null;
  p.profile.capitalBridge = undefined;
  p.profile.baseline = structuredClone(p.evidenceAssumptions);
  p.profile.dataQuality = {status: 'passed', valuationRelease: 'released', checks: []};
  return {m,p};
}
const auditOptions = {simulationCount: 1000};
function removeMultipleInputs(p) {
  for (const key of ['forwardPe','evFcfMultiple','evSalesMultiple','normalizedEbitdaB','evEbitdaMultiple','normalizedCashFlows']) delete p.profile.baseline[key];
}

const observations = [];
function observe(id, data) { observations.push({id, ...data}); console.log('R1_AUDIT_OBSERVATION ' + JSON.stringify(observations.at(-1))); }
function close(actual, expected, message = '') { assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${message}: actual=${actual}, expected=${expected}`); }
function dcfPv(flows, rate = .1, growth = .03) {
  return flows.reduce((sum, flow, index) => sum + flow / (1 + rate) ** (index + 1), 0)
    + flows.at(-1) * (1 + growth) / (rate - growth) / (1 + rate) ** flows.length;
}

test('R1-C01: all five request stages retain operating inputs and exclude the explicit quote', async () => {
  const {m,p} = await auditPack('r1-control-payloads');
  p.profile.baseline.forwardPe = 999;
  await withFakeAi(m,p,trustedPlan(m,p),async(payloads)=>{
    await m.valuationAi.runAiOrchestratedValuation(p,{...auditOptions,currentPrice:100},new Request('https://audit.invalid'),{force:true});
    await m.valuationAi.runResearchValuation(p,{...auditOptions,currentPrice:100},new Request('https://audit.invalid'),{force:true});
    for (const name of ['valuation_plan','valuation_review','research_draft','research_finalize','research_reviewer']) {
      const body=payloads.find(x=>x.text.format.name===name); assert.ok(body,name);
      const evidence=JSON.parse(body.input).evidence;
      for (const key of ['cashFlows','dilutedSharesB','netCashB','wacc','forwardRevenueB']) assert.deepEqual(evidence.operatingBaseline[key],p.evidenceAssumptions[key],`${name}: ${key}`);
      assert.doesNotMatch(body.input,/"(?:currentPrice|marketPrice|fairValue|referencePrice|targetPrice|legacyPrior)"/i);
    }
  });
});

test('R1-01: changing only the quote cannot change the actual independent reviewer input', async () => {
  const {m,p}=await auditPack('r1-price-isolation');
  p.profile.baseline.forwardPe=999; // Force the same dispersion review at both prices.
  const sent=[];
  for (const price of [100,200]) {
    await withFakeAi(m,p,trustedPlan(m,p),async(payloads)=>{
      await m.valuationAi.runAiOrchestratedValuation(p,{...auditOptions,currentPrice:price},new Request('https://audit.invalid'),{force:true});
      const request=payloads.find(x=>x.text.format.name==='valuation_review');
      assert.ok(request,'Fixture must execute the real legacy reviewer stage at both prices.');
      sent.push({price,input:JSON.parse(request.input)});
    });
  }
  const fields = x => ({price:x.price,checks:x.input.checks.filter(c=>['split-and-share-count','implied-expectations','market-implied-reconciliation'].includes(c.id))});
  observe('R1-01',{sent:sent.map(fields),operatingEvidenceUnchanged:JSON.stringify(sent[0].input.evidence)===JSON.stringify(sent[1].input.evidence)});
  assert.deepEqual(sent[0].input.evidence,sent[1].input.evidence,'Controlled input: same operating evidence.');
  assert.deepEqual(sent[0].input.plan,sent[1].input.plan,'Controlled input: same planner response.');
  assert.deepEqual(sent[0].input,sent[1].input,
    'Price-isolated review must not receive price-derived P/S ratios, reverse-DCF growth or market-gap flags. Fixed facts, plan and capital-cost version must give identical review inputs.');
});

test('R1-02: known FV/price aliases in an open driver map never reach a later AI request', async () => {
  const {m,p}=await auditPack('r1-price-aliases');
  const plan=trustedPlan(m,p);
  plan.businesses[0].revenueDriver.params={preliminaryFairValue:707.17,currentPriceUsd:811.23,targetPriceLow:912.34};
  // Both rejecting contaminated model output before forwarding and sanitizing
  // its known forbidden metadata are valid. Do not require accepting this plan.
  await withFakeAi(m,p,plan,async(payloads)=>{
    const result=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    assert.ok(payloads.some(x=>x.text.format.name==='research_draft'),'Exercise the real draft response boundary.');
    const downstream=payloads.filter(x=>['research_finalize','research_reviewer'].includes(x.text.format.name));
    const d=result.orchestration.research;
    const stored=await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
    observe('R1-02',{stages:downstream.map(x=>({stage:x.text.format.name,params:JSON.parse(x.input).draft?.businesses?.[0]?.revenueDriver?.params??JSON.parse(x.input).plan?.businesses?.[0]?.revenueDriver?.params})),approvedPlanStored:Boolean(stored?.approval),release:result.output.dataQuality.valuationRelease});
    for (const body of downstream) assert.doesNotMatch(body.input,/707\.17|811\.23|912\.34|"(?:preliminaryFairValue|currentPriceUsd|targetPriceLow)"/i,
      `${body.text.format.name}: known price/FV metadata is not an operating driver. Reject or remove it before forwarding.`);
    if (!downstream.length) { assert.equal(result.output.dataQuality.valuationRelease,'withheld'); assert.equal(stored,null); }
  });
});

test('R1-C02: operating fields and economic unit prices are not erased by market isolation', async () => {
  const {m}=await auditPack('r1-operating-keys');
  const operating={operatingBaseline:{cashFlows:[10,11,12],operatingIncomeB:8,operatingMargin:.2,dilutedSharesB:2,netCashB:8},revenueDriver:{formula:'volume_x_price',params:{volume:1000000,price:125}}};
  assert.deepEqual(m.researchFirewall.sanitizeResearchInput(operating),operating,
    'Do not restore substring /rating/ or globally remove every field named price: an economic unit price is a supported revenue driver.');
});

test('R1-C03: EV/sales, EV/EBITDA and EV/FCF use their declared metrics independently', async () => {
  const {m,p}=await auditPack('r1-methods');
  for (const [method,expected] of [['ev_sales',80],['ev_ebitda',12],['ev_fcf',4]]) {
    const plan=makeSotpPlan(p,{probability:1});plan.scenarios=[];
    const b=plan.businesses[0];b.valuationMethod=method;
    b.revenueDriver={formula:'revenue_x_margin',params:{revenueB:20},evidenceId:p.cache.latestFilingId};
    b.forecastYears=[{year:2027,revenueB:20,margin:.2,fcfB:1}];
    b.disclosedData.push({label:'EBITDA',value:3,unit:'USD billions',evidenceId:p.cache.latestFilingId});
    const c=m.researchCompiler.compileResearchPlan(p,plan);
    close(c.segments[0].metricValueB*c.segments[0].multiple,expected,method);
    close(m.engine.VALUATION_MODELS.sotp.run(c.profile.baseline,null).value,(expected+120+8)/2,method+' corporate bridge');
  }
});

test('R1-C04: missing or nonfinite FCF is not supplied by revenue or a generic margin', async () => {
  const {m,p}=await auditPack('r1-missing-fcf');
  for (const value of [undefined,null,NaN,Infinity]) {
    const plan=makeSotpPlan(p,{probability:1});plan.scenarios=[];
    Object.assign(plan.businesses[0],{valuationMethod:'ev_fcf',forecastYears:[{year:2027,revenueB:20,margin:.2,fcfB:value}]});
    assert.throws(()=>m.researchCompiler.compileResearchPlan(p,plan),/MODEL_CAPABILITY_GAP/);
  }
});

test('R1-C05: dated capex, equity proceeds and dilution reconcile to an independent SOTP calculation', async () => {
  const {m,p}=await auditPack('r1-capital');
  const plan=makeSotpPlan(p,{probability:1});plan.scenarios=[];
  const flows=[2,3,4,5,6];
  Object.assign(plan.businesses[0],{valuationMethod:'dcf',multiple:null,forecastYears:flows.map((fcfB,i)=>({year:2027+i,fcfB}))});
  for(const timingYear of [1,3,5]) {
    plan.capitalRequirements=[{id:'cap',businessId:'b1',kind:'capex',incremental:true,amountB:2,timingYear,evidenceId:'cap-fixture',rationale:'Incremental investment'}];
    plan.financing=[{id:'eq',kind:'equity',amountB:4,timingYear:0,evidenceId:'eq-fixture',rationale:'Current equity raise'}];
    plan.dilution=[{id:'shares',kind:'new_shares',sharesB:.5,evidenceId:'eq-fixture',rationale:'Matching shares'}];
    const c=m.researchCompiler.compileResearchPlan(p,plan);
    close(m.engine.VALUATION_MODELS.sotp.run(c.profile.baseline,null).value,(dcfPv(flows)-2/1.1**timingYear+120+8+4)/2.5,'dated capital/financing/dilution');
  }
});

test('R1-C06: ambiguous probability/capital combinations reject without blocking supported zero-capital cases', async () => {
  const {m,p}=await auditPack('r1-probability-capital');
  const plan=makeSotpPlan(p,{probability:.5});
  Object.assign(plan.businesses[0],{valuationMethod:'dcf',multiple:null,forecastYears:[2,3,4].map((fcfB,i)=>({year:2027+i,fcfB}))});
  plan.capitalRequirements=[{id:'cap',businessId:'b1',kind:'capex',incremental:true,amountB:2,timingYear:1,evidenceId:'fixture',rationale:'No conditional expenditure contract'}];
  for(const probability of [0,.5,.999]) {plan.scenarios[0].probability=probability;assert.throws(()=>m.researchCompiler.compileResearchPlan(p,plan),/MODEL_CAPABILITY_GAP/);}
  plan.scenarios[0].probability=1;assert.doesNotThrow(()=>m.researchCompiler.compileResearchPlan(p,plan));
  plan.scenarios[0].probability=.5;plan.capitalRequirements[0].amountB=0;assert.doesNotThrow(()=>m.researchCompiler.compileResearchPlan(p,plan));
});

test('R1-C07: weighted scenarios keep fixed investment fixed and reject any positive-weight uncomputed state', async () => {
  const {m,p}=await auditPack('r1-scenarios');
  const plan=trustedPlan(m,p);plan.aggregationRule='scenario_weighted';
  plan.capitalRequirements=[{id:'cap',businessId:'core',kind:'capex',incremental:true,amountB:2,timingYear:2,evidenceId:plan.sources[0].id,rationale:'Fixed incremental investment'}];
  plan.scenarios=[{id:'weak',name:'Weak',description:'',probability:.3,appliesTo:'company',businessIds:['core'],economics:{fcfMultiplier:.8}},
    {id:'strong',name:'Strong',description:'',probability:.7,appliesTo:'company',businessIds:['core'],economics:{fcfMultiplier:1.2}}];
  const output=m.engine.runValuationProfile(m.researchCompiler.compileResearchPlan(p,plan).profile,auditOptions);
  close(output.ensemble.fairValue,((.3*.8+.7*1.2)*dcfPv([10,11,12])-2/1.1**2+8)/2,'scenario expected value');
  plan.capitalRequirements=[];
  plan.scenarios[0].economics.fcfMultiplier=0;
  for(const weight of [0,.000001,.5]) {
    plan.scenarios[0].probability=weight;plan.scenarios[1].probability=1-weight;
    const out=m.engine.runValuationProfile(m.researchCompiler.compileResearchPlan(p,plan).profile,auditOptions);
    if(weight===0) {assert.notEqual(out.dataQuality.valuationRelease,'withheld');assert.ok(Number.isFinite(out.ensemble.fairValue));}
    else {assert.equal(out.dataQuality.valuationRelease,'withheld');assert.equal(out.ensemble.fairValue,null);}
  }
});

test('R1-C08: a late hard gate clears numerical publication fields without mutating the input', async () => {
  const {m,p}=await auditPack('r1-final-gate');
  p.profile.capitalBridge={cashB:200,investmentsB:0,debtB:0,otherClaimsB:0,preferredClaimsB:0,minorityInterestB:0};
  p.profile.sourcePosture='reported_internal_forecast';const before=structuredClone(p.profile);
  const out=m.engine.runValuationProfile(p.profile,auditOptions);
  assert.equal(out.dataQuality.valuationRelease,'withheld');assert.equal(out.releaseGate,'model_check_required');
  assert.equal(out.ensemble.fairValue,null);assert.equal(out.ensemble.expectedReturn,null);
  assert.ok(Object.values(out.ensemble.probabilityDistribution).every(x=>x===null));
  assert.ok(out.models.filter(x=>x.role==='valuation').every(x=>x.value===null&&x.effectiveWeight===0));
  assert.equal(out.reconciliation.perShare,null);assert.equal(out.qualityReview.publishable,false);
  assert.ok(out.qualityReview.preliminaryFairValue>0);
  assert.deepEqual(p.profile,before);
});

test('R1-C09: planner plus user-thesis narrative describes both final input versions', async () => {
  const {m,p}=await auditPack('r1-narrative');removeMultipleInputs(p);
  await withFakeAi(m,p,trustedPlan(m,p),async()=>{
    const previous=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const result=await previous(input,init);
      if(String(input)==='https://api.openai.com/v1/responses'&&JSON.parse(init.body).text.format.name==='valuation_plan') {
        const response=await result.json();const plan=JSON.parse(response.output_text);plan.forecastAdjustments.growthDelta=.05;
        return Response.json({output_text:JSON.stringify(plan)});
      }
      return result;
    };
    const r=await m.valuationAi.runAiOrchestratedValuation(p,{...auditOptions,thesis:{growthDelta:.04,marginDelta:.02,multipleDelta:.1}},new Request('https://audit.invalid'),{force:true});
    const text=r.output.investorRead.variantPath;
    for(const a of [r.output.aiBaseline.assumptions,r.output.signalLedgerThesis.adjustedAssumptions]) {
      assert.ok(text.includes(a.forwardRevenueB.toFixed(2)));
      for(const f of a.cashFlows) assert.ok(text.includes(f.toFixed(2)));
    }
    close(r.output.aiBaseline.assumptions.forwardRevenueB,105,'planner baseline');
    close(r.output.signalLedgerThesis.adjustedAssumptions.forwardRevenueB,109.2,'user thesis');
  });
});

test('R1-C10: approved cache hit has AI origin but zero new AI requests and no production writes', async () => {
  const {m,p}=await auditPack('r1-good-cache');const plan=trustedPlan(m,p);
  let first;
  await withFakeAi(m,p,plan,async(payloads)=>{
    first=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    assert.equal(payloads.length,3);assert.equal(first.orchestration.reviewStatus,'passed');
  });
  const hit=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'));
  assert.equal(hit.orchestration.cached,true);assert.equal(hit.orchestration.planOrigin,'ai');
  assert.equal(hit.orchestration.aiCalledThisRun,false);assert.equal(hit.orchestration.aiUsed,false);
  assert.equal(hit.orchestration.reviewStatus,'passed');assert.equal(hit.orchestration.research.aiCalls,0);
  close(hit.output.ensemble.fairValue,first.output.ensemble.fairValue,'cache recomputation');
  assert.equal(m.issuer.getProductionD1MutationCount(),0);
});
