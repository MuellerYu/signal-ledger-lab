import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import ts from "typescript";

/**
 * Portfolio storage must be isolated from the application database. These tests
 * cover both the source contract (which binding, which tables) and the runtime
 * behaviour against an in-memory stand-in for PORTFOLIO_DB.
 */

const libRoot = new URL("../lib/", import.meta.url);
const appRoot = new URL("../app/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, libRoot), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

const runtimeUrl = dataUrl(await transpile("runtime.ts", [
  ['import { env } from "cloudflare:workers";', "const env = new Proxy({}, { get: (_t, key) => (globalThis.__portfolioEnv ?? {})[key] });"],
]));
const pickNyUrl = dataUrl(await transpile("pick-ny.ts"));
const barsUrl = dataUrl(await transpile("alpaca-bars.ts", [
  ['from "./runtime"', `from "${runtimeUrl}"`],
  ['from "./pick-ny"', `from "${pickNyUrl}"`],
]));
const portfolioDbUrl = dataUrl(await transpile("portfolio-db.ts", [
  ['from "./runtime"', `from "${runtimeUrl}"`],
]));
// The canonical valuation chain is irrelevant here: holdings only need to show
// that they carry whatever the snapshot layer returns.
const valuationStubUrl = dataUrl("export async function getInvestmentSnapshots(){ return globalThis.__snapshots ?? []; }");
const portfolioErrorUrl = dataUrl(await transpile("portfolio-error.ts"));
const storeUrl = dataUrl(await transpile("pick-ny-store.ts", [
  ['from "./runtime"', `from "${runtimeUrl}"`],
  ['from "./pick-ny"', `from "${pickNyUrl}"`],
  ['from "./alpaca-bars"', `from "${barsUrl}"`],
  ['from "./portfolio-db"', `from "${portfolioDbUrl}"`],
  ['from "./portfolio-error"', `from "${portfolioErrorUrl}"`],
  ['from "./investment-snapshot"', `from "${valuationStubUrl}"`],
]));

const pickNy = await import(pickNyUrl);
const portfolioDb = await import(portfolioDbUrl);
const store = await import(storeUrl);
const bars = await import(barsUrl);

const ALPACA_ENV = { ALPACA_API_KEY_ID: "key", ALPACA_API_SECRET_KEY: "secret" };
const SESSIONS = ["2026-01-02", "2026-01-05", "2026-01-06"];
const TICKERS = pickNy.pickNyTickers();

/** In-memory stand-in for D1 that understands only the statements this feature issues. */
function portfolioD1() {
  const state = { portfolios: new Map(), nav: new Map(), holdings: new Map(), rebalances: [] };
  const touchCount = {};

  const key = (portfolioId, date, ticker) => `${portfolioId}|${date}|${ticker ?? ""}`;

  const createdTables = [];

  function run(sql, values) {
    const verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "CREATE") {
      const created = sql.match(/CREATE\s+(?:TABLE|INDEX)\s+IF NOT EXISTS\s+(\w+)/i)?.[1];
      if (created) createdTables.push(created);
      return;
    }
    const table = sql.match(/(?:INTO|FROM|UPDATE)\s+(sl_[a-z_]+)/i)?.[1];
    if (table) touchCount[table] = (touchCount[table] ?? 0) + 1;

    if (verb === "INSERT" && sql.includes("sl_portfolios")) {
      const [id, slug, displayName, requestedStart, inception, initialNav, benchmarkSymbol, benchmarkLabel, methodology, status, createdAt] = values;
      state.portfolios.set(slug, { id, slug, display_name: displayName, requested_start_date: requestedStart, effective_inception_date: inception, initial_nav: initialNav, benchmark_symbol: benchmarkSymbol, benchmark_label: benchmarkLabel, methodology_version: methodology, status, created_at: createdAt });
      return;
    }
    if (verb === "INSERT" && sql.includes("sl_portfolio_daily_nav")) {
      const [portfolioId, date, navValue, dailyReturn, benchmarkNav, benchmarkDailyReturn, excess, hwm, drawdown, priceAsOf, dataSource, methodology, calculatedAt] = values;
      state.nav.set(key(portfolioId, date), { trading_date: date, nav: navValue, daily_return: dailyReturn, benchmark_nav: benchmarkNav, benchmark_daily_return: benchmarkDailyReturn, excess_return: excess, high_water_mark: hwm, drawdown, price_data_as_of: priceAsOf, data_source: dataSource, methodology_version: methodology, calculated_at: calculatedAt });
      return;
    }
    if (verb === "INSERT" && sql.includes("sl_portfolio_daily_holdings")) {
      for (let index = 0; index < values.length; index += 9) {
        const [portfolioId, date, ticker, shares, close, marketValue, weight, dailyReturn, dailyContribution] = values.slice(index, index + 9);
        state.holdings.set(key(portfolioId, date, ticker), { trading_date: date, ticker, shares, adjusted_close: close, market_value: marketValue, portfolio_weight: weight, daily_return: dailyReturn, daily_contribution: dailyContribution });
      }
      return;
    }
    if (verb === "DELETE" && sql.includes("sl_portfolio_daily_nav")) {
      for (const rowKey of [...state.nav.keys()]) if (rowKey.startsWith(`${values[0]}|`)) state.nav.delete(rowKey);
      return;
    }
    if (verb === "DELETE" && sql.includes("sl_portfolio_daily_holdings")) {
      for (const rowKey of [...state.holdings.keys()]) if (rowKey.startsWith(`${values[0]}|`)) state.holdings.delete(rowKey);
      return;
    }
    throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
  }

  function first(sql, values) {
    if (sql.includes("sl_portfolios") && sql.includes("slug = ?")) return state.portfolios.get(values[0]) ?? null;
    if (sql.includes("MAX(trading_date)")) {
      const dates = [...state.nav.entries()].filter(([k]) => k.startsWith(`${values[0]}|`)).map(([, v]) => v.trading_date);
      return { last: dates.length ? dates.sort().at(-1) : null };
    }
    if (sql.includes("COUNT(*)") && sql.includes("sl_portfolio_rebalances")) {
      return { n: state.rebalances.length, last: null };
    }
    return null;
  }

  function all(sql, values) {
    if (sql.includes("sl_portfolio_daily_nav")) {
      return { success: true, results: [...state.nav.values()].sort((a, b) => a.trading_date.localeCompare(b.trading_date)) };
    }
    if (sql.includes("sl_portfolio_daily_holdings") && sql.includes("MIN(trading_date)")) {
      const earliest = [...state.holdings.values()].map((row) => row.trading_date).sort()[0];
      return { success: true, results: [...state.holdings.values()].filter((row) => row.trading_date === earliest) };
    }
    if (sql.includes("sl_portfolio_daily_holdings")) {
      return { success: true, results: [...state.holdings.values()].filter((row) => row.trading_date === values[1]).sort((a, b) => a.ticker.localeCompare(b.ticker)) };
    }
    return { success: true, results: [] };
  }

  return {
    state,
    touchCount,
    createdTables,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { statement.values = values; return statement; },
        async first() { return first(sql, statement.values); },
        async all() { return all(sql, statement.values); },
        async run() { run(sql, statement.values); return { success: true }; },
      };
      return statement;
    },
    async batch(list) {
      for (const statement of list) run(statement.sql, statement.values);
      return [];
    },
  };
}

function alpacaPayload() {
  const response = { bars: {} };
  for (const [index, ticker] of TICKERS.entries()) {
    response.bars[ticker] = SESSIONS.map((date, session) => ({ t: `${date}T05:00:00Z`, c: 100 + index + session }));
  }
  response.bars.SPY = [
    { t: "2026-01-02T05:00:00Z", c: 500 },
    { t: "2026-01-05T05:00:00Z", c: 505 },
    { t: "2026-01-06T05:00:00Z", c: 500 },
  ];
  return response;
}

function installFetch({ ok = true, status = 200, payload = alpacaPayload() } = {}) {
  globalThis.fetch = async () => (ok ? Response.json(payload) : new Response("nope", { status }));
}

afterEach(() => {
  globalThis.__portfolioEnv = undefined;
  delete globalThis.fetch;
  bars.resetBarCache();
});

/* ---------------------------------------------------------------- isolation */

test("portfolio storage reads PORTFOLIO_DB only, never the application DB", async () => {
  const source = await readFile(new URL("pick-ny-store.ts", libRoot), "utf8");
  assert.doesNotMatch(source, /getBindings\(\)\.DB/, "the portfolio store must not read the app-wide DB");
  assert.match(source, /getPortfolioD1/);

  const portfolioSource = await readFile(new URL("portfolio-db.ts", libRoot), "utf8");
  assert.match(portfolioSource, /getBindings\(\)\.PORTFOLIO_DB/);
  assert.doesNotMatch(portfolioSource, /getBindings\(\)\.DB\b/);
});

test("the portfolio initializer cannot touch the application or monitor tables", async () => {
  const statements = portfolioDb.PORTFOLIO_CREATE_STATEMENTS.join("\n");
  for (const forbidden of portfolioDb.FORBIDDEN_PORTFOLIO_TABLES) {
    assert.doesNotMatch(
      statements,
      new RegExp(`(CREATE|ALTER|DROP|INSERT INTO|UPDATE|DELETE FROM)\\s+${forbidden}\\b`, "i"),
      `portfolio DDL must never touch ${forbidden}`,
    );
  }
  // Only CREATE ... IF NOT EXISTS may appear, so an existing table is never altered.
  assert.equal(statements.match(/ALTER|DROP|UPDATE|DELETE/gi), null);

  // Comments name the forbidden function on purpose, so only code is inspected.
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const portfolioSource = stripComments(await readFile(new URL("portfolio-db.ts", libRoot), "utf8"));
  assert.doesNotMatch(portfolioSource, /from "\.\/db"|from "@\/db"/, "the portfolio store must not import the app database module");
  assert.doesNotMatch(portfolioSource, /ensureDatabase/, "the portfolio initializer is its own function");
});

test("every portfolio table is sl_-prefixed", () => {
  assert.ok(portfolioDb.PORTFOLIO_TABLES.length >= 4);
  for (const table of portfolioDb.PORTFOLIO_TABLES) assert.match(table, /^sl_/);
  const declared = portfolioDb.PORTFOLIO_CREATE_STATEMENTS.join(" ").match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? [];
  assert.equal(declared.length, 4);
  for (const statement of declared) assert.match(statement, /sl_/);
});

test("the application schema no longer defines any portfolio table", async () => {
  const schema = await readFile(new URL("db-schema.ts", libRoot), "utf8");
  assert.doesNotMatch(schema, /sl_portfolio|model_portfolio/);
});

test("portfolio routes never read the generic dashboard database", async () => {
  const shared = await readFile(new URL("api/portfolios/shared.ts", appRoot), "utf8");
  for (const source of [shared]) {
    assert.doesNotMatch(source, /getD1\b/, "portfolio routes must not fall back to the app DB");
    assert.doesNotMatch(source, /ensureDatabase\b/);
  }
});

test("the homepage module never requests the full history series", async () => {
  const panel = await readFile(new URL("picks-panel.tsx", appRoot), "utf8");
  assert.match(panel, /api\/portfolios\/ny\/summary/);
  assert.doesNotMatch(panel, /\/history/, "the homepage must read the summary, not the history endpoint");
  assert.doesNotMatch(panel, /computeNavSeries|buildHoldings|pick-ny-store/);
});

/* ------------------------------------------------------- definition + maths */

test("the published picks are the specified weights and sum to 100%", () => {
  const weightSum = pickNy.PICK_NY_TARGETS.reduce((sum, target) => sum + target.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-12);
  assert.deepEqual(pickNy.pickNyTickers(), ["SOXL", "ORCL", "MSTR", "TSLA", "AMD", "ASTS"]);
  assert.equal(pickNy.PICK_NY_INITIAL_NAV, 100);
});

test("both series start at 100 and the portfolio is never rebalanced", () => {
  const barsMap = new Map(TICKERS.map((ticker, index) => [ticker, new Map(SESSIONS.map((date, session) => [date, 100 + index + session]))]));
  barsMap.set("SPY", new Map([["2026-01-02", 500], ["2026-01-05", 505], ["2026-01-06", 500]]));
  const holdings = pickNy.buildHoldings(barsMap, "2026-01-02", 100);
  const points = pickNy.computeNavSeries(holdings, barsMap, barsMap.get("SPY"), "2026-01-02", { initialNav: 100 });

  assert.equal(points[0].nav, 100, "NAV starts at 100");
  assert.equal(points[0].benchmarkNav, 100, "benchmark starts at 100");
  assert.equal(points[0].drawdown, 0);
  assert.ok(points.every((point) => point.drawdown <= 0), "drawdown can never be positive");
  for (const point of points) {
    assert.ok(Math.abs(point.positions.reduce((sum, p) => sum + p.weight, 0) - 1) < 1e-9, "weights sum to 100%");
    assert.ok(Math.abs(point.positions.reduce((sum, p) => sum + p.contributionPoints, 0) - point.cumulativeReturn * 100) < 1e-9);
  }
  // Fixed share counts are what make the strategy non-rebalancing: the same
  // share count must reproduce each session's market value at that close.
  assert.ok(holdings.every((holding) => holding.modelShares > 0));
  for (const point of points) {
    point.positions.forEach((position, index) => {
      assert.ok(Math.abs(holdings[index].modelShares * position.adjustedClose - position.marketValue) < 1e-9);
    });
  }
});

/* ------------------------------------------------------------ store behaviour */

test("the first run persists one NAV row per session and one holding row per position", async () => {
  const db = portfolioD1();
  globalThis.__portfolioEnv = { ...ALPACA_ENV, PORTFOLIO_DB: db };
  installFetch();

  const summary = await store.getPortfolioSummary("ny");
  assert.equal(summary.ok, true, summary.ok ? "" : summary.error);
  assert.equal(summary.value.persisted, true);
  assert.equal(summary.value.inceptionDate, "2026-01-02");
  assert.equal(summary.value.asOfDate, "2026-01-06");
  assert.equal(summary.value.sessions, 3);

  assert.equal([...db.state.nav.keys()].length, 3, "daily NAV rows are unique per session");
  assert.equal([...db.state.holdings.keys()].length, 3 * TICKERS.length);
  assert.equal(db.touchCount.sl_portfolios, 1);
});

test("history is chronological, starts at 100 and agrees with the summary", async () => {
  const db = portfolioD1();
  globalThis.__portfolioEnv = { ...ALPACA_ENV, PORTFOLIO_DB: db };
  installFetch();
  await store.getPortfolioSummary("ny");

  const history = await store.getPortfolioHistory("ny", "SI");
  assert.equal(history.ok, true);
  const dates = history.value.map((point) => point.date);
  assert.deepEqual(dates, [...dates].sort(), "history is chronological");
  assert.equal(history.value[0].nav, 100, "history starts at 100");

  const summary = await store.getPortfolioSummary("ny");
  assert.ok(Math.abs(history.value.at(-1).nav - summary.value.nav) < 1e-9, "latest history NAV equals the summary NAV");
  assert.ok(Math.abs(history.value.at(-1).benchmarkNav - summary.value.benchmarkNav) < 1e-9, "latest benchmark equals the summary benchmark");

  const ranged = await store.getPortfolioHistory("ny", "1M");
  assert.ok(ranged.value.length <= history.value.length);
});

test("holdings report the initial weight alongside the drifted current weight", async () => {
  const db = portfolioD1();
  globalThis.__portfolioEnv = { ...ALPACA_ENV, PORTFOLIO_DB: db };
  installFetch();
  await store.getPortfolioSummary("ny");

  const holdings = await store.getPortfolioHoldings("ny");
  assert.equal(holdings.ok, true);
  assert.equal(holdings.value.length, TICKERS.length);
  for (const row of holdings.value) {
    assert.ok(row.initialWeight > 0 && row.initialWeight <= 0.2);
    assert.ok(row.currentWeight > 0);
    assert.ok(Number.isFinite(row.price) && row.price > 0);
  }
  const currentSum = holdings.value.reduce((sum, row) => sum + row.currentWeight, 0);
  assert.ok(Math.abs(currentSum - 1) < 1e-9, "current weights still sum to 100%");
});

test("a re-run appends nothing once every session is stored", async () => {
  const db = portfolioD1();
  globalThis.__portfolioEnv = { ...ALPACA_ENV, PORTFOLIO_DB: db };
  installFetch();
  await store.getPortfolioSummary("ny");
  const before = [...db.state.nav.keys()].sort();
  const writesBefore = db.touchCount.sl_portfolio_daily_nav;

  // Force the freshness window to lapse so the recompute path runs again.
  for (const row of db.state.nav.values()) row.calculated_at = "2000-01-01T00:00:00.000Z";
  const rerun = await store.getPortfolioSummary("ny");

  assert.equal(rerun.ok, true);
  assert.deepEqual([...db.state.nav.keys()].sort(), before, "stored sessions are not duplicated");
  assert.equal(db.touchCount.sl_portfolio_daily_nav, writesBefore, "an up-to-date series writes no NAV rows");
});

test("without PORTFOLIO_DB the summary still computes and says it is not stored", async () => {
  globalThis.__portfolioEnv = ALPACA_ENV;
  installFetch();
  const summary = await store.getPortfolioSummary("ny");
  assert.equal(summary.ok, true);
  assert.equal(summary.value.persisted, false);
  assert.equal(summary.value.sessions, 3);
  assert.ok(Number.isFinite(summary.value.nav) && summary.value.nav > 0, "a real NAV is still produced");
  assert.ok(summary.value.sparkline.length > 0);

  // Persistence is durability, not a prerequisite for the chart or the table.
  const history = await store.getPortfolioHistory("ny", "SI");
  assert.equal(history.ok, true, "the chart must render from the deterministic series");
  assert.equal(history.value.length, SESSIONS.length);
  assert.equal(history.value[0].nav, 100);
  assert.ok(Math.abs(history.value.at(-1).nav - summary.value.nav) < 1e-9);

  const holdings = await store.getPortfolioHoldings("ny");
  assert.equal(holdings.ok, true, "holdings must render from the deterministic series");
  assert.equal(holdings.value.length, TICKERS.length);
  const weightSum = holdings.value.reduce((total, row) => total + row.currentWeight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9);
});

test("no public surface renders internal engine status words", async () => {
  const surfaces = [
    "dashboard-client.tsx", "valuation-desk.tsx", "picks-panel.tsx",
    "picks/[slug]/portfolio-view.tsx", "picks/page.tsx", "track-record/page.tsx",
  ];
  for (const file of surfaces) {
    const source = await readFile(new URL(file, appRoot), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const word of ["PROVISIONAL", "SCREENING", "HIGH UNCERTAINTY", "DECISION GRADE"]) {
      assert.doesNotMatch(code, new RegExp(word), `${file} must not render ${word}`);
    }
  }
});

test("the public valuation card states a view and a confidence, not a lifecycle status", async () => {
  const source = await readFile(new URL("valuation-desk.tsx", appRoot), "utf8");
  assert.match(source, /export function publicView/);
  assert.match(source, /export function publicBadge/);
  assert.match(source, /"MODEL REVIEW"/);
  assert.match(source, /"VALUATION WITHHELD"/);
  assert.doesNotMatch(source, /READINESS_LABEL/);
});

test("the summary sparkline is capped so the homepage payload stays small", async () => {
  const db = portfolioD1();
  globalThis.__portfolioEnv = { ...ALPACA_ENV, PORTFOLIO_DB: db };
  installFetch();
  const summary = await store.getPortfolioSummary("ny");
  assert.ok(summary.value.sparkline.length <= store.SPARKLINE_POINTS);
  assert.ok(store.SPARKLINE_POINTS <= 64);
});
