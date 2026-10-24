import { getBindings } from "./runtime";
import { optionDte, type NormalizedOptionChain, type NormalizedOptionContract, type OptionsProvider } from "./options-provider";

type AlpacaQuote = { bp?: number; ap?: number; t?: string };
type AlpacaSnapshot = {
  latestQuote?: AlpacaQuote;
  latestTrade?: { p?: number; t?: string };
  dailyBar?: { c?: number; v?: number; t?: string };
  minuteBar?: { c?: number; v?: number; t?: string };
  impliedVolatility?: number;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
};
type AlpacaContract = { symbol?: string; expiration_date?: string; strike_price?: string | number; type?: string; open_interest?: string | number };

const DATA_BASE = "https://data.alpaca.markets";
const TRADING_BASE = "https://paper-api.alpaca.markets";
const CACHE_MS = 15 * 60 * 1_000;
const chainCache = new Map<string, { createdAt: number; expiresAt: number; value: Promise<NormalizedOptionChain> }>();
const expirationCache = new Map<string, { expiresAt: number; value: Promise<string[]> }>();

function credentials() {
  const bindings = getBindings();
  const key = bindings.ALPACA_API_KEY_ID?.trim();
  const secret = bindings.ALPACA_API_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error("ALPACA_OPTIONS_NOT_CONFIGURED");
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, accept: "application/json" };
}

async function alpacaJson<T>(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers: credentials(), cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`ALPACA_OPTIONS_${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOccSymbol(symbol: string) {
  const match = symbol.match(/^([A-Z0-9.]+)(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const expiration = `20${match[2].slice(0, 2)}-${match[2].slice(2, 4)}-${match[2].slice(4, 6)}`;
  return { underlying: match[1], expiration, type: match[3] === "C" ? "call" as const : "put" as const, strike: Number(match[4]) / 1000 };
}

function normalizeContract(symbol: string, snapshot: AlpacaSnapshot, metadata?: AlpacaContract): NormalizedOptionContract | null {
  const parsed = parseOccSymbol(symbol);
  if (!parsed) return null;
  const bid = number(snapshot.latestQuote?.bp);
  const ask = number(snapshot.latestQuote?.ap);
  const midpoint = bid !== null && ask !== null && bid >= 0 && ask >= bid ? (bid + ask) / 2 : null;
  const spreadPct = midpoint && midpoint > 0 && bid !== null && ask !== null ? (ask - bid) / midpoint * 100 : null;
  return {
    underlying: parsed.underlying,
    symbol,
    expiration: metadata?.expiration_date ?? parsed.expiration,
    dte: optionDte(metadata?.expiration_date ?? parsed.expiration),
    strike: number(metadata?.strike_price) ?? parsed.strike,
    type: metadata?.type === "call" || metadata?.type === "put" ? metadata.type : parsed.type,
    bid,
    ask,
    midpoint,
    spreadPct,
    iv: number(snapshot.impliedVolatility),
    delta: number(snapshot.greeks?.delta),
    gamma: number(snapshot.greeks?.gamma),
    theta: number(snapshot.greeks?.theta),
    vega: number(snapshot.greeks?.vega),
    volume: number(snapshot.dailyBar?.v),
    openInterest: number(metadata?.open_interest),
    quoteTimestamp: snapshot.latestQuote?.t ?? snapshot.latestTrade?.t ?? null,
    dataFeed: "Alpaca indicative",
  };
}

async function contractMetadata(ticker: string, params: URLSearchParams) {
  const url = new URL("/v2/options/contracts", TRADING_BASE);
  url.search = params.toString();
  const output: AlpacaContract[] = [];
  let next: string | null = null;
  do {
    if (next) url.searchParams.set("page_token", next);
    const payload: { option_contracts?: AlpacaContract[]; next_page_token?: string | null } = await alpacaJson(url.toString());
    output.push(...(payload.option_contracts ?? []));
    next = payload.next_page_token ?? null;
  } while (next && output.length < 3000);
  return output.filter((item) => item.symbol?.startsWith(ticker));
}

export class AlpacaIndicativeOptionsProvider implements OptionsProvider {
  async getExpirations(ticker: string) {
    const symbol = ticker.trim().toUpperCase();
    const cached = expirationCache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
    const value = contractMetadata(symbol, new URLSearchParams({ underlying_symbols: symbol, status: "active", expiration_date_gte: from, expiration_date_lte: to, limit: "1000" }))
      .then((contracts) => [...new Set(contracts.map((item) => item.expiration_date).filter((date): date is string => Boolean(date)))].sort());
    expirationCache.set(symbol, { expiresAt: Date.now() + CACHE_MS, value });
    value.catch(() => expirationCache.delete(symbol));
    return value;
  }

  async getChain(ticker: string, expiration: string) {
    const symbol = ticker.trim().toUpperCase();
    const key = `${symbol}:${expiration}`;
    const cached = chainCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { ...(await cached.value), cacheAgeMs: Date.now() - cached.createdAt };
    const createdAt = Date.now();
    const value = (async (): Promise<NormalizedOptionChain> => {
      const snapshotUrl = new URL(`/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`, DATA_BASE);
      snapshotUrl.searchParams.set("feed", "indicative");
      snapshotUrl.searchParams.set("expiration_date", expiration);
      snapshotUrl.searchParams.set("limit", "1000");
      const contractsPromise = contractMetadata(symbol, new URLSearchParams({ underlying_symbols: symbol, status: "active", expiration_date: expiration, limit: "1000" }));
      const [snapshotPayload, metadata, stockPayload, expirations] = await Promise.all([
        alpacaJson<{ snapshots?: Record<string, AlpacaSnapshot> }>(snapshotUrl.toString()),
        contractsPromise,
        alpacaJson<AlpacaSnapshot>(`${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=iex`),
        this.getExpirations(symbol),
      ]);
      const metadataBySymbol = new Map(metadata.map((item) => [item.symbol ?? "", item]));
      const contracts = Object.entries(snapshotPayload.snapshots ?? {})
        .map(([contractSymbol, snapshot]) => normalizeContract(contractSymbol, snapshot, metadataBySymbol.get(contractSymbol)))
        .filter((item): item is NormalizedOptionContract => Boolean(item) && item!.expiration === expiration)
        .sort((left, right) => left.strike - right.strike || left.type.localeCompare(right.type));
      const underlyingPrice = number(stockPayload.latestTrade?.p) ?? number(stockPayload.minuteBar?.c) ?? number(stockPayload.dailyBar?.c);
      return {
        underlying: symbol,
        underlyingPrice,
        underlyingQuoteTimestamp: stockPayload.latestTrade?.t ?? stockPayload.minuteBar?.t ?? stockPayload.dailyBar?.t ?? null,
        expiration,
        expirations,
        contracts,
        provider: "Alpaca Market Data",
        dataFeed: "Indicative options feed; stock reference from IEX where available",
        delayed: true,
        indicative: true,
        retrievedAt: new Date().toISOString(),
        cacheAgeMs: 0,
      };
    })();
    chainCache.set(key, { createdAt, expiresAt: createdAt + CACHE_MS, value });
    value.catch(() => chainCache.delete(key));
    return value;
  }

  async getQuote(contractSymbol: string) {
    const parsed = parseOccSymbol(contractSymbol.toUpperCase());
    if (!parsed) return null;
    const chain = await this.getChain(parsed.underlying, parsed.expiration);
    return chain.contracts.find((item) => item.symbol === contractSymbol.toUpperCase()) ?? null;
  }

  async getGreeks(contractSymbol: string) {
    const quote = await this.getQuote(contractSymbol);
    return quote ? { iv: quote.iv, delta: quote.delta, gamma: quote.gamma, theta: quote.theta, vega: quote.vega } : null;
  }
}

export const publicOptionsProvider = new AlpacaIndicativeOptionsProvider();

