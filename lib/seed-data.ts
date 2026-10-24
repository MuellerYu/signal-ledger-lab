export type SecuritySeed = {
  id: string;
  ticker: string;
  issuerName: string;
  exchange: string | null;
  assetType: "equity" | "etf" | "crypto";
  cik: string | null;
  sector: string;
  theme: string;
  watchTier: number;
  benchmark: string;
  factors: string[];
};

export type SourceSeed = {
  id: string;
  name: string;
  sourceKind: string;
  reliabilityTier: number;
  baseUrl: string;
  pollIntervalSec: number;
  enabled: boolean;
  status: string;
};

const equity = (
  ticker: string,
  issuerName: string,
  sector: string,
  theme: string,
  watchTier: number,
  benchmark: string,
  factors: string[] = [],
  cik: string | null = null,
  exchange = "NASDAQ",
): SecuritySeed => ({
  id: ticker.toLowerCase().replace("/", "-"),
  ticker,
  issuerName,
  exchange,
  assetType: "equity",
  cik,
  sector,
  theme,
  watchTier,
  benchmark,
  factors,
});

export const WATCHLIST_SEED: SecuritySeed[] = [
  equity(
    "ORCL",
    "Oracle Corporation",
    "Software & Cloud",
    "AI cloud infrastructure",
    1,
    "QQQ",
    ["IGV"],
    "0001341439",
    "NYSE",
  ),
  equity(
    "MSTR",
    "Strategy Inc.",
    "Digital Assets",
    "Bitcoin treasury",
    1,
    "QQQ",
    ["BTC/USD"],
    "0001050446",
  ),
  equity("NVDA", "NVIDIA Corporation", "Semiconductors", "AI accelerators", 1, "SOXX"),
  equity("AMD", "Advanced Micro Devices, Inc.", "Semiconductors", "AI accelerators", 1, "SOXX"),
  equity("AVGO", "Broadcom Inc.", "Semiconductors", "Custom silicon & networking", 1, "SOXX"),
  equity("TSM", "Taiwan Semiconductor Manufacturing Company", "Semiconductors", "Foundry capacity", 1, "SOXX"),
  equity("MU", "Micron Technology, Inc.", "Semiconductors", "HBM & memory", 1, "SOXX"),
  equity("MSFT", "Microsoft Corporation", "Cloud", "Hyperscaler AI capex", 1, "QQQ"),
  equity("AMZN", "Amazon.com, Inc.", "Cloud", "Hyperscaler AI capex", 1, "QQQ"),
  equity("GOOGL", "Alphabet Inc.", "Cloud", "Hyperscaler AI capex", 1, "QQQ"),
  equity("META", "Meta Platforms, Inc.", "Internet", "AI capex & monetization", 1, "QQQ"),
  equity("ANET", "Arista Networks, Inc.", "Networking", "AI data-center networking", 1, "XLK"),
  equity("VRT", "Vertiv Holdings Co", "Industrials", "Data-center power & cooling", 1, "XLI", [], null, "NYSE"),
  equity("COIN", "Coinbase Global, Inc.", "Digital Assets", "Crypto market infrastructure", 1, "QQQ", ["BTC/USD"]),
  equity("ASML", "ASML Holding N.V.", "Semiconductor Equipment", "Lithography", 2, "SOXX"),
  equity("ARM", "Arm Holdings plc", "Semiconductors", "Compute architecture", 2, "SOXX"),
  equity("MRVL", "Marvell Technology, Inc.", "Semiconductors", "Networking & custom silicon", 2, "SOXX"),
  equity("AMAT", "Applied Materials, Inc.", "Semiconductor Equipment", "Wafer-fab equipment", 2, "SOXX"),
  equity("LRCX", "Lam Research Corporation", "Semiconductor Equipment", "Wafer-fab equipment", 2, "SOXX"),
  equity("KLAC", "KLA Corporation", "Semiconductor Equipment", "Process control", 2, "SOXX"),
  equity("SMCI", "Super Micro Computer, Inc.", "Hardware", "AI servers", 2, "QQQ"),
  equity("DELL", "Dell Technologies Inc.", "Hardware", "AI servers", 2, "XLK", [], null, "NYSE"),
  equity("HPE", "Hewlett Packard Enterprise", "Hardware", "Enterprise infrastructure", 2, "XLK", [], null, "NYSE"),
  equity("CEG", "Constellation Energy Corporation", "Utilities", "Data-center power", 2, "XLU"),
  equity("VST", "Vistra Corp.", "Utilities", "Data-center power", 2, "XLU", [], null, "NYSE"),
  equity("ETN", "Eaton Corporation plc", "Industrials", "Electrical infrastructure", 2, "XLI", [], null, "NYSE"),
  equity("PWR", "Quanta Services, Inc.", "Industrials", "Grid construction", 2, "XLI", [], null, "NYSE"),
  equity("PLTR", "Palantir Technologies Inc.", "Software", "Enterprise AI", 2, "IGV"),
  equity("NOW", "ServiceNow, Inc.", "Software", "Enterprise AI", 2, "IGV"),
  equity("CRM", "Salesforce, Inc.", "Software", "Enterprise AI", 2, "IGV", [], null, "NYSE"),
  {
    id: "spy",
    ticker: "SPY",
    issuerName: "SPDR S&P 500 ETF Trust",
    exchange: "NYSE Arca",
    assetType: "etf",
    cik: null,
    sector: "Benchmark",
    theme: "US large-cap benchmark",
    watchTier: 0,
    benchmark: "SPY",
    factors: [],
  },
  {
    id: "qqq",
    ticker: "QQQ",
    issuerName: "Invesco QQQ Trust",
    exchange: "NASDAQ",
    assetType: "etf",
    cik: null,
    sector: "Benchmark",
    theme: "Nasdaq-100 benchmark",
    watchTier: 0,
    benchmark: "SPY",
    factors: [],
  },
  ...["SOXX", "XLK", "IGV", "XLU", "XLI"].map(
    (ticker): SecuritySeed => ({
      id: ticker.toLowerCase(),
      ticker,
      issuerName: `${ticker} benchmark ETF`,
      exchange: "NYSE Arca",
      assetType: "etf",
      cik: null,
      sector: "Benchmark",
      theme: "Sector benchmark",
      watchTier: 0,
      benchmark: "SPY",
      factors: [],
    }),
  ),
  {
    id: "btc-usd",
    ticker: "BTC/USD",
    issuerName: "Bitcoin / U.S. Dollar",
    exchange: "Crypto",
    assetType: "crypto",
    cik: null,
    sector: "Digital Assets",
    theme: "Bitcoin factor",
    watchTier: 0,
    benchmark: "USD",
    factors: [],
  },
];

export const SOURCE_SEED: SourceSeed[] = [
  {
    id: "sec-edgar",
    name: "SEC EDGAR",
    sourceKind: "official_filing",
    reliabilityTier: 1,
    baseUrl: "https://data.sec.gov",
    pollIntervalSec: 60,
    enabled: true,
    status: "needs_refresh",
  },
  {
    id: "alpaca-news",
    name: "Alpaca / Benzinga News",
    sourceKind: "commercial_news",
    reliabilityTier: 2,
    baseUrl: "https://data.alpaca.markets",
    pollIntervalSec: 60,
    enabled: true,
    status: "needs_setup",
  },
  {
    id: "nasdaq-halts",
    name: "Nasdaq Trading Halts",
    sourceKind: "official_exchange",
    reliabilityTier: 1,
    baseUrl: "https://www.nasdaqtrader.com",
    pollIntervalSec: 60,
    enabled: false,
    status: "planned",
  },
  {
    id: "federal-reserve",
    name: "Federal Reserve",
    sourceKind: "official_macro",
    reliabilityTier: 1,
    baseUrl: "https://www.federalreserve.gov",
    pollIntervalSec: 300,
    enabled: false,
    status: "planned",
  },
  {
    id: "bls",
    name: "U.S. Bureau of Labor Statistics",
    sourceKind: "official_macro",
    reliabilityTier: 1,
    baseUrl: "https://www.bls.gov",
    pollIntervalSec: 300,
    enabled: false,
    status: "planned",
  },
];

export function buildFixtureDashboard() {
  const now = new Date();
  const nowIso = now.toISOString();
  return {
    snapshotAt: nowIso,
    status: "partial",
    mode: "fixture",
    system: {
      monitoring: "partial",
      dataMode: "fixture",
      email: "needs_setup",
      emailEnabled: false,
      lastRunAt: nowIso,
      note: "D1 is unavailable in this runtime. The watchlist and source registry below are honest seed configuration; no live events or scored forecasts are being claimed.",
    },
    metrics: {
      sourcesOnline: 0,
      sourceCount: SOURCE_SEED.length,
      events24h: 0,
      highPriorityEvents: 0,
      activeForecasts: 0,
      brierScore: null,
      hitRate: null,
    },
    kpis: {
      activeSources: 0,
      watchlistCount: WATCHLIST_SEED.filter((item) => item.watchTier > 0).length,
      events24h: 0,
      activeForecasts: 0,
    },
    events: [],
    forecasts: [],
    calibration: [],
    watchlist: WATCHLIST_SEED.filter((item) => item.watchTier > 0).map((item) => ({
      ticker: item.ticker,
      company: item.issuerName,
      sector: item.sector,
      theme: item.theme,
      tier: item.watchTier,
      benchmark: item.benchmark,
      status: "configured",
    })),
    runs: [
      {
        id: "fixture-runtime",
        trigger: "runtime check",
        status: "partial",
        startedAt: nowIso,
        newEvents: 0,
        alertsQueued: 0,
        alertsSent: 0,
        message: "Persistent D1 storage is not attached to this runtime.",
      },
    ],
    sources: SOURCE_SEED.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.sourceKind,
      status: source.status,
      reliabilityTier: source.reliabilityTier,
      lastSuccessAt: null,
    })),
    sourceHealth: SOURCE_SEED.map((source) => ({
      id: source.id,
      name: source.name,
      status: source.status,
      lastSuccessAt: null,
    })),
    scorecard: {
      resolvedForecasts: 0,
      meanBrier: null,
      hitRate: null,
      note: "No scored forecast sample is available.",
    },
    alerts: [],
  };
}
