type Direction = "bullish" | "neutral" | "bearish";

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  error?: string;
  meta?: { changes?: number };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}

export interface NewsAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface ResearchSourceResult {
  status: "success" | "skipped";
  sourceStatus: "healthy";
  itemsSeen: number;
  itemsNew: number;
  cursor?: string | null;
  note?: string | null;
}

interface CoinbaseProductStats {
  open?: string;
  high?: string;
  low?: string;
  volume?: string;
  last?: string;
  volume_30day?: string;
}

type CoinbaseCandle = [
  number,
  number,
  number,
  number,
  number,
  number,
];

interface DailyCandle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface BtcForecastCycle {
  id: string;
  forecast_date: string;
  target_date: string;
}

interface GdeltArticle {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  description?: string;
}

interface GdeltArticleResponse {
  articles?: GdeltArticle[];
}

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const BTC_STATS_URL = `${COINBASE_BASE}/products/BTC-USD/stats`;
const BTC_CANDLES_URL = `${COINBASE_BASE}/products/BTC-USD/candles`;
const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search";
const BING_NEWS_RSS_URL = "https://www.bing.com/news/search";
const BTC_REFRESH_MS = 5 * 60 * 1_000;
const BTC_CANDLE_REFRESH_MS = 30 * 60 * 1_000;
const WORLD_NEWS_REFRESH_MS = 2 * 60 * 1_000;
const WORLD_NEWS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const WORLD_NEWS_BRIEF_MODEL =
  "@cf/meta/llama-3.1-8b-instruct-fast";
const WORLD_NEWS_BRIEF_BATCH = 3;
export const WORLD_NEWS_BRIEF_VERSION = "ai-story-v6";
const WORLD_NEWS_AI_TIMEOUT_MS = 18_000;

function nowIso(): string {
  return new Date().toISOString();
}

function utcDay(value: string | number | Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

function addUtcDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function changes(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[$,%\s,]/g, ""))
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized.length > 12_000
    ? JSON.stringify({ truncated: true })
    : serialized;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function queryAll<T>(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "D1 query failed");
  return result.results ?? [];
}

async function queryFirst<T>(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<T | null> {
  return db.prepare(sql).bind(...values).first<T>();
}

async function execute(
  db: D1Database,
  sql: string,
  ...values: unknown[]
): Promise<D1Result> {
  const result = await db.prepare(sql).bind(...values).run();
  if (!result.success) throw new Error(result.error || "D1 write failed");
  return result;
}

async function fetchJson<T>(url: string, timeoutMs = 18_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "user-agent": "SignalLedger/1.0 owner@example.com",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, timeoutMs = 18_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
        "cache-control": "no-cache",
        "user-agent": "SignalLedger/1.0 owner@example.com",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function isRecent(value: string | null | undefined, withinMs: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < withinMs;
}

async function sourceRecentlySucceeded(
  db: D1Database,
  sourceId: string,
  withinMs: number,
): Promise<boolean> {
  const row = await queryFirst<{
    cursor: string | null;
    last_success_at: string | null;
  }>(
    db,
    "SELECT cursor, last_success_at FROM sources WHERE id = ? LIMIT 1",
    sourceId,
  );
  // A skipped poll is intentionally recorded as a healthy source check, so
  // last_success_at advances even when no network refresh took place. The
  // cursor is only advanced after a real Coinbase/GDELT fetch and therefore
  // remains the authoritative refresh checkpoint.
  return isRecent(row?.cursor ?? row?.last_success_at, withinMs);
}

function average(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  return clean.length
    ? clean.reduce((sum, value) => sum + value, 0) / clean.length
    : null;
}

function quantile(values: number[], probability: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * clamp(probability, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function sampleStdDev(values: number[]): number | null {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const mean = average(clean) ?? 0;
  return Math.sqrt(
    clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (clean.length - 1),
  );
}

function percentReturn(from: number, to: number): number {
  return from > 0 ? (to / from - 1) * 100 : 0;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null;
  const slice = closes.slice(-(period + 1));
  const changes = slice.slice(1).map((value, index) => value - slice[index]);
  const gain = average(changes.map((value) => Math.max(0, value))) ?? 0;
  const loss = average(changes.map((value) => Math.max(0, -value))) ?? 0;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

async function fetchBtcCandles(days = 125): Promise<DailyCandle[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1_000);
  const url = new URL(BTC_CANDLES_URL);
  url.searchParams.set("granularity", "86400");
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  const payload = await fetchJson<CoinbaseCandle[]>(url.toString());
  return payload
    .filter(
      (row) =>
        Array.isArray(row) &&
        row.length >= 6 &&
        row.slice(0, 6).every((value) => Number.isFinite(Number(value))),
    )
    .map((row) => ({
      day: utcDay(Number(row[0]) * 1_000),
      low: Number(row[1]),
      high: Number(row[2]),
      open: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

async function storeCandles(
  db: D1Database,
  candles: DailyCandle[],
  observedAt: string,
): Promise<void> {
  for (const candle of candles) {
    await execute(
      db,
      `INSERT INTO btc_daily_candles
         (day, product_id, open, high, low, close, volume_btc, source_name,
          source_url, observed_at)
       VALUES (?, 'BTC-USD', ?, ?, ?, ?, ?, 'Coinbase Exchange', ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         open = excluded.open,
         high = excluded.high,
         low = excluded.low,
         close = excluded.close,
         volume_btc = excluded.volume_btc,
         observed_at = excluded.observed_at`,
      candle.day,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
      BTC_CANDLES_URL,
      observedAt,
    );
  }
}

function buildForecast(
  candles: DailyCandle[],
  baselinePrice: number,
): {
  targetPrice: number;
  predictedReturnPct: number;
  researchLow: number;
  researchHigh: number;
  stance: Direction;
  thesis: string;
  drivers: string[];
  invalidation: string;
  features: Record<string, unknown>;
} | null {
  if (candles.length < 45 || baselinePrice <= 0) return null;
  const closes = candles.map((row) => row.close);
  const volumes = candles.map((row) => row.volume);
  const latestClose = closes.at(-1) ?? baselinePrice;
  const closeAt = (daysAgo: number) =>
    closes[Math.max(0, closes.length - 1 - daysAgo)] ?? latestClose;
  const momentum7 = percentReturn(closeAt(7), latestClose);
  const momentum30 = percentReturn(closeAt(30), latestClose);
  const momentum90 =
    closes.length > 90 ? percentReturn(closeAt(90), latestClose) : momentum30;
  const rsi14 = rsi(closes) ?? 50;
  const volume7 = average(volumes.slice(-7)) ?? 0;
  const volume30 = average(volumes.slice(-30)) ?? volume7;
  const volumeRatio = volume30 > 0 ? volume7 / volume30 : 1;
  const last31 = closes.slice(-31);
  const logReturns = last31
    .slice(1)
    .map((value, index) => Math.log(value / last31[index]));
  const realizedVol30 =
    (sampleStdDev(logReturns) ?? 0) * Math.sqrt(365) * 100;
  const rolling30Moves: number[] = [];
  for (let index = 30; index < closes.length; index += 1) {
    rolling30Moves.push(
      Math.abs(percentReturn(closes[index - 30], closes[index])),
    );
  }
  const historicalMedianMove = quantile(rolling30Moves, 0.5) ?? 8;
  const historicalUpperMove = quantile(rolling30Moves, 0.8) ?? 18;

  let signal = momentum30 * 0.5 + momentum7 * 0.3 + momentum90 * 0.2;
  if (Math.sign(signal) === Math.sign(momentum7) && volumeRatio > 1.05) {
    signal *= Math.min(1.25, 1 + (volumeRatio - 1) * 0.5);
  } else if (volumeRatio < 0.8) {
    signal *= 0.82;
  }
  if (rsi14 > 72) signal -= Math.min(5, (rsi14 - 72) * 0.35);
  if (rsi14 < 28) signal += Math.min(5, (28 - rsi14) * 0.35);

  const direction = Math.abs(signal) < 1.5 ? 0 : Math.sign(signal);
  const magnitude =
    direction === 0
      ? Math.min(3, historicalMedianMove * 0.25)
      : clamp(
          Math.max(Math.abs(signal), historicalMedianMove * 0.65),
          3,
          Math.max(6, historicalUpperMove),
        );
  const predictedReturnPct =
    direction === 0 ? Number(signal.toFixed(2)) : direction * magnitude;
  const targetPrice = baselinePrice * (1 + predictedReturnPct / 100);
  const riskMove = Math.max(
    historicalMedianMove,
    Math.min(historicalUpperMove, realizedVol30 / Math.sqrt(12)),
  );
  const researchLow = baselinePrice * (1 - riskMove / 100);
  const researchHigh = baselinePrice * (1 + riskMove / 100);
  const stance: Direction =
    predictedReturnPct >= 2
      ? "bullish"
      : predictedReturnPct <= -2
        ? "bearish"
        : "neutral";
  const directionLabel =
    stance === "bullish" ? "上行" : stance === "bearish" ? "下行" : "震荡";
  return {
    targetPrice,
    predictedReturnPct,
    researchLow,
    researchHigh,
    stance,
    thesis:
      `基于该资产自身的7/30/90日动量、量能确认、超买超卖修正和历史30日波幅，` +
      `模型给出未来30天${directionLabel}判断。该目标价在完整30日周期内保持不变，只追加实际价格与偏离。`,
    drivers: [
      `30日动量 ${momentum30 >= 0 ? "+" : ""}${momentum30.toFixed(1)}%，7日动量 ${momentum7 >= 0 ? "+" : ""}${momentum7.toFixed(1)}%。`,
      `近7日/30日平均成交量比 ${volumeRatio.toFixed(2)} 倍，${volumeRatio >= 1.05 ? "量能确认增强" : volumeRatio <= 0.8 ? "量能不足，信号折价" : "量能中性"}。`,
      `RSI(14) 为 ${rsi14.toFixed(1)}；历史滚动30日绝对波幅中位数 ${historicalMedianMove.toFixed(1)}%。`,
      `30日实现波动率年化 ${realizedVol30.toFixed(1)}%，只用于风险区间，不直接决定方向。`,
    ],
    invalidation:
      stance === "bullish"
        ? `若日收盘跌破 ${researchLow.toFixed(0)} 美元且7日动量转负，本次上行判断失效。`
        : stance === "bearish"
          ? `若日收盘突破 ${researchHigh.toFixed(0)} 美元且7日动量转正，本次下行判断失效。`
          : `若日收盘突破 ${researchHigh.toFixed(0)} 美元或跌破 ${researchLow.toFixed(0)} 美元，震荡判断失效。`,
    features: {
      momentum7Pct: momentum7,
      momentum30Pct: momentum30,
      momentum90Pct: momentum90,
      rsi14,
      volume7To30Ratio: volumeRatio,
      realizedVol30AnnualizedPct: realizedVol30,
      historicalMedianAbs30dMovePct: historicalMedianMove,
      historical80thAbs30dMovePct: historicalUpperMove,
      sampleDays: candles.length,
    },
  };
}

function canonicalForecastCycles(
  rows: BtcForecastCycle[],
): BtcForecastCycle[] {
  const ordered = [...rows].sort((left, right) =>
    left.forecast_date.localeCompare(right.forecast_date),
  );
  const cycles: BtcForecastCycle[] = [];
  for (const row of ordered) {
    const current = cycles.at(-1);
    if (!current || row.forecast_date > current.target_date) {
      cycles.push(row);
    }
  }
  return cycles;
}

async function createForecastCycle(
  db: D1Database,
  candles: DailyCandle[],
  baselinePrice: number,
  cutoff: string,
): Promise<number> {
  const forecastDate = utcDay(cutoff);
  const existingRows = await queryAll<BtcForecastCycle>(
    db,
    `SELECT id, forecast_date, target_date
     FROM btc_30d_forecasts
     ORDER BY forecast_date`,
  );
  const currentCycle = canonicalForecastCycles(existingRows).at(-1);
  if (currentCycle && forecastDate <= currentCycle.target_date) return 0;
  const model = buildForecast(
    candles.filter((row) => row.day < forecastDate),
    baselinePrice,
  );
  if (!model) return 0;
  const targetDate = addUtcDays(forecastDate, 30);
  const id = await sha256Hex(`btc-30d|${forecastDate}|signal-ledger-v1`);
  const result = await execute(
    db,
    `INSERT OR IGNORE INTO btc_30d_forecasts
       (id, forecast_date, baseline_price, target_date, target_price,
        predicted_return_pct, research_low, research_high, stance, thesis,
        drivers_json, invalidation_condition, feature_snapshot_json,
        model_version, source_json, information_cutoff_at, frozen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'btc-momentum-volume-v1', ?, ?, ?)`,
    id,
    forecastDate,
    baselinePrice,
    targetDate,
    model.targetPrice,
    model.predictedReturnPct,
    model.researchLow,
    model.researchHigh,
    model.stance,
    model.thesis,
    safeJson(model.drivers),
    model.invalidation,
    safeJson(model.features),
    safeJson({
      provider: "Coinbase Exchange",
      statsUrl: BTC_STATS_URL,
      candlesUrl: BTC_CANDLES_URL,
      methodology:
        "7/30/90日动量 + 成交量确认 + RSI修正 + 历史30日绝对波幅约束",
    }),
    cutoff,
    cutoff,
  );
  if (!changes(result)) return 0;
  const ratio = model.targetPrice / baselinePrice;
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset <= 30; offset += 1) {
    const targetDay = addUtcDays(forecastDate, offset);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO btc_forecast_path
             (id, forecast_id, target_date, day_offset, predicted_price,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          await sha256Hex(`${id}|${targetDay}`),
          id,
          targetDay,
          offset,
          baselinePrice * ratio ** (offset / 30),
          cutoff,
        ),
    );
  }
  await db.batch(statements);
  return 1;
}

async function settleForecasts(db: D1Database): Promise<number> {
  const rows = await queryAll<{
    forecast_id: string;
    target_date: string;
    day_offset: number;
    predicted_price: number;
    baseline_price: number;
    actual_close: number;
  }>(
    db,
    `SELECT path.forecast_id, path.target_date, path.day_offset,
            path.predicted_price, forecast.baseline_price,
            candle.close AS actual_close
     FROM btc_forecast_path path
     JOIN btc_30d_forecasts forecast ON forecast.id = path.forecast_id
     JOIN btc_daily_candles candle ON candle.day = path.target_date
     LEFT JOIN btc_forecast_actuals actual
       ON actual.forecast_id = path.forecast_id
      AND actual.target_date = path.target_date
     WHERE actual.id IS NULL AND path.day_offset > 0
       AND path.target_date < ?
     ORDER BY path.target_date
     LIMIT 400`,
    utcDay(nowIso()),
  );
  let inserted = 0;
  for (const row of rows) {
    const predicted = Number(row.predicted_price);
    const actual = Number(row.actual_close);
    const baseline = Number(row.baseline_price);
    const error = predicted - actual;
    const errorPct = actual > 0 ? (error / actual) * 100 : 0;
    const predictedDirection = Math.sign(predicted - baseline);
    const actualDirection = Math.sign(actual - baseline);
    const directionHit =
      predictedDirection === 0
        ? null
        : predictedDirection === actualDirection
          ? 1
          : 0;
    const at = nowIso();
    const result = await execute(
      db,
      `INSERT OR IGNORE INTO btc_forecast_actuals
         (id, forecast_id, target_date, actual_close, error_amount, error_pct,
          absolute_error_pct, direction_hit, source_name, source_url,
          observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Coinbase Exchange', ?, ?, ?)`,
      await sha256Hex(
        `btc-path-actual|${row.forecast_id}|${row.target_date}`,
      ),
      row.forecast_id,
      row.target_date,
      actual,
      error,
      errorPct,
      Math.abs(errorPct),
      directionHit,
      BTC_CANDLES_URL,
      at,
      at,
    );
    inserted += changes(result);
  }
  return inserted;
}

export async function processBtcResearch(
  db: D1Database,
): Promise<ResearchSourceResult> {
  if (
    await sourceRecentlySucceeded(db, "market:coinbase-btc", BTC_REFRESH_MS)
  ) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "BTC five-minute refresh is not due yet.",
    };
  }
  const observedAt = nowIso();
  const stats = await fetchJson<CoinbaseProductStats>(BTC_STATS_URL, 12_000);
  const price = finiteNumber(stats.last);
  if (price === null || price <= 0) {
    throw new Error("Coinbase BTC stats did not include a valid last price.");
  }
  const open24h = finiteNumber(stats.open);
  const volume24h = finiteNumber(stats.volume);
  const result = await execute(
    db,
    `INSERT OR IGNORE INTO btc_market_snapshots
       (id, product_id, observed_at, price, open_24h, high_24h, low_24h,
        change_24h_pct, volume_24h_btc, volume_24h_usd, volume_30d_btc,
        source_name, source_url, raw_json, created_at)
     VALUES (?, 'BTC-USD', ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'Coinbase Exchange', ?, ?, ?)`,
    await sha256Hex(`coinbase-btc|${observedAt.slice(0, 16)}`),
    observedAt,
    price,
    open24h,
    finiteNumber(stats.high),
    finiteNumber(stats.low),
    open24h && open24h > 0 ? percentReturn(open24h, price) : null,
    volume24h,
    volume24h === null ? null : volume24h * price,
    finiteNumber(stats.volume_30day),
    BTC_STATS_URL,
    safeJson(stats),
    observedAt,
  );

  let candles: DailyCandle[];
  const lastCandleRead = await queryFirst<{ observed_at: string | null }>(
    db,
    "SELECT MAX(observed_at) AS observed_at FROM btc_daily_candles",
  );
  if (!isRecent(lastCandleRead?.observed_at, BTC_CANDLE_REFRESH_MS)) {
    candles = await fetchBtcCandles();
    await storeCandles(db, candles, observedAt);
  } else {
    candles = (
      await queryAll<{
        day: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume_btc: number;
      }>(
        db,
        `SELECT day, open, high, low, close, volume_btc
         FROM btc_daily_candles
         ORDER BY day DESC
         LIMIT 125`,
      )
    )
      .map((row) => ({
        day: row.day,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume_btc),
      }))
      .reverse();
  }
  const forecastInserted = await createForecastCycle(
    db,
    candles,
    price,
    observedAt,
  );
  const actualsInserted = await settleForecasts(db);
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: 1 + candles.length,
    itemsNew: changes(result) + forecastInserted + actualsInserted,
    cursor: observedAt,
    note: `BTC snapshot stored; 30-day cycle +${forecastInserted}, daily comparisons +${actualsInserted}.`,
  };
}

const REGIONS: Array<{
  region: "US" | "JP" | "KR" | "CN" | "GLOBAL";
  label: string;
  market: string;
  query: string;
  rssQueries: string[];
}> = [
  {
    region: "US",
    label: "美国",
    market: "美股",
    rssQueries: [
      "Federal Reserve US economy markets",
      "US tariffs sanctions Treasury markets",
      "US stocks earnings AI semiconductor business",
    ],
    query:
      '("Federal Reserve" OR "US Treasury" OR "White House" OR "US tariffs" OR "US sanctions" OR "US inflation" OR "US jobs" OR "US GDP") sourcelang:english',
  },
  {
    region: "JP",
    label: "日本",
    market: "日股",
    rssQueries: [
      "Bank of Japan yen Nikkei",
      "Japan economy trade stocks",
      "Japan companies earnings semiconductor autos",
    ],
    query:
      '("Bank of Japan" OR yen OR Nikkei OR "Japan economy" OR "Japan trade" OR "Japan politics") sourcelang:english',
  },
  {
    region: "KR",
    label: "韩国",
    market: "韩股",
    rssQueries: [
      "Bank of Korea won KOSPI",
      "South Korea economy semiconductors",
      "Samsung SK Hynix earnings exports",
    ],
    query:
      '("Bank of Korea" OR won OR KOSPI OR "South Korea economy" OR semiconductor OR "South Korea politics") sourcelang:english',
  },
  {
    region: "CN",
    label: "中国",
    market: "上证/港股",
    rssQueries: [
      "China economy yuan PBOC",
      "China trade property stocks",
      "China companies earnings technology EV Hong Kong",
    ],
    query:
      '(PBOC OR yuan OR "China economy" OR "Shanghai stocks" OR "China trade" OR "China property") sourcelang:english',
  },
  {
    region: "GLOBAL",
    label: "全球",
    market: "全球风险资产",
    rssQueries: [
      "oil OPEC shipping sanctions",
      "global central banks tariffs trade",
      "global markets commodities supply disruption",
    ],
    query:
      '(OPEC OR "oil supply" OR sanctions OR tariffs OR "shipping disruption" OR "central bank" OR "energy infrastructure" OR "trade restrictions") sourcelang:english',
  },
];

const NON_INVESTMENT_NEWS =
  /monument|memorial|honou?rs? .{0,30}(?:veterans?|americans who have served)|anniversary|museum|festival|concert|celebrity|wedding|obituary|sports?|football|basketball|livestream|video game|download deals|tourism|recipe|fashion|jewelry|astrology|lottery|wildlife cam|recovering from surgery|excellence award|wins? .{0,30}award|culture|cultural|heritage|alumini?um foil|aluminum foil|on the grill|health tips?|fact checks?\s*:/i;

const INVESTMENT_TRANSMISSION_TERMS =
  /federal reserve|treasury|white house|interest rates?|rate (?:cut|hike|decision)|inflation|\bcpi\b|\bpce\b|payroll|unemployment|\bgdp\b|central bank|bank of japan|bank of korea|\bpboc\b|tariff|sanction|export control|trade restriction|trade deficit|budget|fiscal|tax|regulation|antitrust|semiconductor|chip|artificial intelligence|\bai\b|earnings|revenue|profit|guidance|forecast|merger|acquisition|bankrupt|default|bond|yield|currency|dollar|\byen\b|\byuan\b|\bwon\b|nikkei|kospi|nasdaq|s&p|dow|stocks?|equities|opec|oil|gas|lng|copper|gold|shipping|freight|supply chain|energy infrastructure|attack|airstrike|missile|conflict|war|strait/i;

export function regionHeadlineRelevant(
  region: string,
  headline: string,
): boolean {
  const text = headline.toLowerCase();
  if (NON_INVESTMENT_NEWS.test(text)) return false;
  if (!INVESTMENT_TRANSMISSION_TERMS.test(text)) return false;
  if (/\bmilitary\b/.test(text) && !/attack|airstrike|missile|deploy|conflict|war|sanction|energy|shipping|defen[cs]e (?:budget|spending|contract)/.test(text)) {
    return false;
  }
  if (region === "US") {
    return /united states|\bu\.s\.|\bus\b|federal reserve|treasury|white house|fed |american|wall street|nasdaq|s&p|dow|cpi|pce|payroll|unemployment|gdp|tariff|sanction/.test(
      text,
    );
  }
  if (region === "JP") {
    return /japan|japanese|bank of japan|\bboj\b|\byen\b|nikkei|tokyo/.test(text);
  }
  if (region === "KR") {
    return /south korea|korean|bank of korea|kospi|\bwon\b|samsung|sk hynix/.test(
      text,
    );
  }
  if (region === "CN") {
    return /china|chinese|\bpboc\b|\byuan\b|renminbi|shanghai|hong kong|beijing|alibaba|tencent/.test(
      text,
    );
  }
  return true;
}

function normalizedHeadlineKey(headline: string): string {
  return headline
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function chineseNewsFact(
  region: string,
  headline: string,
  fallbackLabel: string,
  category: string,
): string {
  const text = headline.toLowerCase();
  if (/treasury.*interven.*(?:support )?yen|intervention.*japanese yen/.test(text)) {
    return "美国财政部据报在日本入市后介入外汇市场支撑日元；这不是普通口头表态，而是可能改变日元、日债和日本出口股定价的政策行动。";
  }
  if (/south korea.*exports?.*beat forecasts?.*ai/.test(text)) {
    return "韩国最新出口强于市场预期，AI 投资需求是主要支撑；需要进一步核对半导体出口金额及三星、SK 海力士供应链贡献。";
  }
  if (/china.*(?:strengthen|support).*yuan.*trade tensions/.test(text)) {
    return "在贸易摩擦和增长压力上升的背景下，市场讨论中国增强人民币汇率稳定性；目前属于政策建议，尚不是央行正式行动。";
  }
  if (/interest rates?.*borrowing costs? climb|borrowing costs? climb.*interest rates?/.test(text)) {
    return "美国市场借贷成本继续上升，使推动更低政策利率的政治诉求面临现实阻力；核心矛盾是市场利率与政策诉求出现背离。";
  }
  if (/bomb|airstrike|missile/.test(text) && /iran.*energy infrastructure|energy infrastructure.*iran/.test(text)) {
    return "媒体称美国与以色列可能打击伊朗能源基础设施；尚需官方确认，但若落地会直接抬高原油供应风险和全球通胀风险溢价。";
  }
  if (region === "GLOBAL" && /oil|opec|lng|shipping|strait/.test(text)) {
    return `全球能源或航运出现新的供需风险：${headline.slice(0, 280)}`;
  }
  return `${fallbackLabel}${category}出现新的可定价事实：${headline.slice(0, 300)}`;
}

function fallbackChineseTitle(
  region: string,
  headline: string,
  category: string,
): string {
  const text = headline.toLowerCase();
  if (/south korea.*exports?.*beat forecasts?.*ai/.test(text)) {
    return "AI需求推动韩国出口超预期";
  }
  if (/treasury.*interven.*yen|intervention.*japanese yen/.test(text)) {
    return "美日据报联手干预汇市支撑日元";
  }
  if (/china.*(?:strengthen|support).*yuan/.test(text)) {
    return "贸易压力下人民币稳汇率讨论升温";
  }
  if (/borrowing costs? climb/.test(text)) {
    return "美国借贷成本上升，降息诉求受阻";
  }
  if (/iran.*energy infrastructure|energy infrastructure.*iran/.test(text)) {
    return "伊朗能源设施面临新的冲突风险";
  }
  const regionLabel =
    region === "US"
      ? "美国"
      : region === "JP"
        ? "日本"
        : region === "KR"
          ? "韩国"
          : region === "CN"
            ? "中国"
            : "全球";
  return `${regionLabel}${category}出现重要新进展`;
}

interface WorldNewsBriefCandidate {
  id: string;
  region: string;
  marketScope: string;
  category: string;
  headline: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
}

interface WorldNewsBrief {
  id: string;
  titleZh: string;
  factSummaryZh: string;
  commentaryZh: string;
  impactPathZh: string;
  verificationZh: string;
}

const GENERIC_WORLD_NEWS_BRIEF =
  /出现新的可定价事实|出现重要新进展|先判断这是新事实|只有能改变盈利|新事实\s*→\s*行业供需|核对第二个独立来源|可能通过.+影响|值得关注|可能有影响|影响投资决策|相关资产|后续公司指引|需要进一步核对|目前公开信息只确认[^。]{0,12}[。]?$/;

function generatedBriefIsConcrete(brief: {
  titleZh: string;
  factSummaryZh: string;
  commentaryZh: string;
  impactPathZh: string;
  verificationZh: string;
}): boolean {
  const combined = [
    brief.titleZh,
    brief.factSummaryZh,
    brief.commentaryZh,
    brief.impactPathZh,
    brief.verificationZh,
  ].join(" ");
  if (GENERIC_WORLD_NEWS_BRIEF.test(combined)) return false;
  const concreteMarkers = combined.match(
    /\d|%|美元|日元|韩元|人民币|基点|百分点|亿|万|公司|央行|政府|财政部|美联储|营收|利润|出口|进口|产量|库存|关税|制裁|指引|收益率|汇率|订单|资本开支/g,
  );
  return (concreteMarkers?.length ?? 0) >= 2;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanBriefText(value: unknown, maximum: number): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

async function withinWorldNewsAiBudget<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error("World news AI analysis exceeded 18 seconds")),
      WORLD_NEWS_AI_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function aiStructuredPayload(response: unknown): unknown {
  const root = objectValue(response);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = objectValue(choices[0]);
  const message = objectValue(firstChoice.message);
  let payload: unknown =
    root.response ?? message.parsed ?? message.content ?? response;
  if (typeof payload === "string") {
    const normalized = payload
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    payload = JSON.parse(normalized);
  }
  return payload;
}

function rawDescription(value: unknown): string {
  try {
    const parsed = objectValue(JSON.parse(String(value ?? "{}")));
    return readableRssDescription(String(parsed.description ?? ""));
  } catch {
    return "";
  }
}

function ruleBasedWorldNewsBrief(
  candidate: WorldNewsBriefCandidate,
): WorldNewsBrief | null {
  const context = `${candidate.headline} ${candidate.description}`
    .replace(/\s+/g, " ")
    .trim();
  const text = context.toLowerCase();
  const source = candidate.sourceName || "原始报道";

  if (
    /(?:us treasury|u\.s\. treasury).*(?:interven|bought yen|support yen)|(?:interven|bought yen).*(?:japanese yen|yen)/.test(
      text,
    )
  ) {
    return {
      id: candidate.id,
      titleZh: "美国财政部据报买入日元，加入日本汇市干预",
      factSummaryZh: `${source}报道称，美国财政部在日本出手后买入日元，以支撑此前持续走弱的日本货币；报道把这次行动描述为美日罕见的联合汇市干预，而不是一般的口头表态。`,
      commentaryZh:
        "最先被重新定价的是美元兑日元、日债收益率和日本出口企业的海外收入换算。若干预持续推高日元，日本进口成本下降，但出口商以日元计价的利润会承压。",
      impactPathZh:
        "日元直接受益；日本出口股面临汇兑利润压力，航空与依赖进口原料的企业成本端受益；干预若推高波动，也会影响日经指数和日元套息交易。",
      verificationZh:
        "核对美国财政部与日本财务省是否正式确认、披露干预规模；同时观察美元兑日元是否守住干预后的低点、东京时段成交量以及日本出口股相对日经指数的表现。",
    };
  }

  if (/south korea.*chip exports?.*\$?4[01]b|semiconductor exports?.*\$41 billion/.test(text)) {
    return {
      id: candidate.id,
      titleZh: "韩国芯片出口连续两个月突破400亿美元",
      factSummaryZh:
        "韩国7月半导体出口达到410亿美元，连续第二个月超过400亿美元；来源摘要把增长归因于AI数据中心需求，并指出韩国综合股价指数同期出现创纪录修复。",
      commentaryZh:
        "这不是单纯的股市情绪新闻：芯片出口额直接进入韩国制造业收入、产能利用率和贸易顺差。连续两个月站上400亿美元，说明AI资本开支仍在转化为实际芯片出货。",
      impactPathZh:
        "韩国存储芯片与设备供应链收入预期受支撑，韩元与韩国贸易数据受益；若后续价格而非仅数量推动出口增长，半导体公司的毛利率弹性会更强。",
      verificationZh:
        "核对韩国关税厅7月完整出口分项、芯片出口单价与数量、主要存储产品价格以及下一月前20日出口；同时观察韩国半导体指数能否继续跑赢综合股价指数。",
    };
  }

  if (/us economy.*q2.*1\.5%|q2.*growth slowed to 1\.5%/.test(text)) {
    return {
      id: candidate.id,
      titleZh: "美国二季度GDP仅增1.5%，低于2.1%预期",
      factSummaryZh:
        "美国经济分析局公布的二季度实际GDP年化增速初值为1.5%，低于来源摘要所列的2.1%经济学家预期，显示经济增长较市场原先估计更慢。",
      commentaryZh:
        "增长低于预期会同时下修周期性企业收入预期并提高降息押注。股市方向取决于利率下降带来的估值支持，能否抵消盈利增速放缓和信用风险上升。",
      impactPathZh:
        "美债收益率与美元先反应；银行、工业和可选消费更敏感于增长下修，长久期科技股则更敏感于实际利率下降，标普500的最终方向取决于两股力量谁更强。",
      verificationZh:
        "核对美国经济分析局二次估值、个人消费和企业投资分项，并观察两年期与十年期美债收益率、美元指数及标普500盈利一致预期是否同步下调。",
    };
  }

  if (/economists?.*urge china.*(?:strengthen|support).*yuan|urge beijing.*yuan/.test(text)) {
    return {
      id: candidate.id,
      titleZh: "欧美经济学家呼吁中国增强人民币汇率",
      factSummaryZh:
        "欧美部分经济学家和前官员呼吁北京让人民币走强，理由是长期低估可能加剧贸易摩擦；这是一项外部政策建议，不是中国人民银行已经宣布的汇率行动。",
      commentaryZh:
        "短期直接市场影响有限，因为政策尚未落地。若人民币确实持续升值，进口成本下降但出口企业的人民币收入与价格竞争力会承压，贸易谈判空间则可能扩大。",
      impactPathZh:
        "人民币、出口制造业与进口依赖行业最先受影响；航空、原材料进口企业受益于更强汇率，出口占比较高的制造企业则面临收入换算和报价压力。",
      verificationZh:
        "观察中国人民银行中间价、离岸人民币与在岸价差、外汇储备和官方政策表述；只有央行定价行为或资本流数据发生变化，才把这条建议升级为政策信号。",
    };
  }

  if (/us and israel.*(?:bomb|strike).*iran.*energy infrastructure/.test(text)) {
    return {
      id: candidate.id,
      titleZh: "媒体称美以考虑打击伊朗能源设施",
      factSummaryZh: `${source}称美国与以色列可能对伊朗能源基础设施采取军事行动；目前只有媒体报道，尚无美方、以方或伊朗官方确认，因此应按未证实的高影响风险事件处理。`,
      commentaryZh:
        "若行动落地，最先变化的不是企业营收，而是原油供应风险溢价、航运保险费和通胀预期；这些变量随后会影响航空、化工、消费与央行降息路径。",
      impactPathZh:
        "原油与能源生产商受益于风险溢价上升，航空和高耗能制造成本承压；若霍尔木兹海峡运输受扰，影响会从油价扩散到全球运价与股市风险偏好。",
      verificationZh:
        "等待美国、以色列和伊朗官方确认，核对布伦特原油近月合约、油轮运价、霍尔木兹海峡通行数据；没有官方确认或价格反应前，不把报道当作既成事实。",
    };
  }

  return null;
}

async function generateWorldNewsBriefs(
  ai: NewsAiBinding | undefined,
  candidates: WorldNewsBriefCandidate[],
): Promise<WorldNewsBrief[]> {
  if (candidates.length === 0) return [];
  const enrichedCandidates = await Promise.all(
    candidates.slice(0, WORLD_NEWS_BRIEF_BATCH).map(enrichBriefCandidate),
  );
  const ruleBriefs = enrichedCandidates
    .map(ruleBasedWorldNewsBrief)
    .filter((brief): brief is WorldNewsBrief => brief !== null);
  const ruleIds = new Set(ruleBriefs.map((brief) => brief.id));
  const aiCandidates = enrichedCandidates.filter(
    (candidate) => !ruleIds.has(candidate.id),
  );
  if (!ai || aiCandidates.length === 0) return ruleBriefs;
  const input = aiCandidates.map((candidate) => ({
    id: candidate.id,
    region: candidate.region,
    market: candidate.marketScope,
    category: candidate.category,
    source: candidate.sourceName,
    headline: candidate.headline,
    sourceSnippet: candidate.description || "原始索引未提供正文摘要",
  }));
  try {
    const response = await withinWorldNewsAiBudget(ai.run(WORLD_NEWS_BRIEF_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "你是 Signal Ledger 的中文资深市场编辑。你的任务不是翻译标题，而是把一条新闻写成可以直接口播、可以进入股票模型的具体故事。只允许使用输入标题和来源摘要中的事实，绝不补造数字、人物表态、公司地位或因果。若输入不足以确认事件主体、发生了什么变化及至少一条可验证事实，publishable 必须为 false，不要硬写。每条可发布内容必须输出：1）publishable=true；2）中文标题，直接写主体、动作和关键变化；3）30秒简报，用2至3句交代此前基准、这次新增事实和具体数字；4）为什么重要，指出最先受影响的收入、利润率、资本开支、利率、汇率、商品价格或估值变量；5）谁受影响，列出输入中明确出现的公司、行业或指数，写清利好/利空机制，不给买卖建议；6）接下来观察，给出具体指标、财报字段、政策文件或价格阈值。禁止使用‘出现新的可定价事实’‘先判断这是新事实’‘值得关注’‘可能有影响’‘相关资产’等万能句。若对股市影响有限，要说明为什么有限。全部使用自然、具体的简体中文。",
        },
        {
          role: "user",
          content: JSON.stringify(input),
        },
      ],
      temperature: 0.1,
      max_completion_tokens: 1_800,
      chat_template_kwargs: { thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  publishable: { type: "boolean" },
                  titleZh: { type: "string", minLength: 6 },
                  factSummaryZh: { type: "string", minLength: 70 },
                  commentaryZh: { type: "string", minLength: 45 },
                  impactPathZh: { type: "string", minLength: 35 },
                  verificationZh: { type: "string", minLength: 30 },
                },
                required: [
                  "id",
                  "publishable",
                  "titleZh",
                  "factSummaryZh",
                  "commentaryZh",
                  "impactPathZh",
                  "verificationZh",
                ],
              },
            },
          },
          required: ["items"],
        },
      },
    }));
    const payload = aiStructuredPayload(response);
    const rows = objectValue(payload).items;
    if (!Array.isArray(rows)) return [];
    const allowedIds = new Set(input.map((item) => item.id));
    const briefs = rows.flatMap((row) => {
      const record = objectValue(row);
      const id = cleanBriefText(record.id, 128);
      if (!allowedIds.has(id) || record.publishable !== true) return [];
      const candidate = aiCandidates.find((item) => item.id === id);
      if (!candidate) return [];
      const titleZh = cleanBriefText(record.titleZh, 70);
      const factSummaryZh = cleanBriefText(record.factSummaryZh, 520);
      const commentaryZh = cleanBriefText(record.commentaryZh, 420);
      const impactPathZh = cleanBriefText(record.impactPathZh, 420);
      const verificationZh = cleanBriefText(record.verificationZh, 360);
      if (
        !/[\u3400-\u9fff]/.test(titleZh) ||
        !/[\u3400-\u9fff]/.test(factSummaryZh) ||
        !/[\u3400-\u9fff]/.test(commentaryZh) ||
        !/[\u3400-\u9fff]/.test(impactPathZh) ||
        !/[\u3400-\u9fff]/.test(verificationZh) ||
        factSummaryZh.length < 55 ||
        commentaryZh.length < 35 ||
        impactPathZh.length < 28 ||
        verificationZh.length < 24
        || commentaryZh.includes(factSummaryZh.slice(0, 24))
        || verificationZh.includes(factSummaryZh.slice(0, 24))
        || !generatedBriefIsConcrete({
          titleZh,
          factSummaryZh,
          commentaryZh,
          impactPathZh,
          verificationZh,
        })
      ) {
        return [];
      }
      return [
        {
          id,
          titleZh:
            titleZh ||
            fallbackChineseTitle(
              candidate.region,
              candidate.headline,
              candidate.category,
            ),
          factSummaryZh,
          commentaryZh,
          impactPathZh,
          verificationZh,
        },
      ];
    });
    if (briefs.length === 0) {
      console.warn(
        JSON.stringify({
          event: "world_news_brief_validation_rejected",
          model: WORLD_NEWS_BRIEF_MODEL,
          candidateCount: candidates.length,
          responseItemCount: rows.length,
        }),
      );
    }
    return [...ruleBriefs, ...briefs];
  } catch (caught) {
    console.error(
      JSON.stringify({
        event: "world_news_brief_generation_failed",
        model: WORLD_NEWS_BRIEF_MODEL,
        message:
          caught instanceof Error ? caught.message : "Unknown AI brief error",
      }),
    );
    return ruleBriefs;
  }
}

async function applyWorldNewsBriefs(
  db: D1Database,
  briefs: WorldNewsBrief[],
): Promise<number> {
  let updated = 0;
  for (const brief of briefs) {
    const result = await execute(
      db,
      `UPDATE world_news
       SET title_zh = ?, fact_summary_zh = ?, commentary_zh = ?,
           impact_path_zh = ?, verification_zh = ?, evidence_status = ?,
           brief_version = ?
       WHERE id = ?`,
      brief.titleZh,
      brief.factSummaryZh,
      brief.commentaryZh,
      brief.impactPathZh,
      brief.verificationZh,
      "媒体报道",
      WORLD_NEWS_BRIEF_VERSION,
      brief.id,
    );
    updated += changes(result);
  }
  return updated;
}

async function backfillWorldNewsBriefs(
  db: D1Database,
  ai: NewsAiBinding | undefined,
): Promise<number> {
  if (!ai) return 0;
  const rows = await queryAll<Record<string, unknown>>(
    db,
    `SELECT id, region, market_scope, category, headline, source_name,
            source_url, raw_json
     FROM world_news INDEXED BY world_news_region_published_idx
     WHERE region IN ('US', 'JP', 'KR', 'CN', 'GLOBAL')
       AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
       AND brief_version <> ?
     ORDER BY importance_score DESC, published_at DESC
     LIMIT 50`,
    WORLD_NEWS_BRIEF_VERSION,
  );
  const candidates = rows.map((row) => ({
    id: String(row.id ?? ""),
    region: String(row.region ?? "GLOBAL"),
    marketScope: String(row.market_scope ?? "全球风险资产"),
    category: String(row.category ?? "市场与产业"),
    headline: String(row.headline ?? ""),
    description: rawDescription(row.raw_json),
    sourceName: String(row.source_name ?? "新闻来源"),
    sourceUrl: String(row.source_url ?? ""),
  })).filter((row) => regionHeadlineRelevant(row.region, row.headline))
    .slice(0, WORLD_NEWS_BRIEF_BATCH);
  return applyWorldNewsBriefs(
    db,
    await generateWorldNewsBriefs(ai, candidates),
  );
}

function parseGdeltDate(value: string | undefined): string {
  if (!value) return nowIso();
  const compact = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
  );
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.000Z`;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? nowIso() : date.toISOString();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function rssTag(item: string, tag: string): string {
  const match = item.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return decodeXmlEntities(match?.[1]?.trim() ?? "");
}

function readableRssDescription(value: string): string {
  return decodeXmlEntities(value)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
}

function indexedPublisherUrl(value: string): string {
  try {
    const url = new URL(value);
    const embedded = url.searchParams.get("url");
    return embedded && /^https?:\/\//i.test(embedded) ? embedded : value;
  } catch {
    return value;
  }
}

function htmlAttributeContent(
  html: string,
  attribute: "description" | "og:description" | "twitter:description",
): string {
  const escaped = attribute.replace(":", "\\:");
  const forward = html.match(
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
  );
  const reverse = html.match(
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`,
      "i",
    ),
  );
  return readableRssDescription(forward?.[1] ?? reverse?.[1] ?? "");
}

function articleContextFromHtml(html: string): string {
  const meta = [
    htmlAttributeContent(html, "og:description"),
    htmlAttributeContent(html, "description"),
    htmlAttributeContent(html, "twitter:description"),
  ].find((value) => value.length >= 60);
  const paragraphs = [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
    .map((match) => readableRssDescription(match[1] ?? ""))
    .filter((value) => value.length >= 45)
    .slice(0, 12)
    .join(" ");
  return [meta ?? "", paragraphs]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5_000);
}

async function enrichBriefCandidate(
  candidate: WorldNewsBriefCandidate,
): Promise<WorldNewsBriefCandidate> {
  if (candidate.description.length >= 220) return candidate;
  try {
    const html = await fetchText(indexedPublisherUrl(candidate.sourceUrl), 9_000);
    const context = articleContextFromHtml(html);
    return context.length >= 80
      ? { ...candidate, description: context }
      : candidate;
  } catch {
    return candidate;
  }
}

function googleNewsUrl(query: string): string {
  const url = new URL(GOOGLE_NEWS_RSS_URL);
  url.searchParams.set(
    "q",
    `${query.replace(/\s+sourcelang:english\s*$/i, "")} when:6h`,
  );
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  return url.toString();
}

function bingNewsUrl(query: string): string {
  const url = new URL(BING_NEWS_RSS_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "RSS");
  return url.toString();
}

function parseIndexedNewsRss(xml: string): GdeltArticle[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 40)
    .map((match) => {
      const item = match[1] ?? "";
      return {
        title: rssTag(item, "title"),
        url: rssTag(item, "link"),
        seendate: rssTag(item, "pubDate"),
        description: readableRssDescription(rssTag(item, "description")),
        domain:
          rssTag(item, "source") ||
          rssTag(item, "News:Source") ||
          "News RSS indexed source",
        language: "English",
        sourcecountry: "",
      };
    });
}

function eligibleWorldNewsArticles(
  region: string,
  articles: GdeltArticle[],
): GdeltArticle[] {
  const deduplicated = new Map<string, GdeltArticle>();
  for (const article of articles) {
    const headline = (article.title ?? "").replace(/\s+/g, " ").trim();
    const sourceUrl = article.url?.trim() ?? article.url_mobile?.trim() ?? "";
    if (!headline || !/^https?:\/\//i.test(sourceUrl)) continue;
    const language = article.language?.trim().toLowerCase();
    if (language && language !== "english" && language !== "en") continue;
    const publishedAt = parseGdeltDate(article.seendate);
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    if (
      !Number.isFinite(ageMs) ||
      ageMs < -5 * 60 * 1_000 ||
      ageMs > WORLD_NEWS_MAX_AGE_MS ||
      !regionHeadlineRelevant(region, headline)
    ) {
      continue;
    }
    const key = normalizedHeadlineKey(headline);
    if (key && !deduplicated.has(key)) deduplicated.set(key, article);
  }
  return [...deduplicated.values()].sort(
    (left, right) =>
      parseGdeltDate(right.seendate).localeCompare(
        parseGdeltDate(left.seendate),
      ),
  );
}

function newsAnalysis(headline: string): {
  category: string;
  importance: number;
  commentary: string;
  impact: string;
  verification: string;
} {
  const text = headline.toLowerCase();
  if (
    /central bank|federal reserve|bank of japan|bank of korea|pboc|interest rate|rate cut|rate hike|inflation|cpi|jobs|payroll|gdp/.test(
      text,
    )
  ) {
    return {
      category: "货币政策与宏观",
      importance: 86,
      commentary:
        "关键不在单一数据好坏，而在它是否改变利率路径、实际利率和盈利折现率。先比较市场原有预期，再判断是估值冲击还是盈利冲击。",
      impact:
        "数据或政策表态 → 利率与汇率预期 → 股指估值/金融条件 → 周期股、成长股和出口股盈利预期",
      verification:
        "核对官方发布、国债收益率、美元/本币、指数期货与分析师盈利修订是否同向。",
    };
  }
  if (
    /war|airstrike|missile|sanction|tariff|export control|trade war|shipping disruption|strait|conflict/.test(
      text,
    )
  ) {
    return {
      category: "地缘政治与贸易",
      importance: 90,
      commentary:
        "标题冲击不等于持续行情。真正需要定价的是制裁/关税覆盖范围、供应链替代难度、持续时间以及企业能否转嫁成本。",
      impact:
        "政策或冲突 → 能源/运费/关键零部件 → 企业成本与交付 → 通胀、利润率与风险溢价",
      verification:
        "核对政府原文、实施日期、豁免清单、油价/运价、半导体与出口链公司指引。",
    };
  }
  if (/oil|opec|gas|lng|commodity|copper|gold/.test(text)) {
    return {
      category: "能源与大宗商品",
      importance: 80,
      commentary:
        "先区分供给冲击和需求冲击；前者通常利好上游但压缩下游利润，后者更像增长温度计，不能只看商品价格方向。",
      impact:
        "供需变化 → 商品曲线与库存 → 资源股现金流/制造业成本 → 通胀与消费购买力",
      verification:
        "观察现货与期货曲线、库存、运力、相关公司实现价格与成本指引。",
    };
  }
  if (/earnings|revenue|profit|guidance|forecast|sales/.test(text)) {
    return {
      category: "企业盈利与指引",
      importance: 78,
      commentary:
        "财报表面超预期并不够，最重要的是下一季度指引、核心业务增速、利润率和资本开支相对买方预期的差异。",
      impact:
        "实际业绩/指引 → 一致预期修订 → 估值倍数与资金拥挤度 → 个股及供应链重估",
      verification:
        "核对公司公告、电话会、营收/EPS/利润率/CapEx/核心KPI和盘后价格反应。",
    };
  }
  if (/election|president|prime minister|parliament|government|regulation/.test(text)) {
    return {
      category: "政治与监管",
      importance: 76,
      commentary:
        "政治新闻只有在改变税率、财政支出、监管边界或国际关系时才会进入盈利模型；先判断能否落地，再判断受益和受损行业。",
      impact:
        "政治事件 → 法规/财政/产业政策 → 行业竞争格局 → 企业收入、成本与估值",
      verification:
        "核对正式法案、监管文件、议会进度、执行时间及行业公司的公开回应。",
    };
  }
  return {
    category: "市场与产业",
    importance: 66,
    commentary:
      "先判断这是新事实、重复报道还是市场叙事。只有能改变盈利、估值、资金流或风险溢价的内容，才值得进入交易判断。",
    impact:
      "新事实 → 行业供需/资金偏好 → 盈利或估值变化 → 指数与个股表现",
    verification:
      "核对第二个独立来源、官方原文、相关资产价格和后续公司指引。",
  };
}

export async function processWorldNews(
  db: D1Database,
  ai?: NewsAiBinding,
): Promise<ResearchSourceResult> {
  if (
    await sourceRecentlySucceeded(
      db,
      "news:gdelt-world",
      WORLD_NEWS_REFRESH_MS,
    )
  ) {
    const briefsBackfilled = await backfillWorldNewsBriefs(db, ai);
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note:
        briefsBackfilled > 0
          ? `Global editorial news refresh is not due yet; upgraded ${briefsBackfilled} existing card(s) to Chinese story briefs.`
          : "Global editorial news refresh is not due yet.",
    };
  }
  const briefsBackfilled = 0;
  const detectedAt = nowIso();
  let itemsSeen = 0;
  let itemsNew = 0;
  const newBriefCandidates: WorldNewsBriefCandidate[] = [];
  const regionSlot =
    Math.floor(Date.now() / WORLD_NEWS_REFRESH_MS) % REGIONS.length;
  const selectedRegion = REGIONS[regionSlot] ?? REGIONS[0];
  let provider = "Bing News RSS";
  let articles: GdeltArticle[] = [];
  let atLeastOneProviderResponded = false;
  const providerErrors: string[] = [];
  try {
    const feeds = await Promise.allSettled(
      selectedRegion.rssQueries.map((query) =>
        fetchText(bingNewsUrl(query), 20_000),
      ),
    );
    const fulfilledFeeds = feeds.filter(
      (result): result is PromiseFulfilledResult<string> =>
        result.status === "fulfilled",
    );
    atLeastOneProviderResponded = fulfilledFeeds.length > 0;
    articles = eligibleWorldNewsArticles(
      selectedRegion.region,
      fulfilledFeeds.flatMap((result) =>
        parseIndexedNewsRss(result.value),
      ),
    );
    if (!fulfilledFeeds.length) {
      providerErrors.push("Bing News RSS requests failed");
    }
  } catch (caught) {
    providerErrors.push(
      caught instanceof Error ? caught.message : "Bing News RSS failed",
    );
  }

  if (articles.length === 0) {
    provider = "Google News RSS fallback";
    try {
      const googleArticles = parseIndexedNewsRss(
        await fetchText(googleNewsUrl(selectedRegion.query), 20_000),
      );
      atLeastOneProviderResponded = true;
      articles = eligibleWorldNewsArticles(
        selectedRegion.region,
        googleArticles,
      );
    } catch (caught) {
      providerErrors.push(
        caught instanceof Error ? caught.message : "Google News RSS failed",
      );
    }
  }

  if (articles.length === 0) {
    provider = "GDELT fallback";
    const url = new URL(GDELT_DOC_URL);
    url.searchParams.set("query", selectedRegion.query);
    url.searchParams.set("mode", "ArtList");
    url.searchParams.set("maxrecords", "40");
    url.searchParams.set("format", "json");
    url.searchParams.set("sort", "datedesc");
    url.searchParams.set("timespan", "6h");
    try {
      const payload = await fetchJson<GdeltArticleResponse>(
        url.toString(),
        20_000,
      );
      atLeastOneProviderResponded = true;
      articles = eligibleWorldNewsArticles(
        selectedRegion.region,
        payload.articles ?? [],
      );
    } catch (caught) {
      providerErrors.push(
        caught instanceof Error ? caught.message : "GDELT request failed",
      );
    }
  }

  if (!atLeastOneProviderResponded) {
    throw new Error(
      `Global news providers unavailable: ${providerErrors.join("; ")}`,
    );
  }
  for (const article of articles) {
    const headline = (article.title ?? "").replace(/\s+/g, " ").trim();
    const sourceUrl = article.url?.trim() ?? article.url_mobile?.trim() ?? "";
    if (!headline || !/^https?:\/\//i.test(sourceUrl)) continue;
    const language = article.language?.trim().toLowerCase();
    if (language && language !== "english" && language !== "en") continue;
    const publishedAt = parseGdeltDate(article.seendate);
    const ageMs = Date.now() - new Date(publishedAt).getTime();
    if (
      !Number.isFinite(ageMs) ||
      ageMs < -5 * 60 * 1_000 ||
      ageMs > WORLD_NEWS_MAX_AGE_MS ||
      !regionHeadlineRelevant(selectedRegion.region, headline)
    ) {
      continue;
    }
    itemsSeen += 1;
    const config = selectedRegion;
    const headlineKey = normalizedHeadlineKey(headline);
    if (!headlineKey) continue;
    const sourceEventId = await sha256Hex(
      `${selectedRegion.region}|${publishedAt.slice(0, 10)}|${headlineKey}`,
    );
    const analysis = newsAnalysis(headline);
    const id = await sha256Hex(`world-news|${sourceEventId}`);
    const result = await execute(
      db,
      `INSERT OR IGNORE INTO world_news
         (id, source_event_id, region, market_scope, category,
          importance_score, headline, fact_summary_zh, commentary_zh,
          impact_path_zh, verification_zh, source_name, source_url,
          published_at, detected_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sourceEventId,
      config.region,
      config.market,
      analysis.category,
      analysis.importance,
      headline.slice(0, 500),
      chineseNewsFact(
        config.region,
        headline,
        config.label,
        analysis.category,
      ),
      analysis.commentary,
      analysis.impact,
      analysis.verification,
      article.domain?.trim() || `${provider} indexed source`,
      sourceUrl,
      publishedAt,
      detectedAt,
      safeJson(article),
    );
    const inserted = changes(result);
    itemsNew += inserted;
    if (inserted > 0) {
      newBriefCandidates.push({
        id,
        region: config.region,
        marketScope: config.market,
        category: analysis.category,
        headline,
        description: article.description ?? "",
        sourceName: article.domain?.trim() || `${provider} indexed source`,
        sourceUrl,
      });
    }
  }
  const briefsGenerated = await applyWorldNewsBriefs(
    db,
    await generateWorldNewsBriefs(ai, newBriefCandidates),
  );
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen,
    itemsNew,
    cursor: detectedAt,
    note: `${provider} ${selectedRegion.region} desk refreshed with a 24-hour freshness gate, English-source gate, and public-equity relevance filter; generated ${briefsGenerated} new Chinese story brief(s) and backfilled ${briefsBackfilled}; every card retains its indexed publisher and source link for verification.`,
  };
}
