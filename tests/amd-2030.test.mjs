import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../lib/amd-2030.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { computeAmd2030Case } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("AMD reported Q2 segments reconcile and modeled accelerator revenue is counted inside Data Center once", () => {
  const model = computeAmd2030Case(628.2);
  assert.ok(Math.abs(model.rows.reduce((sum, row) => sum + row.q2RevenueB, 0) - 11.536) < 1e-9);
  assert.equal(model.acceleratorRevenueB, 120);
  assert.equal(model.rows[0].revenue2030B, 150);
  assert.equal(model.revenue2030B, 182);
  assert.ok(Math.abs(model.fcff2030B - 63.48) < 1e-9);
});

test("AMD segment present values and equity bridge reproduce per-share value without double-counting cash", () => {
  const model = computeAmd2030Case(628.2);
  for (const row of model.rows) assert.ok(Math.abs(row.interimValueB + row.terminalValueB - row.presentValueB) < 1e-9);
  assert.ok(Math.abs(model.rows.reduce((sum, row) => sum + row.presentValueB, 0) - model.enterpriseValueNowB) < 1e-9);
  assert.ok(Math.abs((model.enterpriseValueNowB + 9.885) / 1.659 - model.fairValueNowUsd) < 1e-9);
  assert.ok(model.fullWarrantFairValueUsd < model.fairValueNowUsd);
  assert.ok(model.exitPrices.every((item, index, prices) => index === 0 || item.priceUsd > prices[index - 1].priceUsd));
  assert.ok(model.hurdleMultiple > 20);
  assert.equal(computeAmd2030Case(null).hurdleMultiple, null);
});
