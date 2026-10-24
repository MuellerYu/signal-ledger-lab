import { getBindings } from "./runtime";

/**
 * Portfolio storage is isolated on purpose.
 *
 * The `sl_`-prefixed tables can share a database with the always-on monitor
 * worker, whose `sources`, `events` and `forecasts` have a different shape from
 * the Pages application's own tables of the same name. So this module:
 *
 * - reads only the PORTFOLIO_DB binding, never the app-wide DB;
 * - creates only the four `sl_` tables below;
 * - never alters, drops, updates or deletes anything else.
 *
 * The application's `ensureDatabase()` must never run against PORTFOLIO_DB.
 */

export const PORTFOLIO_DB_BINDING = "PORTFOLIO_DB";

export const PORTFOLIO_TABLES = Object.freeze([
  "sl_portfolios",
  "sl_portfolio_rebalances",
  "sl_portfolio_daily_nav",
  "sl_portfolio_daily_holdings",
]);

/** Tables this module must never touch, listed so a test can assert isolation. */
export const FORBIDDEN_PORTFOLIO_TABLES = Object.freeze(["sources", "events", "forecasts"]);

/** The only DDL the portfolio initializer is allowed to run. */
export const PORTFOLIO_CREATE_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS sl_portfolios (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    requested_start_date TEXT NOT NULL,
    effective_inception_date TEXT,
    initial_nav REAL NOT NULL,
    benchmark_symbol TEXT NOT NULL,
    benchmark_label TEXT NOT NULL,
    methodology_version TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sl_portfolio_rebalances (
    id TEXT PRIMARY KEY NOT NULL,
    portfolio_id TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    target_weights_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sl_portfolio_daily_nav (
    portfolio_id TEXT NOT NULL,
    trading_date TEXT NOT NULL,
    nav REAL NOT NULL,
    daily_return REAL,
    benchmark_nav REAL NOT NULL,
    benchmark_daily_return REAL,
    excess_return REAL NOT NULL,
    high_water_mark REAL NOT NULL,
    drawdown REAL NOT NULL,
    price_data_as_of TEXT,
    data_source TEXT NOT NULL,
    methodology_version TEXT NOT NULL,
    calculated_at TEXT NOT NULL,
    PRIMARY KEY (portfolio_id, trading_date)
  )`,
  `CREATE TABLE IF NOT EXISTS sl_portfolio_daily_holdings (
    portfolio_id TEXT NOT NULL,
    trading_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    shares REAL NOT NULL,
    adjusted_close REAL NOT NULL,
    market_value REAL NOT NULL,
    portfolio_weight REAL NOT NULL,
    daily_return REAL,
    daily_contribution REAL NOT NULL,
    PRIMARY KEY (portfolio_id, trading_date, ticker)
  )`,
  `CREATE INDEX IF NOT EXISTS sl_portfolio_daily_holdings_ticker_idx
    ON sl_portfolio_daily_holdings (portfolio_id, ticker, trading_date)`,
]);

export function getPortfolioD1(): D1Database | null {
  try {
    return getBindings().PORTFOLIO_DB ?? null;
  } catch {
    return null;
  }
}

let initialization: Promise<void> | null = null;

/**
 * Creates the portfolio tables if they are missing. Runs once per isolate and
 * is a no-op when the binding is absent, so the model portfolio degrades to a
 * per-request calculation instead of failing.
 */
export async function ensurePortfolioDatabase(d1: D1Database | null = getPortfolioD1()) {
  if (!d1) return false;
  if (!initialization) {
    initialization = (async () => {
      for (const statement of PORTFOLIO_CREATE_STATEMENTS) {
        await d1.prepare(statement).run();
      }
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  await initialization;
  return true;
}
