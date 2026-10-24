// Production-isolated, deterministic harness for the valuation pipeline.
//
// This mirrors the transpile-and-import loader used by integration-pass.test.mjs:
// every Cloudflare binding (D1, runtime env, edge cache) is replaced with an inert
// stand-in and every public provider (SEC, Nasdaq, Coinbase, Alpaca) is served from
// deterministic in-memory fixtures. Nothing here writes to a production D1 table or
// consumes a production `claimAiCall` quota — `getBindings()` returns `{}` and every
// provider fetch is intercepted before it leaves the process.
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const match of [...code.matchAll(/from "(\.\/company-business\/[^"]+)"/g)]) {
    const dependency = match[1];
    code = code.replaceAll(`from "${dependency}"`, `from "${dataUrl(await transpile(`${dependency.slice(2)}.ts`))}"`);
  }
  if (code.includes('from "./research-isolation"')) {
    code = code.replaceAll('from "./research-isolation"', `from "${dataUrl(await transpile("research-isolation.ts"))}"`);
  }
  for (const dependency of ["research-schema", "research-plan", "research-validate"]) {
    if (code.includes(`from "./${dependency}"`)) code = code.replaceAll(`from "./${dependency}"`, `from "${dataUrl(await transpile(`${dependency}.ts`))}"`);
  }
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// ---------------------------------------------------------------------------
// SEC / provider fixtures (deterministic, no network, no production state)
// ---------------------------------------------------------------------------

export const TICKERS = [
  ["AMD", 2488, "Advanced Micro Devices"],
  ["NVDA", 1045810, "NVIDIA CORP"],
  ["OKLO", 1849056, "Oklo Inc"],
  ["SPCX", 1900001, "Space Exploration Technologies"],
];

const quarterly = (end, value) => ({ end, val: value, form: "10-Q", filed: end, start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}` });
const span = (start, end, value, form = "10-Q") => ({ start, end, val: value, form, filed: end });
const annual = (end, value) => ({
  start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}`,
  end,
  val: value,
  form: "10-K",
  filed: end.replace(/^(\d{4})/, (year) => String(Number(year) + 1)),
});
const instant = (end, value) => ({ end, val: value, form: "10-Q", filed: end });

export const QUOTES = { AMD: 210, NVDA: 180, OKLO: 60, SPCX: 120 };

const interimOnlyIssuers = new Set();

export function factsFor(ticker) {
  const interimOnly = interimOnlyIssuers.has(ticker);
  const scale = ticker === "OKLO" ? 0 : 20e9;
  if (interimOnly) {
    // A freshly listed issuer with 10-Q filings only: no full fiscal year exists,
    // so the engine must annualize the latest interim period and label it.
    return {
      entityName: TICKERS.find(([symbol]) => symbol === ticker)?.[2],
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: [
            { start: "2026-04-01", end: "2026-06-30", val: scale / 4, form: "10-Q", filed: "2026-08-04" },
            { start: "2026-01-01", end: "2026-06-30", val: scale / 2, form: "10-Q", filed: "2026-08-04" },
          ] } },
          NetCashProvidedByUsedInOperatingActivities: { units: { USD: [{ start: "2026-01-01", end: "2026-06-30", val: scale * 0.14, form: "10-Q", filed: "2026-08-04" }] } },
          PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [{ start: "2026-01-01", end: "2026-06-30", val: scale * 0.11, form: "10-Q", filed: "2026-08-04" }] } },
          NetIncomeLoss: { units: { USD: [{ start: "2026-01-01", end: "2026-06-30", val: scale * 0.04, form: "10-Q", filed: "2026-08-04" }] } },
          CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instant("2026-06-30", 55e9)] } },
          LongTermDebt: { units: { USD: [instant("2026-06-30", 6e9)] } },
          ShortTermBorrowings: { units: { USD: [instant("2026-06-30", 0)] } },
        },
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [instant("2026-06-30", 5.8e9)] } } },
      },
    };
  }
  const concepts = {
    Revenues: { units: { USD: scale ? [annual("2023-12-31", scale), annual("2024-12-31", scale * 1.1), annual("2025-12-31", scale * 1.25), quarterly("2026-06-30", scale * 1.35)] : [] } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: scale ? [annual("2023-12-31", scale * 0.2), annual("2024-12-31", scale * 0.24), annual("2025-12-31", scale * 0.28)] : [] } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: scale ? [annual("2023-12-31", scale * 0.05), annual("2024-12-31", scale * 0.06), annual("2025-12-31", scale * 0.07)] : [] } },
    NetIncomeLoss: { units: { USD: scale ? [annual("2023-12-31", scale * 0.12), annual("2024-12-31", scale * 0.15), annual("2025-12-31", scale * 0.18)] : [] } },
    ShareBasedCompensation: { units: { USD: scale ? [annual("2023-12-31", scale * 0.03), annual("2024-12-31", scale * 0.03), annual("2025-12-31", scale * 0.03)] : [] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instant("2026-06-30", ticker === "OKLO" ? 1.1e9 : scale * 0.3 + 5e9)] } },
    LongTermDebt: { units: { USD: [instant("2026-06-30", scale * 0.1)] } },
    // This synthetic fixture explicitly reports zero, rather than making the
    // production parser infer zero from an absent short-term borrowing tag.
    ShortTermBorrowings: { units: { USD: [instant("2026-06-30", 0)] } },
  };
  return {
    entityName: TICKERS.find(([symbol]) => symbol === ticker)?.[2],
    facts: {
      "us-gaap": concepts,
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [instant("2026-06-30", ticker === "OKLO" ? 1.5e8 : 1.2e9)] } } },
    },
  };
}

const TICKER_MAP = Object.fromEntries(TICKERS.map(([ticker, cik, title], index) => [String(index), { cik_str: cik, ticker, title }]));

export const SPCX_FILING_TEXT = [
  "As of July 28, 2026, the registrant had 7,696,293,669 shares of Class A common stock and 5,485,486,276 shares of Class B common stock outstanding.",
  "The amount of such shares reserved at June 30, 2026 is as follows: Number of Shares Class A Class B Class C Outstanding Class B 5,569 — — Outstanding stock options 120 352 — Outstanding RSUs 122 — — Future grants under share-based compensation 324 — —",
  "Class C common stock, par value $0.001; — and 482 shares issued and outstanding as of June 30, 2026 and December 31, 2025, respectively.",
  "Three Months Ended June 30, 2026 Space Connectivity AI Total Reportable Segments Revenue $ 962 $ 4,291 $ 2,561 $ 7,814 Costs and expenses Cost of revenue 329 2,060 1,106 3,495 Research and development 1,076 294 2,178 3,548 Selling, general, and administrative 99 281 532 912 Restructuring charges — — 2 2 Total costs and expenses 1,504 2,635 3,818 7,957 Income (loss) from operations ( 542 ) 1,656 ( 1,257 ) ( 143 ) Supplemental segment information Depreciation and amortization $ 158 $ 805 $ 1,885 $ 2,848 Share-based compensation $ 179 $ 136 $ 516 $ 831 Capital expenditures $ 1,174 $ 1,367 $ 4,000 $ 6,541",
  "Six Months Ended June 30, 2026 Space Connectivity AI Total Reportable Segments Revenue $ 1,581 $ 7,548 $ 3,379 $ 12,508 Costs and expenses Cost of revenue 610 3,711 1,562 5,883 Research and development 2,006 499 4,557 7,062 Selling, general, and administrative 169 494 995 1,658 Total costs and expenses 2,785 4,704 7,105 14,594 Income (loss) from operations ( 1,204 ) 2,844 ( 3,726 ) ( 2,086 ) Supplemental segment information Depreciation and amortization $ 324 $ 1,588 $ 3,378 $ 5,290 Share-based compensation $ 324 $ 252 $ 894 $ 1,470 Capital expenditures $ 2,226 $ 2,699 $ 23,551 $ 28,476",
  "Launch Services $ 648 $ 490 $ 978 $ 1,056 Launch & Development 314 256 603 555 Space 962 746 1,581 1,611 Consumer 2,485 1,721 4,633 3,213 Enterprise & Government (1) 1,806 867 2,915 1,849 Connectivity 4,291 2,588 7,548 5,062 Advertising 367 426 710 870 AI Solutions & Infrastructure 2,194 311 2,669 595 AI 2,561 737 3,379 1,465",
  "Total backlog $ 14,286 million. Total deferred revenue as of June 30, 2026 was $ 14,286 million.",
  "Cash and cash equivalents $ 93,522 $ 24,747 Marketable securities 6,487 — Digital assets 1,098 1,637 Total debt and finance leases 39,512 148 39,364 Finance lease liability 1,079 — Total shareholders' equity 127,224 2,573 Goodwill 11,645 11,809",
].join(" ");

export function installProviders() {
  interimOnlyIssuers.add("SPCX");
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://www.sec.gov/files/company_tickers.json")) {
      return Response.json(TICKER_MAP);
    }
    if (url.startsWith("https://data.sec.gov/api/xbrl/companyfacts/")) {
      const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
      const match = TICKERS.find(([, value]) => value === cik);
      if (!match) throw new Error(`unexpected CIK ${cik}`);
      return Response.json(factsFor(match[0]));
    }
    if (url.startsWith("https://data.sec.gov/submissions/")) {
      const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
      const match = TICKERS.find(([, value]) => value === cik);
      const isSpcx = match?.[0] === "SPCX";
      return Response.json({
        name: match?.[2] ?? "Issuer",
        sic: "3674",
        sicDescription: "Semiconductors",
        filings: { recent: isSpcx
          ? { form: ["10-Q"], accessionNumber: ["0001181412-26-000001"], primaryDocument: ["spcx-20260630.htm"], filingDate: ["2026-08-04"], reportDate: ["2026-06-30"] }
          : { form: [], accessionNumber: [], primaryDocument: [], filingDate: [], reportDate: [] } },
      });
    }
    if (url.startsWith("https://www.sec.gov/Archives/")) {
      return new Response(SPCX_FILING_TEXT, { headers: { "content-type": "text/html" } });
    }
    if (url.includes("api.nasdaq.com")) {
      const symbol = decodeURIComponent(url.match(/quote\/([^/]+)\/info/)?.[1] ?? "");
      return Response.json({ data: { primaryData: { lastSalePrice: String(QUOTES[symbol] ?? 100), lastTradeTimestamp: "Sep 14, 2026 4:00 PM ET", isRealTime: true } } });
    }
    if (url.includes("api.exchange.coinbase.com")) {
      return Response.json({ price: "90000.00" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Engine loader (transpile + data-URL import)
// ---------------------------------------------------------------------------

let loadedPromise = null;

export function loadEngine() {
  if (!loadedPromise) {
    loadedPromise = (async () => {
      const snapshotCacheUrl = dataUrl(await transpile("snapshot-cache.ts"));
      const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = {};"]]));
      const issuerUrl = dataUrl(await transpile("issuer-intelligence.ts", [['from "./runtime"', `from "${runtimeUrl}"`]]));
      const aiExposureUrl = dataUrl(await transpile("ai-exposure.ts"));
      const spcxUrl = dataUrl(await transpile("spcx-valuation.ts"));
      const muUrl = dataUrl(await transpile("mu-valuation.ts"));
      const capitalCostUrl = dataUrl(await transpile("valuation-capital-cost.ts", [
        ['from "./runtime"', `from "${runtimeUrl}"`],
        ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
        ['import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";', 'const configuredFeed = () => "iex"; const fetchDailyAdjustedBars = async () => new Map();'],
      ]));
      const valuationUrl = dataUrl(await transpile("universal-valuation.ts", [
        ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
        ['from "./mu-valuation"', `from "${muUrl}"`],
      ]));
      const researchHashUrl = dataUrl(await transpile("research-hash.ts"));
      const packUrl = dataUrl(await transpile("valuation-data.ts", [
        ['import { calculateCapitalCost, loadCapitalCostMarketInputs } from "./valuation-capital-cost";', `import { calculateCapitalCost, loadCapitalCostMarketInputs as loadMarketInputs } from "${capitalCostUrl}";
    const loadCapitalCostMarketInputs = (ticker) => globalThis.__capitalIntegrationMarket ? Promise.resolve(globalThis.__capitalIntegrationMarket) : loadMarketInputs(ticker);`],
        ['from "./valuation-capital-cost"', `from "${capitalCostUrl}"`],
        ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
        ['from "./universal-valuation"', `from "${valuationUrl}"`],
        ['from "./runtime"', `from "${runtimeUrl}"`],
        ['from "./ai-exposure"', `from "${aiExposureUrl}"`],
        ['from "./spcx-valuation"', `from "${spcxUrl}"`],
        ['from "./mu-valuation"', `from "${muUrl}"`],
        ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
        ['from "./research-hash"', `from "${researchHashUrl}"`],
      ]));
      const engine = await import(valuationUrl);
      const { buildAutomatedValuationPack, packCacheKey, ENGINE_VERSION, resetPackCache } = await import(packUrl);
      return { engine, buildAutomatedValuationPack, packCacheKey, ENGINE_VERSION, resetPackCache };
    })();
  }
  return loadedPromise;
}

/** Build the pack and run the deterministic valuation for one ticker. */
export async function runValuation(ticker, { currentPrice } = {}) {
  const { engine, buildAutomatedValuationPack } = await loadEngine();
  const pack = await buildAutomatedValuationPack(ticker);
  const price = currentPrice ?? pack.quote?.price ?? null;
  const output = engine.runValuationProfile(pack.profile, { currentPrice: price });
  return { pack, output };
}
