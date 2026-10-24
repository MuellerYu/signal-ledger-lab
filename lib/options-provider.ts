export type NormalizedOptionContract = {
  underlying: string;
  symbol: string;
  expiration: string;
  dte: number;
  strike: number;
  type: "call" | "put";
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  spreadPct: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  volume: number | null;
  openInterest: number | null;
  quoteTimestamp: string | null;
  dataFeed: string;
};

export type NormalizedOptionChain = {
  underlying: string;
  underlyingPrice: number | null;
  underlyingQuoteTimestamp: string | null;
  expiration: string;
  expirations: string[];
  contracts: NormalizedOptionContract[];
  provider: string;
  dataFeed: string;
  delayed: boolean;
  indicative: boolean;
  retrievedAt: string;
  cacheAgeMs: number;
};

export interface OptionsProvider {
  getExpirations(ticker: string): Promise<string[]>;
  getChain(ticker: string, expiration: string): Promise<NormalizedOptionChain>;
  getQuote(contractSymbol: string): Promise<NormalizedOptionContract | null>;
  getGreeks(contractSymbol: string): Promise<Pick<NormalizedOptionContract, "iv" | "delta" | "gamma" | "theta" | "vega"> | null>;
}

export function optionDte(expiration: string, now = new Date()) {
  const expiry = Date.parse(`${expiration}T20:00:00Z`);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now.getTime()) / 86_400_000)) : 0;
}

