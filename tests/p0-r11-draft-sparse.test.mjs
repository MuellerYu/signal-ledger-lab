import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../lib/', import.meta.url), urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let code = ts.transpileModule(await readFile(new URL(name + '.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(match => match[1])))
    code = code.replaceAll('from "' + spec + '"', 'from "' + await moduleUrl(spec.slice(2)) + '"');
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  urls.set(name, url);
  return url;
}
const [plan, validate, isolation] = await Promise.all(
  ['research-plan', 'research-validate', 'research-isolation']
    .map(async name => import(await moduleUrl(name))),
);
const originalBytes = await readFile(new URL('./fixtures/p0-a7-nvda-live-draft-bad-schema.json', import.meta.url));
const originalSha = '4600d13a7c25fc773d867b4637dade19003fd71babdfb2614501fcf4fb6be5d8';
const sparse = JSON.parse(originalBytes.toString('utf8'));
const finalDcf = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-dcf.json', import.meta.url), 'utf8'));
const accept = value => validate.validateResearchPayload('draft', value);
const reject = value => assert.throws(() => accept(value), /RESEARCH_SCHEMA_INVALID/);
const clone = value => structuredClone(value);
const fields = ['forecastYears', 'multiple', 'disclosedData', 'forecastAssumptions'];

function numericLeaves(value, path = '$') {
  if (typeof value === 'number') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => numericLeaves(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value)
    .flatMap(([key, item]) => numericLeaves(item, `${path}.${key}`));
  return [];
}

test('R11-01 immutable historical sparse draft passes the exploratory draft schema', () => {
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), originalSha);
  assert.equal(plan.researchDraftSchema.properties.businesses.items.additionalProperties, false);
  assert.doesNotThrow(() => accept(sparse));
});

test('R11-02 validation does not mutate the raw historical draft', () => {
  const copy = clone(sparse);
  accept(sparse);
  assert.deepEqual(sparse, copy);
  assert.equal(createHash('sha256').update(originalBytes).digest('hex'), originalSha);
});

test('R11-03 absent business fields stay absent; no arrays, nulls, zeroes, or evidence are synthesized', () => {
  const result = accept(sparse);
  for (let index = 0; index < sparse.businesses.length; index++)
    for (const field of fields)
      assert.equal(Object.hasOwn(result.businesses[index], field), Object.hasOwn(sparse.businesses[index], field), `${index}.${field}`);
  assert.deepEqual(numericLeaves(result), numericLeaves(sparse));
  assert.deepEqual(result.businesses, sparse.businesses);
  assert.deepEqual(result.toolRequests, sparse.toolRequests);
  assert.deepEqual(result.sources, sparse.sources);
});

test('R11-05 historical sparse draft fails the executable final ResearchPlan boundary', () => {
  assert.throws(() => validate.validateResearchPayload('plan', clone(sparse)), /RESEARCH_SCHEMA_INVALID/);
});

test('R11-06 a multiple-based exploratory business may omit multiple', () => {
  const value = clone(sparse);
  value.businesses[0].valuationMethod = 'ev_ebitda';
  assert.doesNotThrow(() => accept(value));
  assert.equal(Object.hasOwn(value.businesses[0], 'multiple'), false);
});

test('R11-07 an explicit legal draft multiple is validated and retained', () => {
  const value = clone(sparse);
  value.businesses[0].valuationMethod = 'ev_ebitda';
  value.businesses[0].multiple = 18;
  assert.equal(accept(value).businesses[0].multiple, 18);
});

test('R11-08 a string multiple is rejected', () => {
  const value = clone(sparse);
  value.businesses[0].multiple = 'abc';
  reject(value);
});

test('R11-09 missing disclosedData is allowed', () => {
  const value = clone(sparse);
  delete value.businesses[0].disclosedData;
  assert.equal(Object.hasOwn(accept(value).businesses[0], 'disclosedData'), false);
});

test('R11-10 present non-array disclosedData is rejected', () => {
  const value = clone(sparse);
  value.businesses[1].disclosedData = {};
  reject(value);
});

test('R11-11 missing forecastAssumptions is allowed', () => {
  const value = clone(sparse);
  delete value.businesses[0].forecastAssumptions;
  assert.equal(Object.hasOwn(accept(value).businesses[0], 'forecastAssumptions'), false);
});

test('R11-12 present invalid forecastAssumptions is rejected', () => {
  const value = clone(sparse);
  value.businesses[1].forecastAssumptions = null;
  reject(value);
});

test('R11-13 missing forecastYears remains allowed in draft', () => {
  const value = clone(sparse);
  delete value.businesses[0].forecastYears;
  assert.equal(Object.hasOwn(accept(value).businesses[0], 'forecastYears'), false);
});

test('R11-14 every other business core field remains required', () => {
  const required = plan.researchPlanSchema.properties.businesses.items.anyOf[0].required.filter(field => !fields.includes(field));
  const draftRequired = plan.researchDraftSchema.properties.businesses.items.required;
  assert.deepEqual(draftRequired, required);
  for (const field of required) {
    const value = clone(sparse);
    delete value.businesses[0][field];
    reject(value);
  }
});

test('R11-15 unknown property and price/FV targeting remain forbidden', () => {
  const top = clone(sparse); top.unexpected = 'value'; reject(top);
  const nested = clone(sparse); nested.businesses[0].unexpected = 'value'; reject(nested);
  for (const field of ['currentPrice', 'fairValue', 'targetPrice']) {
    const value = clone(sparse); value.businesses[0][field] = 100;
    reject(value);
  }
});

test('R11-16 final plan rejects each of the four fields when missing', () => {
  for (const field of fields) {
    const value = clone(finalDcf);
    delete value.businesses[0][field];
    assert.throws(() => validate.validateResearchPayload('plan', value), /RESEARCH_SCHEMA_INVALID/, field);
  }
  assert.doesNotThrow(() => validate.validateResearchPayload('plan', clone(finalDcf)));
});

test('R11-17 final capability and version gates stay separate from exploratory shape', async () => {
  assert.equal(isolation.RESEARCH_ISOLATION_VERSION, 'p0-r11-draft-sparse-v1');
  assert.deepEqual(validate.validateFinalResearchExecution(clone(finalDcf)), []);
  assert.equal(plan.researchPlanSchema.properties.businesses.items.anyOf[0].required.includes('forecastYears'), true);
  const source = await readFile(new URL('../lib/valuation-ai.ts', import.meta.url), 'utf8');
  assert.match(source, /Missing draft business fields do NOT carry forward implicitly/);
  assert.match(source, /The final executable ResearchPlan MUST explicitly provide multiple, disclosedData, forecastAssumptions, and forecastYears/);
});
