// R6 business-bound multiple tests. All market providers are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { installProviders, loadEngine } from './helpers/valuation-harness.mjs';

const root = new URL('../lib/', import.meta.url), urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let code = ts.transpileModule(await readFile(new URL(name + '.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace('import { env } from "cloudflare:workers";', 'const env = {};');
  for (const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(x => x[1])))
    code = code.replaceAll('from "' + spec + '"', 'from "' + await moduleUrl(spec.slice(2)) + '"');
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  urls.set(name, url); return url;
}
const [validation, plans, compiler, engine] = await Promise.all(
  ['research-validate', 'research-plan', 'research-compiler', 'universal-valuation'].map(async name => import(await moduleUrl(name))),
);
const live = JSON.parse(await readFile(new URL('./fixtures/p0-r5-nvda-a5-live-draft.json', import.meta.url), 'utf8'));
let packPromise;
async function pack() {
  if (!packPromise) packPromise = (async () => {
    const previous = globalThis.fetch; installProviders();
    try { return await (await loadEngine()).buildAutomatedValuationPack('NVDA'); }
    finally { globalThis.fetch = previous; }
  })();
  return packPromise;
}
async function sotpPack() {
  const p = await pack();
  return { ...p, profile: { ...p.profile, classification: { ...p.profile.classification, modelFamily: 'auto_energy_optionality_sotp' } } };
}
function plan() {
  return {
    policyVersion: 'r6-offline', businesses: [{
      id: 'core', name: 'Core', stage: 'mature', economicMeaning: 'reported sales',
      segmentationBasis: 'reported_segment',
      revenueDriver: { formula: 'reported_segment', params: { revenueB: 10 }, evidenceId: null },
      costDrivers: [], disclosedData: [], forecastAssumptions: [], growthConstraints: [],
      forecastYears: [{ year: 1, revenueB: 10, fcfB: 2 }, { year: 2, fcfB: 3 }, { year: 3, fcfB: 4 }],
      valuationMethod: 'ev_sales', multiple: null, rationale: 'arithmetic fixture',
      applicabilityConditions: [], overlaps: [],
    }],
    capitalRequirements: [], financing: [], dilution: [],
    valuationMethods: [{ model: 'ev_sales', purpose: 'valuation', multiple: 3, appliesToBusinessIds: ['core'], rationale: 'method' }],
    scenarios: [], probabilitiesCheck: { owners: [], note: '' }, sources: [], missingEvidence: [],
    primaryMethod: 'sotp', aggregationRule: 'sotp', crossChecks: [], thesisChanges: [], revisionRecords: [],
  };
}
const accepted = p => validation.validateResearchPayload('plan', p);
const compiled = async p => compiler.compileResearchPlan(await sotpPack(), accepted(p));

test('R6-02 unique business and model consume numeric multiple in the existing SOTP equation', async () => {
  const p = plan(), c = await compiled(p), b = (await sotpPack()).evidenceAssumptions;
  assert.equal(c.segments[0].multiple, 3);
  assert.equal(c.segments[0].metricValueB, 10);
  const actual = engine.VALUATION_MODELS.sotp.run(c.profile.baseline, null).value;
  assert.equal(actual, (10 * 3 + b.netCashB) / b.dilutedSharesB);
});
test('R6-03 repeated compilation chooses the same consumer', async () => {
  const p = plan(); assert.deepEqual(await compiled(p), await compiled(p));
});
test('R6-04 method array order cannot change either business binding', async () => {
  const p = plan();
  const second = structuredClone(p.businesses[0]);
  second.id = 'other'; second.name = 'Other'; second.revenueDriver.params.revenueB = 20;
  second.forecastYears[0].revenueB = 20;
  p.businesses.push(second);
  p.valuationMethods.push({ model: 'ev_sales', purpose: 'valuation', multiple: 4, appliesToBusinessIds: ['other'], rationale: 'other method' });
  const first = await compiled(p);
  p.valuationMethods.reverse();
  const reversed = await compiled(p);
  assert.deepEqual(first.segments, reversed.segments);
  assert.deepEqual(first.segments.map(x => x.multiple), [3, 4]);
});
test('R6-05 one method with two possible consumers and duplicate declarations fail closed', async () => {
  const p = plan(), second = structuredClone(p.businesses[0]);
  second.id = 'other'; p.businesses.push(second);
  p.valuationMethods[0].appliesToBusinessIds.push('other');
  await assert.rejects(compiled(p), /no unique SOTP business consumer/);
  const q = plan(); q.valuationMethods.push(structuredClone(q.valuationMethods[0]));
  await assert.rejects(compiled(q), /multiple consumers for one business/);
});
test('R6-06 unconsumed number fails rather than disappearing', async () => {
  const p = plan(); p.valuationMethods[0].model = 'ev_fcf';
  await assert.rejects(compiled(p), /method-level multiple is unused/);
  const q = plan(); q.valuationMethods[0].appliesToBusinessIds = [];
  await assert.rejects(compiled(q), /valuation method requires unique business targets/);
});
test('R6-07 DCF with absent method multiple still compiles', async () => {
  const p = plan(); p.businesses[0].valuationMethod = 'dcf'; p.valuationMethods = [{ model: 'dcf', purpose: 'valuation', appliesToBusinessIds: ['core'], rationale: 'dcf' }];
  p.primaryMethod = 'dcf'; p.aggregationRule = 'single_model';
  const c = compiler.compileResearchPlan(await pack(), accepted(p));
  assert.equal(c.primaryMethod, 'dcf');
});
test('R6-08 DCF null and absent method multiple stay equivalent', async () => {
  const p = plan(); p.businesses[0].valuationMethod = 'dcf'; p.valuationMethods = [{ model: 'dcf', purpose: 'valuation', appliesToBusinessIds: ['core'], rationale: 'dcf' }];
  p.primaryMethod = 'dcf'; p.aggregationRule = 'single_model';
  const nullVersion = structuredClone(p); nullVersion.valuationMethods[0].multiple = null;
  assert.deepEqual(compiler.compileResearchPlan(await pack(), accepted(nullVersion)), compiler.compileResearchPlan(await pack(), accepted(p)));
  assert.equal(compiler.hashPlan(nullVersion), compiler.hashPlan(p));
});
test('R6-09 legal multiple changes only the existing multiplication result', async () => {
  const a = plan(), b = plan(); b.valuationMethods[0].multiple = 4;
  const ca = await compiled(a), cb = await compiled(b);
  assert.equal(ca.segments[0].metricValueB, cb.segments[0].metricValueB);
  assert.equal(ca.segments[0].metricValueB * ca.segments[0].multiple, 30);
  assert.equal(cb.segments[0].metricValueB * cb.segments[0].multiple, 40);
});
test('R6-10 illegal string, null, NaN and Infinity still reject', () => {
  for (const value of ['3', null, NaN, Infinity, -Infinity]) {
    const p = plan(); p.valuationMethods[0].multiple = value;
    assert.throws(() => accepted(p), /RESEARCH_SCHEMA_INVALID/);
  }
});
test('R6-11 raw input remains unchanged after validation and compilation', async () => {
  const p = plan(), source = structuredClone(p);
  await compiled(p); assert.deepEqual(p, source);
});
test('R6-12 canonicalization is idempotent and compilation is repeatable', async () => {
  const p = plan(), c = plans.canonicalizeResearchPlan(p);
  assert.equal(plans.canonicalizeResearchPlan(c), c);
  assert.deepEqual(await compiled(c), await compiled(c));
});
test('R6-13 price targeting remains isolated before binding', () => {
  const p = plan(); p.valuationMethods[0].targetPrice = 100;
  assert.throws(() => accepted(p), /RESEARCH_SCHEMA_INVALID/);
});
test('R6-14 undeclared method fields still reject', () => {
  const p = plan(); p.valuationMethods[0].extra = 7;
  assert.throws(() => accepted(p), /RESEARCH_SCHEMA_INVALID/);
});
test('R6-15 A5 historical draft without roles is rejected by the current schema', async () => {
  const raw = structuredClone(live);
  assert.throws(() => validation.validateResearchPayload('draft', live), /RESEARCH_SCHEMA_INVALID/);
  assert.deepEqual(live, raw);
});
