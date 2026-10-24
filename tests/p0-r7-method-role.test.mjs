// R7 role semantics. Providers are local fixtures; no live HTTP is authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
const [validation, plans, compiler, engine, firewall, isolation] = await Promise.all(
  ['research-validate', 'research-plan', 'research-compiler', 'universal-valuation', 'research-firewall', 'research-isolation']
    .map(async name => import(await moduleUrl(name))),
);
const rawA5 = JSON.parse(await readFile(new URL('./fixtures/p0-r5-nvda-a5-live-draft.json', import.meta.url), 'utf8'));
const roleA5 = JSON.parse(await readFile(new URL('./fixtures/p0-r7-nvda-a5-role-only.json', import.meta.url), 'utf8'));
let packPromise;
async function pack() {
  if (!packPromise) packPromise = (async () => {
    const prior = globalThis.fetch; installProviders();
    try { return await (await loadEngine()).buildAutomatedValuationPack('NVDA'); }
    finally { globalThis.fetch = prior; }
  })();
  return packPromise;
}
function dcf() {
  return {
    policyVersion: 'r7-offline',
    businesses: [{
      id: 'core', name: 'Core', stage: 'mature', economicMeaning: 'operating cash flow',
      segmentationBasis: 'reported_segment',
      revenueDriver: { formula: 'reported_segment', params: { revenueB: 10 }, evidenceId: null },
      costDrivers: [], disclosedData: [], forecastAssumptions: [], growthConstraints: [],
      forecastYears: [{ year: 1, revenueB: 10, fcfB: 2 }, { year: 2, fcfB: 3 }, { year: 3, fcfB: 4 }],
      valuationMethod: 'dcf', multiple: null, rationale: 'offline arithmetic',
      applicabilityConditions: [], overlaps: [],
    }],
    capitalRequirements: [], financing: [], dilution: [],
    valuationMethods: [{ model: 'dcf', purpose: 'valuation', appliesToBusinessIds: ['core'], rationale: 'DCF' }],
    scenarios: [], probabilitiesCheck: { owners: [], note: '' }, sources: [], missingEvidence: [],
    primaryMethod: 'dcf', aggregationRule: 'single_model', crossChecks: [], thesisChanges: [], revisionRecords: [],
  };
}
function advisory(model, multiple) {
  return { model, purpose: 'cross_check', multiple, appliesToBusinessIds: ['core'], rationale: 'Operating guardrail' };
}
async function compiled(plan) { return compiler.compileResearchPlan(await pack(), validation.validateResearchPayload('plan', plan)); }
function sotp() {
  const p = dcf(); p.businesses[0].valuationMethod = 'ev_sales';
  p.businesses[0].multiple = null;
  p.valuationMethods = [{ model: 'ev_sales', purpose: 'valuation', multiple: 3, appliesToBusinessIds: ['core'], rationale: 'SOTP segment' }];
  p.primaryMethod = 'sotp'; p.aggregationRule = 'sotp'; return p;
}
async function sotpCompiled(p) {
  const source = await pack();
  return compiler.compileResearchPlan({
    ...source, profile: { ...source.profile, classification: { ...source.profile.classification, modelFamily: 'auto_energy_optionality_sotp' } },
  }, validation.validateResearchPayload('plan', p));
}

test('R7-01 explicit DCF valuation method compiles', async () => {
  const c = await compiled(dcf()); assert.equal(c.primaryMethod, 'dcf'); assert.equal(c.advisoryMethods.length, 0);
});
for (const [id, model, multiple] of [['02', 'ev_fcf', 34], ['03', 'ev_ebitda', 18], ['04', 'ev_sales', 14]]) {
  test(`R7-${id} ${model} cross_check remains audit-only`, async () => {
    const p = dcf(); p.valuationMethods.push(advisory(model, multiple));
    const c = await compiled(p), baseline = await compiled(dcf());
    assert.equal(c.advisoryMethods[0].multiple, multiple);
    assert.deepEqual(c.segments, baseline.segments);
    assert.deepEqual(c.profile.modelApplicability, baseline.profile.modelApplicability);
  });
}
test('R7-05 three cross-check multiples do not change valuation inputs or FV', async () => {
  const a = dcf(), b = structuredClone(a);
  b.valuationMethods.push(advisory('ev_fcf', 34), advisory('ev_ebitda', 18), advisory('ev_sales', 14));
  const x = await compiled(a), y = await compiled(b);
  assert.deepEqual(x.profile, y.profile); assert.deepEqual(x.segments, y.segments);
  const firstFV = engine.runValuationProfile(x.profile).ensemble.fairValue;
  const secondFV = engine.runValuationProfile(y.profile).ensemble.fairValue;
  assert.equal(firstFV, secondFV);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  console.log('R7_COMPILER_COMPARISON=' + JSON.stringify({
    withoutCrossChecks: { profileHash: digest(x.profile), segmentsHash: digest(x.segments), fairValue: firstFV },
    withCrossChecks: { profileHash: digest(y.profile), segmentsHash: digest(y.segments), fairValue: secondFV },
    advisoryCount: y.advisoryMethods.length,
  }));
});
test('R7-06 executable numeric multiple without consumer fails closed', async () => {
  const p = dcf(); p.valuationMethods.push({ ...advisory('ev_sales', 14), purpose: 'valuation' });
  await assert.rejects(compiled(p), /method-level multiple has no unique SOTP business consumer/);
});
test('R7-07 executable multiple with two candidate consumers fails closed', async () => {
  const p = sotp(), second = structuredClone(p.businesses[0]); second.id = 'other'; p.businesses.push(second);
  p.valuationMethods[0].appliesToBusinessIds.push('other');
  await assert.rejects(sotpCompiled(p), /method-level multiple has no unique SOTP business consumer/);
  const duplicate = dcf(); duplicate.valuationMethods.push(structuredClone(duplicate.valuationMethods[0]));
  await assert.rejects(compiled(duplicate), /multiple declarations for one consumer/);
});
test('R7-08 role cannot evade closed schema or invalid range', () => {
  for (const mutate of [
    p => { p.valuationMethods[1].extra = 1; },
    p => { p.valuationMethods[1].purpose = 'advisory'; },
    p => { p.valuationMethods[1].multiple = -1; },
    p => { p.valuationMethods[1].multiple = Infinity; },
  ]) {
    const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', 34)); mutate(p);
    assert.throws(() => validation.validateResearchPayload('plan', p), /RESEARCH_SCHEMA_INVALID/);
  }
});
test('R7-09 cross-check string multiple rejects', () => {
  const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', '34'));
  assert.throws(() => validation.validateResearchPayload('plan', p), /RESEARCH_SCHEMA_INVALID/);
});
test('R7-10 cross-check price and FV fields reject', () => {
  for (const key of ['currentPrice', 'fairValue', 'targetPrice']) {
    const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', 34)); p.valuationMethods[1][key] = 100;
    assert.throws(() => validation.validateResearchPayload('plan', p), /RESEARCH_SCHEMA_INVALID/);
  }
});
test('R7-11 raw no-purpose A5 draft fails closed without text inference', () => {
  assert.throws(() => validation.validateResearchPayload('draft', rawA5), /RESEARCH_SCHEMA_INVALID/);
  const p = dcf(); delete p.valuationMethods[0].purpose;
  assert.throws(() => validation.validateResearchPayload('plan', p), /RESEARCH_SCHEMA_INVALID/);
});
test('R7-12 DCF null and absent method multiple normalize identically', async () => {
  const a = dcf(), b = structuredClone(a); b.valuationMethods[0].multiple = null;
  assert.deepEqual(await compiled(a), await compiled(b)); assert.equal(compiler.hashPlan(a), compiler.hashPlan(b));
});
test('R7-13 missing-value sentinel and explicit zero retain R5 meaning', () => {
  const p = dcf(); p.businesses[0].revenueDriver.params.revenueB = 'not supplied';
  p.businesses[0].forecastYears[0].capexB = null;
  p.businesses[0].forecastYears[1].capexB = 0;
  const c = validation.validateResearchPayload('draft', { ...p, toolRequests: [] });
  assert.equal(Object.hasOwn(c.businesses[0].revenueDriver.params, 'revenueB'), false);
  assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), false);
  assert.equal(c.businesses[0].forecastYears[1].capexB, 0);
  assert.throws(() => validation.validateResearchPayload('plan', p), /FORECAST_CAPEX/);
});
test('R7-14 R6 unique SOTP consumer still binds the specified number', async () => {
  const c = await sotpCompiled(sotp());
  assert.equal(c.segments[0].multiple, 3); assert.equal(c.segments[0].metricValueB, 10);
});
test('R7-15 validation and compilation do not mutate source', async () => {
  const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', 34));
  const original = structuredClone(p); await compiled(p); assert.deepEqual(p, original);
});
test('R7-16 canonicalization and compilation are idempotent', async () => {
  const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', 34));
  const canonical = plans.canonicalizeResearchPlan(p);
  assert.equal(plans.canonicalizeResearchPlan(canonical), canonical);
  assert.deepEqual(await compiled(canonical), await compiled(canonical));
});
test('R7-17 reviewer boundary retains cross-check role while purpose patch is immutable', () => {
  const p = dcf(); p.valuationMethods.push(advisory('ev_fcf', 34));
  const input = firewall.sanitizeResearchInput({ plan: p });
  assert.equal(input.plan.valuationMethods[1].purpose, 'cross_check');
  assert.equal(input.plan.valuationMethods[1].multiple, 34);
  assert.equal(plans.isMutablePath('valuationMethods[1].purpose'), false);
});
test('R7-18 role-only A5 fixture passes schema and moves beyond the R6 multiple gate', async () => {
  const before = structuredClone(rawA5), comparable = structuredClone(roleA5);
  comparable.valuationMethods.forEach(method => { delete method.purpose; });
  assert.deepEqual(comparable, rawA5);
  const c = validation.validateResearchPayload('draft', roleA5);
  assert.equal(c.valuationMethods.filter(method => method.purpose === 'cross_check' && typeof method.multiple === 'number').length, 3);
  assert.deepEqual(rawA5, before);
  const p = await pack();
  assert.throws(() => compiler.compileResearchPlan(p, c), error => {
    assert.doesNotMatch(error.message, /method-level multiple/);
    assert.match(error.message, /costDrivers not implemented/);
    return true;
  });
});
test('R7 method role remains in plan hash under the newer compiler version', () => {
  assert.equal(isolation.RESEARCH_ISOLATION_VERSION, 'p0-r11-draft-sparse-v1');
  const a = dcf(), b = structuredClone(a);
  b.valuationMethods[0].purpose = 'cross_check';
  assert.notEqual(compiler.hashPlan(a), compiler.hashPlan(b));
});
