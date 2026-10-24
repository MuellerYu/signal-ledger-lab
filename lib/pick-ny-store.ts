import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";
import { getInvestmentSnapshots } from "./investment-snapshot";
import { ensurePortfolioDatabase, getPortfolioD1 } from "./portfolio-db";
import { readableError } from "./portfolio-error";
import {
  PICK_NY_BENCHMARK_SYMBOL,
  PICK_NY_INITIAL_NAV,
  PICK_NY_METHODOLOGY_VERSION,
  PICK_NY_NAME,
  PICK_NY_REQUESTED_START,
  PICK_NY_SLUG,
  PICK_NY_TARGETS,
  buildHoldings,
  computeNavSeries,
  pickNyTickers,
  resolveInceptionSession,
  summarizeNavSeries,
  type AdjustedBarMap,
  type PickNyHolding,
  type PickNyNavPoint,
} from "./pick-ny";

/**
 * Persistence for the public model portfolios.
 *
 * Storage lives on the dedicated PORTFOLIO_DB binding and only ever touches the
 * `sl_` tables, so it is safe to share a database with the always-on monitor
 * worker. The application's own schema initializer is never run here.
 *
 * Once a session is stored it is never rewritten: a published NAV becomes the
 * official track record and history is only ever appended to.
 */

export const PORTFOLIO_SCHEMA = "signal-ledger.portfolio.v1";
export const PORTFOLIO_PRICE_ADJUSTMENT = "all";
export const PORTFOLIO_BENCHMARK_LABEL = `S&P 500 — ${PICK_NY_BENCHMARK_SYMBOL} total-return proxy`;

const FRESH_MS = 30 * 60 * 1_000;
const WRITE_CHUNK = 60;
const TRADING_DAYS_PER_YEAR = 252;
/** The homepage sparkline is capped so the summary payload stays small. */
export const SPARKLINE_POINTS = 48;

export const PORTFOLIO_DISCLOSURE =
  "Signal Ledger Picks are research model portfolios, not brokerage accounts, investment funds, or personalized investment advice. Model performance may differ from real-world investable returns.";

export type PortfolioHistoryPoint = {
  date: string;
  nav: number;
  benchmarkNav: number;
  drawdown: number;
};

export type PortfolioHoldingRow = {
  ticker: string;
  initialWeight: number;
  currentWeight: number;
  shares: number;
  price: number;
  returnPct: number;
  contributionPoints: number;
  /** From the canonical InvestmentSnapshot; never recalculated here. */
  fairValue: number | null;
  fvUpsidePct: number | null;
  view: "BUY" | "WATCH" | "SELL" | null;
};

export type PortfolioSummary = {
  schema: string;
  slug: string;
  displayName: string;
  status: string;
  inceptionDate: string;
  asOfDate: string;
  sessions: number;
  nav: number;
  cumulativeReturn: number;
  benchmarkLabel: string;
  benchmarkNav: number;
  benchmarkCumulativeReturn: number;
  excessCumulativeReturn: number;
  highWaterMark: number;
  currentDrawdown: number;
  maxDrawdown: number;
  maxDrawdownDate: string | null;
  volatility: number | null;
  methodologyVersion: string;
  priceSource: string;
  priceDataAsOf: string | null;
  lastRebalanceDate: string | null;
  rebalanceCount: number;
  /** At most SPARKLINE_POINTS samples, so the homepage never pulls the full series. */
  sparkline: PortfolioHistoryPoint[];
  /** False when PORTFOLIO_DB is absent and the series is recomputed per request. */
  persisted: boolean;
  stale: boolean;
  calculatedAt: string;
  disclosure: string;
};

export type PortfolioResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

type PortfolioRow = {
  id: string;
  slug: string;
  display_name: string;
  requested_start_date: string;
  effective_inception_date: string | null;
  initial_nav: number;
  benchmark_symbol: string;
  benchmark_label: string;
  methodology_version: string;
  status: string;
  created_at: string;
};

type NavRow = {
  trading_date: string;
  nav: number;
  benchmark_nav: number;
  drawdown: number;
  high_water_mark: number;
  price_data_as_of: string | null;
  data_source: string;
  calculated_at: string;
};

type HoldingRow = {
  trading_date: string;
  ticker: string;
  shares: number;
  adjusted_close: number;
  market_value: number;
  portfolio_weight: number;
  daily_contribution: number;
};

type Computed = {
  inceptionDate: string;
  holdings: PickNyHolding[];
  points: PickNyNavPoint[];
  priceSource: string;
};

type Stored = {
  portfolio: PortfolioRow;
  nav: NavRow[];
  holdings: HoldingRow[];
  rebalanceCount: number;
  lastRebalanceDate: string | null;
};

/**
 * Durability gaps are an operator concern, never a public one: the page keeps
 * rendering from the deterministic series while this records the cause.
 */
function reportPersistenceGap(surface: string, detail = "PORTFOLIO_DB binding absent") {
  console.warn(`[pick-ny] serving ${surface} from the deterministic backtest: ${detail}`);
}

function priceSource(feed: string) {
  return `alpaca:${feed}:adjusted_${PORTFOLIO_PRICE_ADJUSTMENT}`;
}

async function compute(): Promise<Computed> {
  const tickers = pickNyTickers();
  const symbols = [...tickers, PICK_NY_BENCHMARK_SYMBOL];
  const feed = configuredFeed();
  const bars: AdjustedBarMap = await fetchDailyAdjustedBars(symbols, { start: PICK_NY_REQUESTED_START });
  const benchmark = bars.get(PICK_NY_BENCHMARK_SYMBOL) ?? new Map<string, number>();

  // Adjusted closes are mandatory: an unadjusted price would misstate every
  // return after a split or distribution.
  const missing = symbols.filter((symbol) => (bars.get(symbol)?.size ?? 0) === 0);
  if (missing.length) throw new Error(`No adjusted daily history returned for ${missing.join(", ")}.`);

  const inceptionDate = resolveInceptionSession(bars, benchmark, PICK_NY_REQUESTED_START, tickers);
  if (!inceptionDate) {
    throw new Error(`No US session on or after ${PICK_NY_REQUESTED_START} has an adjusted close for every holding and the benchmark.`);
  }

  const holdings = buildHoldings(bars, inceptionDate, PICK_NY_INITIAL_NAV);
  const points = computeNavSeries(holdings, bars, benchmark, inceptionDate, { initialNav: PICK_NY_INITIAL_NAV });
  if (!points.length) throw new Error("The provider returned no sessions for the model portfolio.");

  return { inceptionDate, holdings, points, priceSource: priceSource(feed) };
}

/** Creates the portfolio row and appends only sessions that are not stored yet. */
async function persist(db: D1Database, computed: Computed) {
  const now = new Date().toISOString();
  const existing = await db
    .prepare(`SELECT id, effective_inception_date FROM sl_portfolios WHERE slug = ?`)
    .bind(PICK_NY_SLUG)
    .first<{ id: string; effective_inception_date: string | null }>();

  const portfolioId = existing?.id ?? `${PICK_NY_SLUG}-v1`;
  // A different inception means different share counts, so a stored series that
  // disagrees is no longer this portfolio and is rebuilt rather than appended to.
  const restart = !existing || existing.effective_inception_date !== computed.inceptionDate;

  if (restart) {
    await db.batch([
      db.prepare(`DELETE FROM sl_portfolio_daily_nav WHERE portfolio_id = ?`).bind(portfolioId),
      db.prepare(`DELETE FROM sl_portfolio_daily_holdings WHERE portfolio_id = ?`).bind(portfolioId),
    ]);
  }

  await db
    .prepare(`INSERT INTO sl_portfolios (id, slug, display_name, requested_start_date, effective_inception_date,
                initial_nav, benchmark_symbol, benchmark_label, methodology_version, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                effective_inception_date = excluded.effective_inception_date,
                benchmark_label = excluded.benchmark_label,
                methodology_version = excluded.methodology_version,
                status = excluded.status`)
    .bind(
      portfolioId, PICK_NY_SLUG, PICK_NY_NAME, PICK_NY_REQUESTED_START, computed.inceptionDate,
      PICK_NY_INITIAL_NAV, PICK_NY_BENCHMARK_SYMBOL, PORTFOLIO_BENCHMARK_LABEL,
      PICK_NY_METHODOLOGY_VERSION, "live", now,
    )
    .run();

  const lastStored = restart
    ? null
    : await db
        .prepare(`SELECT MAX(trading_date) AS last FROM sl_portfolio_daily_nav WHERE portfolio_id = ?`)
        .bind(portfolioId)
        .first<{ last: string | null }>()
        .then((row) => row?.last ?? null);

  const sharesByTicker = new Map(computed.holdings.map((holding) => [holding.ticker, holding.modelShares]));
  const pending = lastStored ? computed.points.filter((point) => point.sessionDate > lastStored) : computed.points;
  const statements: D1PreparedStatement[] = [];

  for (const point of pending) {
    statements.push(
      db
        .prepare(`INSERT INTO sl_portfolio_daily_nav (portfolio_id, trading_date, nav, daily_return, benchmark_nav,
                    benchmark_daily_return, excess_return, high_water_mark, drawdown, price_data_as_of, data_source,
                    methodology_version, calculated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(portfolio_id, trading_date) DO UPDATE SET
                    nav = excluded.nav,
                    daily_return = excluded.daily_return,
                    benchmark_nav = excluded.benchmark_nav,
                    benchmark_daily_return = excluded.benchmark_daily_return,
                    excess_return = excluded.excess_return,
                    high_water_mark = excluded.high_water_mark,
                    drawdown = excluded.drawdown,
                    price_data_as_of = excluded.price_data_as_of,
                    data_source = excluded.data_source,
                    methodology_version = excluded.methodology_version,
                    calculated_at = excluded.calculated_at`)
        .bind(
          portfolioId, point.sessionDate, point.nav, point.dailyReturn, point.benchmarkNav,
          point.benchmarkDailyReturn, point.excessCumulativeReturn, point.highWaterMark, point.drawdown,
          point.sessionDate, computed.priceSource, PICK_NY_METHODOLOGY_VERSION, now,
        ),
    );

    const placeholders = point.positions.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(`INSERT INTO sl_portfolio_daily_holdings (portfolio_id, trading_date, ticker, shares, adjusted_close,
                    market_value, portfolio_weight, daily_return, daily_contribution)
                  VALUES ${placeholders}
                  ON CONFLICT(portfolio_id, trading_date, ticker) DO UPDATE SET
                    shares = excluded.shares,
                    adjusted_close = excluded.adjusted_close,
                    market_value = excluded.market_value,
                    portfolio_weight = excluded.portfolio_weight,
                    daily_return = excluded.daily_return,
                    daily_contribution = excluded.daily_contribution`)
        .bind(
          ...point.positions.flatMap((position) => [
            portfolioId, point.sessionDate, position.ticker, sharesByTicker.get(position.ticker) ?? 0,
            position.adjustedClose, position.marketValue, position.weight, position.dailyReturn,
            position.dailyContribution,
          ]),
        ),
    );
  }

  for (let index = 0; index < statements.length; index += WRITE_CHUNK) {
    await db.batch(statements.slice(index, index + WRITE_CHUNK));
  }
}

async function readStored(db: D1Database, slug: string): Promise<Stored | null> {
  const portfolio = await db.prepare(`SELECT * FROM sl_portfolios WHERE slug = ?`).bind(slug).first<PortfolioRow>();
  if (!portfolio) return null;

  const navResult = await db
    .prepare(`SELECT trading_date, nav, benchmark_nav, drawdown, high_water_mark, price_data_as_of, data_source, calculated_at
              FROM sl_portfolio_daily_nav WHERE portfolio_id = ? ORDER BY trading_date ASC`)
    .bind(portfolio.id)
    .all<NavRow>();
  const nav = navResult.results ?? [];
  if (!nav.length) return null;

  const holdingResult = await db
    .prepare(`SELECT trading_date, ticker, shares, adjusted_close, market_value, portfolio_weight, daily_contribution
              FROM sl_portfolio_daily_holdings WHERE portfolio_id = ? AND trading_date = ? ORDER BY ticker ASC`)
    .bind(portfolio.id, nav.at(-1)!.trading_date)
    .all<HoldingRow>();

  const rebalance = await db
    .prepare(`SELECT COUNT(*) AS n, MAX(effective_date) AS last FROM sl_portfolio_rebalances WHERE portfolio_id = ?`)
    .bind(portfolio.id)
    .first<{ n: number; last: string | null }>();

  return {
    portfolio,
    nav,
    holdings: holdingResult.results ?? [],
    rebalanceCount: rebalance?.n ?? 0,
    lastRebalanceDate: rebalance?.last ?? null,
  };
}

/**
 * Reads the stored series and only recomputes when it is older than the refresh
 * window. A visitor never pays for a full-history rebuild inside the window.
 */
async function loadStored(db: D1Database | null, slug: string): Promise<{ stored: Stored | null; computed: Computed | null }> {
  if (!db) return { stored: null, computed: await compute() };

  let stored: Stored | null = null;
  try {
    stored = await readStored(db, slug);
  } catch {
    stored = null;
  }

  const age = stored ? Date.now() - Date.parse(stored.nav.at(-1)!.calculated_at) : Number.POSITIVE_INFINITY;
  if (stored && Number.isFinite(age) && age < FRESH_MS) return { stored, computed: null };

  const computed = await compute();
  await persist(db, computed);
  return { stored: await readStored(db, slug), computed };
}

/** Evenly samples a series down to at most `limit` points, always keeping the last. */
export function downsample<T>(points: T[], limit = SPARKLINE_POINTS): T[] {
  if (points.length <= limit) return points;
  const step = (points.length - 1) / (limit - 1);
  const sampled: T[] = [];
  for (let index = 0; index < limit - 1; index++) sampled.push(points[Math.round(index * step)]);
  sampled.push(points.at(-1)!);
  return sampled;
}

export function summarizeStored(stored: Stored): Omit<PortfolioSummary, "persisted" | "stale" | "schema"> {
  const nav = stored.nav;
  const latest = nav.at(-1)!;
  const first = nav.at(0)!;

  let maxDrawdown = 0;
  let maxDrawdownDate: string | null = null;
  for (const row of nav) {
    if (row.drawdown < maxDrawdown) {
      maxDrawdown = row.drawdown;
      maxDrawdownDate = row.trading_date;
    }
  }

  const dailyReturns: number[] = [];
  for (let index = 1; index < nav.length; index++) {
    const prior = nav[index - 1].nav;
    if (prior > 0) dailyReturns.push(nav[index].nav / prior - 1);
  }
  let volatility: number | null = null;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  return {
    slug: stored.portfolio.slug,
    displayName: stored.portfolio.display_name,
    status: stored.portfolio.status,
    inceptionDate: first.trading_date,
    asOfDate: latest.trading_date,
    sessions: nav.length,
    nav: latest.nav,
    cumulativeReturn: latest.nav / first.nav - 1,
    benchmarkLabel: stored.portfolio.benchmark_label,
    benchmarkNav: latest.benchmark_nav,
    benchmarkCumulativeReturn: latest.benchmark_nav / first.nav - 1,
    excessCumulativeReturn: (latest.nav - latest.benchmark_nav) / first.nav,
    highWaterMark: latest.high_water_mark,
    currentDrawdown: latest.drawdown,
    maxDrawdown,
    maxDrawdownDate,
    volatility,
    methodologyVersion: stored.portfolio.methodology_version,
    priceSource: latest.data_source,
    priceDataAsOf: latest.price_data_as_of ?? latest.trading_date,
    lastRebalanceDate: stored.lastRebalanceDate,
    rebalanceCount: stored.rebalanceCount,
    sparkline: downsample(nav.map((row) => ({
      date: row.trading_date,
      nav: row.nav,
      benchmarkNav: row.benchmark_nav,
      drawdown: row.drawdown,
    }))),
    calculatedAt: latest.calculated_at,
    disclosure: PORTFOLIO_DISCLOSURE,
  };
}

/** Derives the same summary shape from an in-memory series, for the no-DB path. */
function summarizeComputed(slug: string, computed: Computed): PortfolioSummary {
  const summary = summarizeNavSeries(computed.points)!;
  return {
    schema: PORTFOLIO_SCHEMA,
    slug,
    displayName: PICK_NY_NAME,
    status: "live",
    inceptionDate: summary.inceptionDate,
    asOfDate: summary.asOfDate,
    sessions: summary.sessions,
    nav: summary.nav,
    cumulativeReturn: summary.cumulativeReturn,
    benchmarkLabel: PORTFOLIO_BENCHMARK_LABEL,
    benchmarkNav: summary.benchmarkNav,
    benchmarkCumulativeReturn: summary.benchmarkCumulativeReturn,
    excessCumulativeReturn: summary.excessCumulativeReturn,
    highWaterMark: summary.highWaterMark,
    currentDrawdown: summary.currentDrawdown,
    maxDrawdown: summary.maxDrawdown,
    maxDrawdownDate: summary.maxDrawdownDate,
    volatility: summary.volatility,
    methodologyVersion: PICK_NY_METHODOLOGY_VERSION,
    priceSource: computed.priceSource,
    priceDataAsOf: summary.asOfDate,
    lastRebalanceDate: null,
    rebalanceCount: 0,
    sparkline: downsample(computed.points.map((point) => ({
      date: point.sessionDate,
      nav: point.nav,
      benchmarkNav: point.benchmarkNav,
      drawdown: point.drawdown,
    }))),
    persisted: false,
    stale: false,
    calculatedAt: new Date().toISOString(),
    disclosure: PORTFOLIO_DISCLOSURE,
  };
}

export async function getPortfolioSummary(slug: string = PICK_NY_SLUG): Promise<PortfolioResult<PortfolioSummary>> {
  const db = getPortfolioD1();
  if (db) {
    try {
      await ensurePortfolioDatabase(db);
    } catch (caught) {
      const { code, error } = readableError(caught);
      return { ok: false, code, error };
    }
  }

  try {
    const { stored, computed } = await loadStored(db, slug);
    if (stored) {
      return { ok: true, value: { schema: PORTFOLIO_SCHEMA, ...summarizeStored(stored), persisted: true, stale: false } };
    }
    return { ok: true, value: summarizeComputed(slug, computed!) };
  } catch (caught) {
    const { code, error } = readableError(caught);
    return { ok: false, code, error };
  }
}

/** Chart series only: date, NAV, benchmark NAV and drawdown. */
export async function getPortfolioHistory(
  slug: string = PICK_NY_SLUG,
  range: string = "SI",
): Promise<PortfolioResult<PortfolioHistoryPoint[]>> {
  const summary = await getPortfolioSummary(slug);
  if (!summary.ok) return summary;

  // Persistence is durability, not a prerequisite for drawing the series: the
  // same deterministic backtest that produces the summary produces the chart,
  // so a missing or unreadable store never blanks the public page.
  const db = getPortfolioD1();
  if (!db) reportPersistenceGap("history");
  if (db) {
    try {
      const stored = await readStored(db, slug);
      if (stored) {
        const all = stored.nav.map((row) => ({
          date: row.trading_date,
          nav: row.nav,
          benchmarkNav: row.benchmark_nav,
          drawdown: row.drawdown,
        }));
        return { ok: true, value: filterRange(all, range, summary.value.asOfDate) };
      }
      reportPersistenceGap("history", "no stored sessions");
    } catch (error) {
      reportPersistenceGap("history", error instanceof Error ? error.message : String(error));
    }
  }

  try {
    const computed = await compute();
    const all = computed.points.map((point) => ({
      date: point.sessionDate,
      nav: point.nav,
      benchmarkNav: point.benchmarkNav,
      drawdown: point.drawdown,
    }));
    return { ok: true, value: filterRange(all, range, summary.value.asOfDate) };
  } catch (caught) {
    const { code, error } = readableError(caught);
    return { ok: false, code, error };
  }
}

export function filterRange(points: PortfolioHistoryPoint[], range: string, asOf: string) {
  if (range === "SI") return points;
  if (range === "YTD") {
    const start = `${Number(asOf.slice(0, 4)) - 1}-12-31`;
    return points.filter((point) => point.date > start);
  }
  const months = range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : 0;
  if (!months) return points;
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const from = cutoff.toISOString().slice(0, 10);
  return points.filter((point) => point.date >= from);
}

type HoldingCore = Omit<PortfolioHoldingRow, "fairValue" | "fvUpsidePct" | "view">;

/** Latest session's positions, enriched with the canonical valuation view. */
export async function getPortfolioHoldings(
  slug: string = PICK_NY_SLUG,
): Promise<PortfolioResult<PortfolioHoldingRow[]>> {
  const rows = await computeHoldings(slug);
  if (!rows.ok) return rows;

  // Fair value comes from the shared cached snapshot so the table can never
  // disagree with the valuation workbench, and no valuation math runs here.
  const valuations = new Map<string, { fairValue: number | null; upsidePct: number | null; view: "BUY" | "WATCH" | "SELL" | null }>();
  try {
    const snapshots = await getInvestmentSnapshots(rows.value.map((row) => row.ticker));
    for (const snapshot of snapshots) {
      const label = String(snapshot.ratingLabel ?? "").toUpperCase();
      valuations.set(snapshot.ticker.toUpperCase(), {
        fairValue: snapshot.fairValue,
        upsidePct: snapshot.upsidePct,
        view:
          label === "STRONG_BUY" || label === "UNDERVALUED" ? "BUY"
          : label === "OVERVALUED" ? "SELL"
          : snapshot.fairValue === null ? null : "WATCH",
      });
    }
  } catch {
    // A valuation outage must not remove the holdings themselves.
  }

  return {
    ok: true,
    value: rows.value.map((row) => {
      const valuation = valuations.get(row.ticker.toUpperCase());
      return {
        ...row,
        fairValue: valuation?.fairValue ?? null,
        fvUpsidePct: valuation?.upsidePct ?? null,
        view: valuation?.view ?? null,
      };
    }),
  };
}

async function computeHoldings(slug: string): Promise<PortfolioResult<HoldingCore[]>> {
  const initialWeight = new Map(PICK_NY_TARGETS.map((target) => [target.ticker, target.weight]));
  const db = getPortfolioD1();
  if (!db) reportPersistenceGap("holdings");

  if (db) {
    try {
      const stored = await readStored(db, slug);
      if (stored) {
        const firstResult = await db
          .prepare(`SELECT ticker, adjusted_close FROM sl_portfolio_daily_holdings
                    WHERE portfolio_id = ?
                      AND trading_date = (SELECT MIN(trading_date) FROM sl_portfolio_daily_holdings WHERE portfolio_id = ?)`)
          .bind(stored.portfolio.id, stored.portfolio.id)
          .all<{ ticker: string; adjusted_close: number }>();
        const initialPrice = new Map((firstResult.results ?? []).map((row) => [row.ticker, row.adjusted_close]));
        return {
          ok: true,
          value: stored.holdings.map((row) => {
            const start = initialPrice.get(row.ticker) ?? 0;
            return {
              ticker: row.ticker,
              initialWeight: initialWeight.get(row.ticker) ?? 0,
              currentWeight: row.portfolio_weight,
              shares: row.shares,
              price: row.adjusted_close,
              returnPct: start > 0 ? row.adjusted_close / start - 1 : 0,
              contributionPoints: row.daily_contribution,
            };
          }),
        };
      }
    } catch {
      // Fall through to the deterministic series below.
    }
  }

  try {
    const computed = await compute();
    const latest = computed.points.at(-1)!;
    const inceptionClose = new Map(computed.points.at(0)!.positions.map((position) => [position.ticker, position.adjustedClose]));
    return {
      ok: true,
      value: computed.holdings.map((holding) => {
        const position = latest.positions.find((candidate) => candidate.ticker === holding.ticker)!;
        const start = inceptionClose.get(holding.ticker) ?? 0;
        return {
          ticker: holding.ticker,
          initialWeight: holding.weight,
          currentWeight: position.weight,
          shares: holding.modelShares,
          price: position.adjustedClose,
          returnPct: start > 0 ? position.adjustedClose / start - 1 : 0,
          contributionPoints: position.contributionPoints,
        };
      }),
    };
  } catch (caught) {
    const { code, error } = readableError(caught);
    return { ok: false, code, error };
  }
}
