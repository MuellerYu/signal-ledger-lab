// P0-R8 final-plan capability checks use only local provider fixtures.
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
const [validation, plans, compiler, engine, isolation] = await Promise.all(
  ['research-validate', 'research-plan', 'research-compiler', 'universal-valuation', 'research-isolation']
    .map(async name => import(await moduleUrl(name))),
);
const rawA5 = JSON.parse(await readFile(new URL('./fixtures/p0-r5-nvda-a5-live-draft.json', import.meta.url), 'utf8'));
const roleA5 = JSON.parse(await readFile(new URL('./fixtures/p0-r7-nvda-a5-role-only.json', import.meta.url), 'utf8'));
const dcfFixture = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-dcf.json', import.meta.url), 'utf8'));
const sotpFixture = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-sotp.json', import.meta.url), 'utf8'));
let packPromise;
async function pack() {
  if (!packPromise) packPromise = (async () => {
    const prior = globalThis.fetch; installProviders();
    try { return await (await loadEngine()).buildAutomatedValuationPack('NVDA'); }
    finally { globalThis.fetch = prior; }
  })();
  return packPromise;
}
async function sotpPack() {
  const source = await pack();
  return { ...source, profile: { ...source.profile,
    classification: { ...source.profile.classification, modelFamily: 'auto_energy_optionality_sotp' } } };
}
function finalPlan() {
  return structuredClone(dcfFixture);
}
function sotpPlan() {
  return structuredClone(sotpFixture);
}
function rejected(p, code) {
  assert.throws(() => validation.validateResearchPayload('plan', p), error => {
    assert.match(error.message, /RESEARCH_SCHEMA_INVALID/);
    assert.match(error.message, new RegExp(code));
    return true;
  });
}
const accepted = p => validation.validateResearchPayload('plan', p);
const compiled = async p => compiler.compileResearchPlan(await pack(), accepted(p));

test('R8-01 exploratory draft retains tool requests and A5 role structure', () => {
  const original = structuredClone(roleA5);
  const draft = validation.validateResearchPayload('draft', roleA5);
  assert.ok(draft.toolRequests.length > 0);
  assert.deepEqual(roleA5, original);
  assert.equal(rawA5.valuationMethods[0].purpose, undefined, 'raw A5 remains an immutable pre-R7 fixture');
  assert.equal(draft.valuationMethods[1].purpose, 'cross_check');
});
test('R8-02 final costDrivers are rejected', () => {
  const p = finalPlan(); p.businesses[0].costDrivers.push({ formula: 'constant', params: { value: 1 }, evidenceId: null });
  rejected(p, 'COST_DRIVERS');
  assert.throws(() => compiler.compileResearchPlan({ profile: {}, evidenceAssumptions: {} }, p), /costDrivers not implemented/);
});
test('R8-03 final forecastAssumptions are rejected', () => {
  const p = finalPlan(); p.businesses[0].forecastAssumptions.push({ id: 'a', field: 'growth', value: .2, unit: 'fraction', evidenceId: null, rationale: 'candidate' });
  rejected(p, 'FORECAST_ASSUMPTIONS');
});
test('R8-04 final capexB presence fails, while R5 null remains absence', () => {
  const p = finalPlan(); p.businesses[0].forecastYears[0].capexB = 0;
  rejected(p, 'FORECAST_CAPEX');
  const absent = finalPlan(); absent.businesses[0].forecastYears[0].capexB = null;
  const c = accepted(absent); assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), false);
});
test('R8-05 unknown cannot be silently cleaned into a zero economic placeholder', () => {
  const p = finalPlan(); p.capitalRequirements.push({ id: 'unknown', businessId: 'core', kind: 'capex',
    incremental: false, amountB: 0, timingYear: 1, evidenceId: null, rationale: 'unknown' });
  const original = structuredClone(p); rejected(p, 'CAPITAL_INCREMENTAL'); assert.deepEqual(p, original);
  const q = finalPlan(); q.businesses[0].revenueDriver.params.revenueB = 'not supplied';
  assert.equal(Object.hasOwn(accepted(q).businesses[0].revenueDriver.params, 'revenueB'), false);
});
test('R8-06 genuine zero FCF stays zero; zero terminal path fails economic gate', async () => {
  const p = finalPlan(); p.businesses[0].forecastYears[1].fcfB = 0;
  assert.equal((await compiled(p)).profile.baseline.cashFlows[1], 0);
  p.businesses[0].forecastYears[2].fcfB = 0;
  assert.equal(accepted(p).businesses[0].forecastYears[2].fcfB, 0);
  const source = await pack();
  assert.throws(() => compiler.compileResearchPlan(source, p), /complete DCF path/);
});
test('R8-07 unsupported disclosed unit is not guessed into USD billions', () => {
  const p = finalPlan(); p.businesses[0].disclosedData.push({ label: 'Margin', value: .5, unit: 'percent', evidenceId: null });
  rejected(p, 'DISCLOSED_UNIT');
});
test('R8-08 domain label is not a supported growth constraint field', () => {
  const p = finalPlan(); p.businesses[0].growthConstraints.push({ id: 'g', field: 'accelerator_revenue_growth', max: .8, rationale: 'candidate' });
  rejected(p, 'CONSTRAINT_FIELD');
});
test('R8-09 non-incremental capital rejects even at zero amount', () => {
  const p = finalPlan(); p.capitalRequirements.push({ id: 'c', businessId: 'core', kind: 'capex',
    incremental: false, amountB: 0, timingYear: 1, evidenceId: null, rationale: 'placeholder' });
  rejected(p, 'CAPITAL_INCREMENTAL');
});
test('R8-10 debt/future financing rejects rather than entering net cash', () => {
  const p = finalPlan(); p.financing.push({ id: 'f', kind: 'debt', amountB: 0, timingYear: 1,
    costPct: .05, evidenceId: null, rationale: 'placeholder' });
  rejected(p, 'FINANCING_KIND');
});
test('R8-11 stock compensation zero is not an executable dilution placeholder', () => {
  const p = finalPlan(); p.dilution.push({ id: 'd', kind: 'stock_comp', sharesB: 0, evidenceId: null, rationale: 'unknown' });
  rejected(p, 'DILUTION_KIND');
});
test('R8-12 unsupported scenario economics reject even at identity values', () => {
  const p = finalPlan(); p.aggregationRule = 'scenario_weighted';
  p.scenarios.push({ id: 'base', name: 'Base', description: '', probability: 1, appliesTo: 'company',
    businessIds: ['core'], economics: { growthMultiplier: 1, fcfMultiplier: 1 } });
  rejected(p, 'SCENARIO_ECONOMICS');
});
test('R8-13 direct final audit reports many independent A5 mismatches at once', () => {
  const issues = validation.validateFinalResearchExecution(roleA5);
  const codes = new Set(issues.map(issue => issue.code));
  for (const code of ['COST_DRIVERS', 'FORECAST_ASSUMPTIONS', 'FORECAST_CAPEX', 'DISCLOSED_UNIT',
    'CONSTRAINT_FIELD', 'CAPITAL_INCREMENTAL', 'FINANCING_KIND', 'DILUTION_KIND', 'SCENARIO_ECONOMICS'])
    assert.ok(codes.has(code), code);
  assert.ok(issues.length >= 20);
  const asPlan = structuredClone(roleA5); delete asPlan.toolRequests;
  rejected(asPlan, 'COST_DRIVERS');
});
test('R8-14 synthetic final single-business DCF validates and compiles', async () => {
  const c = await compiled(finalPlan());
  assert.deepEqual(c.profile.baseline.cashFlows, [2, 3, 4]);
  assert.ok(Number.isFinite(engine.runValuationProfile(c.profile).ensemble.fairValue));
});
test('R8-15 synthetic final SOTP validates and binds the specified multiple', async () => {
  const c = compiler.compileResearchPlan(await sotpPack(), accepted(sotpPlan()));
  assert.equal(c.segments[0].multiple, 3); assert.equal(c.segments[0].metricValueB, 10);
});
test('R8-16 R4 DCF null/absent multiple canonicalize identically', () => {
  const a = finalPlan(), b = structuredClone(a); b.valuationMethods[0].multiple = null;
  assert.deepEqual(accepted(a), accepted(b)); assert.equal(compiler.hashPlan(a), compiler.hashPlan(b));
});
test('R8-17 R5 missing and explicit zero remain distinct', () => {
  const p = finalPlan(); p.businesses[0].forecastYears[0].capexB = null;
  p.businesses[0].forecastYears[1].fcfB = 0;
  const c = accepted(p); assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), false);
  assert.equal(c.businesses[0].forecastYears[1].fcfB, 0);
});
test('R8-18 R6 numeric SOTP consumer remains unique', async () => {
  const p = sotpPlan(), c = compiler.compileResearchPlan(await sotpPack(), accepted(p));
  assert.equal(c.segments[0].multiple, 3);
  p.valuationMethods.push(structuredClone(p.valuationMethods[0]));
  const source = await sotpPack();
  assert.throws(() => compiler.compileResearchPlan(source, p), /multiple consumers|multiple declarations/);
});
test('R8-19 R7 cross_check multiple cannot change valuation profile', async () => {
  const a = finalPlan(), b = structuredClone(a);
  b.valuationMethods.push({ model: 'ev_fcf', purpose: 'cross_check', appliesToBusinessIds: ['core'],
    multiple: 34, rationale: 'advisory' });
  const x = await compiled(a), y = await compiled(b);
  assert.deepEqual(x.profile, y.profile); assert.deepEqual(x.segments, y.segments);
  assert.equal(y.advisoryMethods.length, 1);
});
test('R8-20 price/FV targeting remains forbidden before projection', () => {
  const p = finalPlan(); p.businesses[0].targetPrice = 100; rejected(p, 'price-targeting');
});
test('R8-21 final schema firewall rejects unknown economic fields', () => {
  const p = finalPlan(); p.businesses[0].forecastYears[0].inventedEconomicField = 1;
  assert.throws(() => accepted(p), /unknown field/);
});
test('R8-22 old version and no-purpose cached plans cannot pass new contract', () => {
  assert.equal(isolation.RESEARCH_ISOLATION_VERSION, 'p0-r11-draft-sparse-v1');
  const p = finalPlan(), old = structuredClone(p); delete old.valuationMethods[0].purpose;
  assert.throws(() => accepted(old), /RESEARCH_SCHEMA_INVALID/);
  const changed = structuredClone(p); changed.valuationMethods[0].purpose = 'cross_check';
  assert.notEqual(compiler.hashPlan(p), compiler.hashPlan(changed));
  assert.equal(plans.researchPlanSchema.properties.businesses.items.anyOf.length, plans.FINAL_RESEARCH_EXECUTION_CONTRACT.businessMethods.length);
});
