import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

test("issuer intelligence persists reusable profiles and unifies Alphabet share classes", async () => {
  const source = await readFile(new URL("../lib/issuer-intelligence.ts", import.meta.url), "utf8");
  assert.match(source, /issuerId: "alphabet", name: "Alphabet", tickers: \["GOOG", "GOOGL"\]/);
  assert.match(source, /issuerId: "exxon"[\s\S]*?cik: "0000034088"/);
  assert.match(source, /ADDITIONAL_MAJOR_ISSUERS/);
  for (const ticker of ["ADBE", "AMGN", "CAT", "CSCO", "NOW", "TXN", "PANW", "VRTX"]) assert.match(source, new RegExp(`\\["${ticker}"`));
  assert.match(source, /issuer_profiles/);
  assert.match(source, /issuer_profile_securities/);
  assert.match(source, /issuer_ai_usage/);
  assert.match(source, /NEW_ISSUER/);
  assert.match(source, /MODEL_DISPERSION_REVIEW/);
  assert.doesNotMatch(source, /fairValue\s*:/);
});

test("verified reporting CIK can preserve a financial history through an issuer reorganization", async () => {
  const source = await readFile(new URL("../lib/valuation-data.ts", import.meta.url), "utf8");
  assert.match(source, /verified\?\.cik \?\? directoryCik/);
  assert.match(source, /historical financial series/);
});

test("public option provider is indicative, cached and server credentialed", async () => {
  const [provider, route, page, reviewRoute, reviewer, workstation] = await Promise.all([
    readFile(new URL("../lib/alpaca-options.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/options/chain/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/options/chain-desk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/options/review/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/options-ai.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/options/workstation.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(provider, /feed", "indicative"/);
  assert.match(provider, /ALPACA_API_KEY_ID/);
  assert.match(provider, /15 \* 60 \* 1_000/);
  assert.match(route, /signal-ledger\.options-chain\.v1/);
  // Entitlement-gated: the chain varies per FREE/PRO, so it is not edge-cacheable.
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /getCurrentEntitlement/);
  assert.match(route, /iv: null/);
  assert.match(route, /options_AI_used: false/);
  // Correction pass: the chain is the default view and both strategies are
  // equal, independently ranked first-class tools.
  assert.match(page, /Option Chain/);
  assert.match(page, /Sell Put/);
  assert.match(page, /Covered Call/);
  assert.match(page, /DETERMINISTIC RECOMMENDATIONS/);
  assert.match(page, /SELL PUT/);
  assert.match(page, /COVERED CALL/);
  assert.match(page, /strategyPanel\("put"/);
  assert.match(page, /strategyPanel\("call"/);
  assert.match(page, /className="strike-cell"/);
  assert.match(page, /quote-cell/);
  assert.match(page, /const callLabels = \["OI", "Vol"/);
  assert.match(page, /export type ChainTab = "chain" \| Strategy/);
  assert.match(page, /Gamma/);
  assert.match(page, /Vega/);
  assert.match(page, /NO ATTRACTIVE TRADE/);
  assert.match(page, /buildOptionsPicks/);
  assert.match(page, /Ask AI to review/);
  assert.match(page, /Show all strikes/);
  assert.match(page, /More Greeks/);
  assert.match(page, /\/api\/valuation\/snapshot\?ticker=/);
  assert.doesNotMatch(page, /fetch\(`\/api\/valuation\/\$\{encodeURIComponent\(symbol\)\}`/);
  assert.match(reviewRoute, /reviewTopOptions/);
  assert.match(reviewer, /slice\(0, 5\)/);
  assert.match(reviewer, /USER_REQUESTED_TOP_FIVE_REVIEW/);
  assert.doesNotMatch(page, /IBKR/);
  // The scenario tool is secondary functionality behind Advanced tools.
  assert.match(workstation, /Option Scenario Analyzer/);
  assert.match(workstation, /Advanced tools/);
  assert.match(workstation, /opt-advanced/);
  assert.match(workstation, /setAdvancedOpen\(true\)/);
});

test("covered strategy ranking enforces DTE, delta, liquidity, coverage and per-trade return", async () => {
  const options = await loadTypeScript("../lib/options-screen.ts");
  const contracts = [
    { symbol: "TSLA261002P00200000", expiration: "2026-10-02", dte: 18, strike: 200, type: "put", bid: 4, ask: 4.2, midpoint: 4.1, spreadPct: 4.9, iv: 0.55, delta: -0.25, volume: 600, openInterest: 2000 },
    { symbol: "TSLA261002P00210000", expiration: "2026-10-02", dte: 18, strike: 210, type: "put", bid: 7, ask: 9, midpoint: 8, spreadPct: 25, iv: 0.6, delta: -0.3, volume: 20, openInterest: 20 },
    { symbol: "TSLA261002C00260000", expiration: "2026-10-02", dte: 18, strike: 260, type: "call", bid: 4.5, ask: 4.8, midpoint: 4.65, spreadPct: 6.5, iv: 0.5, delta: 0.24, volume: 900, openInterest: 2500 },
  ];
  const settings = { cash: 50_000, shares: 100, contracts: 1, feesPerContract: 0.65, minReturnPct: 1, minDte: 7, maxDte: 30, minAbsDelta: 0.15, maxAbsDelta: 0.35, maxSpreadPct: 12, minOpenInterest: 100, fairValue: 245, buyZone: 220 };
  const puts = options.rankCashSecuredPuts(contracts, 240, settings);
  const calls = options.rankCoveredCalls(contracts, 240, settings);
  assert.equal(puts.length, 1);
  assert.equal(calls.length, 1);
  assert.match(puts[0].rationale[0], /not annualized/);
  assert.equal(puts[0].symbol, "TSLA261002P00200000");
  assert.equal(calls[0].symbol, "TSLA261002C00260000");
  assert.equal(calls[0].upsideToStrikePct.toFixed(2), "8.33");
  assert.equal(calls[0].assignmentRiskProxyPct, 24);
});
