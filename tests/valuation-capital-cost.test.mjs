import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compile = (source) => "data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64");
const cacheUrl = compile(await readFile(new URL("../lib/snapshot-cache.ts", import.meta.url), "utf8"));
const source = (await readFile(new URL("../lib/valuation-capital-cost.ts", import.meta.url), "utf8"))
  .replace('import { getBindings } from "./runtime";', 'const getBindings = () => globalThis.__capitalTestBindings ?? {};')
  .replace('import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";', 'const configuredFeed = () => "iex"; const fetchDailyAdjustedBars = (...args) => globalThis.__capitalTestBars(...args);')
  .replace('from "./snapshot-cache"', `from "${cacheUrl}"`);
const capital = await import(compile(source));
const DAY = 86_400_000;
const iso = (date) => new Date(date).toISOString().slice(0, 10);
const entry = (date, value) => `<entry><content><m:properties><d:NEW_DATE>${date}T00:00:00</d:NEW_DATE><d:BC_10YEAR>${value}</d:BC_10YEAR></m:properties></content></entry>`;

function histories(end = "2026-09-18", observations = 180) {
  const sessions = [];
  for (let time = Date.parse(end); sessions.length <= observations; time -= DAY) {
    if (![0, 6].includes(new Date(time).getUTCDay())) sessions.unshift(iso(time));
  }
  const stock = new Map(); const market = new Map();
  let s = 100; let m = 100;
  sessions.forEach((date, index) => {
    const marketReturn = ((index % 9) - 4) / 500;
    if (index) { m *= 1 + marketReturn; s *= 1 + 2 * marketReturn + 0.001; }
    stock.set(date, s); market.set(date, m);
  });
  return { stock, market, end: sessions.at(-1) };
}

test("Treasury percentage units, missing values, future observations and staleness are enforced", () => {
  const xml = entry("2026-09-17", 4.2) + entry("2026-09-18", 4.1) + entry("2026-09-19", "") + entry("2026-09-21", 9);
  const rate = capital.parseTreasury10Year(xml, "2026-09-20");
  assert.equal(rate.asOf, "2026-09-18");
  assert.ok(Math.abs(rate.value - 0.041) < 1e-12);
  assert.equal(capital.parseTreasury10Year(entry("2026-08-01", 4.2), "2026-09-20"), null);
  assert.equal(capital.parseTreasury10Year(entry("2026-09-18", 0), "2026-09-20"), null);
  assert.equal(capital.parseTreasury10Year(xml, "invalid"), null);
});

test("historical beta is computed from matched returns with an intercept, not raw price levels", () => {
  const { stock, market, end } = histories();
  const beta = capital.estimateHistoricalBeta(stock, market, end);
  assert.ok(Math.abs(beta.value - 2) < 1e-10);
  assert.ok(Math.abs(beta.rSquared - 1) < 1e-10);
  assert.equal(beta.observations, 180);
  const missingDay = [...stock.keys()][30];
  stock.delete(missingDay);
  const missing = capital.estimateHistoricalBeta(stock, market, end);
  assert.equal(missing.observations, 178, "both return intervals using a missing close are excluded");
  assert.ok(Math.abs(missing.value - 2) < 1e-10);
  assert.equal(capital.estimateHistoricalBeta(stock, new Map([...market].map(([date]) => [date, 100])), end), null);
  const short = histories(end, 60);
  assert.equal(capital.estimateHistoricalBeta(short.stock, short.market, end), null);
  assert.equal(capital.estimateHistoricalBeta(stock, market, "2026-10-20"), null);
});

test("CAPM and market-equity/book-debt WACC match hand arithmetic with transparent assumptions", () => {
  const market = {
    riskFree: { value: 0.04, asOf: "2026-09-18", source: "Treasury fixture", url: "https://home.treasury.gov/" },
    beta: { value: 1.5, rSquared: 0.6, observations: 180, start: "2026-01-01", end: "2026-09-18", benchmark: "SPY", source: "fixture" },
    warnings: [],
  };
  const inputs = { market, price: 100, sharesB: 1, debtB: 25, taxRate: 0.2, terminalGrowth: 0.02 };
  const result = capital.calculateCapitalCost(inputs);
  assert.ok(Math.abs(result.costOfEquity - 0.1075) < 1e-12);
  assert.ok(Math.abs(result.wacc - 0.0956) < 1e-12);
  assert.equal(result.preTaxCostOfDebt, 0.06);
  assert.match(result.equityRiskPremium.source, /policy assumption/);
  assert.match(result.creditSpread.source, /not an issuer bond quote/);
  const debtFree = capital.calculateCapitalCost({ ...inputs, debtB: 0 });
  assert.equal(debtFree.wacc, debtFree.costOfEquity);
  for (const bad of [{ debtB: null }, { debtB: -1 }, { taxRate: undefined }, { price: null }, { terminalGrowth: 0.2 }, { market: { ...market, beta: null } }]) {
    assert.equal(capital.calculateCapitalCost({ ...inputs, ...bad }), null);
  }
});

test("market inputs reuse caches, need no AI, and fail safely without credentials or return history", async () => {
  const savedFetch = globalThis.fetch;
  let fetches = 0; let barLoads = 0;
  try {
    assert.equal((await capital.loadCapitalCostMarketInputs("NONE")).beta, null);
    globalThis.__capitalTestBindings = { ALPACA_API_KEY_ID: "test-only", ALPACA_API_SECRET_KEY: "test-only" };
    const today = iso(Date.now());
    const { stock, market, end } = histories(iso(Date.parse(today) - DAY));
    globalThis.fetch = async (url) => {
      assert.ok(String(url).startsWith("https://home.treasury.gov/"), "no OpenAI or other unrelated request");
      fetches += 1;
      return new Response(`<feed>${entry(end, 4)}</feed>`, { headers: { "Content-Type": "application/xml" } });
    };
    globalThis.__capitalTestBars = async (tickers, options) => {
      barLoads += 1;
      assert.equal(options.end, `${today}T00:00:00Z`);
      assert.equal(options.feed, "iex");
      return new Map([[tickers[0], tickers[0] === "FAIL" ? new Map() : stock], ["SPY", market]]);
    };
    const first = await capital.loadCapitalCostMarketInputs("TEST");
    const second = await capital.loadCapitalCostMarketInputs("TEST");
    assert.deepEqual(first, second);
    assert.equal(fetches, 1);
    assert.equal(barLoads, 1);
    assert.ok(first.beta.value > 1.99);
    assert.match(first.beta.source, /Alpaca IEX/);
    const failure = await capital.loadCapitalCostMarketInputs("FAIL");
    assert.equal(failure.beta, null);
    assert.ok(failure.warnings.some((warning) => /Insufficient/.test(warning)));
    assert.equal(fetches, 1, "the risk-free cache is shared across issuers");
  } finally {
    globalThis.fetch = savedFetch;
    delete globalThis.__capitalTestBindings;
    delete globalThis.__capitalTestBars;
  }
});
