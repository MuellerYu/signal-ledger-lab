/**
 * Signal Ledger PICK-NY is a public research model portfolio. It is not a
 * brokerage account and not investment advice. Model shares are set once at
 * inception and held; the portfolio never rebalances until an explicit
 * rebalance event is published.
 *
 * Everything here is pure arithmetic over adjusted daily closes so the whole
 * calculation can be reproduced and tested without a network call.
 */

export const PICK_NY_PORTFOLIO_ID = "pick-ny";
export const PICK_NY_SLUG = "ny";
export const PICK_NY_NAME = "Signal Ledger Pick-NY";
export const PICK_NY_METHODOLOGY_VERSION = "pick-ny-v1";
export const PICK_NY_REQUESTED_START = "2026-01-01";
export const PICK_NY_INITIAL_NAV = 100;
export const PICK_NY_BENCHMARK_SYMBOL = "SPY";
export const PICK_NY_PRICE_FEED = "iex";

export type PickNyTarget = { ticker: string; weight: number };

/** Target weights of the initial NAV. They sum to 1 and are never rewritten. */
export const PICK_NY_TARGETS: readonly PickNyTarget[] = Object.freeze([
  { ticker: "SOXL", weight: 0.2 },
  { ticker: "ORCL", weight: 0.2 },
  { ticker: "MSTR", weight: 0.2 },
  { ticker: "TSLA", weight: 0.2 },
  { ticker: "AMD", weight: 0.1 },
  { ticker: "ASTS", weight: 0.1 },
]);

export function pickNyTickers(targets: readonly PickNyTarget[] = PICK_NY_TARGETS) {
  return targets.map((target) => target.ticker);
}

/** Published picks. Only Pick-NY exists today; the index is built to grow. */
export const PORTFOLIO_INDEX = Object.freeze([
  {
    slug: PICK_NY_SLUG,
    displayName: PICK_NY_NAME,
    subtitle: "New York Model Portfolio",
    status: "live",
  },
]);

export function isKnownPortfolio(slug: string) {
  return PORTFOLIO_INDEX.some((entry) => entry.slug === slug);
}

/** Adjusted closes by ticker, then by ISO session date. */
export type AdjustedBarMap = Map<string, Map<string, number>>;

export type PickNyHolding = {
  ticker: string;
  weight: number;
  inceptionPrice: number;
  /** Fractional model shares: initial NAV × weight ÷ adjusted inception close. */
  modelShares: number;
};

export type PickNyPositionPoint = {
  ticker: string;
  adjustedClose: number;
  marketValue: number;
  weight: number;
  /** Adjusted-close return for this session; null on the inception row. */
  dailyReturn: number | null;
  /** Points of NAV added by this position on this session. */
  dailyContribution: number;
  /** Points of NAV return this position has contributed since inception. */
  contributionPoints: number;
};

export type PickNyNavPoint = {
  sessionDate: string;
  nav: number;
  dailyReturn: number | null;
  cumulativeReturn: number;
  benchmarkNav: number;
  benchmarkDailyReturn: number | null;
  benchmarkCumulativeReturn: number;
  /** Portfolio cumulative return minus benchmark cumulative return. */
  excessCumulativeReturn: number;
  highWaterMark: number;
  /** nav / highWaterMark - 1, so this is always <= 0. */
  drawdown: number;
  positions: PickNyPositionPoint[];
};

export type PickNySummary = {
  inceptionDate: string;
  asOfDate: string;
  sessions: number;
  nav: number;
  cumulativeReturn: number;
  benchmarkNav: number;
  benchmarkCumulativeReturn: number;
  excessCumulativeReturn: number;
  highWaterMark: number;
  currentDrawdown: number;
  maxDrawdown: number;
  maxDrawdownDate: string | null;
  /** Annualized standard deviation of daily returns; null until two returns exist. */
  volatility: number | null;
  contributions: PickNyPositionPoint[];
};

function sortedSessions(series: Map<string, number>) {
  return [...series.keys()].sort();
}

/**
 * The first US session on or after the requested start date where the benchmark
 * and every holding actually traded, so each position can be bought at a real
 * adjusted close. Returns null when the history does not reach that far.
 */
export function resolveInceptionSession(
  bars: AdjustedBarMap,
  benchmark: Map<string, number>,
  requestedStart: string = PICK_NY_REQUESTED_START,
  tickers: readonly string[] = pickNyTickers(),
): string | null {
  const candidates = sortedSessions(benchmark).filter((date) => date >= requestedStart);
  for (const date of candidates) {
    const close = benchmark.get(date);
    if (!(typeof close === "number" && close > 0)) continue;
    if (tickers.every((ticker) => {
      const price = bars.get(ticker)?.get(date);
      return typeof price === "number" && price > 0;
    })) return date;
  }
  return null;
}

export function buildHoldings(
  bars: AdjustedBarMap,
  inceptionDate: string,
  initialNav: number = PICK_NY_INITIAL_NAV,
  targets: readonly PickNyTarget[] = PICK_NY_TARGETS,
): PickNyHolding[] {
  return targets.map(({ ticker, weight }) => {
    const inceptionPrice = bars.get(ticker)?.get(inceptionDate);
    if (!(typeof inceptionPrice === "number" && inceptionPrice > 0)) {
      throw new Error(`No adjusted close for ${ticker} on ${inceptionDate}.`);
    }
    return {
      ticker,
      weight,
      inceptionPrice,
      modelShares: (initialNav * weight) / inceptionPrice,
    };
  });
}

/**
 * Daily NAV from a fixed share count. A holding with no bar on a session is
 * carried at its last observed adjusted close rather than dropped, so a halt
 * does not silently change the portfolio's exposure.
 */
export function computeNavSeries(
  holdings: PickNyHolding[],
  bars: AdjustedBarMap,
  benchmark: Map<string, number>,
  inceptionDate: string,
  options: { initialNav?: number; modelCash?: number } = {},
): PickNyNavPoint[] {
  const initialNav = options.initialNav ?? PICK_NY_INITIAL_NAV;
  const modelCash = options.modelCash ?? 0;
  const benchmarkInception = benchmark.get(inceptionDate);
  if (!(typeof benchmarkInception === "number" && benchmarkInception > 0)) {
    throw new Error(`No benchmark close on ${inceptionDate}.`);
  }

  const sessions = sortedSessions(benchmark).filter((date) => date >= inceptionDate);
  const lastClose = new Map(holdings.map((holding) => [holding.ticker, holding.inceptionPrice]));
  const points: PickNyNavPoint[] = [];
  // The inception session has no prior NAV, so its return is unset rather than 0.
  let previousNav: number | null = null;
  let previousBenchmarkNav: number | null = null;
  let highWaterMark = initialNav + modelCash;

  for (const sessionDate of sessions) {
    const positions: PickNyPositionPoint[] = [];
    let nav = modelCash;

    for (const holding of holdings) {
      const close = bars.get(holding.ticker)?.get(sessionDate) ?? lastClose.get(holding.ticker)!;
      const priorClose = lastClose.get(holding.ticker)!;
      lastClose.set(holding.ticker, close);
      const marketValue = holding.modelShares * close;
      nav += marketValue;
      positions.push({
        ticker: holding.ticker,
        adjustedClose: close,
        marketValue,
        weight: 0,
        dailyReturn: priorClose > 0 ? close / priorClose - 1 : null,
        dailyContribution: (holding.modelShares * (close - priorClose) / initialNav) * 100,
        contributionPoints: 0,
      });
    }

    holdings.forEach((holding, index) => {
      const position = positions[index];
      position.weight = nav > 0 ? position.marketValue / nav : 0;
      position.contributionPoints =
        ((position.marketValue - holding.modelShares * holding.inceptionPrice) / initialNav) * 100;
    });

    highWaterMark = Math.max(highWaterMark, nav);
    const benchmarkNav = initialNav * (benchmark.get(sessionDate)! / benchmarkInception);
    points.push({
      sessionDate,
      nav,
      dailyReturn: previousNav !== null && previousNav > 0 ? nav / previousNav - 1 : null,
      cumulativeReturn: nav / initialNav - 1,
      benchmarkNav,
      benchmarkDailyReturn:
        previousBenchmarkNav !== null && previousBenchmarkNav > 0 ? benchmarkNav / previousBenchmarkNav - 1 : null,
      benchmarkCumulativeReturn: benchmarkNav / initialNav - 1,
      excessCumulativeReturn: (nav - benchmarkNav) / initialNav,
      highWaterMark,
      drawdown: highWaterMark > 0 ? nav / highWaterMark - 1 : 0,
      positions,
    });
    previousNav = nav;
    previousBenchmarkNav = benchmarkNav;
  }

  return points;
}

const TRADING_DAYS_PER_YEAR = 252;

/** Latest session plus the risk and contribution figures the panel renders. */
export function summarizeNavSeries(points: PickNyNavPoint[]): PickNySummary | null {
  const latest = points.at(-1);
  const first = points.at(0);
  if (!latest || !first) return null;

  let maxDrawdown = 0;
  let maxDrawdownDate: string | null = null;
  for (const point of points) {
    if (point.drawdown < maxDrawdown) {
      maxDrawdown = point.drawdown;
      maxDrawdownDate = point.sessionDate;
    }
  }

  const dailyReturns = points.map((point) => point.dailyReturn).filter((value): value is number => value !== null);
  let volatility: number | null = null;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1);
    volatility = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }

  return {
    inceptionDate: first.sessionDate,
    asOfDate: latest.sessionDate,
    sessions: points.length,
    nav: latest.nav,
    cumulativeReturn: latest.cumulativeReturn,
    benchmarkNav: latest.benchmarkNav,
    benchmarkCumulativeReturn: latest.benchmarkCumulativeReturn,
    excessCumulativeReturn: latest.excessCumulativeReturn,
    highWaterMark: latest.highWaterMark,
    currentDrawdown: latest.drawdown,
    maxDrawdown,
    maxDrawdownDate,
    volatility,
    contributions: [...latest.positions].sort((left, right) => right.contributionPoints - left.contributionPoints),
  };
}
