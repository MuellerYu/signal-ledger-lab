import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = async (path) => ts.transpileModule(await readFile(new URL(path, root), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const universeUrl = dataUrl(await transpile("launch-universe.ts"));
const treeCode = (await transpile("owner-forecast-tree.ts"))
  .replace('from "./launch-universe"', `from "${universeUrl}"`);
const { seedOwnerForecastTree, computeOwnerForecastTree, matchesReportedBusinessAnchor } = await import(dataUrl(treeCode));

const evidence = {
  status: "verified", kind: "revenue_line", periodEnd: "2026-06-30",
  periodForm: "10-Q",
  sourceUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000123/amd.htm",
  accessionNumber: "0000002488-26-000123", consolidatedRevenueB: 15, unit: "USD billions", reason: "",
  businesses: [{ name: "Data Center", revenueB: 10, sourceExcerpt: "SEC table" },
    { name: "Client", revenueB: 5, sourceExcerpt: "SEC table" }],
};

test("owner tree seeds only verified SEC evidence and binds published roots to it", () => {
  assert.equal(seedOwnerForecastTree("AMD", "AMD", "0000002488", { ...evidence, status: "unverified" }, null), null);
  const tree = seedOwnerForecastTree("AMD", "AMD", "0000002488", evidence, 1);
  assert.equal(tree.businesses.length, 2);
  assert.equal(matchesReportedBusinessAnchor(tree, "0000002488", evidence), true);
  assert.equal(matchesReportedBusinessAnchor({ ...tree, businesses: [{ ...tree.businesses[0], baseRevenueB: 11 }, tree.businesses[1]] }, "0000002488", evidence), false);
});

test("leaf forecasts avoid parent double count and calculate conditional terminal P/E", () => {
  const tree = seedOwnerForecastTree("AMD", "AMD", "0000002488", evidence, 1);
  tree.horizonYears = 1;
  tree.discountRate = 0.1;
  tree.netCashB = 0;
  tree.businesses = tree.businesses.map((row) => ({ ...row, annualGrowth: 0.1, netMargin: 0.1, pe: 10 }));
  assert.equal(computeOwnerForecastTree(tree).ready, true);
  assert.ok(Math.abs(computeOwnerForecastTree(tree).perShareUsd - 60) < 1e-9);
  tree.businesses.push({ ...tree.businesses[0], id: "split-1", parentId: tree.businesses[0].id,
    basis: "owner_split", name: "Accelerators", baseRevenueB: 10 });
  assert.equal(computeOwnerForecastTree(tree).ready, true);
  assert.equal(computeOwnerForecastTree(tree).rows.length, 2);
  assert.ok(Math.abs(computeOwnerForecastTree(tree).perShareUsd - 60) < 1e-9);
  tree.businesses.push({ ...tree.businesses[0], id: "split-2", parentId: tree.businesses[0].id,
    basis: "owner_split", name: "Other", baseRevenueB: 1 });
  assert.equal(computeOwnerForecastTree(tree).ready, false);
});

test("unfilled assumptions and tampered source metadata cannot publish", () => {
  const tree = seedOwnerForecastTree("AMD", "AMD", "0000002488", evidence, null);
  assert.equal(computeOwnerForecastTree(tree).ready, false);
  tree.source.url = "https://example.com/filing.htm";
  assert.match(computeOwnerForecastTree(tree).issues.join(" "), /SEC source metadata/);
});
