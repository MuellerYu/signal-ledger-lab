import { getBindings } from "./runtime";
import { PICK_NY_PRICE_FEED, type AdjustedBarMap } from "./pick-ny";

/**
 * Adjusted daily closes from Alpaca. `adjustment=all` is what makes this series
 * usable for a held-portfolio return: splits, reverse splits and cash
 * distributions are already reflected in the printed close, so a raw unadjusted
 * close is never used.
 *
 * Equities and crypto live behind different endpoints and different symbol
 * spellings, so they are never batched together: the equity endpoint answers
 * `invalid symbol: BTC-USD` for a crypto pair, and one rejected symbol fails
 * the entire request, which would take every equity down with it.
 */

const DATA_BASE = "https://data.alpaca.markets";
const STOCK_BARS_PATH = "/v2/stocks/bars";
const CRYPTO_BARS_PATH = "/v1beta3/crypto/us/bars";
const PAGE_LIMIT = 10_000;
const MAX_SYMBOLS_PER_REQUEST = 50;
const CACHE_MS = 15 * 60 * 1_000;

export type BarFeed = "iex" | "sip";

type AlpacaBar = { t?: string; c?: number };

export type BarTimeframe = "1Day" | "1Hour" | "30Min" | "15Min";
type AlpacaBarsResponse = { bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null };

const cache = new Map<string, { expiresAt: number; value: Promise<AdjustedBarMap> }>();

function credentials() {
  const bindings = getBindings();
  const key = bindings.ALPACA_API_KEY_ID?.trim();
  const secret = bindings.ALPACA_API_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error("ALPACA_BARS_NOT_CONFIGURED");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, accept: "application/json" };
}

async function alpacaJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { headers: credentials(), cache: "no-store", signal: controller.signal });
    if (!response.ok) {
      // The provider's message is what distinguishes a rejected symbol from a
      // malformed request, so it travels with the status.
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`ALPACA_BARS_${response.status}|${body}`);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** The feed the deployment is allowed to read. Free plans are limited to IEX. */
export function configuredFeed(): BarFeed {
  const configured = getBindings().ALPACA_DATA_FEED?.trim().toLowerCase();
  return configured === "sip" ? "sip" : PICK_NY_PRICE_FEED;
}

export function normalizeBarSymbol(value: unknown) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Crypto pairs are quoted as `BTC/USD` while the universe spells them
 * `BTC-USD`, and they are served by the crypto endpoint rather than the equity
 * one.
 *
 * A bare "-" is not enough to call something crypto: equity class shares are
 * spelled the same way (`BRK-B`, `BF-B`). The split is only safe when both
 * halves are recognisable — a known crypto base and a known quote asset.
 */
const CRYPTO_BASES = new Set([
  "AAVE", "ADA", "ALGO", "ATOM", "AVAX", "BAT", "BCH", "BTC", "COMP", "CRV",
  "DOGE", "DOT", "ETC", "ETH", "FIL", "GRT", "LINK", "LTC", "MATIC", "MKR",
  "SHIB", "SOL", "SUSHI", "UNI", "USDC", "USDT", "XTZ", "YFI",
]);
const CRYPTO_QUOTES = new Set(["USD", "USDT", "USDC", "EUR", "GBP", "AUD", "JPY", "CAD", "CHF"]);

export function isCryptoSymbol(symbol: string) {
  const pair = /^([A-Z0-9]+)[-/]([A-Z0-9]+)$/.exec(symbol);
  if (!pair) return false;
  return CRYPTO_BASES.has(pair[1]) && CRYPTO_QUOTES.has(pair[2]);
}

const toCryptoPair = (symbol: string) => symbol.replace("-", "/");
const fromCryptoPair = (symbol: string) => symbol.replace("/", "-");

/** Intraday closes keyed by ticker, then by ISO timestamp. */
export type IntradayBarMap = Map<string, Map<string, number>>;

type LoadContext = { start: string; end?: string; feed: BarFeed; timeframe: BarTimeframe };

/** One page-set for one chunk of symbols on the endpoint that owns them. */
async function requestChunk(
  chunk: string[],
  crypto: boolean,
  ctx: LoadContext,
  ingest: (symbol: string, bars: AlpacaBar[]) => void,
): Promise<void> {
  let pageToken: string | null = null;
  do {
    const url = new URL(crypto ? CRYPTO_BARS_PATH : STOCK_BARS_PATH, DATA_BASE);
    url.searchParams.set("symbols", crypto ? chunk.map(toCryptoPair).join(",") : chunk.join(","));
    url.searchParams.set("timeframe", ctx.timeframe);
    url.searchParams.set("start", ctx.start);
    if (ctx.end) url.searchParams.set("end", ctx.end);
    // Crypto takes neither an adjustment nor a venue feed.
    if (!crypto) {
      url.searchParams.set("adjustment", "all");
      url.searchParams.set("feed", ctx.feed);
    }
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const payload = await alpacaJson<AlpacaBarsResponse>(url.toString());
    for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
      ingest(crypto ? fromCryptoPair(normalizeBarSymbol(symbol)) : normalizeBarSymbol(symbol), bars ?? []);
    }
    pageToken = payload.next_page_token ?? null;
  } while (pageToken);
}

/**
 * Loads a chunk, and on a *symbol* rejection splits it so a single bad symbol
 * costs only itself. Bisecting terminates at one symbol, so the extra requests
 * stay logarithmic in the chunk size.
 *
 * Only a rejected symbol justifies the split. Splitting on any client error
 * would turn a malformed request — an out-of-range date, say — into one request
 * per symbol and exhaust the invocation's subrequest budget, which reads as a
 * provider outage when it is really a bad query. Server errors are never split.
 */
async function loadChunk(
  chunk: string[],
  crypto: boolean,
  ctx: LoadContext,
  ingest: (symbol: string, bars: AlpacaBar[]) => void,
  rejected: string[],
): Promise<void> {
  try {
    await requestChunk(chunk, crypto, ctx, ingest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const parsed = /^ALPACA_BARS_(\d+)\|([\s\S]*)$/.exec(message);
    const status = parsed ? Number(parsed[1]) : Number.NaN;
    const body = parsed ? parsed[2] : "";
    const symbolRejected = Number.isFinite(status) && status >= 400 && status < 500 && /invalid symbol|invalid_symbol/i.test(body);

    if (chunk.length === 1 && symbolRejected) {
      rejected.push(chunk[0]);
      return;
    }
    if (chunk.length > 1 && symbolRejected) {
      const mid = Math.ceil(chunk.length / 2);
      await loadChunk(chunk.slice(0, mid), crypto, ctx, ingest, rejected);
      await loadChunk(chunk.slice(mid), crypto, ctx, ingest, rejected);
      return;
    }
    throw error;
  }
}

/** Populates `result` from both endpoints, equities first then crypto. */
async function loadBars(
  symbols: string[],
  ctx: LoadContext,
  keyOf: (stamp: string) => string | null,
): Promise<AdjustedBarMap> {
  const result: AdjustedBarMap = new Map(symbols.map((symbol) => [symbol, new Map<string, number>()]));
  const ingest = (symbol: string, bars: AlpacaBar[]) => {
    const series = result.get(symbol);
    if (!series) return;
    for (const bar of bars) {
      const key = keyOf(String(bar.t ?? ""));
      const close = Number(bar.c);
      if (key && Number.isFinite(close) && close > 0) series.set(key, close);
    }
  };

  const rejected: string[] = [];
  for (const [group, crypto] of [
    [symbols.filter((symbol) => !isCryptoSymbol(symbol)), false],
    [symbols.filter(isCryptoSymbol), true],
  ] as const) {
    for (let index = 0; index < group.length; index += MAX_SYMBOLS_PER_REQUEST) {
      await loadChunk(group.slice(index, index + MAX_SYMBOLS_PER_REQUEST), crypto, ctx, ingest, rejected);
    }
  }

  // A symbol the venue does not serve simply has no series; it must never be
  // mistaken for a flat return.
  for (const symbol of rejected) result.get(symbol)?.clear();
  return result;
}

/** The cache is process-wide, so tests need an explicit way to reset it. */
export function resetBarCache() {
  cache.clear();
}

/**
 * Split- and distribution-adjusted daily closes, keyed by ticker then session.
 * Throws when Alpaca is not configured so the caller can report an honest
 * "unavailable" state instead of an empty series that looks like a flat return.
 */
export async function fetchDailyAdjustedBars(
  tickers: string[],
  options: { start: string; end?: string; feed?: BarFeed; timeframe?: BarTimeframe } = { start: "" },
): Promise<AdjustedBarMap> {
  const symbols = [...new Set(tickers.map(normalizeBarSymbol).filter(Boolean))];
  if (!symbols.length) return new Map();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.start)) throw new Error("A start date is required for adjusted daily bars.");

  const ctx: LoadContext = {
    start: options.start,
    end: options.end,
    feed: options.feed ?? configuredFeed(),
    timeframe: options.timeframe ?? "1Day",
  };
  const key = [symbols.join(","), ctx.start, ctx.end ?? "", ctx.feed, ctx.timeframe].join("|");
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = loadBars(symbols, ctx, (stamp) => (/^\d{4}-\d{2}-\d{2}$/.test(stamp.slice(0, 10)) ? stamp.slice(0, 10) : null));
  cache.set(key, { expiresAt: now + CACHE_MS, value });
  value.catch(() => cache.delete(key));
  return value;
}

/**
 * Intraday closes with their full UTC timestamp, so a session can be read at
 * 13:00, 14:00, 15:00 and the close rather than only end to end. Only `1Day`
 * collapses to a session date.
 *
 * Alpaca stamps a bar with the START of its period, so a bar stamped 19:00Z
 * carries the close of the 15:00–16:00 ET hour — the regular-session close.
 */
export async function fetchIntradayBars(
  tickers: string[],
  options: { start: string; end?: string; feed?: BarFeed; timeframe?: BarTimeframe } = { start: "" },
): Promise<IntradayBarMap> {
  const symbols = [...new Set(tickers.map(normalizeBarSymbol).filter(Boolean))];
  if (!symbols.length) return new Map();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.start)) throw new Error("A start date is required for intraday bars.");

  const ctx: LoadContext = {
    start: options.start,
    end: options.end,
    feed: options.feed ?? configuredFeed(),
    timeframe: options.timeframe ?? "1Hour",
  };
  const key = ["intraday", symbols.join(","), ctx.start, ctx.end ?? "", ctx.feed, ctx.timeframe].join("|");
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as unknown as IntradayBarMap;

  const value = (async (): Promise<IntradayBarMap> =>
    loadBars(symbols, ctx, (stamp) => (/^\d{4}-\d{2}-\d{2}T/.test(stamp) ? stamp : null)))();

  cache.set(key, { expiresAt: now + CACHE_MS, value: value as unknown as Promise<AdjustedBarMap> });
  value.catch(() => cache.delete(key));
  return value;
}
