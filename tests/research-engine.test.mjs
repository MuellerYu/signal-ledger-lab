// Acceptance tests for the adaptive research engine (Task B).
//
// Loads the full valuation pipeline (valuation-data, universal-valuation,
// valuation-ai) plus every research module through the same transpile-and-import
// technique the harness uses, with all Cloudflare bindings replaced by inert
// stand-ins and every provider served from deterministic fixtures. Nothing here
// writes to a production D1 table or consumes a production `claimAiCall` quota.
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
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  for (const dependency of ["research-schema", "research-plan", "research-validate"]) {
    if (code.includes(`from "./${dependency}"`)) code = code.replaceAll(`from "./${dependency}"`, `from "${dataUrl(await transpile(`${dependency}.ts`))}"`);
  }
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
    const actualResearchCheckUrl = dataUrl(await transpile("research-check.ts"));
    // Test-only call counter around the real check implementation.
    const researchCheckUrl = dataUrl(`
      import { runResearchChecks as actualRunResearchChecks } from "${actualResearchCheckUrl}";
      export * from "${actualResearchCheckUrl}";
      export function runResearchChecks(...args) {
        if (globalThis.__p0FailStopStageCounts) globalThis.__p0FailStopStageCounts.checks += 1;
        return actualRunResearchChecks(...args);
      }
    `);
    const actualResearchValidateUrl = dataUrl(await transpile("research-validate.ts", [
      ['from "./research-plan"', `from "${researchPlanUrl}"`],
    ]));
    const researchValidateUrl = dataUrl(`
      import { validateResearchPayload as actualValidate } from "${actualResearchValidateUrl}";
      export * from "${actualResearchValidateUrl}";
      export function validateResearchPayload(...args) {
        const count = globalThis.__p0R10StageCounts;
        if (count?.reviewReturned && args[0] === 'plan') count.planValidationsAfterReviewer += 1;
        return actualValidate(...args);
      }
    `);
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
    const actualResearchCompilerUrl = dataUrl(await transpile("research-compiler.ts", [
      ['from "./universal-valuation"', `from "${valuationUrl}"`],
      ['from "./research-hash"', `from "${researchHashUrl}"`],
      ['from "./research-plan"', `from "${researchPlanUrl}"`],
    ]));
    const researchCompilerUrl = dataUrl(`
      import { compileResearchPlan as actualCompile } from "${actualResearchCompilerUrl}";
      export * from "${actualResearchCompilerUrl}";
      export function compileResearchPlan(...args) {
        const count = globalThis.__p0R10StageCounts;
        if (count?.reviewReturned) count.compilesAfterReviewer += 1;
        return actualCompile(...args);
      }
    `);
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

function compileAndRun(m, pack, plan, price) {
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const output = m.engine.runValuationProfile(compiled.profile, { currentPrice: price });
  return { compiled, output };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("1: successful ResearchPlan overrides legacy special-case assumptions", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  // AMD's legacy curated profile carries no segments (single-company DCF).
  assert.equal(pack.profile.baseline.sotpSegments?.length ?? 0, 0);
  // A research plan that re-segments the company is authoritative.
  const plan = makeSotpPlan(pack);
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  assert.deepEqual(compiled.segments.map((s) => s.name), ["Alpha", "Beta"]);
  assert.equal(compiled.profile.baseline.sotpSegments.length, 2);
  assert.equal(compiled.profile.thesis.growthDelta, 0);
  assert.equal(compiled.profile.thesis.marginDelta, 0);
  assert.equal(compiled.profile.thesis.multipleDelta, 0);
});

test("2: legacy assumptions still work as a deterministic fallback", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const output = m.engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  assert.ok(Number.isFinite(output.ensemble.fairValue));
  assert.ok(output.ensemble.fairValue > 0);
});

test("3: no legacy assumption is applied twice after compilation", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const legacyForwardRevenueB = pack.profile.baseline.forwardRevenueB; // curated analyst override (~87.7)
  assert.ok(legacyForwardRevenueB !== null && legacyForwardRevenueB > 70, "legacy AMD override present");
  const compiled = m.researchCompiler.compileResearchPlan(pack, makePlan(pack));
  // The compiled cash-flow stream is the plan's, not the legacy curated stream.
  assert.deepEqual(compiled.profile.baseline.cashFlows, [10, 11, 12]);
  // The compiled forward revenue derives from evidence, never the legacy consensus.
  assert.notEqual(compiled.profile.baseline.forwardRevenueB, legacyForwardRevenueB);
  assert.equal(compiled.profile.thesis.growthDelta, 0);
  assert.equal(compiled.profile.thesis.marginDelta, 0);
  assert.equal(compiled.profile.thesis.multipleDelta, 0);
});

test("4: reviewer patches are whitelist-only; a whole-plan rewrite is rejected", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack);
  const filingId = plan.sources[0].id;
  // A structural path cannot be patched: the reviewer cannot replace the plan.
  const rewrite = m.valuationAi.applyValidRevisions(plan, [{
    revisionReason: "evidence_contradiction",
    path: "businesses",
    oldValue: null,
    proposedValue: null,
    evidenceRefs: [filingId],
    explanation: "replace the whole plan",
  }]);
  assert.equal(rewrite.changed, false);
  assert.equal(rewrite.revisions.length, 0);
  // A whitelisted path with a valid unit DOES apply.
  const ok = m.valuationAi.applyValidRevisions(makePlan(pack), [{
    revisionReason: "unit_error",
    path: "businesses[0].forecastYears[0].fcfB",
    oldValue: 10,
    proposedValue: 12,
    evidenceRefs: [filingId],
    explanation: "fix the unit",
  }], new Set([filingId]));
  assert.equal(ok.changed, true);
  assert.equal(ok.plan.businesses[0].forecastYears[0].fcfB, 12);
});

test("5: disabled paths and price-shaped reasons are rejected", async () => {
  const m = await mods();
  for (const path of ["fairValue", "targetPrice", "referencePrice", "businesses[0].name", "primaryMethod", "aggregationRule", "policyVersion", "businesses[0].id"]) {
    assert.equal(m.researchPlan.isMutablePath(path), false, `path must be immutable: ${path}`);
  }
  assert.equal(m.researchPlan.isMutablePath("businesses[0].forecastYears[1].growth"), true);
  assert.equal(m.researchPlan.isMutablePath("scenarios[0].probability"), true);
  assert.equal(m.researchPlan.isRevisionReason("price_too_low"), false);
  assert.equal(m.researchPlan.isRevisionReason("growth_too_conservative"), false);
  assert.equal(m.researchPlan.isRevisionReason("evidence_contradiction"), true);
});

test("6: revisions citing nonexistent or empty evidence ids are rejected", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack);
  const rejected = m.valuationAi.applyValidRevisions(plan, [{
    revisionReason: "evidence_contradiction",
    path: "businesses[0].forecastYears[0].fcfB",
    oldValue: 10,
    proposedValue: 99,
    evidenceRefs: ["not-a-real-evidence-id"],
    explanation: "cites nothing real",
  }]);
  assert.equal(rejected.changed, false);
  const empty = m.valuationAi.applyValidRevisions(makePlan(pack), [{
    revisionReason: "evidence_contradiction",
    path: "businesses[0].forecastYears[0].fcfB",
    oldValue: 10,
    proposedValue: 99,
    evidenceRefs: [],
    explanation: "no evidence",
  }]);
  assert.equal(empty.changed, false);
});

test("7: planner/reviewer schemas carry no price field", async () => {
  const m = await mods();
  const tokens = ["fairvalue", "targetprice", "referenceprice", "currentprice", "marketprice", "consensus", "sanity"];
  const schemas = [m.researchPlan.researchPlanSchema, m.researchPlan.researchDraftSchema, m.researchPlan.researchRevisionSchema];
  for (const schema of schemas) {
    assert.equal(schema.additionalProperties, false);
    const keys = Object.keys(schema.properties ?? {}).map((k) => k.toLowerCase());
    for (const token of tokens) {
      assert.ok(!keys.some((k) => k.includes(token)), `${token} must not be a schema key`);
    }
  }
  const revisionItems = m.researchPlan.researchRevisionSchema.properties.revisions.items;
  assert.equal(revisionItems.additionalProperties, false);
  const revisionKeys = Object.keys(revisionItems.properties ?? {}).map((k) => k.toLowerCase());
  for (const token of tokens) {
    assert.ok(!revisionKeys.some((k) => k.includes(token)), `${token} must not be a revision key`);
  }
});

test("8: unknown formula or model raises MODEL_CAPABILITY_GAP", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const base = makePlan(pack);
  const badFormula = { ...base, businesses: [{ ...base.businesses[0], revenueDriver: { formula: "javascript_eval", params: {}, evidenceId: "x" } }] };
  assert.throws(() => m.researchCompiler.compileResearchPlan(pack, badFormula), (e) => /MODEL_CAPABILITY_GAP/.test(e.message) && /javascript_eval/.test(e.message));
  const badModel = { ...base, businesses: [{ ...base.businesses[0], valuationMethod: "made_up_model" }], primaryMethod: "made_up_model" };
  assert.throws(() => m.researchCompiler.compileResearchPlan(pack, badModel), (e) => /MODEL_CAPABILITY_GAP/.test(e.message) && /made_up_model/.test(e.message));
});

test("9: same plan + same evidence → deterministic, identical output", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const a = compileAndRun(m, pack, makePlan(pack), pack.quote?.price);
  const b = compileAndRun(m, pack, makePlan(pack), pack.quote?.price);
  assert.equal(a.output.ensemble.fairValue, b.output.ensemble.fairValue);
  assert.equal(m.researchCompiler.hashPlan(makePlan(pack)), m.researchCompiler.hashPlan(makePlan(pack)));
});

test("10: each cache layer invalidates on the correct key change", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const issuerId = "test-issuer-10";
  const plan = makePlan(pack);
  const planB = { ...plan, businesses: [{ ...plan.businesses[0], forecastYears: [{ year: 2027, fcfB: 99 }] }] };
  const assumptionVersion = m.researchCompiler.hashPlan(plan);
  await m.issuer.persistResearchPlan({ issuerId, policyVersion: "p1", evidenceVersion: "e1", assumptionVersion, plan });
  // policy change → miss
  assert.equal(await m.issuer.loadResearchPlan(issuerId, "p2", "e1"), null);
  // evidence change → miss
  assert.equal(await m.issuer.loadResearchPlan(issuerId, "p1", "e2"), null);
  // exact match → hit with the stored assumptionVersion
  const hit = await m.issuer.loadResearchPlan(issuerId, "p1", "e1");
  assert.ok(hit);
  assert.equal(hit.assumptionVersion, assumptionVersion);
  // assumption (plan) change → different assumptionVersion (valuation cache layer)
  assert.notEqual(m.researchCompiler.hashPlan(plan), m.researchCompiler.hashPlan(planB));
});

test("11: duplication / segment overlap is detected", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const base = makePlan(pack);
  const plan = { ...base, businesses: [{ ...base.businesses[0], overlaps: ["core"] }] };
  const { compiled, output } = compileAndRun(m, pack, plan, pack.quote?.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  const overlap = checks.find((c) => c.id === "segment-overlap");
  assert.equal(overlap.status, "failed");
});

test("12: funding gap is detected when capital exceeds financing plus cash", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack, {
    capitalRequirements: [{ id: "c1", businessId: "core", kind: "capex", incremental: true, amountB: 1000, timingYear: 1, evidenceId: "x", rationale: "huge buildout" }],
  });
  const { compiled, output } = compileAndRun(m, pack, plan, pack.quote?.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  const gap = checks.find((c) => c.id === "funding-gap");
  assert.equal(gap.status, "warning");
});

test("13: company scenario probabilities exceeding 1 are detected", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack, {
    scenarios: [
      { id: "s1", name: "A", description: "a", probability: 0.7, appliesTo: "company", businessIds: ["core"] },
      { id: "s2", name: "B", description: "b", probability: 0.6, appliesTo: "company", businessIds: ["core"] },
    ],
  });
  assert.throws(() => compileAndRun(m, pack, plan, pack.quote?.price), /MODEL_CAPABILITY_GAP/);
  const { compiled, output } = compileAndRun(m, pack, makePlan(pack), pack.quote?.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  const prob = checks.find((c) => c.id === "scenario-probability-sum");
  assert.equal(prob.status, "failed");
});

test("14: probability_double_count flags an uncertainty owned twice", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack, {
    scenarios: [
      { id: "s1", name: "Segment bet", description: "d", probability: 0.6, appliesTo: "segment", businessIds: ["core"] },
      { id: "s2", name: "Company bet", description: "d", probability: 0.7, appliesTo: "company", businessIds: ["core"] },
    ],
  });
  assert.throws(() => compileAndRun(m, pack, plan, pack.quote?.price), /MODEL_CAPABILITY_GAP/);
  const { compiled, output } = compileAndRun(m, pack, makePlan(pack), pack.quote?.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  const dc = checks.find((c) => c.id === "probability-double-count");
  assert.equal(dc.status, "failed");
});

test("15: capital, dilution, financing and probability each move value", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const price = pack.quote?.price;
  const run = (plan) => compileAndRun(m, pack, plan, price).output.ensemble.fairValue;
  const base = makePlan(pack);
  const baseValue = run(base);
  assert.ok(Number.isFinite(baseValue));

  // capex↑ → value↓
  const highCapex = run({ ...base, capitalRequirements: [{ id: "c1", businessId: "core", kind: "capex", incremental: true, amountB: 5, timingYear: 1, evidenceId: "x", rationale: "capex" }] });
  assert.ok(highCapex < baseValue, `capex should lower value: ${highCapex} vs ${baseValue}`);

  // dilution↑ → per-share value↓
  const diluted = run({ ...base, dilution: [{ id: "d1", kind: "new_shares", sharesB: 1, evidenceId: "x", rationale: "dilution" }] });
  assert.ok(diluted < baseValue, `dilution should lower per-share value: ${diluted} vs ${baseValue}`);

  // equity financing → net-cash bridge up (SOTP applies the EV/equity bridge
  // unconditionally; the single-business DCF above runs on an equity cash-flow
  // basis, which correctly ignores netCashB, so financing is asserted on SOTP)
  const sotpBase = compileAndRun(m, pack, makeSotpPlan(pack, { probability: 1 }), price).output.ensemble.fairValue;
  const sotpFin = compileAndRun(m, pack, { ...makeSotpPlan(pack, { probability: 1 }), financing: [{ id: "f1", kind: "equity", amountB: 10, timingYear: 0, evidenceId: "x", rationale: "equity raise" }], dilution: [{ id: "d1", kind: "new_shares", sharesB: 0.001, evidenceId: "x", rationale: "incremental issued shares" }] }, price).output.ensemble.fairValue;
  assert.ok(sotpFin > sotpBase, `equity financing should raise value via the bridge: ${sotpFin} vs ${sotpBase}`);

  // probability → optionality scales (segment probability)
  const low = compileAndRun(m, pack, makeSotpPlan(pack, { probability: 0.3 }), price);
  const high = compileAndRun(m, pack, makeSotpPlan(pack, { probability: 0.9 }), price);
  assert.equal(low.compiled.segments[0].probability, 0.3);
  assert.equal(high.compiled.segments[0].probability, 0.9);
  assert.ok(Number.isFinite(low.output.ensemble.fairValue));
  assert.ok(Number.isFinite(high.output.ensemble.fairValue));
  assert.ok(low.output.ensemble.fairValue < high.output.ensemble.fairValue, `probability should scale value: ${low.output.ensemble.fairValue} vs ${high.output.ensemble.fairValue}`);
});

test("16: AI-off legacy path is unchanged (matches pre-upgrade baseline)", async () => {
  const m = await mods();
  const frozen = JSON.parse(await readFile(new URL("./fixtures/pre-upgrade-baseline.json", import.meta.url), "utf8"));
  for (const ticker of ["OKLO", "AMD", "NVDA", "SPCX"]) {
    const pack = await m.packMod.buildAutomatedValuationPack(ticker);
    const output = m.engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
    const expected = frozen.tickers[ticker].oldPublishedFairValue;
    const actual = output.ensemble.fairValue;
    assert.ok(Number.isFinite(actual), `${ticker} fair value must be finite`);
    assert.ok(Math.abs(actual - expected) < 1e-6, `${ticker}: legacy FV ${actual} != frozen ${expected}`);
  }
});

test("17: planner firewall strips every price field", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const view = m.researchFirewall.sanitizeEvidenceView(pack);
  const json = JSON.stringify(view);
  assert.ok(!json.includes("fairValue"));
  assert.ok(!json.includes("targetPrice"));
  assert.ok(!json.includes("referencePrice"));
  assert.ok(!json.includes("currentPrice"));
  assert.ok(!("quote" in view));
  assert.ok(!json.includes(String(pack.quote?.price)), "the current quote price must not reach the planner");
  assert.ok(view.operatingBaseline, "operatingBaseline is present");
  assert.equal(view.identity.securityTicker, "AMD");
});

test("18: review-check firewall strips every price-bearing check", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const plan = makePlan(pack);
  const { compiled, output } = compileAndRun(m, pack, plan, pack.quote?.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  const synthetic = [...checks, {
    id: "fair-value-check",
    label: "Fair value sanity",
    status: "passed",
    detail: "Fair value is $451.49 and current price is $210; upside 115%.",
    evidenceRefs: [],
    priceBearing: true,
  }];
  const sanitized = m.researchFirewall.sanitizeChecksForReviewer(synthetic);
  assert.ok(!sanitized.some((c) => c.id === "fair-value-check"), "price-bearing check must be dropped");
  const json = JSON.stringify(sanitized);
  // No monetary figure survives redaction, and no price word reaches the reviewer.
  // (isPriceBearing over-matches the harmless standalone word "base" in the
  // dilution-basis detail, so we assert on real price tokens instead.)
  assert.ok(!/\$\s?-?\d/.test(json), `dollar figure leaked to reviewer: ${json.slice(0, 300)}`);
  for (const word of ["fairvalue", "currentprice", "targetprice", "referenceprice", "consensus", "upside", "downside", "rating"]) {
    assert.ok(!new RegExp(`\\b${word}\\b`, "i").test(json), `price word leaked to reviewer: ${word}`);
  }
  assert.ok(!json.includes("$451.49"));
  assert.ok(!json.includes("upside"));
});

test("19: evidenceVersion excludes market state", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const evidenceVersion = pack.cache.evidenceVersion;
  assert.ok(evidenceVersion && evidenceVersion.length > 0);

  // evidenceVersion is a pure hash of persistent research evidence + identity only:
  // re-deriving it from { evidence, cik, latestFilingId } must reproduce it exactly.
  const fromEvidence = m.researchHash.hashCanonical({
    evidence: pack.evidenceAssumptions,
    cik: pack.identity.cik,
    latestFilingId: pack.cache.latestFilingId,
  });
  assert.equal(evidenceVersion, fromEvidence, "evidenceVersion must be a hash of evidence + cik + filing id only");

  // A quote-bearing input would hash to a different value, proving the current
  // quote (and any transient market state) is NOT an input to evidenceVersion.
  const withQuote = m.researchHash.hashCanonical({
    evidence: pack.evidenceAssumptions,
    cik: pack.identity.cik,
    latestFilingId: pack.cache.latestFilingId,
    quote: pack.quote?.price,
  });
  assert.notEqual(evidenceVersion, withQuote, "injecting the quote must change the hash, confirming it is excluded today");
});

test("20: dry-run is production-isolated (Production D1 mutations = 0)", async () => {
  const m = await mods();
  assert.equal(m.issuer.getProductionD1MutationCount(), 0);
  const pack = await m.packMod.buildAutomatedValuationPack("AMD");
  const result = await m.valuationAi.runResearchValuation(pack, { currentPrice: pack.quote?.price }, new Request("https://example.test/research"), { force: true });
  assert.equal(m.issuer.getProductionD1MutationCount(), 0, "no production D1 mutation may occur");
  assert.equal(result.orchestration.research.productionD1Mutations, 0);
  assert.equal(result.orchestration.research.aiCalls, 0, "AI disabled → zero AI calls");
  assert.equal(result.orchestration.research.usedDeterministicFallback, true);
  assert.ok(result.output, "an output is produced");
  // A fallback is not an approved research plan and must not poison the cache.
  const loaded = await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, result.orchestration.research.policyVersion, result.orchestration.research.evidenceVersion);
  assert.equal(loaded, null, "an unreviewed fallback must not enter the approved cache");
  assert.equal(result.orchestration.aiCalledThisRun, false);
  assert.equal(result.orchestration.planOrigin, "deterministic");
  assert.equal(result.orchestration.reviewStatus, "not_run");
  assert.equal(result.output.dataQuality.valuationRelease, "withheld");
});

test("21: deterministic fallback preserves the multi-year evidence cash-flow path", async () => {
  const m = await mods();
  const pack = await m.packMod.buildAutomatedValuationPack("NVDA");
  const evidencePath = pack.evidenceAssumptions.cashFlows ?? pack.evidenceAssumptions.normalizedCashFlows ?? [];
  assert.ok(evidencePath.length >= 3, "the NVDA fixture must carry a multi-year evidence cash-flow path");

  // deterministicResearchPlan must mirror the evidence horizon, never collapse it to a
  // single forward year (a one-year plan turns the DCF into "year-1 FCF + terminal
  // perpetuity" and silently discards the reported growth path).
  const plan = m.valuationAi.deterministicResearchPlan(pack);
  assert.equal(plan.businesses[0].forecastYears.length, evidencePath.length);

  // Through compilation the cash-flow stream must stay multi-year and equal the evidence.
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const compiledPath = compiled.profile.baseline.cashFlows ?? [];
  assert.equal(compiledPath.length, evidencePath.length);
  assert.deepEqual(
    compiledPath.map((v) => Number(v.toFixed(6))),
    evidencePath.map((v) => Number(v.toFixed(6))),
  );

  // The resulting DCF must be the multi-year value (≈$208), not the single-year collapse (≈$116).
  const output = m.engine.runValuationProfile(compiled.profile, { currentPrice: pack.quote?.price });
  assert.ok(Number.isFinite(output.ensemble.fairValue));
  assert.ok(output.ensemble.fairValue > 150, `expected multi-year DCF above the single-year collapse, got ${output.ensemble.fairValue}`);
});

test("22: capability-aware deterministic model selection (no blind DCF, no blind family.models[0])", async () => {
  const m = await mods();

  // AMD (ai_semiconductor) intends sotp as primary, but raw evidence has no segment
  // split. A whole-company DCF is a legitimate supported cross-model, and the downgrade
  // must be clearly marked (SOTP requires research-loop segment evidence).
  const amd = await m.packMod.buildAutomatedValuationPack("AMD");
  const amdPlan = m.valuationAi.deterministicResearchPlan(amd);
  assert.equal(amdPlan.primaryMethod, "dcf", "AMD must select a whole-company DCF, not a segment SOTP it cannot parameterize");
  assert.ok(amdPlan.missingEvidence.some((item) => /intends sotp/.test(item)), "the SOTP→DCF downgrade must be explicitly marked");

  // SPCX (integrated_space) is anchored to sotp/optionality; collapsing it into a generic
  // DCF would be misleading, so it must emit MODEL_CAPABILITY_GAP, never a DCF.
  const spcx = await m.packMod.buildAutomatedValuationPack("SPCX");
  const spcxResult = await m.valuationAi.runResearchValuation(spcx, { currentPrice: spcx.quote?.price }, new Request("https://example.test/research"), { force: true });
  assert.equal(spcxResult.orchestration.research.plan.primaryMethod, "sotp");
  assert.ok(spcxResult.orchestration.research.capabilityGap, "SPCX must emit a capability gap");
  assert.match(spcxResult.orchestration.research.capabilityGap, /anchored to sotp/);

  // OKLO (advanced_nuclear) is anchored to project_npv; a generic DCF on current earnings
  // is not an acceptable substitute for project/commercialization economics.
  const oklo = await m.packMod.buildAutomatedValuationPack("OKLO");
  const okloResult = await m.valuationAi.runResearchValuation(oklo, { currentPrice: oklo.quote?.price }, new Request("https://example.test/research"), { force: true });
  assert.ok(okloResult.orchestration.research.capabilityGap, "OKLO must emit a capability gap");
  assert.match(okloResult.orchestration.research.capabilityGap, /anchored to project_npv/);
});


test('P0: segment DCF consumes all years and subtracts timed investment only once', async () => {
  const m = await mods();
  const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.evidenceAssumptions = { ...pack.evidenceAssumptions, cashFlowBasis: 'analyst_fcff', wacc: 0.1, terminalGrowth: 0.03, netCashB: 8, dilutedSharesB: 2 };
  pack.profile.capitalCost = null;
  const plan = makeSotpPlan(pack, { probability: 1 });
  plan.scenarios = [];
  plan.businesses[0] = { ...plan.businesses[0], valuationMethod: 'dcf', multiple: null,
    forecastYears: [1, 2, 3, 4, 5].map((n) => ({ year: 2026 + n, fcfB: n + 1 })) };
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const expected = [2, 3, 4, 5, 6].reduce((v, c, i) => v + c / 1.1 ** (i + 1), 0) + 6 * 1.03 / .07 / 1.1 ** 5;
  assert.ok(Math.abs(compiled.segments[0].metricValueB - expected) < 1e-9);
  assert.ok(Math.abs(m.engine.VALUATION_MODELS.sotp.run(compiled.profile.baseline, null).value - (expected + 30 * 4 + 8) / 2) < 1e-9);
  const later = structuredClone(plan); later.businesses[0].forecastYears[3].fcfB += 7;
  assert.ok(Math.abs(m.researchCompiler.compileResearchPlan(pack, later).segments[0].metricValueB - expected - 7 / 1.1 ** 4) < 1e-9);
  const invested = structuredClone(plan);
  invested.capitalRequirements = [{ id: 'c', businessId: 'b1', kind: 'capex', incremental: true, amountB: 10, timingYear: 5, evidenceId: 'x', rationale: 'one-off' }];
  const withCapex = m.researchCompiler.compileResearchPlan(pack, invested);
  assert.ok(Math.abs(withCapex.segments[0].metricValueB - expected + 10 / 1.1 ** 5) < 1e-9);
  assert.equal(withCapex.profile.baseline.netCashB, 8, 'investment is not subtracted again from cash');
  const single = makePlan(pack, { capitalRequirements: [{ ...invested.capitalRequirements[0], businessId: 'core', timingYear: 3 }] });
  const withSpend = m.engine.VALUATION_MODELS.dcf.run(m.researchCompiler.compileResearchPlan(pack, single).profile.baseline, null).value;
  const withoutSpend = m.engine.VALUATION_MODELS.dcf.run(m.researchCompiler.compileResearchPlan(pack, makePlan(pack)).profile.baseline, null).value;
  assert.ok(Math.abs(withoutSpend - withSpend - 10 / 1.1 ** 3 / 2) < 1e-9, 'last-year investment must not reduce perpetual terminal flow');
});

test('P0: ambiguous economics and unsupported aggregation fail closed', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const reject = (plan) => assert.throws(() => m.researchCompiler.compileResearchPlan(pack, plan), /MODEL_CAPABILITY_GAP/);
  const noMultiple = makeSotpPlan(pack); noMultiple.businesses[0].multiple = null; reject(noMultiple);
  const implicitSotp = makeSotpPlan(pack); implicitSotp.aggregationRule = 'single_model'; reject(implicitSotp);
  const ambiguous = makePlan(pack); ambiguous.capitalRequirements = [{ id: 'c', kind: 'capex', businessId: 'core', amountB: 5, timingYear: 1 }]; reject(ambiguous);
  for (const kind of ['debt', 'hybrid']) reject(makePlan(pack, { financing: [{ id: 'f', kind, amountB: 10, timingYear: 1, costPct: .05 }] }));
  reject(makePlan(pack, { financing: [{ id: 'f', kind: 'equity', amountB: 10, timingYear: 0 }] }));
  reject(makePlan(pack, { dilution: [{ id: 'd', kind: 'stock_comp', sharesB: 1 }] }));
  const missingYear = makePlan(pack); delete missingYear.businesses[0].forecastYears[1].fcfB; reject(missingYear);
  const skippedYear = makePlan(pack); skippedYear.businesses[0].forecastYears[1].year += 1; reject(skippedYear);
  const costs = makePlan(pack); costs.businesses[0].costDrivers = [{ formula: 'constant', params: { value: 100 }, evidenceId: 'x' }]; reject(costs);
  const bounded = makePlan(pack); bounded.businesses[0].growthConstraints = [{ id: 'g', field: 'fcfB', max: 9 }]; reject(bounded);
});

test('P0: matched cash and shares at fair issuance do not create value', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const plan = makeSotpPlan(pack, { probability: 1 });
  const compile = (p) => m.researchCompiler.compileResearchPlan(pack, p).profile.baseline;
  const before = m.engine.VALUATION_MODELS.sotp.run(compile(plan), null).value;
  plan.financing = [{ id: 'raise', kind: 'equity', timingYear: 0, amountB: before * .1, evidenceId: 'offering', rationale: 'current issuance' }];
  plan.dilution = [{ id: 'shares', kind: 'new_shares', sharesB: .1, evidenceId: 'offering', rationale: 'incremental' }];
  assert.ok(Math.abs(m.engine.VALUATION_MODELS.sotp.run(compile(plan), null).value - before) < 1e-9);
});

test('P0: valid bear/base/bull states share businesses and sum to one', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const plan = makePlan(pack, { aggregationRule: 'scenario_weighted', scenarios: [
    { id: 'bear', name: 'Bear', description: 'lower cash', probability: .25, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: .8 } },
    { id: 'base', name: 'Base', description: 'unchanged', probability: .5, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: 1 } },
    { id: 'bull', name: 'Bull', description: 'higher cash', probability: .25, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: 1.2 } },
  ] });
  const { compiled, output } = compileAndRun(m, pack, plan, pack.quote.price);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);
  assert.equal(checks.find(c => c.id === 'scenario-exclusivity').status, 'passed');
  assert.equal(checks.find(c => c.id === 'scenario-probability-sum').status, 'passed');
  const values = output.researchScenarios.scenarios;
  assert.ok(values[0].value < values[1].value && values[1].value < values[2].value);
  assert.ok(Math.abs(output.researchScenarios.expectedValue - values.reduce((sum, s) => sum + s.value * s.probability, 0)) < 1e-9);
});

test('P0: evidence is externally registered; multiples and negative cash flows have correct units', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const plan = makeSotpPlan(pack); plan.businesses[0].multiple = 20;
  const revision = { revisionReason: 'evidence_contradiction', path: 'businesses[0].multiple', oldValue: 20, proposedValue: 24, evidenceRefs: ['invented'], explanation: 'unsupported' };
  plan.sources.push({ id: 'invented', kind: 'filing', label: 'self-declared' });
  assert.equal(m.valuationAi.applyValidRevisions(structuredClone(plan), [revision]).changed, false);
  assert.equal(m.valuationAi.applyValidRevisions(structuredClone(plan), [revision], new Set(['real'])).changed, false);
  assert.equal(m.valuationAi.applyValidRevisions(structuredClone(plan), [{ ...revision, evidenceRefs: ['real'] }], new Set(['real'])).plan.businesses[0].multiple, 24);
  assert.equal(m.valuationAi.applyValidRevisions(structuredClone(plan), [{ ...revision, oldValue: 19, evidenceRefs: ['real'] }], new Set(['real'])).changed, false);
  const negative = { ...revision, path: 'businesses[0].forecastYears[0].fcfB', oldValue: 10, proposedValue: -3, evidenceRefs: ['real'] };
  assert.equal(m.valuationAi.applyValidRevisions(makePlan(pack), [negative], new Set(['real'])).plan.businesses[0].forecastYears[0].fcfB, -3);
});

test('P0: failed research checks withhold the numerical output', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const profile = m.researchCompiler.compileResearchPlan(pack, makePlan(pack)).profile;
  profile.dataQuality = { status: 'failed', valuationRelease: 'withheld', checks: [{ id: 'research-unit', status: 'failed', label: 'unit', detail: 'invalid evidence' }] };
  const result = m.engine.runValuationProfile(profile, { currentPrice: 100 });
  assert.equal(result.ensemble.fairValue, null);
  assert.equal(result.dataQuality.valuationRelease, 'withheld');
  assert.equal(result.releaseGate, 'model_check_required');
  assert.equal(result.qualityReview.publishable, false);
});

test('P0: independent input ignores legacy thesis and quote changes do not change FV', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  const view = m.researchFirewall.sanitizeEvidenceView(pack);
  pack.profile.baseline.cashFlows = [99999]; pack.profile.thesis.growthDelta = .9;
  assert.deepEqual(m.researchFirewall.sanitizeEvidenceView(pack), view);
  const profile = m.researchCompiler.compileResearchPlan(pack, makePlan(pack)).profile;
  const a = m.engine.runValuationProfile(profile, { currentPrice: 150 });
  const b = m.engine.runValuationProfile(profile, { currentPrice: 180 });
  assert.equal(a.ensemble.fairValue, b.ensemble.fairValue);
  assert.notEqual(a.ensemble.expectedReturn, b.ensemble.expectedReturn);
});

// Every external request is intercepted; the fake key never leaves this process.
async function withFakeAi(m, pack, plan, action, { failReview = false, draftToolRequests = [] } = {}) {
  const provider = globalThis.fetch;
  const payloads = [];
  globalThis.__p0TestBindings = { AI_VALUATION_ENABLED: 'true', OPENAI_API_KEY: 'isolated-test-key' };
  globalThis.fetch = async (input, init) => {
    if (String(input) !== 'https://api.openai.com/v1/responses') return provider(input, init);
    const body = JSON.parse(init.body); payloads.push(body);
    const name = body.text.format.name;
    if (failReview && name === 'research_reviewer') return new Response('unavailable', { status: 503 });
    let response;
    if (name === 'research_draft') response = { ...plan, toolRequests: draftToolRequests };
    else if (name === 'research_finalize') response = plan;
    else if (name === 'research_reviewer') { response = { revisions: [] }; if (globalThis.__p0R10StageCounts) globalThis.__p0R10StageCounts.reviewReturned = true; }
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

function failStopMatrix(payloads, toolCalls, checks, finalResults) {
  const stages = payloads.map((body) => body.text.format.name);
  return {
    research_draft: stages.filter((stage) => stage === 'research_draft').length,
    tool_calls: toolCalls,
    research_finalize: stages.filter((stage) => stage === 'research_finalize').length,
    checks,
    research_reviewer: stages.filter((stage) => stage === 'research_reviewer').length,
    publication_final_result: finalResults,
  };
}

test('P0-R10: failed tool evidence is excluded and finalize still runs once, including force and multi-tool paths', async () => {
  const m = await mods();
  const prototype = m.researchTools.ResearchToolRunner.prototype;
  const originalRun = prototype.run;
  for (const force of [false, true]) {
    const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
    pack.issuerProfile.issuerId = `p0-a7-tool-fail-${force}`;
    const plan = trustedPlan(m, pack);
    const counts = { checks: 0 };
    let toolCalls = 0;
    prototype.run = async function (tool, args, evidence) {
      toolCalls += 1;
      const result = await originalRun.call(this, tool, args, evidence);
      return toolCalls === 2 ? { id: result.id, tool, ok: false, error: 'synthetic hard failure', byteLength: 0 } : result;
    };
    globalThis.__p0FailStopStageCounts = counts;
    try {
      await withFakeAi(m, pack, plan, async (payloads) => {
        const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), { force });
        const finalizer = JSON.parse(payloads.find((body) => body.text.format.name === 'research_finalize').input);
        assert.equal(finalizer.toolResults.filter((item) => item.ok === false).length, 1);
        assert.ok(!finalizer.evidenceIds.includes('tool:list_filing_documents:2'));
        const matrix = failStopMatrix(payloads, toolCalls, counts.checks, 1);
        assert.deepEqual(matrix, { research_draft: 1, tool_calls: 3, research_finalize: 1, checks: 2, research_reviewer: 1, publication_final_result: 1 });
        assert.equal(result.orchestration.finalResearchStatus, 'passed');
        console.log('P0_A7_STAGE_MATRIX ' + JSON.stringify({ case: `tool_failure_force_${force}`, ...matrix }));
      }, { draftToolRequests: Array.from({ length: 3 }, () => ({ tool: 'list_filing_documents', args: { limit: 1 } })) });
    } finally {
      prototype.run = originalRun;
      delete globalThis.__p0FailStopStageCounts;
    }
  }
});

test('P0-R10: pre-review hard check reaches one reviewer, then unchanged failed check withholds', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'p0-a7-hard-check-fail';
  const plan = trustedPlan(m, pack);
  plan.businesses[0].overlaps = ['core'];
  const counts = { checks: 0 };
  globalThis.__p0FailStopStageCounts = counts;
  try {
    await withFakeAi(m, pack, plan, async (payloads) => {
      const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), { force: true });
      const matrix = failStopMatrix(payloads, 0, counts.checks, 1);
      assert.deepEqual(matrix, { research_draft: 1, tool_calls: 0, research_finalize: 1, checks: 2, research_reviewer: 1, publication_final_result: 1 });
      assert.deepEqual(result.orchestration.revisions, []);
      assert.equal(result.orchestration.reviewStatus, 'passed');
      assert.equal(result.orchestration.finalResearchStatus, 'failed');
      assert.ok(result.orchestration.finalFailureCheckIds.includes('segment-overlap'));
      assert.equal(result.output.dataQuality.valuationRelease, 'withheld');
      assert.equal(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, result.orchestration.research.policyVersion, result.orchestration.research.evidenceVersion), null);
      console.log('P0_A7_STAGE_MATRIX ' + JSON.stringify({ case: 'research_check_failure', ...matrix }));
    });
  } finally { delete globalThis.__p0FailStopStageCounts; }
});

test('P0-R11: empty review preserves plan hash, binds new isolation version, and excludes R10 cache', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'p0-r10-cache-version';
  const plan = trustedPlan(m, pack);
  const oldPolicy = `${m.researchPolicy.policyVersion()}:p0-r10-post-review-failstop-v1`;
  await m.issuer.persistResearchPlan({ issuerId: pack.issuerProfile.issuerId, policyVersion: oldPolicy,
    evidenceVersion: pack.cache.evidenceVersion, assumptionVersion: m.researchCompiler.hashPlan(plan), plan,
    approval: { compilerVersion: 'p0-r10-post-review-failstop-v1', evidenceIds: [plan.sources[0].id], planOrigin: 'ai', reviewStatus: 'passed' } });
  const counts = { checks: 0 }; globalThis.__p0FailStopStageCounts = counts;
  const stages = { reviewReturned: false, planValidationsAfterReviewer: 0, compilesAfterReviewer: 0 }; globalThis.__p0R10StageCounts = stages;
  try {
    await withFakeAi(m, pack, plan, async (payloads) => {
      const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'));
      assert.deepEqual(result.orchestration.revisions, []);
      assert.deepEqual(result.orchestration.research.plan.revisionRecords, []);
      assert.equal(result.orchestration.research.assumptionVersion, m.researchCompiler.hashPlan(result.orchestration.research.plan));
      assert.equal(counts.checks, 2);
      assert.equal(stages.planValidationsAfterReviewer, 2); // post-review recheck plus pre-persist validation
      assert.equal(stages.compilesAfterReviewer, 1);
      assert.equal(result.orchestration.cached, false);
      assert.equal(payloads.length, 3);
      const stored = await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, result.orchestration.research.policyVersion, result.orchestration.research.evidenceVersion);
      assert.equal(stored?.approval?.compilerVersion, 'p0-r11-draft-sparse-v1');
      assert.equal(stored.assumptionVersion, result.orchestration.research.assumptionVersion);
    });
  } finally { delete globalThis.__p0FailStopStageCounts; delete globalThis.__p0R10StageCounts; }
});

test('P0-R10: accepted reviewer change still receives post-review checks', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'p0-r10-changed-review';
  const plan = trustedPlan(m, pack); const counts = { checks: 0 }; globalThis.__p0FailStopStageCounts = counts;
  try {
    await withFakeAi(m, pack, plan, async () => {
      const prior = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) === 'https://api.openai.com/v1/responses' && JSON.parse(init.body).text.format.name === 'research_reviewer') {
          return Response.json({ output_text: JSON.stringify({ revisions: [{ revisionReason: 'unit_error', path: 'businesses[0].forecastYears[0].fcfB', oldValue: 10,
            proposedValue: 12, evidenceRefs: [plan.sources[0].id], explanation: 'Synthetic unit correction' }] }) });
        }
        return prior(input, init);
      };
      try {
        const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), { force: true });
        assert.equal(counts.checks, 2);
        assert.equal(result.orchestration.reviewStatus, 'passed');
        assert.equal(result.orchestration.revisions.length, 1);
        assert.equal(result.orchestration.research.plan.businesses[0].forecastYears[0].fcfB, 12);
        assert.equal(result.orchestration.finalResearchStatus, 'passed');
      } finally { globalThis.fetch = prior; }
    });
  } finally { delete globalThis.__p0FailStopStageCounts; }
});

test('P0-A7 fail-stop: valid research retains draft, finalize, checks, reviewer order', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'p0-a7-success-path';
  const plan = trustedPlan(m, pack);
  const counts = { checks: 0 };
  globalThis.__p0FailStopStageCounts = counts;
  try {
    await withFakeAi(m, pack, plan, async (payloads) => {
      const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), { force: true });
      const matrix = failStopMatrix(payloads, 0, counts.checks, 1);
      assert.deepEqual(matrix, { research_draft: 1, tool_calls: 0, research_finalize: 1, checks: 2, research_reviewer: 1, publication_final_result: 1 });
      assert.equal(result.orchestration.reviewStatus, 'passed');
      assert.equal(result.orchestration.planOrigin, 'ai');
      console.log('P0_A7_STAGE_MATRIX ' + JSON.stringify({ case: 'success', ...matrix, release: result.output.dataQuality.valuationRelease }));
    });
  } finally { delete globalThis.__p0FailStopStageCounts; }
});

test('R7-17 actual reviewer request sees advisory role but cannot promote it by patch', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'r7-reviewer-advisory-role';
  const plan = trustedPlan(m, pack);
  plan.valuationMethods.push({ model: 'ev_fcf', purpose: 'cross_check', multiple: 12,
    appliesToBusinessIds: ['core'], rationale: 'Operating guardrail' });
  await withFakeAi(m, pack, plan, async (payloads) => {
    await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
    const request = payloads.find(body => body.text.format.name === 'research_reviewer');
    assert.ok(request, 'reviewer request must be sent through the fake transport');
    const input = JSON.parse(request.input);
    assert.equal(input.plan.valuationMethods[1].purpose, 'cross_check');
    assert.equal(input.plan.valuationMethods[1].multiple, 12);
    const revision = { revisionReason: 'evidence_contradiction', path: 'valuationMethods[1].purpose',
      oldValue: 'cross_check', proposedValue: 'valuation', evidenceRefs: [plan.sources[0].id], explanation: 'Attempted promotion' };
    const applied = m.valuationAi.applyValidRevisions(structuredClone(plan), [revision], new Set([plan.sources[0].id]));
    assert.equal(applied.revisions.length, 0);
    assert.equal(applied.plan.valuationMethods[1].purpose, 'cross_check');
  });
});

test('R7 old no-purpose plan is rejected before persisted cache write', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  const plan = makePlan(pack); delete plan.valuationMethods[0].purpose;
  const entry = { issuerId: 'r7-old-no-purpose-cache', policyVersion: 'r7-policy',
    evidenceVersion: 'r7-evidence', assumptionVersion: m.researchCompiler.hashPlan(plan), plan };
  await assert.rejects(m.issuer.persistResearchPlan(entry), /RESEARCH_SCHEMA_INVALID/);
  assert.equal(await m.issuer.loadResearchPlan(entry.issuerId, entry.policyVersion, entry.evidenceVersion), null);
});

test('R8-23 actual finalize request contains the shared executable-plan contract', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'r8-finalizer-instructions';
  const plan = trustedPlan(m, pack);
  await withFakeAi(m, pack, plan, async (payloads) => {
    await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
    const finalize = payloads.find(body => body.text.format.name === 'research_finalize');
    assert.ok(finalize);
    for (const phrase of ['Final ResearchPlan is executable', 'ev_sales|ev_ebitda|ev_fcf', 'costDrivers and forecastAssumptions to []',
      'Unknown FCF is not 0', 'forecastYears.capexB', 'incremental=true', 'timingYear=0 equity',
      'fcfMultiplier', 'cross_check methods are advisory'])
      assert.ok(finalize.instructions.includes(phrase), phrase);
    assert.deepEqual(finalize.text.format.schema, JSON.parse(JSON.stringify(m.researchPlan.researchPlanSchema)));
  });
});

test('R8-24 reviewer cannot promote advisory or introduce unsupported economics', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'r8-reviewer-boundary';
  const plan = trustedPlan(m, pack);
  plan.valuationMethods.push({ model: 'ev_fcf', purpose: 'cross_check', multiple: 12,
    appliesToBusinessIds: ['core'], rationale: 'audit-only guardrail' });
  await withFakeAi(m, pack, plan, async (payloads) => {
    await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
    const request = payloads.find(body => body.text.format.name === 'research_reviewer');
    assert.ok(request);
    assert.equal(JSON.parse(request.input).plan.valuationMethods[1].purpose, 'cross_check');
    const evidenceId = plan.sources[0].id;
    const revisions = [
      { revisionReason: 'evidence_contradiction', path: 'valuationMethods[1].purpose', oldValue: 'cross_check', proposedValue: 'valuation', evidenceRefs: [evidenceId], explanation: 'promotion' },
      { revisionReason: 'evidence_contradiction', path: 'businesses[0].costDrivers[0].params.value', oldValue: null, proposedValue: 1, evidenceRefs: [evidenceId], explanation: 'unsupported cost driver' },
    ];
    const applied = m.valuationAi.applyValidRevisions(structuredClone(plan), revisions, new Set([evidenceId]));
    assert.equal(applied.revisions.length, 0);
    assert.equal(applied.plan.valuationMethods[1].purpose, 'cross_check');
    assert.deepEqual(applied.plan.businesses[0].costDrivers, []);
  });
  // A formally mutable numeric patch can still exceed the final execution
  // contract. Exercise the actual reviewer response boundary and its recheck.
  pack.issuerProfile.issuerId = 'r8-reviewer-unsupported-capital';
  const evidenceId = plan.sources[0].id;
  plan.capitalRequirements.push({ id: 'incremental', businessId: 'core', kind: 'capex',
    incremental: true, amountB: 1, timingYear: 1, evidenceId, rationale: 'Synthetic incremental investment' });
  await withFakeAi(m, pack, plan, async () => {
    const prior = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input) === 'https://api.openai.com/v1/responses' && JSON.parse(init.body).text.format.name === 'research_reviewer') {
        return Response.json({ output_text: JSON.stringify({ revisions: [{
          revisionReason: 'evidence_contradiction', path: 'capitalRequirements[0].timingYear',
          oldValue: 1, proposedValue: 99, evidenceRefs: [evidenceId], explanation: 'Unsupported year',
        }] }) });
      }
      return prior(input, init);
    };
    try {
      const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
      assert.equal(result.orchestration.reviewStatus, 'failed');
      assert.match(result.orchestration.research.schemaError, /CAPITAL_CONSUMER/);
      assert.equal(result.output.dataQuality.valuationRelease, 'withheld');
    } finally { globalThis.fetch = prior; }
  });
});

test('R8-22 persisted final plan is revalidated before replacement and reuse', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  const plan = trustedPlan(m, pack);
  const entry = { issuerId: 'r8-cache-capability', policyVersion: 'r8-policy',
    evidenceVersion: 'r8-evidence', assumptionVersion: m.researchCompiler.hashPlan(plan), plan };
  assert.equal(await m.issuer.persistResearchPlan(entry), false, 'no database binding exists in this test');
  const original = await m.issuer.loadResearchPlan(entry.issuerId, entry.policyVersion, entry.evidenceVersion);
  assert.deepEqual(original?.plan, plan);
  const rejected = structuredClone(entry);
  rejected.plan.businesses[0].costDrivers.push({ formula: 'constant', params: { value: 1 }, evidenceId: plan.sources[0].id });
  await assert.rejects(m.issuer.persistResearchPlan(rejected), /COST_DRIVERS/);
  assert.deepEqual(await m.issuer.loadResearchPlan(entry.issuerId, entry.policyVersion, entry.evidenceVersion), original);
});

test('P0: actual request payloads exclude price/FV for legacy and research routes', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.profile.baseline.forwardPe = 999; // Forces dispersion review in the legacy path.
  pack.profile.classification.rationale = 'Current price is $765.43; target price $987.65';
  const plan = trustedPlan(m, pack);
  await withFakeAi(m, pack, plan, async (payloads) => {
    await m.valuationAi.runAiOrchestratedValuation(pack, { currentPrice: 765.43 }, new Request('https://example.test'), { force: true });
    await m.valuationAi.runResearchValuation(pack, { currentPrice: 765.43 }, new Request('https://example.test'), { force: true });
    const names = payloads.map(p => p.text.format.name);
    for (const name of ['valuation_plan', 'valuation_review', 'research_draft', 'research_finalize', 'research_reviewer']) assert.ok(names.includes(name), `actual ${name} request captured`);
    for (const payload of payloads) {
      assert.doesNotMatch(payload.input, /765\.43|987\.65|"(?:marketPrice|currentPrice|fairValue|referencePrice|targetPrice|legacyPrior)"/i);
    }
  });
  assert.equal(m.issuer.getProductionD1MutationCount(), 0);
});

test('P0: successful reviewed plan caches its origin; failure cannot replace it', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = 'p0-reviewed-cache';
  const plan = trustedPlan(m, pack);
  let first;
  await withFakeAi(m, pack, plan, async () => {
    first = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
  });
  assert.equal(first.orchestration.reviewStatus, 'passed');
  assert.equal(first.orchestration.research.aiCalls, 3);
  const detail = first.orchestration.research;
  const stored = await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, detail.policyVersion, detail.evidenceVersion);
  assert.ok(stored?.approval, JSON.stringify({checks:first.output.dataQuality, gate:first.output.releaseGate}));
  const hit = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'));
  assert.equal(hit.orchestration.aiCalledThisRun, false);
  assert.equal(hit.orchestration.planOrigin, 'ai');
  assert.equal(hit.orchestration.reviewStatus, 'passed');
  assert.equal(hit.orchestration.research.cached, true);
  assert.equal(hit.output.ensemble.fairValue, first.output.ensemble.fairValue);
  const bad = structuredClone(plan); bad.businesses[0].overlaps = ['core'];
  await withFakeAi(m, pack, bad, async () => {
    const rejected = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
    assert.equal(rejected.orchestration.finalResearchStatus, 'failed');
    assert.equal(rejected.output.dataQuality.valuationRelease, 'withheld');
  });
  await withFakeAi(m, pack, plan, async () => {
    const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://example.test'), { force: true });
    assert.equal(result.orchestration.reviewStatus, 'failed');
    assert.equal(result.output.ensemble.fairValue, null);
  }, { failReview: true });
  assert.equal((await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, detail.policyVersion, detail.evidenceVersion)).assumptionVersion, stored.assumptionVersion);
  assert.equal(m.issuer.getProductionD1MutationCount(), 0);
});


test('P0: scenario cash-flow changes do not scale fixed incremental investment', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const plan = makePlan(pack, { aggregationRule: 'scenario_weighted', scenarios: [
    { id: 'bear', name: 'Bear', description: '', probability: .5, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: .8 } },
    { id: 'bull', name: 'Bull', description: '', probability: .5, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: 1.2 } },
  ], capitalRequirements: [{ id: 'c', businessId: 'core', kind: 'capex', incremental: true, amountB: 2, timingYear: 2 }] });
  const scenarios = m.researchCompiler.compileResearchPlan(pack, plan).profile.scenarioWeighted.scenarios;
  assert.equal(scenarios[0].baseline.cashFlows[1], 11 * .8 - 2);
  assert.equal(scenarios[1].baseline.cashFlows[1], 11 * 1.2 - 2);
});


test('P0-R1: every actual AI stage preserves operating inputs while excluding market fields', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.profile.baseline.forwardPe = 999; // Also exercise the old reviewer request.
  const plan = trustedPlan(m, pack);
  await withFakeAi(m, pack, plan, async (payloads) => {
    await m.valuationAi.runAiOrchestratedValuation(pack, { currentPrice: 765.43 }, new Request('https://example.test'), { force: true });
    await m.valuationAi.runResearchValuation(pack, { currentPrice: 765.43 }, new Request('https://example.test'), { force: true });
    for (const name of ['valuation_plan', 'valuation_review', 'research_draft', 'research_finalize', 'research_reviewer']) {
      const payload = payloads.find(p => p.text.format.name === name);
      assert.ok(payload, name);
      const baseline = JSON.parse(payload.input).evidence.operatingBaseline;
      for (const key of ['cashFlows', 'dilutedSharesB', 'netCashB', 'wacc', 'forwardRevenueB']) assert.deepEqual(baseline[key], pack.evidenceAssumptions[key], `${name}: ${key}`);
      assert.doesNotMatch(payload.input, /765\.43|"(?:marketPrice|currentPrice|fairValue|targetPrice|rating|quote)"/i);
    }
  });
  assert.deepEqual(m.researchFirewall.sanitizeResearchInput({ operatingBaseline: { cashFlows: [10], rating: 'BUY', current_price: 91 }, fairValueNow: 42 }), { operatingBaseline: { cashFlows: [10] } });
});

test('P0-R1: EV/FCF consumes only explicit forecast FCF, never a generic margin', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.evidenceAssumptions.cashFlowBasis = 'analyst_fcff';
  const plan = makeSotpPlan(pack, { probability: 1 });
  plan.businesses[0].valuationMethod = 'ev_fcf';
  plan.businesses[0].forecastYears = [{ year: 2027, revenueB: 20, margin: .2 }];
  assert.throws(() => m.researchCompiler.compileResearchPlan(pack, plan), /MODEL_CAPABILITY_GAP/);
  plan.businesses[0].forecastYears[0].fcfB = 1;
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  assert.equal(compiled.segments[0].metric, 'fcf');
  assert.equal(compiled.segments[0].metricValueB * compiled.segments[0].multiple, 4);
});

test('P0-R1: an uncomputed zero-weight state does not invalidate computable states', async () => {
  const m = await mods(); const pack = await m.packMod.buildAutomatedValuationPack('AMD');
  const plan = makePlan(pack, { aggregationRule: 'scenario_weighted', scenarios: [
    { id: 'zero', name: 'Zero weight', description: '', probability: 0, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: 0 } },
    { id: 'normal', name: 'Normal', description: '', probability: 1, appliesTo: 'company', businessIds: ['core'], economics: { fcfMultiplier: 1 } },
  ] });
  const { output } = compileAndRun(m, pack, plan, pack.quote.price);
  assert.notEqual(output.dataQuality.valuationRelease, 'withheld');
  assert.equal(output.researchScenarios.scenarios[0].value, null);
  assert.equal(output.researchScenarios.expectedValue, output.researchScenarios.scenarios[1].value);
});

test('P0-R1: legacy reviewer failure and disabled paths expose truthful call and origin metadata', async () => {
  const m = await mods(); const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  const disabled = await m.valuationAi.runAiOrchestratedValuation(pack, {}, new Request('https://example.test'), { force: true });
  assert.equal(disabled.orchestration.aiCalledThisRun, false);
  assert.equal(disabled.orchestration.planOrigin, 'deterministic');
  assert.equal(disabled.orchestration.reviewStatus, 'not_run');
  pack.profile.baseline.forwardPe = 999;
  await withFakeAi(m, pack, trustedPlan(m, pack), async (payloads) => {
    const provider = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const result = await provider(input, init);
      return String(input) === 'https://api.openai.com/v1/responses' && JSON.parse(init.body).text.format.name === 'valuation_review'
        ? new Response('unavailable', { status: 503 }) : result;
    };
    const result = await m.valuationAi.runAiOrchestratedValuation(pack, { currentPrice: pack.quote.price }, new Request('https://example.test'), { force: true });
    assert.deepEqual(payloads.map(p => p.text.format.name), ['valuation_plan', 'valuation_review']);
    assert.equal(result.orchestration.aiCalledThisRun, true);
    assert.equal(result.orchestration.aiUsed, true);
    assert.equal(result.orchestration.planOrigin, 'deterministic');
    assert.equal(result.orchestration.reviewStatus, 'failed');
    assert.equal(result.orchestration.status, 'deterministic_fallback');
    assert.equal(result.orchestration.reviewerUsed, null);
  });
});

// P0-R2 boundary evidence uses synthetic data and intercepts every AI request.
async function r2Pack(id) {
  const m = await mods();
  const pack = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  pack.issuerProfile.issuerId = `p0-r2-${id}`;
  Object.assign(pack.evidenceAssumptions, { cashFlowBasis: 'analyst_fcff', cashFlows: [10, 11, 12], normalizedCashFlows: [10, 11, 12],
    wacc: .1, costOfEquity: .12, terminalGrowth: .03, netCashB: 8, dilutedSharesB: 2, forwardRevenueB: 100, forwardFcfB: 10, forwardEps: 1, fcfMargin: .1 });
  pack.profile.baseline = structuredClone(pack.evidenceAssumptions);
  pack.profile.baseline.forwardPe = 999;
  pack.profile.capitalCost = null;
  pack.profile.capitalBridge = undefined;
  pack.profile.dataQuality = { status: 'passed', valuationRelease: 'released', checks: [] };
  return { m, pack, plan: trustedPlan(m, pack) };
}
const r2Observe = (id, data) => console.log('P0_R2_PAYLOAD_EVIDENCE ' + JSON.stringify({ id, synthetic: true, ...data }));

test('P0-R2: only explicit operating provenance crosses the review-check projection', async () => {
  const {m} = await r2Pack('provenance');
  const base = { id: 'dimensional-check', label: 'Dimensional consistency', status: 'passed', detail: 'Revenue and diluted shares use consistent units.', evidenceRefs: [] };
  const checks = [undefined, 'market', 'mixed', 'operating'].map((provenance, i) => ({...base, id: `${base.id}-${i}`, provenance, derivedRatio: 1234}));
  const sent = m.researchFirewall.sanitizeChecksForReviewer(checks);
  assert.deepEqual(sent, [{...base, id: `${base.id}-3`}]);
  assert.deepEqual(m.researchFirewall.sanitizeChecksForReviewer([{...base, provenance: 'operating', priceBearing: true}]), []);
});

test('P0-R2: aliases share one validation and sending contract, preserving economic prices', async () => {
  const {m, plan} = await r2Pack('aliases');
  const aliases = ['preliminaryFairValue', 'CURRENT_PRICE_USD', 'target-price-low', 'estimated_fair_value_12m',
    'marketPriceUSD', 'ReferencePriceHigh', 'analyst_target_usd', 'consensusPrice', 'priceTargetHigh',
    'stock_price_usd', 'sharePriceNow', 'lastPrice', 'fvUsd', 'estimated_fv', 'rating_label', 'RATING', 'quoteUSD', 'expectedReturnPct'];
  for (const key of aliases) {
    const contaminated = structuredClone(plan);
    contaminated.businesses[0].revenueDriver.params[key] = 707.17;
    assert.throws(() => m.researchValidate.validateResearchPayload('plan', contaminated), /price-targeting field/, key);
    const args = {toolRequests: [{tool: 'get', args: {[key]: 707.17}}]};
    assert.doesNotMatch(JSON.stringify(m.researchFirewall.sanitizeResearchInput(args)), /707\.17/, key);
    assert.throws(() => m.researchValidate.validateResearchPayload('draft', {...plan, ...args}), /price-targeting field/, key);
  }
  const operating = {operatingBaseline: {operatingIncomeB: 8, operatingMargin: .2, cashFlows: [10, 11, 12], dilutedSharesB: 2, netCashB: 8, debtB: 3, wacc: .1},
    revenueDriver: {formula: 'volume_x_price', params: {volume: 1000000, price: 125}}};
  assert.deepEqual(m.researchFirewall.sanitizeResearchInput(operating), operating);
  for (const formula of ['volume_x_price', 'capacity_x_utilization_x_price']) {
    const good = structuredClone(plan); good.businesses[0].revenueDriver = {formula, params: formula === 'volume_x_price' ? {volume: 1000000, price: 125} : {capacity: 1000000, utilization: .8, price: 125}, evidenceId: plan.sources[0].id};
    assert.doesNotThrow(() => m.researchValidate.validateResearchPayload('plan', good));
    assert.deepEqual(m.researchFirewall.sanitizeResearchInput(good).businesses[0].revenueDriver, good.businesses[0].revenueDriver);
  }
  r2Observe('aliases-and-operating-controls', {aliases, projectedOperating: m.researchFirewall.sanitizeResearchInput(operating)});
});

test('P0-R2: all five actual request inputs stay identical across ordinary and hard-gate quotes', async () => {
  const {m, pack, plan} = await r2Pack('quote-invariance');
  plan.businesses[0].revenueDriver = {formula: 'volume_x_price', params: {volume: 1000000, price: 125}, evidenceId: plan.sources[0].id};
  Object.assign(pack.evidenceAssumptions, {operatingIncomeB: 8, operatingMargin: .2, debtB: 3, preliminaryFairValue: 707.17, CURRENT_PRICE_USD: 811.23});
  const cases = [];
  for (const price of [100, 200, .01, 1000000]) {
    await withFakeAi(m, pack, plan, async (payloads) => {
      const old = await m.valuationAi.runAiOrchestratedValuation(pack, {currentPrice: price, simulationCount: 1000}, new Request('https://fixture.invalid'), {force: true});
      await m.valuationAi.runResearchValuation(pack, {currentPrice: price, simulationCount: 1000}, new Request('https://fixture.invalid'), {force: true});
      const inputs = Object.fromEntries(payloads.map(body => [body.text.format.name, JSON.parse(body.input)]));
      assert.deepEqual(Object.keys(inputs).sort(), ['valuation_plan', 'valuation_review', 'research_draft', 'research_finalize', 'research_reviewer'].sort());
      for (const input of Object.values(inputs)) {
        assert.doesNotMatch(JSON.stringify(input), /707\.17|811\.23/);
        for (const key of ['cashFlows', 'dilutedSharesB', 'netCashB', 'wacc', 'operatingIncomeB', 'operatingMargin', 'debtB']) assert.deepEqual(input.evidence.operatingBaseline[key], pack.evidenceAssumptions[key]);
      }
      assert.equal(inputs.research_finalize.draft.businesses[0].revenueDriver.params.price, 125);
      assert.equal(inputs.research_reviewer.plan.businesses[0].revenueDriver.params.price, 125);
      assert.ok(inputs.valuation_review.checks.some(c => c.id === 'share-scale'));
      assert.ok(inputs.research_reviewer.checks.some(c => c.id === 'compilation-completeness'));
      if (cases.length) assert.deepEqual(inputs, cases[0].inputs, `quote=${price}: entire five-stage input equality`);
      const market = old.output.dataQuality.checks.filter(c => c.provenance === 'market');
      if (price === .01 || price === 1000000) {
        assert.ok(market.some(c => c.status === 'failed'));
        assert.equal(old.output.dataQuality.valuationRelease, 'withheld');
        assert.equal(old.output.ensemble.fairValue, null);
      }
      cases.push({price, release: old.output.dataQuality.valuationRelease, market, inputs});
    });
  }
  assert.notDeepEqual(cases[0].market, cases[1].market);
  for (const captured of cases) r2Observe('five-stage-quote-invariance', {cases: [captured]});
});

test('P0-R2: contaminated draft or finalized response is rejected before forwarding or approval', async () => {
  for (const stage of ['research_draft', 'research_finalize']) {
    const {m, pack, plan} = await r2Pack(stage);
    await withFakeAi(m, pack, plan, async (payloads) => {
      const previous = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const response = await previous(input, init);
        if (String(input) !== 'https://api.openai.com/v1/responses' || JSON.parse(init.body).text.format.name !== stage) return response;
        const body = await response.json(); const result = JSON.parse(body.output_text);
        result.businesses[0].revenueDriver.params['estimated-fair-value-usd'] = 707.17;
        return Response.json({output_text: JSON.stringify(result)});
      };
      const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), {force: true});
      assert.deepEqual(payloads.map(body => body.text.format.name), stage === 'research_draft' ? ['research_draft'] : ['research_draft', 'research_finalize']);
      assert.match(result.orchestration.research.schemaError, /RESEARCH_SCHEMA_INVALID.*estimated-fair-value-usd/);
      assert.equal(result.orchestration.planOrigin, 'deterministic');
      assert.equal(result.orchestration.reviewStatus, 'not_run');
      assert.equal(result.output.dataQuality.valuationRelease, 'withheld');
      const d = result.orchestration.research;
      assert.equal(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, d.policyVersion, d.evidenceVersion), null);
      for (const body of payloads) assert.doesNotMatch(body.input, /707\.17|estimated-fair-value-usd/);
      r2Observe(stage + '-rejection', {stages: payloads.map(body => body.text.format.name), schemaError: d.schemaError, release: result.output.dataQuality.valuationRelease, planOrigin: result.orchestration.planOrigin});
    });
  }
});

test('P0-R2: contaminated write cannot replace approved memory cache; cache version changes', async () => {
  const {m, pack, plan} = await r2Pack('write-protection');
  let first;
  await withFakeAi(m, pack, plan, async () => { first = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'), {force: true}); });
  const d = first.orchestration.research;
  const clean = await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, d.policyVersion, d.evidenceVersion);
  assert.ok(clean?.approval);
  assert.notEqual(clean.approval.compilerVersion, 'p0-r1-correctness-v1');
  assert.ok(d.policyVersion.endsWith(clean.approval.compilerVersion));
  const bad = structuredClone(clean); bad.plan.businesses[0].revenueDriver.params.targetPriceLow = 912.34;
  await assert.rejects(m.issuer.persistResearchPlan(bad), /RESEARCH_SCHEMA_INVALID/);
  assert.deepEqual(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, d.policyVersion, d.evidenceVersion), clean);
  const hit = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'));
  assert.equal(hit.orchestration.cached, true); assert.equal(hit.orchestration.aiCalledThisRun, false);
  const old = {...clean, issuerId: 'p0-r2-old-version', approval: {...clean.approval, compilerVersion: 'p0-r1-correctness-v1'}};
  await m.issuer.persistResearchPlan(old);
  const oldPack = structuredClone(pack); oldPack.issuerProfile.issuerId = old.issuerId;
  const miss = await m.valuationAi.runResearchValuation(oldPack, {}, new Request('https://fixture.invalid'));
  assert.equal(miss.orchestration.cached, false); assert.equal(miss.orchestration.planOrigin, 'deterministic');
  assert.equal(miss.output.dataQuality.valuationRelease, 'withheld');
  r2Observe('approved-write-and-version', {compilerVersion: clean.approval.compilerVersion, cleanCacheHit: hit.orchestration.cached, rejectedVersionFallback: miss.orchestration.planOrigin});
});

test('P0-R2: historical contaminated approved DB row is neither hydrated nor reused', async () => {
  const {m, pack, plan} = await r2Pack('historical-cache');
  const seed = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'));
  const d = seed.orchestration.research;
  plan.businesses[0].revenueDriver.params.CURRENT_PRICE_USD = 811.23;
  const row = {issuer_id: pack.issuerProfile.issuerId, policy_version: d.policyVersion, evidence_version: d.evidenceVersion, assumption_version: 'contaminated-history',
    plan_json: JSON.stringify({plan, approval: {compilerVersion: 'p0-r2-price-isolation-v1', evidenceIds: [plan.sources[0].id], planOrigin: 'ai', reviewStatus: 'passed'}})};
  let reads = 0;
  // Inert DB adapter: no real binding, no external I/O, no mutable SQL accepted.
  globalThis.__p0TestBindings = {DB: {batch: async () => [], prepare: (sql) => ({bind() {return this;}, first: async () => {
    assert.match(sql, /^SELECT \* FROM research_plans/); reads++; return structuredClone(row);
  }, run: async () => {throw new Error('Unexpected DB mutation');}})}};
  try {
    assert.equal(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId, d.policyVersion, d.evidenceVersion), null);
    const result = await m.valuationAi.runResearchValuation(pack, {}, new Request('https://fixture.invalid'));
    assert.ok(reads >= 2, 'Rejected row must not be hydrated into the memory cache');
    assert.equal(result.orchestration.cached, false);
    assert.equal(result.orchestration.aiCalledThisRun, false);
    assert.equal(result.orchestration.reviewStatus, 'not_run');
    assert.equal(result.orchestration.planOrigin, 'deterministic');
    assert.equal(result.output.dataQuality.valuationRelease, 'withheld');
    assert.doesNotMatch(JSON.stringify(result.orchestration.research.plan), /811\.23|CURRENT_PRICE_USD/);
    assert.equal(m.issuer.getProductionD1MutationCount(), 0);
    r2Observe('historical-cache-rejection', {reads, cacheHit: result.orchestration.cached, planOrigin: result.orchestration.planOrigin, release: result.output.dataQuality.valuationRelease});
  } finally { delete globalThis.__p0TestBindings; }
});

// P0-R3: contract tests intentionally use an ordinary unknown name, not another
// stock-price alias, to distinguish a positive schema from a larger blacklist.
const r3Extra = 'undeclaredAuditDatum';
const r3Record = (id, data) => console.log('P0_R3_CONTRACT_OBSERVATION ' + JSON.stringify({id, synthetic: true, ...data}));
function r3RichPlan(plan) {
  const p = structuredClone(plan), id = p.sources[0].id, b = p.businesses[0];
  b.costDrivers = [{formula: 'constant', params: {value: 1}, evidenceId: id, note: 'Operating cost'}];
  b.forecastAssumptions = [{id: 'a', field: 'revenueB', value: 100, unit: 'USD billions', evidenceId: id, rationale: 'Synthetic assumption'}];
  b.growthConstraints = [{id: 'g', field: 'growth', min: 0, max: .2, rationale: 'Synthetic bounds', evidenceId: null}];
  p.capitalRequirements = [{id: 'c', businessId: 'core', kind: 'capex', incremental: true, amountB: 1, timingYear: 1, evidenceId: id, rationale: 'Incremental only'}];
  p.financing = [{id: 'f', kind: 'equity', amountB: 2, timingYear: 0, costPct: .1, evidenceId: id, rationale: 'Synthetic capital'}];
  p.dilution = [{id: 'd', kind: 'new_shares', sharesB: .1, evidenceId: id, rationale: 'Synthetic shares'}];
  p.scenarios = [{id: 's', name: 'Operating state', description: 'Synthetic', probability: .5, appliesTo: 'company', businessIds: ['core'], economics: {fcfMultiplier: 1}}];
  p.probabilitiesCheck.owners = [{uncertaintyId: 's', owner: 'scenario'}];
  p.revisionRecords = [{revisionReason: 'probability_invalid', path: 'scenarios[0].probability', oldValue: .4, proposedValue: .5, evidenceRefs: [id], explanation: 'Synthetic correction'}];
  p.sources[0].asOf = '2026-09-21'; p.sources[0].url = 'https://fixture.invalid/filing';
  return p;
}

test('P0-R3: every declared nested node rejects ordinary extra fields and wrong structures', async () => {
  const {m, plan} = await r2Pack('r3-nodes'), p = {...r3RichPlan(plan), toolRequests: []};
  // The rich node fixture exercises the exploratory draft grammar; its cost
  // and financing fields are intentionally outside the final executable set.
  assert.doesNotThrow(() => m.researchValidate.validateResearchPayload('draft', p));
  const nodes = [x=>x, x=>x.businesses[0], x=>x.businesses[0].revenueDriver, x=>x.businesses[0].revenueDriver.params,
    x=>x.businesses[0].costDrivers[0], x=>x.businesses[0].costDrivers[0].params, x=>x.businesses[0].disclosedData[0],
    x=>x.businesses[0].forecastYears[0], x=>x.businesses[0].forecastAssumptions[0], x=>x.businesses[0].growthConstraints[0],
    x=>x.capitalRequirements[0], x=>x.financing[0], x=>x.dilution[0], x=>x.valuationMethods[0], x=>x.scenarios[0], x=>x.scenarios[0].economics,
    x=>x.probabilitiesCheck, x=>x.probabilitiesCheck.owners[0], x=>x.sources[0], x=>x.revisionRecords[0]];
  for (const node of nodes) {
    const dirty = structuredClone(p); node(dirty)[r3Extra] = {ordinary: 1622.46};
    assert.throws(() => m.researchValidate.validateResearchPayload('draft', dirty), /unknown field/);
    assert.doesNotMatch(JSON.stringify(m.researchFirewall.sanitizeResearchInput({draft: dirty})), /undeclaredAuditDatum/);
  }
  const invalid = [x=>x.businesses[0].disclosedData[0].value={}, x=>x.businesses[0].forecastYears[0].fcfB={},
    x=>x.businesses[0].forecastAssumptions[0].value='100', x=>x.businesses[0].growthConstraints[0].min=[],
    x=>x.capitalRequirements[0].incremental='true', x=>x.sources[0].url={}, x=>x.scenarios[0].businessIds=[{}],
    x=>x.probabilitiesCheck.owners[0].owner='both', x=>x.businesses[0].applicabilityConditions=[{}],
    x=>x.revisionRecords[0].evidenceRefs=[{}], x=>x.businesses[0].disclosedData=[null]];
  for (const mutate of invalid) {const dirty=structuredClone(p); mutate(dirty); assert.throws(()=>m.researchValidate.validateResearchPayload('draft',dirty),/RESEARCH_SCHEMA_INVALID/);}
  assert.deepEqual(m.researchFirewall.sanitizeResearchInput({draft: p}).draft, p);
  r3Record('closed-nodes', {checkedNodes: nodes.length, wrongStructures: invalid.length, incrementalPreserved: true});
});

test('P0-R3: all formula contracts preserve finite operating parameters and empty fallback', async () => {
  const {m, pack, plan} = await r2Pack('r3-formulas');
  const cases = [['volume_x_price',{volume:'1e6',price:125}],['capacity_x_utilization_x_price',{capacity:1e6,utilization:.8,price:'125'}],
    ['users_x_arpu',{users:1e6,arpu:125}],['constant',{value:125e6}],['reported_segment',{revenueB:.125}],['growth',{revenueB:.125}],['revenue_x_margin',{revenueB:.125}],
    ['asset_yield_minus_share_plus_fees',{}],['sum_of_children',{}],['scenario_weighted',{}]];
  for (const [formula,params] of cases) {
    const good=structuredClone(plan);good.businesses[0].revenueDriver={formula,params,evidenceId:plan.sources[0].id};
    assert.doesNotThrow(()=>m.researchValidate.validateResearchPayload('plan',good));
    assert.deepEqual(m.researchFirewall.sanitizeResearchInput(good),good);
    const extra=structuredClone(good);extra.businesses[0].revenueDriver.params[r3Extra]=1;
    assert.throws(()=>m.researchValidate.validateResearchPayload('plan',extra),/unknown field/);
    const key=Object.keys(params)[0];
    if(key) for(const value of [null,{},[],true,'',' ','0x10','1e999',NaN,Infinity]) {
      const bad=structuredClone(good);bad.businesses[0].revenueDriver.params[key]=value;
      assert.throws(()=>m.researchValidate.validateResearchPayload('plan',bad),/RESEARCH_SCHEMA_INVALID/);
    }
    // The three non-evaluated formulas retain the disclosed/forecast fallback.
    if(!key) assert.doesNotThrow(()=>m.researchCompiler.compileResearchPlan(pack,good));
  }
  assert.deepEqual(plan.businesses[0].revenueDriver.params, {});
  assert.doesNotThrow(()=>m.researchValidate.validateResearchPayload('plan',plan));
  assert.doesNotThrow(()=>m.researchCompiler.compileResearchPlan(pack,plan));
  r3Record('formula-contracts',{formulas:cases.map(([formula])=>formula),numericStringsPreserved:true,emptyReportedFallback:true});
});

test('P0-R3: tool schemas and dispatch share bounded arguments, aliases and unknown-field rejection', async () => {
  const {m, pack, plan} = await r2Pack('r3-tools');
  const evidence = await m.packMod.loadSecEvidence('AMD');
  const valid = [['list_filing_documents',{}],['list_filing_documents',{limit:1}],['get_reported_segments',{}],
    ['get_peer_financials',{peers:['AMD']}],['get_peer_financials',{peerTickers:['AMD']}],['get_peer_financials',{tickers:['AMD']}]];
  for(const [tool,args] of valid) {
    const draft={...plan,toolRequests:[{tool,args}]};
    assert.doesNotThrow(()=>m.researchValidate.validateResearchPayload('draft',draft));
    assert.deepEqual(m.researchFirewall.sanitizeResearchInput(draft),draft);
    const result=await new m.researchTools.ResearchToolRunner(6,120000,1000).run(tool,args,evidence);
    assert.equal(result.ok,true,result.error);
    if(tool==='list_filing_documents'&&args.limit) assert.ok(result.data.filings.length<=args.limit);
    if(tool==='get_peer_financials') assert.ok(result.data.peers.AMD);
    const bad={...args,[r3Extra]:1};
    assert.throws(()=>m.researchValidate.validateResearchPayload('draft',{...plan,toolRequests:[{tool,args:bad}]}),/unknown field/);
    const blocked=await new m.researchTools.ResearchToolRunner().run(tool,bad,evidence);
    assert.equal(blocked.ok,false);assert.match(blocked.error,/RESEARCH_SCHEMA_INVALID/);
  }
  for(const [tool,args] of [['list_filing_documents',{limit:null}],['list_filing_documents',{limit:0}],['list_filing_documents',{limit:11}],['list_filing_documents',{limit:1.5}],
    ['list_filing_documents',{limit:'1'}],['get_reported_segments',{limit:1}],['get_peer_financials',{peers:[123]}],['get_peer_financials',{tickers:[{}]}],['get_peer_financials',{peerTickers:['']}],['toString',{}]]) {
    assert.throws(()=>m.researchValidate.validateResearchPayload('draft',{...plan,toolRequests:[{tool,args}]}),/RESEARCH_SCHEMA_INVALID/);
    assert.equal((await new m.researchTools.ResearchToolRunner().run(tool,args,evidence)).ok,false);
  }
  r3Record('tool-contracts',{validRequests:valid,productionWrites:m.issuer.getProductionD1MutationCount(),issuer:pack.issuerProfile.issuerId});
});

test('P1: SEC research collects annual and quarterly reports and verifies disclosed business rows', async () => {
  const m = await loadAll();
  installProviders();
  const originalFetch = globalThis.fetch;
  const accessionQ = '0001045810-26-000075';
  const accessionK = '0001045810-26-000010';
  const nvdaQ = 'Segment Information The table below presents details of our reportable segments. Compute & Networking Graphics Total (In millions) Three Months Ended Jul 31, 2026 Revenue $ 10,000 $ 2,000 $ 12,000 Other segment items 3,000 800 3,800';
  const nvdaK = 'Segment Information The table below presents details of our reportable segments. Compute & Networking Graphics Total (In millions) Year Ended Jan 31, 2026 Revenue $ 35,000 $ 5,000 $ 40,000';
  const facts = { entityName: 'NVIDIA CORPORATION', facts: { 'us-gaap': {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      { start: '2026-05-01', end: '2026-07-31', filed: '2026-08-28', form: '10-Q', accn: accessionQ, val: 12e9 },
      { start: '2025-02-01', end: '2026-01-31', filed: '2026-03-01', form: '10-K', accn: accessionK, val: 40e9 },
    ] } },
  } } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/companyfacts/')) return Response.json(facts);
    if (url.includes('/submissions/')) return Response.json({ name: 'NVIDIA CORPORATION', filings: { recent: {
      form: ['8-K', '10-K', '10-Q'], accessionNumber: ['0001045810-26-000080', accessionK, accessionQ],
      filingDate: ['2026-09-01', '2026-03-01', '2026-08-28'], reportDate: ['2026-08-31', '2026-01-31', '2026-07-31'],
      primaryDocument: ['event.htm', 'annual.htm', 'quarter.htm'],
    } } });
    if (url.endsWith('/quarter.htm')) return new Response(nvdaQ);
    if (url.endsWith('/annual.htm')) return new Response(nvdaK);
    if (url.endsWith('/event.htm')) throw new Error('8-K must not be fetched as the periodic report');
    return originalFetch(input, init);
  };
  try {
    const evidence = await m.packMod.loadSecEvidence('NVDA');
    assert.equal(evidence.documents.annual?.body, nvdaK);
    assert.equal(evidence.documents.quarterly?.body, nvdaQ);
    assert.equal(evidence.documents.current?.form, '8-K');
    assert.equal(evidence.latestFiling?.accessionNumber, accessionQ);
    assert.equal(evidence.reportedBusinesses.status, 'verified');
    assert.equal(evidence.reportedBusinesses.kind, 'reportable_segment');
    assert.deepEqual(evidence.reportedBusinesses.businesses.map((row) => [row.name, row.revenueB]),
      [['Compute & Networking', 10], ['Graphics', 2]]);
    const segments = await new m.researchTools.ResearchToolRunner(6, 120_000, 1_000).run('get_reported_segments', {}, evidence);
    assert.equal(segments.ok, true);
    assert.equal(segments.data.reportedBusinesses.status, 'verified');
    const packRef = { cache: { latestFilingId: accessionQ, evidenceVersion: 'fixture' } };
    assert.equal(m.valuationAi.researchEvidenceIds(packRef, [segments]).has(segments.id), true);
    const uncertain = { ...evidence, reportedBusinesses: { ...evidence.reportedBusinesses, status: 'unverified', businesses: [] } };
    const uncertainResult = await new m.researchTools.ResearchToolRunner(6, 120_000, 1_000).run('get_reported_segments', {}, uncertain);
    assert.equal(uncertainResult.data.available, false);
    assert.equal(m.valuationAi.researchEvidenceIds(packRef, [uncertainResult]).has(uncertainResult.id), false);
    const documents = await new m.researchTools.ResearchToolRunner(6, 120_000, 1_000).run('list_filing_documents', {}, evidence);
    assert.equal(documents.data.latestAnnualReport.bodyAvailable, true);
    assert.equal(documents.data.latestCurrentReport.bodyAvailable, false);
  } finally { globalThis.fetch = originalFetch; }

  const document = { form: '10-Q', accessionNumber: '0000000000-26-000001', url: 'https://www.sec.gov/example',
    filed: '2026-09-01', reportDate: '2026-08-31', body: 'Disaggregated revenue (in millions) Cloud services and license support 12,000 Cloud license and on-premise license 4,000 Hardware 2,000 Services 2,000' };
  const oracleFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    { start: '2026-06-01', end: '2026-08-31', form: '10-Q', accn: document.accessionNumber, val: 20e9 },
  ] } } } } };
  assert.equal(m.packMod.extractReportedBusinesses('ORCL', document, oracleFacts).status, 'unverified');
  assert.equal(m.packMod.extractReportedBusinesses('ORCL', document, { facts: {} }).status, 'unverified');
  const mismatched = structuredClone(oracleFacts);
  mismatched.facts['us-gaap'].Revenues.units.USD[0].val = 21e9;
  assert.equal(m.packMod.extractReportedBusinesses('ORCL', document, mismatched).status, 'unverified');
  const restated = structuredClone(oracleFacts);
  restated.facts['us-gaap'].Revenues.units.USD[0].accn = '0000000000-26-000002';
  assert.equal(m.packMod.extractReportedBusinesses('ORCL', document, restated).status, 'unverified');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/companyfacts/')) return Response.json({ entityName: 'NVIDIA CORPORATION', facts: { 'us-gaap': { Revenues: { units: { USD: [
      { start: '2025-06-01', end: '2026-05-31', form: '10-K', accn: '0000000000-26-000003', val: 20e9 },
    ] } } } } });
    if (url.includes('/submissions/')) return Response.json({ name: 'NVIDIA CORPORATION', filings: { recent: {
      form: ['8-K', '10-Q', '10-K'], accessionNumber: ['0000000000-26-000004', '0000000000-26-000002', '0000000000-26-000003'],
      filingDate: ['2026-07-10', '2026-03-01', '2026-06-20'], reportDate: ['2026-07-10', '2026-02-28', '2026-05-31'],
      primaryDocument: ['event.htm', 'quarter.htm', 'annual.htm'],
    } } });
    if (url.endsWith('/annual.htm')) return new Response('Segment Information The table below presents details of our reportable segments. Compute & Networking Graphics Total (In millions) Year Ended May 31, 2026 Revenue $ 18,000 $ 2,000 $ 20,000');
    if (url.endsWith('/quarter.htm')) return new Response('prior quarter');
    if (url.endsWith('/event.htm')) throw new Error('8-K must not displace the annual report');
    return originalFetch(input, init);
  };
  try {
    const annualFirst = await m.packMod.loadSecEvidence('NVDA');
    assert.equal(annualFirst.latestFiling?.accessionNumber, '0000000000-26-000003');
    assert.equal(annualFirst.reportedBusinesses.status, 'verified');
    assert.equal(annualFirst.documents.quarterly?.body, 'prior quarter');
  } finally { globalThis.fetch = originalFetch; }
  const pltr = { ...document, body: 'Revenue by customer (in millions) Government $ 700 Commercial $ 300' };
  const pltrFacts = structuredClone(oracleFacts);
  pltrFacts.facts['us-gaap'].Revenues.units.USD[0].val = 1e9;
  const pltrSplit = m.packMod.extractReportedBusinesses('PLTR', pltr, pltrFacts);
  assert.equal(pltrSplit.status, 'unverified');
  // Filing table shapes are taken from the issuers' SEC 10-Q disclosures.
  const amdOfficial = { ...document, accessionNumber: '0000002488-26-000123', reportDate: '2026-06-27',
    body: 'Segment Information Three Months Ended June 27, 2026 and Six Months Ended June 27, 2026 (In millions) Net revenue: Data Center $ 6,718 3,718 12,000 7,000 Client and Gaming Client 3,062 2,062 6,000 4,000 Gaming 779 679 1,500 1,300 Total Client and Gaming 3,841 2,741 7,500 5,300 Embedded 977 877 1,800 1,600 Total net revenue $ 11,536 7,336 21,300 13,900' };
  const amdFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    { start: '2026-03-29', end: '2026-06-27', form: '10-Q', accn: amdOfficial.accessionNumber, val: 11.536e9 },
  ] } } } } };
  const amdSplit = m.packMod.extractReportedBusinesses('AMD', amdOfficial, amdFacts);
  assert.equal(amdSplit.status, 'verified');
  assert.equal(amdSplit.kind, 'revenue_line');
  assert.deepEqual(amdSplit.businesses.map((row) => [row.name, row.revenueB]),
    [['Data Center', 6.718], ['Client', 3.062], ['Gaming', 0.779], ['Embedded', 0.977]]);
  const pltrOfficial = { ...document, accessionNumber: '0001321655-26-000041', reportDate: '2026-06-30',
    body: 'Segment and Geographic Information Financial information for each reportable segment, including disaggregation of revenue, was as follows (in thousands, except percentages): Three Months Ended June 30, 2026 2025 Contribution: Government revenue $ 990,032 500,000 Expenses attributable to government segment (288,926) Government contribution 701,106 Commercial revenue 945,432 400,000 Expenses attributable to commercial segment (210,488) Commercial contribution 734,944' };
  const pltrOfficialFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    { start: '2026-04-01', end: '2026-06-30', form: '10-Q', accn: pltrOfficial.accessionNumber, val: 1.935464e9 },
  ] } } } } };
  const pltrOfficialSplit = m.packMod.extractReportedBusinesses('PLTR', pltrOfficial, pltrOfficialFacts);
  assert.equal(pltrOfficialSplit.status, 'verified');
  assert.deepEqual(pltrOfficialSplit.businesses.map((row) => row.revenueB), [0.990032, 0.945432]);
  const nvidiaOfficial = { ...document, accessionNumber: '0001045810-26-000075', reportDate: '2026-07-26',
    body: 'Note 13 - Segment Information The table below presents details of our reportable segments. Compute & Networking Graphics Total (In millions) Three Months Ended Jul 26, 2026 Revenue $ 88,299 $ 7,922 $ 96,221 Other segment items 25,603 4,023 29,626' };
  const nvidiaFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    { start: '2026-04-27', end: '2026-07-26', form: '10-Q', accn: nvidiaOfficial.accessionNumber, val: 96.221e9 },
  ] } } } } };
  assert.deepEqual(m.packMod.extractReportedBusinesses('NVDA', nvidiaOfficial, nvidiaFacts).businesses.map((row) => row.revenueB), [88.299, 7.922]);
  const oracleStatement = { ...document,
    body: 'Condensed Consolidated Statements of Operations (in millions, except per share data) Revenues: Cloud services and license support $ 11,007 9,963 Cloud license and on-premise license 1,129 1,256 Hardware 703 754 Services 1,291 1,307 Total revenues 14,130' };
  const oracleStatementFacts = structuredClone(oracleFacts);
  oracleStatementFacts.facts['us-gaap'].Revenues.units.USD[0].val = 14.13e9;
  assert.equal(m.packMod.extractReportedBusinesses('ORCL', oracleStatement, oracleStatementFacts).status, 'unverified');
  const oracleCurrent = { ...document, accessionNumber: '0001193125-26-389274', reportDate: '2026-08-31',
    body: 'The following table presents summary results for each of our three businesses: Three Months Ended August 31 (in millions) Cloud and software: Revenues $ 17,157 Cloud and software expenses 6,235 Hardware: Revenues $ 774 Hardware expenses 272 Services: Revenues $ 1,414 Services expenses 969 Totals: Revenues $ 19,345' };
  const oracleCurrentFacts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    { start: '2026-06-01', end: '2026-08-31', form: '10-Q', accn: oracleCurrent.accessionNumber, val: 19.345e9 },
  ] } } } } };
  const currentSplit = m.packMod.extractReportedBusinesses('ORCL', oracleCurrent, oracleCurrentFacts);
  assert.equal(currentSplit.status, 'verified');
  assert.equal(currentSplit.kind, 'reportable_segment');
  assert.deepEqual(currentSplit.businesses.map((row) => row.revenueB), [17.157, 0.774, 1.414]);
});

test('P1: a new periodic accession bypasses a warm pack and research-plan cache', async () => {
  const m = await loadAll();
  installProviders();
  m.packMod.resetPackCache();
  const oldPack = await m.packMod.buildAutomatedValuationPack('AMD');
  const accession = '0000000000-26-000099';
  const originalFetch = globalThis.fetch;
  const originalBindings = globalThis.__p0TestBindings;
  globalThis.__p0TestBindings = { ...originalBindings, AI_VALUATION_ENABLED: 'false' };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/submissions/')) return Response.json({ name: 'ADVANCED MICRO DEVICES INC', filings: { recent: {
      form: ['8-K', '10-K'], accessionNumber: ['0000000000-26-000100', accession],
      filingDate: ['2026-09-24', '2026-09-23'], reportDate: ['2026-09-24', '2026-09-20'],
      primaryDocument: ['event.htm', 'annual.htm'],
    } } });
    return originalFetch(input, init);
  };
  try {
    assert.equal(await m.packMod.latestPeriodicAccession(oldPack.identity.cik), accession);
    assert.notEqual(oldPack.cache.latestFilingId, accession);
    const result = await m.valuationAi.runResearchValuation(oldPack, {}, new Request('https://fixture.invalid/research'));
    const freshPack = await m.packMod.buildAutomatedValuationPack('AMD', accession);
    assert.equal(freshPack.cache.latestFilingId, accession);
    assert.equal(result.orchestration.research.evidenceVersion, freshPack.cache.evidenceVersion);
    assert.notEqual(result.orchestration.research.evidenceVersion, oldPack.cache.evidenceVersion);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__p0TestBindings = originalBindings;
    m.packMod.resetPackCache();
  }
});

test('P0-R3: arbitrary structural contamination stops each model response before further sending or approval', async () => {
  for(const stage of ['research_draft','research_finalize','research_reviewer']) {
    const {m,pack,plan}=await r2Pack('r3-response-'+stage);
    await withFakeAi(m,pack,plan,async(payloads)=>{
      const provider=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{
        const response=await provider(input,init);
        if(String(input)!=='https://api.openai.com/v1/responses'||JSON.parse(init.body).text.format.name!==stage)return response;
        const body=await response.json(), data=JSON.parse(body.output_text);
        if(stage==='research_reviewer')data[r3Extra]={ordinary:1622.46};
        else data.businesses[0].disclosedData[0][r3Extra]={ordinary:1622.46};
        return Response.json({output_text:JSON.stringify(data)});
      };
      const r=await m.valuationAi.runResearchValuation(pack,{},new Request('https://fixture.invalid'),{force:true});
      const d=r.orchestration.research;
      assert.match(d.schemaError,/undeclaredAuditDatum.*unknown field/);
      assert.equal(r.output.dataQuality.valuationRelease,'withheld');
      assert.equal(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion),null);
      for(const body of payloads)assert.doesNotMatch(body.input,/undeclaredAuditDatum/);
      assert.equal(payloads.length,['research_draft','research_finalize','research_reviewer'].indexOf(stage)+1);
      r3Record('response-'+stage,{stages:payloads.map(p=>p.text.format.name),schemaError:d.schemaError,reviewStatus:r.orchestration.reviewStatus,release:r.output.dataQuality.valuationRelease});
    });
  }
});

test('P0-R3: legal tool draft and post-review plan preserve declared economics at actual boundaries', async () => {
  const {m,pack,plan}=await r2Pack('r3-positive-requests');
  plan.businesses[0].revenueDriver={formula:'volume_x_price',params:{volume:'1000000',price:125},evidenceId:plan.sources[0].id};
  plan.capitalRequirements=[{id:'c',businessId:'core',kind:'capex',incremental:true,amountB:1,timingYear:2,evidenceId:plan.sources[0].id,rationale:'Incremental'}];
  await withFakeAi(m,pack,plan,async(payloads)=>{
    const provider=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const response=await provider(input,init);
      if(String(input)!=='https://api.openai.com/v1/responses')return response;
      const stage=JSON.parse(init.body).text.format.name, body=await response.json(), data=JSON.parse(body.output_text);
      if(stage==='research_draft')data.toolRequests=[{tool:'list_filing_documents',args:{limit:1}}];
      if(stage==='research_reviewer')data.revisions=[{revisionReason:'evidence_contradiction',path:'businesses[0].forecastYears[0].fcfB',oldValue:10,proposedValue:9,evidenceRefs:[plan.sources[0].id],explanation:'Synthetic operating correction'}];
      return Response.json({output_text:JSON.stringify(data)});
    };
    const r=await m.valuationAi.runResearchValuation(pack,{},new Request('https://fixture.invalid'),{force:true});
    assert.equal(r.orchestration.reviewStatus,'passed');
    assert.equal(r.orchestration.research.plan.businesses[0].forecastYears[0].fcfB,9);
    const d=r.orchestration.research, stored=await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
    assert.ok(stored?.approval);assert.equal(stored.plan.capitalRequirements[0].incremental,true);
    for(const body of payloads.filter(x=>['research_finalize','research_reviewer'].includes(x.text.format.name))) {
      const input=JSON.parse(body.input), sent=input.draft??input.plan;
      assert.deepEqual(sent.businesses[0].revenueDriver,plan.businesses[0].revenueDriver);
      assert.equal(sent.capitalRequirements[0].incremental,true);
      r3Record('actual-'+body.text.format.name,{input});
    }
  });
});

test('P0-R3: unknown nested field cannot replace clean storage or hydrate a historical row', async () => {
  const {m,pack,plan}=await r2Pack('r3-cache');let first;
  await withFakeAi(m,pack,plan,async()=>{first=await m.valuationAi.runResearchValuation(pack,{},new Request('https://fixture.invalid'),{force:true});});
  const d=first.orchestration.research, clean=await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
  assert.ok(clean?.approval);
  const dirty=structuredClone(clean);dirty.plan.businesses[0].forecastYears[0][r3Extra]={ordinary:1622.46};
  await assert.rejects(m.issuer.persistResearchPlan(dirty),/unknown field/);
  assert.deepEqual(await m.issuer.loadResearchPlan(pack.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion),clean);
  const historical=structuredClone(pack);historical.issuerProfile.issuerId+='-historical';let reads=0;
  const row={issuer_id:historical.issuerProfile.issuerId,policy_version:d.policyVersion,evidence_version:d.evidenceVersion,assumption_version:'invalid-structure',plan_json:JSON.stringify({plan:dirty.plan,approval:clean.approval})};
  globalThis.__p0TestBindings={DB:{batch:async()=>[],prepare:(sql)=>({bind(){return this;},first:async()=>{assert.match(sql,/^SELECT \* FROM research_plans/);reads++;return structuredClone(row);},run:async()=>{throw new Error('No writes allowed');}})}};
  try {
    assert.equal(await m.issuer.loadResearchPlan(historical.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion),null);
    const fallback=await m.valuationAi.runResearchValuation(historical,{},new Request('https://fixture.invalid'));
    assert.ok(reads>=2);assert.equal(fallback.orchestration.cached,false);assert.equal(fallback.orchestration.planOrigin,'deterministic');
    assert.equal(fallback.orchestration.aiCalledThisRun,false);assert.equal(fallback.output.dataQuality.valuationRelease,'withheld');
    r3Record('unknown-cache-field',{reads,cacheHit:false,planOrigin:fallback.orchestration.planOrigin,release:fallback.output.dataQuality.valuationRelease});
  } finally {delete globalThis.__p0TestBindings;}
  assert.equal(m.issuer.getProductionD1MutationCount(),0);
});
