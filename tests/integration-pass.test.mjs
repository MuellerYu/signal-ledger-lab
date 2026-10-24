import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../lib/", import.meta.url);
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

// The production modules talk to Cloudflare bindings and a D1 database. Both are
// replaced with inert stand-ins so the whole deterministic pipeline can run in
// Node against mocked public providers.
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
const snapshotModule = await import(dataUrl(await transpile("investment-snapshot.ts", [
  ['await buildAutomatedValuationPack(symbol)', 'await (globalThis.__p0SnapshotPack ?? buildAutomatedValuationPack)(symbol)'],
  ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
  ['from "./runtime"', `from "${runtimeUrl}"`],
  ['from "./universal-valuation"', `from "${valuationUrl}"`],
  ['from "./valuation-data"', `from "${packUrl}"`],
])));
const options = await import(dataUrl(await transpile("options-screen.ts")));
const engine = await import(valuationUrl);
const { buildAutomatedValuationPack, verifiedFilingIdentity, packCacheKey, ENGINE_VERSION, resetPackCache } = await import(packUrl);

/* ------------------------------------------------------------------ */
/* Mocked public providers                                             */
/* ------------------------------------------------------------------ */

const TICKERS = [
  ["AMD", 2488, "Advanced Micro Devices"],
  ["NVDA", 1045810, "NVIDIA CORP"],
  ["MU", 723125, "MICRON TECHNOLOGY INC"],
  ["MSTR", 1050446, "Strategy"],
  ["OKLO", 1849056, "Oklo Inc"],
  ["TSLA", 1318605, "Tesla, Inc."],
  ["GOOG", 1652044, "Alphabet Inc."],
  ["GOOGL", 1652044, "Alphabet Inc."],
  ["JPM", 19617, "JPMORGAN CHASE & CO"],
  ["O", 726728, "Realty Income"],
  ["ORCL", 1341439, "ORACLE CORP"],
  ["CRCL", 1876042, "Circle Internet Group"],
  ["SPCX", 1900001, "Space Exploration Technologies"],
];

const quarterly = (end, value) => ({ end, val: value, form: "10-Q", filed: end, start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}` });
const span = (start, end, value, form = "10-Q") => ({ start, end, val: value, form, filed: end });

// Micron's inline XBRL product-revenue table, built from a compact spec so the
// fixture stays readable: [context id, start, end, XBRL member, tagged dollars].
const MICRON_PRODUCT_FACTS = [
  ["dramQ", "2026-02-27", "2026-05-28", "mu:DRAMProductsMember", "31,328"],
  ["nandQ", "2026-02-27", "2026-05-28", "mu:NANDProductsMember", "9,943"],
  ["otherQ", "2026-02-27", "2026-05-28", "mu:OtherProductSalesMember", "185"],
  ["dramY", "2025-08-29", "2026-05-28", "mu:DRAMProductsMember", "60,908"],
  ["nandY", "2025-08-29", "2026-05-28", "mu:NANDProductsMember", "17,683"],
  ["otherY", "2025-08-29", "2026-05-28", "mu:OtherProductSalesMember", "368"],
];

const MICRON_FILING_TEXT = [
  "These agreements are structured as take-or-pay agreements, with binding commitments for specific volumes over the multi-year contract terms.",
  "Pricing for most agreements is either fixed, or is subject to minimum and maximum pricing.",
  "We broke ground in January 2025 on an HBM advanced packaging facility in Singapore to expand total advanced packaging capacity beginning in the first half of calendar 2027.",
  "In Taiwan, we are modernizing and expanding our production capacity for DRAM and HBM products.",
  "For the first nine months of 2026, net cash used for financing activities included $9.38 billion of repayments of debt.",
];

const micronFilingHtml = () => [
  "<html><body>",
  ...MICRON_FILING_TEXT,
  ...MICRON_PRODUCT_FACTS.map(([id, start, end, member]) => `<xbrli:context id="${id}"><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period><xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">${member}</xbrldi:explicitMember></xbrli:segment></xbrli:entity></xbrli:context>`),
  ...MICRON_PRODUCT_FACTS.map(([id, , , , value]) => `<ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="${id}" scale="6">${value}</ix:nonFraction>`),
  "</body></html>",
].join("");
const annual = (end, value) => ({
  start: `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}`,
  end,
  val: value,
  form: "10-K",
  filed: end.replace(/^(\d{4})/, (year) => String(Number(year) + 1)),
});
const instant = (end, value) => ({ end, val: value, form: "10-Q", filed: end });

const interimOnlyIssuers = new Set();

function factsFor(ticker) {
  const interimOnly = interimOnlyIssuers.has(ticker);
  const scale = ticker === "OKLO" ? 0 : ticker === "MSTR" ? 0.5e9 : ticker === "JPM" ? 150e9 : 20e9;
  if (ticker === "MU") {
    // Micron as reported: a trough fiscal year, then a super-cycle with both
    // nine-month periods and the latest quarter on file, so the trailing twelve
    // months and the reported product table have to be rolled forward.
    const usd = (rows) => ({ units: { USD: rows } });
    return {
      entityName: "MICRON TECHNOLOGY INC",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: usd([
            annual("2025-08-28", 37_378e6),
            span("2024-08-30", "2025-05-29", 26_063e6),
            span("2025-08-29", "2026-05-28", 78_959e6),
            span("2026-02-27", "2026-05-28", 41_456e6),
          ]),
          GrossProfit: usd([
            annual("2025-08-28", 14_873e6),
            span("2024-08-30", "2025-05-29", 9_819e6),
            span("2025-08-29", "2026-05-28", 60_457e6),
            span("2026-02-27", "2026-05-28", 35_056e6),
          ]),
          OperatingIncomeLoss: usd([
            annual("2025-08-28", 9_770e6),
            span("2024-08-30", "2025-05-29", 6_116e6),
            span("2025-08-29", "2026-05-28", 55_589e6),
            span("2026-02-27", "2026-05-28", 33_318e6),
          ]),
          NetIncomeLoss: usd([
            annual("2025-08-28", 8_539e6),
            span("2024-08-30", "2025-05-29", 5_338e6),
            span("2025-08-29", "2026-05-28", 47_268e6),
            span("2026-02-27", "2026-05-28", 28_243e6),
          ]),
          EarningsPerShareDiluted: { units: { "USD/shares": [
            annual("2025-08-28", 7.59),
            span("2024-08-30", "2025-05-29", 4.75),
            span("2025-08-29", "2026-05-28", 41.4),
            span("2026-02-27", "2026-05-28", 24.67),
          ] } },
          DepreciationDepletionAndAmortization: usd([
            annual("2025-08-28", 8_352e6),
            span("2024-08-30", "2025-05-29", 6_203e6),
            span("2025-08-29", "2026-05-28", 6_862e6),
            span("2026-02-27", "2026-05-28", 2_364e6),
          ]),
          NetCashProvidedByUsedInOperatingActivities: usd([
            annual("2025-08-28", 17_525e6),
            span("2024-08-30", "2025-05-29", 11_795e6),
            span("2025-08-29", "2026-05-28", 45_702e6),
            span("2026-02-27", "2026-05-28", 20_000e6),
          ]),
          PaymentsToAcquirePropertyPlantAndEquipment: usd([
            annual("2025-08-28", 15_857e6),
            span("2024-08-30", "2025-05-29", 10_199e6),
            span("2025-08-29", "2026-05-28", 19_602e6),
            span("2026-02-27", "2026-05-28", 7_000e6),
          ]),
          IncomeTaxExpenseBenefit: usd([
            span("2024-08-30", "2025-05-29", 695e6),
            span("2025-08-29", "2026-05-28", 8_178e6),
          ]),
          CashAndCashEquivalentsAtCarryingValue: usd([instant("2026-05-28", 24_995e6)]),
          LongTermDebt: usd([instant("2026-05-28", 14_000e6)]),
          ShortTermBorrowings: usd([instant("2026-05-28", 0)]),
          StockholdersEquity: usd([instant("2026-05-28", 100_724e6)]),
          WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [span("2026-02-27", "2026-05-28", 1_145e6)] } },
        },
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [instant("2026-05-28", 1_145e6)] } } },
      },
    };
  }
  if (ticker === "GOOG" || ticker === "GOOGL") {
    // Alphabet with three full fiscal years of EBIT, depreciation, capex and
    // income tax plus a reported operating working-capital balance, so the DCF
    // can build a complete unlevered FCFF bridge (EBIT×(1−tax)+D&A−CapEx−ΔNWC).
    // The figures are chosen so every bridge term is hand-checkable: a 20% book
    // tax rate and an equal 15% FCFF-before-NWC margin in each year.
    const usd = (rows) => ({ units: { USD: rows } });
    return {
      entityName: "Alphabet Inc.",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: usd([
            annual("2023-12-31", 20e9),
            annual("2024-12-31", 24e9),
            annual("2025-12-31", 30e9),
          ]),
          OperatingIncomeLoss: usd([
            annual("2023-12-31", 5e9),
            annual("2024-12-31", 6e9),
            annual("2025-12-31", 7.5e9),
          ]),
          DepreciationDepletionAndAmortization: usd([
            annual("2023-12-31", 2e9),
            annual("2024-12-31", 2.4e9),
            annual("2025-12-31", 3e9),
          ]),
          PaymentsToAcquirePropertyPlantAndEquipment: usd([
            annual("2023-12-31", 3e9),
            annual("2024-12-31", 3.6e9),
            annual("2025-12-31", 4.5e9),
          ]),
          IncomeTaxExpenseBenefit: usd([
            annual("2023-12-31", 0.8e9),
            annual("2024-12-31", 0.96e9),
            annual("2025-12-31", 1.2e9),
          ]),
          NetIncomeLoss: usd([
            annual("2023-12-31", 3.2e9),
            annual("2024-12-31", 3.84e9),
            annual("2025-12-31", 4.8e9),
          ]),
          NetCashProvidedByUsedInOperatingActivities: usd([
            annual("2023-12-31", 6e9),
            annual("2024-12-31", 7.2e9),
            annual("2025-12-31", 9e9),
          ]),
          AccountsReceivableNetCurrent: usd([
            instant("2023-12-31", 2e9),
            instant("2024-12-31", 2.4e9),
            instant("2025-12-31", 3e9),
          ]),
          InventoryNet: usd([
            instant("2023-12-31", 1e9),
            instant("2024-12-31", 1.2e9),
            instant("2025-12-31", 1.5e9),
          ]),
          AccountsPayableCurrent: usd([
            instant("2023-12-31", 1.5e9),
            instant("2024-12-31", 1.8e9),
            instant("2025-12-31", 2.25e9),
          ]),
          CashAndCashEquivalentsAtCarryingValue: usd([instant("2025-12-31", 10e9)]),
          LongTermDebt: usd([instant("2025-12-31", 2e9)]),
          ShortTermBorrowings: usd([instant("2025-12-31", 0)]),
          StockholdersEquity: usd([instant("2025-12-31", 30e9)]),
        },
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [instant("2025-12-31", 10e9)] } } },
      },
    };
  }
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
    LongTermDebt: { units: { USD: [instant("2026-06-30", ticker === "MSTR" ? 7e9 : scale * 0.1)] } },
    // This synthetic fixture explicitly reports zero, rather than making the
    // production parser infer zero from an absent short-term borrowing tag.
    ShortTermBorrowings: { units: { USD: [instant("2026-06-30", 0)] } },
    ...(ticker === "MSTR" ? { DigitalAssets: { units: { USD: [instant("2026-06-30", 30e9)] } } } : {}),
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
// MU is quoted in its super-cycle range so the reverse solve has to explain a
// price above the model, which is the case the methodology spec calls out.
const QUOTES = { AMD: 210, NVDA: 180, MU: 925.65, MSTR: 300, OKLO: 60, TSLA: 250, GOOG: 200, GOOGL: 200, JPM: 280, O: 58, ORCL: 180, CRCL: 90, SPCX: 120 };

let bitcoinCalls = 0;
let nasdaqCalls = 0;
let secCalls = 0;
let failSec = false;

globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input.url;
  if (failSec && url.startsWith("https://data.sec.gov/")) {
    secCalls += 1;
    return new Response("upstream unavailable", { status: 503 });
  }
  if (url.startsWith("https://www.sec.gov/files/company_tickers.json")) {
    secCalls += 1;
    return Response.json(TICKER_MAP);
  }
  if (url.startsWith("https://data.sec.gov/api/xbrl/companyfacts/")) {
    secCalls += 1;
    const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
    const match = TICKERS.find(([, value]) => value === cik);
    assert.ok(match, `unexpected CIK ${cik}`);
    return Response.json(factsFor(match[0]));
  }
  if (url.startsWith("https://data.sec.gov/submissions/")) {
    secCalls += 1;
    const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
    const match = TICKERS.find(([, value]) => value === cik);
    const isSpcx = match?.[0] === "SPCX";
    const isMu = match?.[0] === "MU";
    return Response.json({
      name: match?.[2] ?? "Issuer",
      sic: "3674",
      sicDescription: "Semiconductors",
      filings: { recent: isSpcx
        ? { form: ["10-Q"], accessionNumber: ["0001181412-26-000001"], primaryDocument: ["spcx-20260630.htm"], filingDate: ["2026-08-04"], reportDate: ["2026-06-30"] }
        : isMu
        ? { form: ["10-Q"], accessionNumber: ["0000723125-26-000015"], primaryDocument: ["mu-20260528.htm"], filingDate: ["2026-06-25"], reportDate: ["2026-05-28"] }
        : { form: [], accessionNumber: [], primaryDocument: [], filingDate: [], reportDate: [] } },
    });
  }
  if (url.startsWith("https://www.sec.gov/Archives/")) {
    secCalls += 1;
    if (url.includes("mu-20260528")) return new Response(micronFilingHtml(), { headers: { "content-type": "text/html" } });
    return new Response([
      "As of July 28, 2026, the registrant had 7,696,293,669 shares of Class A common stock and 5,485,486,276 shares of Class B common stock outstanding.",
      "The amount of such shares reserved at June 30, 2026 is as follows: Number of Shares Class A Class B Class C Outstanding Class B 5,569 — — Outstanding stock options 120 352 — Outstanding RSUs 122 — — Future grants under share-based compensation 324 — —",
      "Class C common stock, par value $0.001; — and 482 shares issued and outstanding as of June 30, 2026 and December 31, 2025, respectively.",
      "Three Months Ended June 30, 2026 Space Connectivity AI Total Reportable Segments Revenue $ 962 $ 4,291 $ 2,561 $ 7,814 Costs and expenses Cost of revenue 329 2,060 1,106 3,495 Research and development 1,076 294 2,178 3,548 Selling, general, and administrative 99 281 532 912 Restructuring charges — — 2 2 Total costs and expenses 1,504 2,635 3,818 7,957 Income (loss) from operations ( 542 ) 1,656 ( 1,257 ) ( 143 ) Supplemental segment information Depreciation and amortization $ 158 $ 805 $ 1,885 $ 2,848 Share-based compensation $ 179 $ 136 $ 516 $ 831 Capital expenditures $ 1,174 $ 1,367 $ 4,000 $ 6,541",
      "Six Months Ended June 30, 2026 Space Connectivity AI Total Reportable Segments Revenue $ 1,581 $ 7,548 $ 3,379 $ 12,508 Costs and expenses Cost of revenue 610 3,711 1,562 5,883 Research and development 2,006 499 4,557 7,062 Selling, general, and administrative 169 494 995 1,658 Total costs and expenses 2,785 4,704 7,105 14,594 Income (loss) from operations ( 1,204 ) 2,844 ( 3,726 ) ( 2,086 ) Supplemental segment information Depreciation and amortization $ 324 $ 1,588 $ 3,378 $ 5,290 Share-based compensation $ 324 $ 252 $ 894 $ 1,470 Capital expenditures $ 2,226 $ 2,699 $ 23,551 $ 28,476",
      "Launch Services $ 648 $ 490 $ 978 $ 1,056 Launch & Development 314 256 603 555 Space 962 746 1,581 1,611 Consumer 2,485 1,721 4,633 3,213 Enterprise & Government (1) 1,806 867 2,915 1,849 Connectivity 4,291 2,588 7,548 5,062 Advertising 367 426 710 870 AI Solutions & Infrastructure 2,194 311 2,669 595 AI 2,561 737 3,379 1,465",
      "Total backlog $ 14,286 million. Total deferred revenue as of June 30, 2026 was $ 14,286 million.",
      "Cash and cash equivalents $ 93,522 $ 24,747 Marketable securities 6,487 — Digital assets 1,098 1,637 Total debt and finance leases 39,512 148 39,364 Finance lease liability 1,079 — Total shareholders' equity 127,224 2,573 Goodwill 11,645 11,809",
    ].join(" "), { headers: { "content-type": "text/html" } });
  }
  if (url.includes("api.nasdaq.com")) {
    nasdaqCalls += 1;
    const symbol = decodeURIComponent(url.match(/quote\/([^/]+)\/info/)?.[1] ?? "");
    return Response.json({ data: { primaryData: { lastSalePrice: String(QUOTES[symbol] ?? 100), lastTradeTimestamp: "Sep 14, 2026 4:00 PM ET", isRealTime: true } } });
  }
  if (url.includes("api.exchange.coinbase.com")) {
    bitcoinCalls += 1;
    return Response.json({ price: "90000.00" });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const EXPECTED_FAMILIES = {
  AMD: "ai_semiconductor",
  NVDA: "ai_compute_platform",
  MU: "memory_cycle_semiconductor",
  MSTR: "bitcoin_treasury",
  OKLO: "advanced_nuclear_project_npv",
  TSLA: "auto_energy_optionality_sotp",
  GOOG: "digital_platform",
  GOOGL: "digital_platform",
  JPM: "bank",
  O: "reit",
  ORCL: "cloud_software_hybrid",
  CRCL: "stablecoin_network",
  SPCX: "integrated_space_connectivity_ai_platform",
};

test("correction pass: an interim-only public issuer is annualized, labelled and valued", async () => {
  // SPCX files 10-Q statements only (listed June 2026), so every later SPCX
  // assertion in this file also exercises the interim-annualized basis.
  interimOnlyIssuers.add("SPCX");
  const pack = await buildAutomatedValuationPack("SPCX");
  const financials = pack.pipeline.find((stage) => stage.id === "financials");
  assert.equal(financials.status, "partial");
  assert.match(financials.detail, /annualized latest interim period \(×2\)/);
  assert.match(financials.detail, /Space Exploration Technologies/i);
  assert.ok((pack.profile.evidenceMissing ?? []).some((item) => /full fiscal year/i.test(item)));

  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  assert.ok(output.ensemble.fairValue > 0, "an interim-only public issuer must still be valued");
  assert.equal(output.valuationScenarios.method, "segment_sotp");
  assert.ok(output.valuationScenarios.bear.value < output.valuationScenarios.base.value);
  assert.ok(output.valuationScenarios.base.value < output.valuationScenarios.bull.value);
});

test("acceptance pass: correct valuation family and a released fair value for every requested ticker", async () => {
  for (const [ticker, family] of Object.entries(EXPECTED_FAMILIES)) {
    const pack = await buildAutomatedValuationPack(ticker);
    assert.equal(pack.profile.classification.modelFamily, family, `${ticker} routed to the wrong family`);
    const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
    assert.notEqual(output.status, "unavailable", `${ticker} published no valuation at all`);
    assert.ok(output.ensemble.fairValue > 0, `${ticker} produced no usable fair value`);
    assert.ok(["STRONG BUY", "BUY", "WATCH", "REDUCE", "SELL"].includes(output.rating.value));
  }
});

test("correction pass: SPCX resolves to the current public SpaceX issuer with no legacy identity", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const classification = pack.profile.classification;
  assert.equal(classification.companyName, "Space Exploration Technologies");
  assert.equal(classification.modelFamily, "integrated_space_connectivity_ai_platform");
  assert.equal(pack.issuerProfile.issuerId, "spacex");
  assert.equal(pack.issuerProfile.profileSource, "verified_registry");

  const serialized = JSON.stringify({ classification, issuerProfile: pack.issuerProfile, segments: pack.profile.baseline.sotpSegments });
  assert.doesNotMatch(serialized, /research proxy/i);
  assert.doesNotMatch(serialized, /private[- ]company|private high growth|liquidity discount/i);

  const segments = pack.profile.baseline.sotpSegments ?? [];
  const names = segments.map((segment) => segment.name).join(" | ");
  // The reported framework is Space / Connectivity / AI, with Starship and AI
  // future optionality carved out separately.
  assert.match(names, /Space segment/i);
  assert.match(names, /Connectivity segment/i);
  assert.match(names, /AI segment/i);
  assert.match(names, /Starship scenario tree/i);
  assert.match(names, /Strategic optionality/i);
  // Reported sub-lines are carried in the audit text.
  const metrics = segments.map((segment) => segment.metric).join(" | ");
  assert.match(metrics, /Launch Services/i);
  assert.match(metrics, /Consumer/i);
  assert.match(metrics, /Enterprise & Government/i);
  assert.match(metrics, /AI Solutions & Infrastructure/i);

  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  assert.notEqual(output.status, "unavailable", "SPCX must attempt a public-equity valuation, not a private-proxy fallback");
  assert.ok(output.ensemble.fairValue > 0);
  assert.equal(output.valuationScenarios.method, "segment_sotp");

  // The reporting basis and the verified SEC entity are both carried through.
  assert.equal(pack.identity.filingIdentityVerified, true);
  assert.match(String(pack.identity.secEntityName), /Space Exploration Technologies/i);
  assert.equal(pack.profile.dataQuality?.checks.find((check) => check.id === "security-identity")?.status, "passed");

  // Ticker-reuse protection: a mismatched SEC entity can never supply filings.
  assert.equal(verifiedFilingIdentity("SPCX", "SPACE EXPLORATION TECHNOLOGIES CORP"), true);
  assert.equal(verifiedFilingIdentity("SPCX", "SPAC and New Issue ETF"), false);
  assert.equal(verifiedFilingIdentity("AMD", "ANY ENTITY AT ALL"), true);

  // No legacy private-aerospace routing may survive anywhere in the product.
  const files = await Promise.all([
    readFile(new URL("../lib/universal-valuation.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/issuer-intelligence.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/valuation-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/options/workstation.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of files) {
    assert.doesNotMatch(source, /SpaceX research proxy/);
    assert.doesNotMatch(source, /private_aerospace/);
  }
});

test("correction pass: TSLA exposes SOTP drivers and economically distinct Bear/Base/Bull cases", async () => {
  const pack = await buildAutomatedValuationPack("TSLA");
  const segments = pack.profile.baseline.sotpSegments ?? [];
  assert.ok(segments.length >= 5, "the TSLA SOTP must separate automotive, energy, autonomy and other optionality");
  const names = segments.map((segment) => segment.name).join(" | ");
  for (const expected of ["Automotive", "Energy", "FSD", "Robotaxi", "Optimus"]) assert.match(names, new RegExp(expected, "i"));
  for (const segment of segments.filter((item) => /FSD|Robotaxi|Optimus/i.test(item.name))) {
    assert.ok((segment.probability ?? 1) < 1, `${segment.name} must be probability weighted rather than fully credited`);
    assert.match(segment.metric, /probab|adoption|success/i);
  }

  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  assert.equal(output.valuationScenarios.method, "segment_sotp");
  const { bear, base, bull } = output.valuationScenarios;
  assert.ok(bear.value !== null && base.value !== null && bull.value !== null);
  assert.ok(bear.value < base.value && base.value < bull.value, "the three cases must differ for the stated economic reasons");
  assert.match(bear.assumptions, /probabilit/i);
  assert.match(bull.assumptions, /probabilit/i);
  assert.equal(output.ensemble.scenarios.base, base.value);
  assert.ok(output.engine.modelsIncluded >= 1);
  assert.equal(output.confidenceLabel, output.ensemble.confidence >= 0.4 ? output.confidenceLabel : "Low confidence");
  if (output.ensemble.confidence < 0.4) assert.equal(output.confidenceLabel, "Low confidence");

  // The page must render the segment components, the case weights and the
  // low-confidence range instead of one authoritative number.
  const workstation = await readFile(new URL("../app/fair-value/workstation.tsx", import.meta.url), "utf8");
  assert.match(workstation, /Sum-of-the-parts components/);
  assert.match(workstation, /<th>Probability<\/th>/);
  assert.match(workstation, /Enterprise-to-equity reconciliation/);
  assert.match(workstation, /= Fair value per share/);
  assert.match(workstation, /sotpSegments.map/);
  assert.match(workstation, /lowConfidence/);
  assert.match(workstation, /Case weights/);
});

test("acceptance pass: the shared snapshot equals the valuation page and reuses its cache", async () => {
  const engineOutput = engine.runValuationProfile((await buildAutomatedValuationPack("MU")).profile, { currentPrice: QUOTES.MU });
  const snapshot = snapshotModule.toInvestmentSnapshot(engineOutput, { issuerId: "micron" });
  assert.equal(snapshot.ticker, engineOutput.ticker);
  assert.equal(snapshot.fairValue, engineOutput.ensemble.fairValue);
  assert.equal(snapshot.rating, engineOutput.rating.value);
  assert.equal(snapshot.buyZone, engineOutput.rating.buyZone);
  assert.equal(snapshot.p50, engineOutput.ensemble.probabilityDistribution.p50);
  assert.equal(snapshot.valuationStatus, engineOutput.status);
  assert.equal(snapshot.aiUsed, false);
  assert.equal(snapshot.aiModel, null);

  const first = await snapshotModule.getInvestmentSnapshot("AMD");
  const second = await snapshotModule.getInvestmentSnapshot("amd");
  assert.ok(first && second);
  assert.equal(first.fairValue, second.fairValue);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true, "the second read must reuse the cached snapshot");
});

test("acceptance pass: normal page traffic performs no OpenAI call", async () => {
  const [snapshotLib, snapshotRoute, chainRoute, chainDesk, dashboard] = await Promise.all([
    readFile(new URL("../lib/investment-snapshot.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuation/snapshot/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/options/chain/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/options/chain-desk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [snapshotLib, snapshotRoute, chainRoute, dashboard]) {
    assert.doesNotMatch(source, /api\.openai\.com/);
    assert.doesNotMatch(source, /OPENAI_API_KEY/);
  }
  // The optional AI review only runs from an explicit click.
  assert.match(chainDesk, /onClick=\{\(\) => void requestAiReview\(\)\}/);
  assert.doesNotMatch(chainDesk, /useEffect\([^)]*requestAiReview/s);
  assert.match(dashboard, /\/api\/valuation\/snapshot\?scope=home/);
  assert.match(snapshotLib, /aiUsed: false/);
});

/* ------------------------------------------------------------------ */
/* P0 financial口径                                                    */
/* ------------------------------------------------------------------ */

test("P0 numeric: the DCF discounts by hand-checkable arithmetic, and the cash-flow basis controls the rate and bridge", () => {
  const cashFlows = [10, 12, 14, 16, 18, 20];

  // Unlevered FCFF: discounted at the WACC, then bridged to equity with net cash.
  const unlevered = engine.VALUATION_MODELS.dcf.run({
    cashFlowBasis: "fcff_ebit_bridge",
    cashFlows,
    wacc: 0.1,
    terminalGrowth: 0.03,
    netCashB: 5,
    dilutedSharesB: 2,
  }, null);
  const pv = cashFlows.reduce((sum, cf, i) => sum + cf / 1.1 ** (i + 1), 0);
  const terminal = 20 * 1.03 / (0.1 - 0.03);                 // last CF × (1+g) ÷ (WACC−g)
  const expectedUnlevered = (pv + terminal / 1.1 ** 6 + 5) / 2;
  assert.ok(unlevered.value !== null && Math.abs(unlevered.value - expectedUnlevered) < 1e-9,
    `unlevered DCF ${unlevered.value} must equal the hand-computed ${expectedUnlevered}`);

  // The same stream tagged as the levered CFO−CapEx proxy must discount at the
  // cost of equity with NO net-cash add-back (interest is already in the stream),
  // so the basis changes the number rather than only its label.
  const levered = engine.VALUATION_MODELS.dcf.run({
    cashFlowBasis: "cfo_capex_proxy",
    cashFlows,
    costOfEquity: 0.14,
    terminalGrowth: 0.03,
    netCashB: 5,          // must be ignored for an equity-basis stream
    dilutedSharesB: 2,
  }, null);
  const pvLevered = cashFlows.reduce((sum, cf, i) => sum + cf / 1.14 ** (i + 1), 0);
  const terminalLevered = 20 * 1.03 / (0.14 - 0.03);
  const expectedLevered = (pvLevered + terminalLevered / 1.14 ** 6 + 0) / 2;
  assert.ok(levered.value !== null && Math.abs(levered.value - expectedLevered) < 1e-9,
    `levered DCF ${levered.value} must equal ${expectedLevered} with no net-cash bridge`);
  assert.notEqual(unlevered.value, levered.value, "changing the basis must change the discounted value");

  // A missing net-cash line must withhold the unlevered value rather than read as
  // zero; an explicit zero is a defined value and still produces one.
  const missingBridge = engine.VALUATION_MODELS.dcf.run({
    cashFlowBasis: "fcff_ebit_bridge",
    cashFlows,
    wacc: 0.1,
    terminalGrowth: 0.03,
    dilutedSharesB: 2,
    // netCashB deliberately omitted
  }, null);
  assert.equal(missingBridge.value, null, "a missing net-cash line must fail closed, not default to zero");
  assert.ok(missingBridge.missingInputs.includes("netCashB"));
  const explicitZero = engine.VALUATION_MODELS.dcf.run({
    cashFlowBasis: "fcff_ebit_bridge",
    cashFlows,
    wacc: 0.1,
    terminalGrowth: 0.03,
    netCashB: 0,
    dilutedSharesB: 2,
  }, null);
  assert.ok(explicitZero.value !== null, "an explicit zero net cash is a defined value and still values");
});

test("P0 numeric: the effective tax rate is income tax ÷ pre-tax income (EBT), not ÷ EBIT", async () => {
  const goog = await buildAutomatedValuationPack("GOOG");
  const b = goog.profile.baseline;
  assert.equal(b.taxRateBasis, "book_ebt");
  // Income tax 0.8 / 0.96 / 1.2 B over pre-tax income 4.0 / 4.8 / 6.0 B = 20% each.
  assert.ok(Math.abs(b.effectiveTaxRate - 0.20) < 1e-9, `tax rate ${b.effectiveTaxRate} must be 20%`);
  // A wrong ÷EBIT denominator would give 0.8/5 = 0.96/6 = 1.2/7.5 = 16%, not 20%.
  assert.ok(Math.abs(b.effectiveTaxRate - 0.16) > 1e-9, "the rate must use EBT, not EBIT");
});

test("P0 numeric: reported ΔNWC is subtracted from FCFF; unreported ΔNWC downgrades the basis", async () => {
  // GOOG reports a working-capital balance, so the engine must subtract the
  // year-over-year ΔNWC and tag the bridge a complete FCFF.
  const goog = await buildAutomatedValuationPack("GOOG");
  const g = goog.profile.baseline;
  assert.equal(g.cashFlowBasis, "fcff_ebit_bridge");
  // NWC = receivables + inventory − payables = 1.5 / 1.8 / 2.25 B, so ΔNWC is
  // +0.3 B (2024) and +0.45 B (2025). FCFF = EBIT×(1−0.2) + D&A − CapEx − ΔNWC:
  //   2024: 4.8 + 2.4 − 3.6 − 0.3 = 3.3 → 13.75%; 2025: 6.0 + 3.0 − 4.5 − 0.45 = 4.05 → 13.50%.
  // median margin 13.625% → starting = .65×.13625 + .35×.30 = .1935625,
  // forward margin = .1935625 + (.30 − .1935625)×.25 = .220171875.
  assert.ok(Math.abs(g.fcfMargin - 0.220171875) < 1e-9, `ΔNWC-inclusive margin ${g.fcfMargin} must be 0.220171875`);
  assert.ok(g.fcfMargin < 0.226875, "subtracting ΔNWC must lower the FCFF margin below the pre-NWC level");

  // MU reports EBIT/D&A/capex but no working-capital balance, so the unlevered
  // bridge must be labelled a pre-working-capital proxy — never a complete FCFF.
  // As a levered issuer with reported equity, its cost of equity sits above WACC.
  const mu = await buildAutomatedValuationPack("MU");
  assert.equal(mu.profile.baseline.cashFlowBasis, "fcff_before_nwc");
  const muBasis = mu.profile.dataQuality?.checks.find((check) => check.id === "cash-flow-basis");
  assert.equal(muBasis?.status, "warning");
  assert.ok(mu.profile.baseline.costOfEquity > mu.profile.baseline.wacc, "levered cost of equity must sit above WACC");

  // A generic issuer with no EBIT/D&A history must fall back to the labelled
  // levered CFO−CapEx proxy and never invent an unlevered bridge.
  const nvda = await buildAutomatedValuationPack("NVDA");
  assert.equal(nvda.profile.baseline.cashFlowBasis, "cfo_capex_proxy");
});

// Mutate a provider response, not an internal calculation or source string.
// Every case builds a fresh pack and restores the shared test provider/cache.
async function withGoogFacts(change, verify) {
  const originalFetch = globalThis.fetch;
  resetPackCache();
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!String(args[0]).includes("/companyfacts/CIK0001652044.json")) return response;
    const payload = await response.json();
    change(payload.facts["us-gaap"]);
    return Response.json(payload);
  };
  try {
    await verify(await buildAutomatedValuationPack("GOOG"));
  } finally {
    globalThis.fetch = originalFetch;
    resetPackCache();
  }
}

test("P1: sourced capital-cost inputs flow into the actual valuation pack and provenance", async () => {
  globalThis.__capitalIntegrationMarket = {
    riskFree: { value: 0.04, asOf: "2026-09-18", source: "Treasury test fixture", url: "https://home.treasury.gov/" },
    beta: { value: 1.2, rSquared: 0.6, observations: 180, start: "2026-01-01", end: "2026-09-18", benchmark: "SPY", source: "Adjusted-return test fixture" }, warnings: [],
  };
  try {
    await withGoogFacts(() => {}, (pack) => {
      const cost = pack.profile.capitalCost;
      const assumptions = pack.profile.baseline;
      assert.ok(cost);
      assert.ok(Math.abs(cost.costOfEquity - 0.094) < 1e-12);
      assert.equal(assumptions.costOfEquity, cost.costOfEquity);
      assert.equal(assumptions.wacc, cost.wacc);
      assert.equal(assumptions.costOfEquitySource, "capm_market_inputs");
      assert.match(pack.profile.inputSources.wacc.transformation, /market equity/);
      assert.match(pack.profile.inputSources.costOfEquity.transformation, /policy ERP/);
      assert.equal(pack.profile.inputSources.costOfEquity.asOf, "2026-09-18");
      const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price, simulationCount: 1000 });
      assert.deepEqual(output.engine.capitalCost, cost);
      assert.match(pack.profile.dataQuality.checks.find((check) => check.id === "cost-of-capital-source").detail, /sourced Treasury/);
    });
    await withGoogFacts((facts) => { delete facts.ShortTermBorrowings; }, (pack) => {
      assert.equal(pack.profile.capitalCost, null, "missing debt cannot enter a sourced WACC as zero");
      assert.equal(pack.profile.baseline.costOfEquitySource, "policy_heuristic");
    });
    const imported = await buildAutomatedValuationPack("AMD");
    assert.equal(imported.profile.capitalCost, null, "imported research rates are not silently overwritten");
    assert.equal(imported.profile.inputSources.cashFlows.kind, "analyst_estimate");
    assert.equal(imported.profile.inputSources.cashFlows.transformation, undefined, "an imported cash-flow path must not inherit an automated SEC transformation");
    assert.match(imported.profile.dataQuality.checks.find((check) => check.id === "cost-of-capital-source").detail, /Imported research WACC/);
  } finally {
    delete globalThis.__capitalIntegrationMarket;
    resetPackCache();
  }
});

test("P0: missing NWC components cannot pass as a complete FCFF bridge; explicit zero can", async () => {
  for (const missing of ["InventoryNet", "AccountsPayableCurrent", "AccountsReceivableNetCurrent"]) {
    await withGoogFacts((facts) => { delete facts[missing]; }, (pack) => {
      assert.equal(pack.profile.baseline.cashFlowBasis, "fcff_before_nwc", missing);
      assert.equal(pack.profile.dataQuality.checks.find((c) => c.id === "cash-flow-basis").status, "warning");
    });
  }
  await withGoogFacts((facts) => {
    facts.InventoryNet.units.USD.forEach((row) => { row.val = 0; });
  }, (pack) => {
    assert.equal(pack.profile.baseline.cashFlowBasis, "fcff_ebit_bridge");
    assert.ok(Math.abs(pack.profile.baseline.fcfMargin - 0.224640625) < 1e-9);
  });
  await withGoogFacts((facts) => {
    facts.InventoryNet.units.USD = facts.InventoryNet.units.USD.slice(1);
  }, (pack) => {
    assert.equal(pack.profile.baseline.cashFlowBasis, "fcff_before_nwc", "a missing opening balance is not zero");
  });
});

test("P0: short-term borrowing is added once, without double-counting long-term maturities", async () => {
  const usd = (value, end = "2025-12-31") => ({ units: { USD: [instant(end, value)] } });
  await withGoogFacts((facts) => {
    facts.ShortTermBorrowings = usd(3e9);
    facts.LongTermDebtCurrent = usd(0.5e9);
    facts.LongTermDebtNoncurrent = usd(1.5e9);
  }, (pack) => {
    assert.equal(pack.profile.capitalBridge.debtB, 5);
    assert.equal(pack.profile.baseline.netCashB, 5, "10 cash - (2 long-term + 3 short-term)");
  });
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    facts.ShortTermBorrowings = usd(3e9);
    facts.LongTermDebtCurrent = usd(0.5e9);
    facts.LongTermDebtNoncurrent = usd(1.5e9);
  }, (pack) => {
    assert.equal(pack.profile.baseline.netCashB, 5, "components and aggregate must reconcile");
  });
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    facts.DebtCurrent = usd(3.5e9);
    facts.ShortTermBorrowings = usd(3e9);
    facts.LongTermDebtCurrent = usd(0.5e9);
    facts.LongTermDebtNoncurrent = usd(1.5e9);
  }, (pack) => {
    assert.equal(pack.profile.baseline.netCashB, 5, "current debt total already includes short-term borrowing");
  });
});

test("P0: a gap in fiscal years cannot turn a multi-year NWC change into one year's cash flow", async () => {
  await withGoogFacts((facts) => {
    for (const concept of ["AccountsReceivableNetCurrent", "InventoryNet", "AccountsPayableCurrent"]) {
      facts[concept].units.USD[0].end = "2022-12-31";
    }
  }, (pack) => {
    assert.equal(pack.profile.baseline.cashFlowBasis, "fcff_before_nwc",
      "only one comparable annual change remains; do not use a two-year movement");
  });
});

test("P0: incomplete or different-date debt cannot silently become a complete capital bridge", async () => {
  const usd = (value, end = "2025-12-31") => ({ units: { USD: [instant(end, value)] } });
  for (const change of [
    (facts) => { delete facts.LongTermDebt; facts.LongTermDebtNoncurrent = usd(2e9); },
    (facts) => { facts.LongTermDebt = usd(2e9, "2024-12-31"); },
    (facts) => { facts.ShortTermBorrowings = usd(3e9, "2024-12-31"); },
    (facts) => { delete facts.ShortTermBorrowings; },
  ]) {
    await withGoogFacts(change, (pack) => {
      assert.equal(pack.profile.baseline.netCashB, undefined);
      assert.equal(engine.VALUATION_MODELS.dcf.run(pack.profile.baseline, null).value, null);
      assert.equal(pack.profile.dataQuality.checks.find((c) => c.id === "capital-bridge").status, "warning");
    });
  }
  await withGoogFacts((facts) => {
    facts.LongTermDebt = usd(0);
    facts.ShortTermBorrowings = usd(0);
  }, (pack) => { assert.equal(pack.profile.baseline.netCashB, 10); });
});

test("P0: debt completeness is proven by a disclosed total or split, never by tag absence", async () => {
  const usd = (value, end = "2025-12-31") => ({ units: { USD: [instant(end, value)] } });
  // 1. A disclosed combined total is complete on its own: no short-term tag is
  //    forced to exist, and the total is used verbatim (not summed with children).
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    delete facts.ShortTermBorrowings;
    facts.DebtLongtermAndShorttermCombinedAmount = usd(2e9);
  }, (pack) => {
    assert.equal(pack.profile.capitalBridge.debtB, 2, "combined total used verbatim");
    assert.equal(pack.profile.baseline.netCashB, 8, "10 cash - 2 combined debt");
    assert.match(pack.profile.capitalBridge.debtSource, /combined long-term and short-term debt/);
    assert.equal(pack.profile.dataQuality.checks.find((c) => c.id === "capital-bridge").status, "passed");
  });
  // 2. A complete current + non-current split (Oracle-style notes payable) is
  //    complete without a separate short-term borrowings line.
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    delete facts.ShortTermBorrowings;
    facts.NotesPayableCurrent = usd(0.5e9);
    facts.LongTermNotesAndLoans = usd(1.5e9);
  }, (pack) => {
    assert.equal(pack.profile.capitalBridge.debtB, 2, "current notes + non-current notes");
    assert.equal(pack.profile.baseline.netCashB, 8, "10 cash - (0.5 + 1.5) split debt");
    assert.match(pack.profile.capitalBridge.debtSource, /current debt 500M \+ non-current debt 1500M/);
  });
  // 3. An explicitly reported zero short-term borrowing still yields a complete
  //    bridge alongside the combined total.
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    facts.ShortTermBorrowings = usd(0);
    facts.DebtLongtermAndShorttermCombinedAmount = usd(2e9);
  }, (pack) => {
    assert.equal(pack.profile.baseline.netCashB, 8, "explicit zero short-term borrowing is a value, not a gap");
  });
  // 4. Truly absent debt (no total, no split, no components) is withheld, not
  //    read as zero.
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    delete facts.ShortTermBorrowings;
  }, (pack) => {
    assert.equal(pack.profile.baseline.netCashB, undefined);
    assert.equal(pack.profile.dataQuality.checks.find((c) => c.id === "capital-bridge").status, "warning");
  });
  // 5. A combined total at a different date than cash cannot splice a bridge.
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    delete facts.ShortTermBorrowings;
    facts.DebtLongtermAndShorttermCombinedAmount = usd(2e9, "2024-12-31");
  }, (pack) => {
    assert.equal(pack.profile.baseline.netCashB, undefined, "debt at 2024-12-31 must not bridge against 2025-12-31 cash");
  });
  // 6. When both a combined total and its components are present, the total is
  //    used once — the components are never added on top of it.
  await withGoogFacts((facts) => {
    delete facts.LongTermDebt;
    delete facts.ShortTermBorrowings;
    facts.DebtLongtermAndShorttermCombinedAmount = usd(5e9);
    facts.LongTermDebtCurrent = usd(2e9);
    facts.LongTermDebtNoncurrent = usd(3e9);
  }, (pack) => {
    assert.equal(pack.profile.capitalBridge.debtB, 5, "combined total, not 5 + 2 + 3 = 10");
    assert.equal(pack.profile.baseline.netCashB, 5, "10 cash - 5 combined debt");
  });
});

test("P0: TTM FCFF uses a full-year NWC change, not the change since December", async () => {
  await withGoogFacts((facts) => {
    for (const [concept, prior, current] of [
      ["RevenueFromContractWithCustomerExcludingAssessedTax", 10e9, 20e9],
      ["OperatingIncomeLoss", 2.5e9, 5e9],
      ["DepreciationDepletionAndAmortization", 1e9, 2e9],
      ["PaymentsToAcquirePropertyPlantAndEquipment", 1.5e9, 3e9],
      ["IncomeTaxExpenseBenefit", 0.4e9, 0.8e9],
      ["NetIncomeLoss", 1.6e9, 3.2e9],
    ]) facts[concept].units.USD.push(span("2025-01-01", "2025-06-30", prior), span("2026-01-01", "2026-06-30", current));
    for (const [concept, prior, current] of [
      ["AccountsReceivableNetCurrent", 1.4e9, 3e9],
      ["InventoryNet", 0.7e9, 1.5e9],
      ["AccountsPayableCurrent", 1.05e9, 2.25e9],
    ]) facts[concept].units.USD.push(instant("2025-06-30", prior), instant("2026-06-30", current));
  }, (pack) => {
    // TTM: 10 EBIT × .8 + 4 D&A - 6 CapEx - (2.25 - 1.05) NWC = 4.8.
    // 4.8 / 40 revenue = 12%. Last three margins: 13.75%, 13.5%, 12%.
    const expected = (0.135 * 0.65 + 0.30 * 0.35) * 0.75 + 0.30 * 0.25;
    assert.equal(pack.profile.baseline.cashFlowBasis, "fcff_ebit_bridge");
    assert.ok(Math.abs(pack.profile.baseline.fcfMargin - expected) < 1e-9);
  });
});

test("P0: preferred claims subtract billions, not dollars, from common equity", async () => {
  await withGoogFacts((facts) => {
    facts.PreferredStockValue = { units: { USD: [instant("2025-12-31", 1e9)] } };
  }, (pack) => {
    assert.equal(pack.profile.capitalBridge.preferredClaimsB, 1);
    assert.equal(pack.profile.baseline.netCashB, 7, "10B cash - 2B debt - 1B preferred");
    const a = pack.profile.baseline;
    const withoutPreferred = engine.VALUATION_MODELS.dcf.run({ ...a, netCashB: 8 }, null).value;
    assert.ok(Math.abs(withoutPreferred - engine.VALUATION_MODELS.dcf.run(a, null).value - 0.1) < 1e-9,
      "1B preferred / 10B shares must reduce common value by $0.10/share");
  });
});

test("P0: EV/FCF accepts unlevered inputs only and excludes mismatched models from the ensemble", async () => {
  const assumptions = { forwardFcfB: 10, evFcfMultiple: 20, netCashB: -50, dilutedSharesB: 1 };
  for (const cashFlowBasis of ["fcff_ebit_bridge", "analyst_fcff", "fcff_before_nwc"]) {
    assert.equal(engine.VALUATION_MODELS.ev_fcf.run({ ...assumptions, cashFlowBasis }, null).value, 150);
  }
  for (const cashFlowBasis of ["cfo_capex_proxy", "fcfe_equity", "derived_proxy", "not_applicable", undefined]) {
    const result = engine.VALUATION_MODELS.ev_fcf.run({ ...assumptions, cashFlowBasis }, null);
    assert.equal(result.value, null, String(cashFlowBasis));
    assert.match(result.explanation, /unlevered/i);
    assert.ok(result.missingInputs.length > 0);
  }
  const pack = await buildAutomatedValuationPack("NVDA");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote.price });
  const evFcf = output.models.find((m) => m.model === "ev_fcf");
  assert.equal(evFcf.value, null);
  assert.equal(evFcf.effectiveWeight, 0);
  assert.ok(output.ensemble.fairValue > 0, "valid remaining models still produce a valuation");
});

/* ------------------------------------------------------------------ */
/* Options recommendations                                             */
/* ------------------------------------------------------------------ */

const contracts = [
  { symbol: "SOXL261002P00095000", expiration: "2026-10-02", dte: 18, strike: 95, type: "put", bid: 2.31, ask: 2.46, midpoint: 2.385, spreadPct: 6.3, iv: 0.62, delta: -0.24, volume: 800, openInterest: 2400 },
  { symbol: "SOXL261002P00100000", expiration: "2026-10-02", dte: 18, strike: 100, type: "put", bid: 4.2, ask: 4.6, midpoint: 4.4, spreadPct: 9.1, iv: 0.7, delta: -0.36, volume: 300, openInterest: 500 },
  { symbol: "SOXL261002P00088000", expiration: "2026-10-02", dte: 18, strike: 88, type: "put", bid: 0.85, ask: 1.05, midpoint: 0.95, spreadPct: 21, iv: 0.66, delta: -0.12, volume: 40, openInterest: 60 },
];
const settings = { cash: 30_000, shares: 100, contracts: 1, feesPerContract: 1.3, minReturnPct: 0.5, minDte: 7, maxDte: 30, minAbsDelta: 0.15, maxAbsDelta: 0.35, maxSpreadPct: 12, minOpenInterest: 100, fairValue: 115, buyZone: 92, strongBuyZone: 80 };

test("options picks are deterministic, labelled, and never forced", () => {
  const ranked = options.rankCashSecuredPuts(contracts, 102, settings);
  assert.equal(ranked.length, 1, "only the contract clearing every rule may be ranked");
  const picks = options.buildOptionsPicks(ranked);
  // A single qualifying contract is shown once rather than duplicated.
  assert.deepEqual(picks.map((pick) => pick.label), ["BEST RISK-ADJUSTED"]);
  for (const pick of picks) assert.equal(pick.candidate.symbol, ranked[0].symbol);
  const three = options.buildOptionsPicks([
    { ...ranked[0], symbol: "A", returnOnCashPct: 3, delta: -0.28, assignmentRiskProxyPct: 28, score: 40 },
    { ...ranked[0], symbol: "B", returnOnCashPct: 5, delta: -0.33, assignmentRiskProxyPct: 33, score: 30 },
    { ...ranked[0], symbol: "C", returnOnCashPct: 1, delta: -0.18, assignmentRiskProxyPct: 18, score: 20 },
  ]);
  assert.deepEqual(three.map((pick) => pick.label), ["BEST RISK-ADJUSTED", "BEST INCOME", "MOST CONSERVATIVE"]);
  assert.equal(three[0].candidate.symbol, "A");
  assert.equal(three[1].candidate.symbol, "B");
  assert.equal(three[2].candidate.symbol, "C");
  const candidate = ranked[0];
  // 95 strike less net premium (2.31 bid × 100 less 1.30 fees) / 100 shares.
  assert.equal(candidate.breakeven.toFixed(2), "92.70");
  assert.equal(candidate.valuationSupportLabel, "HIGH");
  assert.equal(candidate.liquidityLabel, "GOOD");
  assert.equal(candidate.recommendation, "ATTRACTIVE");
  // score = premium quality × liquidity × spread × delta × valuation support × IV
  const c = candidate.components;
  const expected = candidate.components.premiumReturn * c.liquidity * c.spread * c.delta * c.valuationSupport * (c.ivAttractiveness ?? 1) * 100;
  assert.ok(Math.abs(candidate.score - expected) < 1e-9);
  assert.deepEqual(options.buildOptionsPicks([]), [], "an empty ranking must stay empty");
  const rejected = options.rankCashSecuredPuts(contracts, 102, { ...settings, minReturnPct: 25 });
  assert.equal(rejected.length, 0, "no qualifying contract must return NO ATTRACTIVE TRADE");
});

test("covered-call scoring uses the separate covered-call formula", () => {
  const calls = [{ symbol: "SOXL261002C00115000", expiration: "2026-10-02", dte: 18, strike: 115, type: "call", bid: 2.4, ask: 2.55, midpoint: 2.475, spreadPct: 6.1, iv: 0.55, delta: 0.26, volume: 700, openInterest: 1800 }];
  const ranked = options.rankCoveredCalls(calls, 102, settings);
  assert.equal(ranked.length, 1);
  const c = ranked[0].components;
  const expected = c.premiumReturn * c.liquidity * c.spread * (c.upsideRetained ?? 1) * (c.strikeVsFairValue ?? 1) * c.delta * 100;
  assert.ok(Math.abs(ranked[0].score - expected) < 1e-9);
});

test("correction pass: the options desk opens on the chain and never forces Sell Put", async () => {
  const [desk, workstation] = await Promise.all([
    readFile(new URL("../app/options/chain-desk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/options/workstation.tsx", import.meta.url), "utf8"),
  ]);

  // Default landing state is the neutral chain, with a real chain-first tablist.
  assert.match(workstation, /useState<ChainTab>\("chain"\)/);
  assert.match(workstation, /tab=\{chainTab\}/);
  assert.match(desk, /aria-selected=\{tab === "chain"\}/);
  assert.match(desk, /Option Chain<\/button>/);
  assert.doesNotMatch(desk, /useState<Strategy>\("put"\)/);
  // The chain is rendered before the recommendations, and the anchor/analyzer
  // preference is only derived from the user's own tab.
  assert.ok(desk.indexOf("opt-broker-chain") < desk.indexOf("opt-reco-grid"), "the chain must render above the recommendations");

  // Bid/Ask hug the frozen strike column on both sides; the basic chain keeps
  // OI/Vol/Bid/Ask for FREE and gates IV/Delta/Greeks behind PRO.
  assert.match(desk, /const callLabels = \["OI", "Vol"/);
  assert.match(desk, /const putLabels = \["Bid", "Ask"/);
  assert.match(desk, /isPro \? \["IV", "Delta"\]/);
  assert.match(desk, /isPro && moreGreeks/);
  assert.match(desk, /strike-cell/);
  assert.match(desk, /strike-head/);
  assert.match(desk, /quote-cell/);

  // Both strategies are ranked and rendered independently.
  assert.match(desk, /const putRanked = useMemo/);
  assert.match(desk, /const callRanked = useMemo/);
  assert.match(desk, /strategyPanel\("put", putRanked, putPicks\)/);
  assert.match(desk, /strategyPanel\("call", callRanked, callPicks\)/);
  assert.match(desk, /DETERMINISTIC RECOMMENDATIONS/);
  assert.doesNotMatch(desk, /Sell Call/);

  // Ticker changes must not select a strategy by themselves.
  assert.doesNotMatch(workstation, /setChainTab\("put"\)/);
  assert.doesNotMatch(workstation, /setChainTab\("call"\)/);
  assert.match(workstation, /if \(value !== "chain"\)/);
});

test("correction pass: recommendation rows expose the full candidate field set", () => {
  const rows = options.rankCashSecuredPuts(contracts, 102, settings);
  const candidate = rows[0];
  for (const field of ["expiration", "dte", "strike", "bid", "ask", "midpoint", "delta", "iv", "openInterest", "volume", "netPremium", "breakeven", "collateralRequired", "sharesRequired", "returnOnCashPct", "annualizedYieldPct", "distanceFromSpotPct", "valuationSupportLabel", "liquidityScore", "riskLabel"]) {
    assert.ok(field in candidate, `candidate is missing ${field}`);
  }
  assert.ok(candidate.distanceFromSpotPct < 0, "a put strike sits below spot");
  assert.equal(candidate.collateralRequired, 9500);
  assert.equal(candidate.sharesRequired, 0);
  const calls = options.rankCoveredCalls([{ symbol: "SOXL261002C00115000", expiration: "2026-10-02", dte: 18, strike: 115, type: "call", bid: 2.4, ask: 2.55, midpoint: 2.475, spreadPct: 6.1, iv: 0.55, delta: 0.26, volume: 700, openInterest: 1800 }], 102, settings)[0];
  assert.equal(calls.sharesRequired, 100);
  assert.equal(calls.collateralRequired, 0);
  assert.ok(calls.distanceFromSpotPct > 0, "a call strike sits above spot");
  assert.ok(["LOW", "MODERATE", "HIGH"].includes(calls.riskLabel));
});

test("the default chain window keeps ±10 strikes and hides dead contracts", () => {
  const wide = [];
  for (let strike = 60; strike <= 160; strike += 5) {
    wide.push({ strike, type: "call", bid: 1, spreadPct: 5, volume: 100, openInterest: 200 });
    wide.push({ strike, type: "put", bid: strike === 100 ? 0 : 1, spreadPct: strike === 105 ? 60 : 5, volume: 100, openInterest: 200 });
  }
  const windowed = options.selectDisplayStrikes(wide, 102);
  assert.ok(windowed.windowed);
  assert.ok(windowed.rows.length <= 21);
  assert.ok(windowed.rows.every((row) => !options.isDeadContract(row.call)));
  assert.ok(windowed.hidden > 0);
  const all = options.selectDisplayStrikes(wide, 102, true);
  assert.equal(all.hidden, 0);
  assert.equal(all.rows.length, wide.length / 2);
  assert.equal(options.isDeadContract({ strike: 100, type: "put", bid: 0, spreadPct: 3 }), true);
  assert.equal(options.isDeadContract({ strike: 100, type: "put", bid: 1, spreadPct: 60 }), true);
  assert.equal(options.isDeadContract({ strike: 100, type: "put", bid: 1, spreadPct: 3 }), false);
});

test("acceptance pass: only bitcoin treasuries pay for a reference price", async () => {
  const before = bitcoinCalls;
  const mstrPack = await buildAutomatedValuationPack("MSTR");
  assert.ok(mstrPack.profile.baseline.bitcoinHoldings > 0, "the bitcoin treasury anchor needs reported holdings");
  assert.ok(mstrPack.profile.baseline.bitcoinPriceUsd > 0, "the bitcoin treasury anchor needs a reference price");
  const afterMstr = bitcoinCalls;
  await buildAutomatedValuationPack("JPM");
  await buildAutomatedValuationPack("NVDA");
  assert.equal(bitcoinCalls, afterMstr, "non-treasury issuers must never trigger a crypto reference call");
  assert.ok(afterMstr >= before);
  assert.ok(secCalls > 0 && nasdaqCalls > 0);
});

test("acceptance report: TSLA, MU, SPCX and AMD stay internally consistent", async () => {
  const report = {};
  for (const ticker of ["TSLA", "MU", "SPCX", "AMD"]) {
    const pack = await buildAutomatedValuationPack(ticker);
    const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
    report[ticker] = {
      price: pack.quote?.price ?? null,
      fairValue: output.ensemble.fairValue,
      rating: output.rating.value,
      confidence: output.ensemble.confidence,
      confidenceLabel: output.confidenceLabel,
      bear: output.ensemble.scenarios.bear,
      base: output.ensemble.scenarios.base,
      bull: output.ensemble.scenarios.bull,
      family: output.classification.modelFamily,
      modelsIncluded: output.engine.modelsIncluded,
      modelsRouted: output.engine.valuationModelsRouted,
      segments: (pack.profile.baseline.sotpSegments ?? []).map((segment) => ({
        name: segment.name,
        value: segment.metricValueB * segment.multiple * (segment.probability ?? 1),
        probability: segment.probability ?? 1,
      })),
      sotpValue: output.models.find((model) => model.model === "sotp")?.value ?? null,
      reconciliation: output.reconciliation,
      forwardMargin: pack.profile.baseline.fcfMargin ?? null,
      netCashB: pack.profile.baseline.netCashB ?? null,
      dilutedSharesB: output.reconciliation.dilutedSharesB,
    };
  }
  console.log("ACCEPTANCE REPORT " + JSON.stringify(report, (key, value) => typeof value === "number" ? Number(value.toFixed(4)) : value));

  // AMD: the previously working valuation must not regress.
  assert.equal(report.AMD.family, "ai_semiconductor");
  assert.ok(report.AMD.fairValue > 0);
  assert.ok(report.AMD.modelsIncluded >= 3);

  // MU: mid-cycle normalization must lift the forecast margin away from the
  // trough years (2% and 3%) and keep at least two models contributing.
  assert.equal(report.MU.family, "memory_cycle_semiconductor");
  assert.ok(report.MU.forwardMargin > 0.12, `MU margin should be cycle-normalized, got ${report.MU.forwardMargin}`);
  assert.ok(report.MU.modelsIncluded >= 2);
  assert.ok(report.MU.fairValue > 0);

  // SPCX: the public-equity SOTP bridge must reconcile to the segment sum.
  const spcx = report.SPCX;
  assert.equal(spcx.family, "integrated_space_connectivity_ai_platform");
  assert.ok(spcx.sotpValue > 0);
  assert.ok(spcx.reconciliation.segmentValueB > 0);
  assert.ok(spcx.reconciliation.dilutedSharesB > 0);
  const implied = (spcx.reconciliation.segmentValueB + spcx.netCashB) / spcx.reconciliation.dilutedSharesB;
  assert.ok(Math.abs(implied - spcx.sotpValue) < 0.01, "segment value + net cash ÷ diluted shares must equal the SOTP per-share value");
  assert.ok(Math.abs(spcx.reconciliation.perShare - spcx.sotpValue) < 0.01);

  // TSLA: every SOTP component is present and probability weighted, the equity
  // bridge ties out, and the primary fair value is always the base estimate.
  const tsla = report.TSLA;
  assert.equal(tsla.family, "auto_energy_optionality_sotp");
  const names = tsla.segments.map((segment) => segment.name).join(" | ");
  for (const expected of ["Automotive", "Energy", "FSD", "Robotaxi", "Optimus", "Stock-based compensation"]) {
    assert.match(names, new RegExp(expected, "i"));
  }
  for (const segment of tsla.segments.filter((item) => /FSD|Robotaxi|Optimus/i.test(item.name))) {
    assert.ok(segment.probability < 1);
  }
  assert.ok(tsla.segments.some((segment) => /Stock-based compensation/i.test(segment.name) && segment.value < 0), "dilution must be an explicit negative claim");
  assert.ok(tsla.bear < tsla.base && tsla.base < tsla.bull);
  assert.equal(tsla.reconciliation.perShare, tsla.sotpValue);
  assert.ok(Math.abs(tsla.reconciliation.equityValueB / tsla.dilutedSharesB - tsla.sotpValue) < 0.01);
  assert.ok(tsla.base > 0, "the base case is always published, including at low confidence");
});

test("engine integrity: every published fair value passes the release gate", async () => {
  const report = {};
  for (const ticker of ["AMD", "TSLA", "MU", "SPCX"]) {
    const pack = await buildAutomatedValuationPack(ticker);
    const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
    report[ticker] = output;
  }
  console.log("INTEGRITY REPORT " + JSON.stringify(Object.fromEntries(Object.entries(report).map(([ticker, output]) => [ticker, {
    price: output.currentPrice.value,
    fairValue: Number((output.ensemble.fairValue ?? 0).toFixed(4)),
    rating: output.rating.value,
    gate: output.releaseGate,
    gateDetail: output.releaseGateDetail,
    publishedBasis: output.engine.publishedBasis,
    confidence: Number((output.ensemble.confidence * 100).toFixed(1)),
    confidenceLabel: output.confidenceLabel,
    confidenceParts: Object.fromEntries(Object.entries(output.confidenceBreakdown).map(([key, value]) => [key, Number(value.toFixed(3))])),
    bridge: output.reconciliation,
    bear: output.ensemble.scenarios.bear,
    base: output.ensemble.scenarios.base,
    bull: output.ensemble.scenarios.bull,
  }]))));

  for (const [ticker, output] of Object.entries(report)) {
    // 1. A published fair value must reconcile exactly.
    assert.ok(output.ensemble.fairValue > 0, `${ticker} published no fair value`);
    assert.equal(output.releaseGate, "passed", `${ticker} failed the release gate: ${output.releaseGateDetail}`);
    assert.equal(output.reconciliation.matchesFairValue, true, `${ticker} bridge does not tie`);
    assert.ok(output.reconciliation.perShare !== null, `${ticker} perShare is null`);
    assert.ok(output.reconciliation.equityValueB !== null, `${ticker} equityValue is null`);
    assert.ok(output.reconciliation.dilutedSharesB > 0, `${ticker} diluted shares missing`);
    const tie = output.reconciliation.equityValueB / output.reconciliation.dilutedSharesB;
    assert.ok(Math.abs(tie - output.ensemble.fairValue) < Math.max(0.02, output.ensemble.fairValue * 0.005), `${ticker} bridge drift`);
    // 1b. The published fair value must equal the Base case.
    assert.ok(Math.abs(output.ensemble.scenarios.base - output.ensemble.fairValue) < 0.01, `${ticker} Base case differs from the published fair value`);
    // 2. A directional rating is only allowed behind a closed gate.
    if (["BUY", "SELL", "STRONG BUY", "REDUCE"].includes(output.rating.value)) {
      assert.equal(output.releaseGate, "passed");
      assert.ok(output.ensemble.confidence >= 0.4, `${ticker} directional rating at low confidence`);
    }
    // 3. Confidence is a named aggregate, never a bare number.
    for (const key of ["dataQuality", "forecastQuality", "modelAgreement", "sourceProvenance", "evidenceFreshness"]) {
      assert.ok(typeof output.confidenceBreakdown[key] === "number" && output.confidenceBreakdown[key] >= 0 && output.confidenceBreakdown[key] <= 1, `${ticker} confidence component ${key} invalid`);
    }
    // 4. A segment SOTP that dominates the ensemble must be the published basis.
    const sotp = output.models.find((model) => model.model === "sotp" && model.value !== null && model.effectiveWeight > 0);
    if (sotp && sotp.effectiveWeight >= 0.6) {
      assert.equal(output.engine.publishedBasis, "reconciled_segment_sotp");
      assert.ok(Math.abs(sotp.value - output.ensemble.fairValue) < 0.01);
    }
    // 5. Prior reliability is a labelled prior, not a claimed backtest.
    for (const model of output.models) assert.ok(typeof model.priorReliability === "number");
    assert.doesNotMatch(output.engine.formula, /historical reliability/);
  }
});

test("engine integrity: snapshot, page and options all quote one canonical snapshot", async () => {
  const [snapshotLib, page, desk, optionsAi] = await Promise.all([
    readFile(new URL("../lib/investment-snapshot.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/fair-value/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/options/chain-desk.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/options-ai.ts", import.meta.url), "utf8"),
  ]);
  // The valuation page reads the canonical snapshot instead of recomputing.
  assert.match(page, /getInvestmentSnapshot/);
  assert.doesNotMatch(page, /buildAutomatedValuationPack/);
  // The snapshot carries the canonical field set.
  for (const field of ["issuerId", "securityId", "snapshotId", "modelsUsed", "modelWeights", "keyAssumptions", "equityBridge", "evidenceFreshness", "releaseGate"]) {
    assert.match(snapshotLib, new RegExp(`${field}`), `snapshot is missing ${field}`);
  }
  // Options consume the snapshot and keep support neutral when the gate failed.
  assert.match(desk, /releaseGate === "passed"/);
  assert.match(desk, /valuation support is neutral/i);
  assert.match(desk, /valuationSnapshotId: snapshot\?\.snapshotId/);
  // The AI review cache key includes chain, strategy, filters and snapshot id.
  for (const key of ["expiration", "chainTimestamp", "filterHash", "valuationSnapshotId"]) {
    assert.match(optionsAi, new RegExp(key), `cache key is missing ${key}`);
  }
  // Deterministic screening presets exist and are not AI-driven.
  assert.match(desk, /OPTIONS_PRESETS/);
  assert.match(desk, /applyOptionsPreset/);
});

test("engine integrity: homepage renders canonical snapshots server-side", async () => {
  const [page, dashboard, desk] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/valuation-desk.tsx", import.meta.url), "utf8"),
  ]);
  // The route must not block first byte on the coverage shelf: twelve canonical
  // snapshots cost seconds on a cold isolate and that delay was paid on every
  // navigation back to Research. The client loads them straight after paint.
  assert.doesNotMatch(page, /await getInvestmentSnapshots/, "the route must not block on snapshots");
  assert.match(dashboard, /initialSnapshots/);
  assert.match(dashboard, /useState<InvestmentSnapshot\[\]>\(initialSnapshots\)/);
  assert.match(dashboard, /\/api\/valuation\/snapshot\?scope=home/, "the client still loads the shelf");
  // The price-versus-value shelf shows price, fair value, gap, rating and confidence.
  assert.match(desk, /valuation-shelf-price/);
  assert.match(desk, /valuation-shelf-confidence/);
  assert.match(desk, /PRICE VS VALUE/);
});

test("master spec: canonical snapshot carries the full spec interface", async () => {
  const snapshot = await snapshotModule.getInvestmentSnapshot("AMD");
  assert.ok(snapshot);
  for (const field of ["snapshotId", "ticker", "securityId", "issuerId", "company", "marketPrice", "marketPriceTimestamp", "fairValue", "bearValue", "baseValue", "bullValue", "upsideDownside", "buyZone", "strongBuyZone", "ratingLabel", "statusLabel", "confidence", "valuationFamily", "selectedModels", "rejectedModels", "equityBridgeView", "marketImpliedExpectations", "keyDrivers", "evidence", "valuationUpdatedAt", "engineVersion"]) {
    assert.ok(field in snapshot, `canonical snapshot is missing ${field}`);
  }
  assert.equal(snapshot.baseValue, snapshot.fairValue, "base case must equal the published fair value");
  assert.equal(snapshot.equityBridgeView.perShareValue, snapshot.fairValue);
  assert.ok(snapshot.evidence.length > 0, "every material input must carry evidence provenance");
  assert.ok(snapshot.selectedModels.length > 0);
  assert.equal(snapshot.engineVersion, snapshot.cache.engineVersion);
  // Quantified reverse valuation, not just prose.
  assert.ok(snapshot.marketImpliedExpectations?.requiredMarginPct !== undefined);
});

test("master spec: AI exposure is classified and cannot double count", async () => {
  const aiModule = await import(dataUrl(await transpile("ai-exposure.ts")));
  const spcx = await buildAutomatedValuationPack("SPCX");
  const spcxOutput = engine.runValuationProfile(spcx.profile, { currentPrice: spcx.quote?.price });
  const spcxAi = spcxOutput.aiExposure;
  assert.ok(spcxAi);
  assert.equal(spcxAi.exposureType, "AI_NATIVE_SEGMENT");
  assert.ok(spcxAi.standaloneSegments.length > 0, "SPCX must carry a standalone AI segment");
  assert.ok((spcxAi.reportedRevenueB ?? 0) > 0 || (spcxAi.estimatedRevenueB ?? 0) > 0, "the AI segment must carry reported or modelled revenue");
  assert.equal(spcxAi.doubleCountCheckPassed, true);
  // The AI segment must not be a multiple of consolidated SpaceX revenue.
  const aiSegment = (spcx.profile.baseline.sotpSegments ?? []).find((segment) => /^ai segment/i.test(segment.name));
  assert.ok(aiSegment, "the reported AI segment must exist in the SOTP");
  assert.ok(aiSegment.metricValueB !== spcx.profile.baseline.forwardRevenueB, "AI value must come from the AI segment, not consolidated revenue");
  // AI is a reportable segment, so its driver is reported data.
  assert.equal(aiSegment.driverSource, "reported");

  const nvda = await buildAutomatedValuationPack("NVDA");
  const nvdaAi = engine.runValuationProfile(nvda.profile, { currentPrice: nvda.quote?.price }).aiExposure;
  assert.equal(nvdaAi.exposureType, "AI_INFRASTRUCTURE");
  assert.equal(nvdaAi.standaloneSegments.length, 0, "embedded AI must not create a standalone segment");
  assert.equal(nvdaAi.doubleCountCheckPassed, true);

  // The classifier never creates AI value from wording alone.
  const none = aiModule.classifyAiExposure({ ticker: "KO", familyId: "consumer_staples", segments: [], forwardRevenueB: 40 });
  assert.equal(none.materiality, "NONE");
  assert.equal(none.doubleCountCheckPassed, true);
});

test("master spec: GOOG and GOOGL share one issuer-level intrinsic value", async () => {
  const [goog, googl] = await Promise.all([snapshotModule.getInvestmentSnapshot("GOOG"), snapshotModule.getInvestmentSnapshot("GOOGL")]);
  assert.ok(goog && googl);
  assert.equal(goog.issuerId, googl.issuerId, "both share classes must resolve to one issuer");
  assert.equal(goog.valuationFamily, googl.valuationFamily);
  assert.ok(Math.abs(goog.fairValue - googl.fairValue) < 1e-9, "intrinsic value must not differ by share class");
  assert.equal(goog.equityBridgeView.perShareValue, googl.equityBridgeView.perShareValue);
});

test("SPCX quality: reported segment data overrides model assumptions", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const spcx = output.spcx;
  assert.ok(spcx, "the SPCX detail must be published");
  const reported = spcx.reported;
  // Three reported segments with revenue, operating income, D&A, SBC and capex.
  assert.ok(reported.quarter && reported.halfYear);
  for (const segment of ["space", "connectivity", "ai"]) {
    assert.ok(reported.halfYear[segment].revenue > 0, `${segment} reported revenue missing`);
    assert.ok(reported.halfYear[segment].depreciationAmortization > 0, `${segment} reported D&A missing`);
    assert.ok(reported.halfYear[segment].capitalExpenditures > 0, `${segment} reported capex missing`);
  }
  // AI is valued from reported revenue and reported segment adjusted EBITDA
  // (operating income + D&A + share-based compensation), not a $4B guess.
  assert.ok(Math.abs(spcx.ai.revenueB - (reported.halfYear.ai.revenue * 2) / 1000) < 1e-6);
  assert.ok(Math.abs(spcx.ai.ebitdaB - ((reported.halfYear.ai.operatingIncome + reported.halfYear.ai.depreciationAmortization + reported.halfYear.ai.shareBasedCompensation) * 2) / 1000) < 1e-6);
  assert.ok(spcx.ai.capexB > 20, "AI capital expenditure must come from the filing");
  // No placeholder 1.0x multiple anywhere in the segment methods.
  for (const segment of spcx.segments) {
    assert.match(segment.method, /forward EV\/EBITDA/i);
    assert.match(segment.method, /discounted two years/i);
    assert.match(segment.method, /margin/i);
    assert.doesNotMatch(segment.method, /1\.0×/);
    assert.ok(segment.anchorMultiple2028 >= 8, `${segment.segment} must carry a real forward multiple`);
  }
});

test("SPCX quality: Starship is a scenario tree whose probabilities sum to 100%", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const starship = output.spcx.starship;
  assert.equal(starship.scenarios.length, 4);
  assert.ok(Math.abs(starship.probabilitySum - 1) < 1e-9, "scenario probabilities must sum to 100%");
  for (const scenario of starship.scenarios) {
    assert.ok(scenario.probability > 0 && scenario.probability < 1);
    assert.ok(scenario.revenuePerLaunchM > 0 && scenario.launchCostM > 0);
    assert.ok(scenario.note.length > 10, "each scenario must state its economics");
  }
  // Scenario economics differ, so the expected value is not one probability
  // multiplication destroying the whole option.
  const npvs = new Set(starship.scenarios.map((scenario) => scenario.npvB.toFixed(3)));
  assert.ok(npvs.size > 1, "scenario NPVs must differ");
  assert.ok(starship.expectedValueB > 0);
});

test("SPCX quality: gates, buy zone and rating are gated on the quality review", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const review = output.qualityReview;
  assert.ok(review);
  assert.equal(review.gates.length, 3);
  const spcx = output.spcx;
  // Share count is part of the data gate and must be reconciled.
  assert.ok(spcx.shareBridge.fullyDilutedSharesCurrentB >= (spcx.shareBridge.basicSharesCurrentB ?? 0));
  // Buy zone only when every gate passed.
  if (review.publishable) {
    assert.ok(spcx.buyZone, "a publishable valuation must carry a buy zone");
    assert.ok(spcx.buyZone.buyPrice < spcx.fairValue);
    assert.ok(spcx.buyZone.strongBuyPrice < spcx.buyZone.buyPrice);
    assert.equal(output.rating.buyZone, spcx.buyZone.buyPrice);
    assert.equal(output.rating.strongBuyZone, spcx.buyZone.strongBuyPrice);
  } else {
    assert.equal(spcx.buyZone, null);
    assert.equal(output.rating.buyZone, null);
    assert.equal(output.rating.strongBuyZone, null);
    assert.equal(output.rating.value, "WATCH");
    assert.match(output.rating.rationale, /MODEL REVIEW REQUIRED|MODEL DIVERGENCE/);
    assert.ok(review.preliminaryFairValue !== null, "the preliminary number stays available in the audit");
  }
  // Divergence review is explained, never silently adjusted.
  if (review.status === "MODEL_DIVERGENCE_REVIEW") {
    assert.ok(review.divergence.explanation.length >= 3);
    assert.ok(review.whyDifferent.length > 0);
  }
});

test("SPCX quality: identities, implied multiples and share count all reconcile", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const spcx = output.spcx;
  const shares = spcx.shareBridge.fullyDilutedSharesCurrentB;
  // Identities.
  assert.ok(Math.abs(output.ensemble.fairValue - spcx.fairValue) / spcx.fairValue <= 0.0025);
  assert.ok(Math.abs(spcx.equityValueB / shares - spcx.fairValue) / spcx.fairValue <= 0.0025);
  assert.ok(Math.abs(output.ensemble.fairValue - output.ensemble.scenarios.base) < 1e-6);
  const segmentSum = spcx.segments.reduce((total, segment) => total + segment.enterpriseValueB, 0);
  assert.ok(Math.abs(segmentSum + spcx.starship.expectedValueB + spcx.otherOptionality.valueB + spcx.netCorporateB - spcx.equityValueB) < 1e-6, "segments + Starship + strategic optionality + net corporate must equal equity value");
  // The contribution table is the same identity per share.
  assert.ok(Math.abs(spcx.valuationContributionTotalB - spcx.equityValueB) < 1e-6);
  assert.ok(Math.abs(spcx.fairValue - spcx.equityValueB / shares) < 1e-6);
  // Implied multiples are computed, not asserted.
  assert.ok(spcx.impliedMultiples.fairValueEvEbitda !== null || spcx.impliedMultiples.fairValueEvRevenue !== null);
  assert.ok(spcx.impliedMultiples.marketCapB !== null);
  console.log("SPCX QUALITY " + JSON.stringify({
    shares: Number(shares.toFixed(4)),
    fairValue: Number(spcx.fairValue.toFixed(2)),
    space: Number(spcx.space.enterpriseValueB.toFixed(1)),
    connectivity: Number(spcx.connectivity.enterpriseValueB.toFixed(1)),
    ai: Number(spcx.ai.enterpriseValueB.toFixed(1)),
    starship: Number(spcx.starship.expectedValueB.toFixed(1)),
    netCorporate: Number(spcx.netCorporateB.toFixed(1)),
    gates: output.qualityReview.status,
    publishable: output.qualityReview.publishable,
    evEbitda: output.qualityReview.impliedMultiples.fairValueEvEbitda === null ? null : Number(output.qualityReview.impliedMultiples.fairValueEvEbitda.toFixed(1)),
    marketEvEbitda: output.qualityReview.impliedMultiples.marketEvEbitda === null ? null : Number(output.qualityReview.impliedMultiples.marketEvEbitda.toFixed(1)),
    gapPct: output.qualityReview.divergence.gapPct === null ? null : Number(output.qualityReview.divergence.gapPct.toFixed(1)),
  }));
});

test("SPCX quality: SOTP stays primary while the DCF and forward multiple are shown as cross-checks", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const spcx = output.spcx;
  const crossChecks = spcx.crossChecks;
  assert.equal(crossChecks.publishedFrom, "SOTP");
  assert.ok(Math.abs(crossChecks.sotp.perShare - spcx.fairValue) < 1e-6, "the SOTP cross-check must be the published value");
  // All three models produce their own number from their own inputs.
  assert.ok(crossChecks.dcf.perShare > 0 && crossChecks.forwardMultiple.perShare > 0);
  assert.match(crossChecks.dcf.inputs, /terminal value/i);
  assert.match(crossChecks.forwardMultiple.inputs, /build capital/i);
  assert.ok(crossChecks.blendedDiscountRate > 0.08 && crossChecks.blendedDiscountRate < 0.15);
  assert.ok(crossChecks.blendedTerminalMultiple > 5 && crossChecks.blendedTerminalMultiple < 15);
  // Each segment also carries its own DCF and EV/Sales cross-check.
  for (const segment of spcx.segments) {
    assert.ok(segment.methodValues.dcfB > 0 && segment.methodValues.forwardSalesB > 0);
    assert.ok(segment.methodValues.primaryForwardEbitdaB === segment.enterpriseValueB);
  }
  // Weights are stated and never averaged into the published number.
  assert.ok(Math.abs(crossChecks.sotp.weight + crossChecks.dcf.weight + crossChecks.forwardMultiple.weight - 1) < 1e-9);
  assert.match(crossChecks.weightsNote, /never averaged/i);

  // Market-implied expectations solve each lever instead of only calling the price expensive.
  const marketImplied = spcx.marketImplied;
  assert.ok(marketImplied.marketEquityValueB !== null);
  assert.ok(marketImplied.valueGapB !== null);
  const ai2028 = spcx.forecast[2];
  const connectivity2028 = spcx.forecast[2];
  assert.ok(marketImplied.requiredConnectivity2028RevenueB > connectivity2028.connectivityRevenue);
  assert.ok(marketImplied.requiredAi2028RevenueB > ai2028.aiRevenue);
  assert.ok(marketImplied.requiredAi2028Multiple > 20, "the reverse solve must state the multiple the price implies");
  assert.ok(marketImplied.requiredAi2028EbitdaMargin > 0.38, "the reverse solve must state the AI margin the price implies");
  assert.ok(marketImplied.combination.length >= 2, "the combination solve must be stated");
  assert.ok(marketImplied.requiredStarshipNpvB > spcx.starship.expectedValueB);
  assert.equal(marketImplied.equalSplit.length, 5);
  for (const row of marketImplied.equalSplit) assert.ok(row.requirement.length > 20, `${row.lever} must state a quantified requirement`);
  assert.match(marketImplied.headline, /requires about \$/);
});

test("SPCX quality: every segment carries value and the forecast is built from its drivers", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const spcx = output.spcx;

  // Space Core may not be zeroed by another segment's development spending.
  for (const segment of spcx.segments) {
    assert.ok(segment.enterpriseValueB > 0, `${segment.segment} must carry a positive value, not a zero floor`);
    assert.match(segment.method, /forward EV\/EBITDA/i);
    assert.ok(segment.methodValues.dcfB > 0 && segment.methodValues.forwardSalesB > 0, `${segment.segment} needs both cross-checks`);
  }
  // Connectivity is built from subscribers × ARPU plus the reported sub-lines and
  // the sub-lines must reconcile to the reported segment total.
  for (const row of spcx.forecast) {
    const subLines = (row.consumerRevenue ?? 0) + (row.enterpriseRevenue ?? 0) + (row.starshieldRevenue ?? 0) + (row.directToDeviceRevenue ?? 0);
    assert.ok(Math.abs(subLines - row.connectivityRevenue) < 0.05, `FY${row.year} Connectivity sub-lines must sum to the segment revenue`);
    assert.ok((row.consumerSubscribersM ?? 0) > 0 && (row.consumerArpuMonthly ?? 0) > 0);
    assert.ok((row.aiDeployedCapitalB ?? 0) > 0, `FY${row.year} AI revenue must follow deployed capital`);
  }
  const first = spcx.forecast[0];
  const reportedConsumer = (spcx.reported.revenueDetail.find((line) => line.label === "Consumer")?.halfYear ?? 0) * 2 / 1000;
  assert.ok(Math.abs(first.consumerRevenue - reportedConsumer) < 0.01, "the anchor year Consumer revenue must be the reported run-rate");
  // The plan ramps to the calibration: 2028E AI $105B and Connectivity $42B.
  assert.ok(Math.abs(spcx.forecast[2].aiRevenue - 105) < 1e-6, "2028E AI revenue must equal the calibration");
  assert.ok(Math.abs(spcx.forecast[2].connectivityRevenue - 42) < 1e-6, "2028E Connectivity revenue must equal the calibration");

  // Starship is generated from its drivers: launch economics plus the measurable
  // Starlink deployment saving and orbital infrastructure.
  const full = spcx.starship.scenarios.find((scenario) => /FULL REUSABILITY/.test(scenario.name));
  const failure = spcx.starship.scenarios.find((scenario) => scenario.name === "FAILURE");
  assert.ok((full.internalSavingsB ?? 0) > 0, "full reuse must carry the Starlink deployment saving");
  assert.ok((full.orbitalInfrastructureRevenueB ?? 0) > 0, "full reuse must carry the orbital infrastructure economics");
  const baseScale = spcx.starship.scenarios.find((scenario) => /BASE COMMERCIAL/.test(scenario.name));
  assert.ok((full.npvB ?? 0) > (baseScale.npvB ?? 0), "full reuse must be worth more than base commercial scale");
  assert.equal(failure.npvB, 0, "the failure case is worth zero, not a negative carried into the bridge");
  assert.ok(spcx.starship.expectedValueB >= 0);
  // The expected value must equal the probability-weighted scenario values.
  const weighted = spcx.starship.scenarios.reduce((sum, scenario) => sum + scenario.npvB * scenario.probability, 0);
  assert.ok(Math.abs(weighted - spcx.starship.expectedValueB) < 1e-6);

  // The published value still follows SOTP, and the cases stay ordered.
  const [core, base, vision] = spcx.cases;
  assert.equal(base.published, true);
  assert.ok(core.value < base.value && base.value < vision.value, "CORE < BASE < VISION");
  assert.ok(Math.abs(base.value - spcx.fairValue) < 1e-6);
});

test("SPCX quality: the calibration is applied as inputs and every published number is recomputed", async () => {
  const pack = await buildAutomatedValuationPack("SPCX");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const spcx = output.spcx;
  const calibration = spcx.calibration.BASE;

  // The 2028E plan is the calibration, and the segment values are recomputed from
  // EBITDA × multiple ÷ (1 + discount)² rather than typed in.
  const expect = {
    Connectivity: { revenue: 42, margin: 0.58, multiple: 16, discount: 0.1 },
    AI: { revenue: 105, margin: 0.38, multiple: 20, discount: 0.12 },
    Space: { revenue: 8, margin: 0.2, multiple: 15, discount: 0.1 },
  };
  for (const segment of spcx.segments) {
    const rules = expect[segment.segment];
    const ebitda2028 = rules.revenue * rules.margin;
    const expected = (ebitda2028 * rules.multiple) / (1 + rules.discount) ** 2;
    assert.ok(Math.abs(segment.anchorRevenue2028B - rules.revenue) < 1e-6, `${segment.segment} 2028E revenue must equal the calibration`);
    assert.ok(Math.abs(segment.anchorEbitda2028B - ebitda2028) < 1e-6, `${segment.segment} 2028E EBITDA must be revenue × margin`);
    assert.ok(Math.abs(segment.enterpriseValueB - expected) < 0.5, `${segment.segment} value must be EBITDA × multiple discounted two years`);
    assert.ok(segment.methodValues.dcfB > 0 && segment.methodValues.forwardSalesB > 0);
  }

  // Starship expected value = probability-weighted scenario values, and the
  // contribution table is the equity bridge expressed per share.
  const weightedStarship = spcx.starship.scenarios.reduce((sum, scenario) => sum + scenario.npvB * scenario.probability, 0);
  assert.ok(Math.abs(weightedStarship - spcx.starship.expectedValueB) < 1e-6);
  const contributionTotal = spcx.valuationContribution.reduce((sum, row) => sum + row.valueB, 0);
  assert.ok(Math.abs(contributionTotal - spcx.equityValueB) < 1e-6);
  for (const row of spcx.valuationContribution) {
    assert.ok(Math.abs(row.perShare - row.valueB / spcx.shareBridge.fullyDilutedSharesCurrentB) < 1e-6, `${row.component} per share must be value ÷ diluted shares`);
  }

  // The three cases are generated from their own calibrations.
  assert.ok(spcx.cases[0].value > 40 && spcx.cases[0].value < 90, "CORE should be a conservative but non-trivial value");
  assert.ok(spcx.cases[1].value > 70 && spcx.cases[1].value < 130, "BASE should land near the institutional calibration");
  assert.ok(spcx.cases[2].value > spcx.cases[1].value * 1.3, "VISION must be materially above base");

  // The market-implied block answers the price question with numbers.
  assert.ok(spcx.marketImplied.requiredAi2028RevenueB > calibration.revenueB.AI[2]);
  assert.ok(spcx.marketImplied.requiredAi2028EbitdaMargin > calibration.ebitdaMargin.AI[2]);
  assert.ok(spcx.marketImplied.requiredAi2028Multiple > calibration.forwardMultiple2028.AI);
  assert.ok(spcx.marketImplied.requiredStarshipExpectedB > spcx.starship.expectedValueB);
  assert.ok(spcx.marketImplied.combination.length >= 2);

  // Public targets are captured for comparison but never enter the calculation.
  assert.ok(spcx.externalResearch.length >= 3);
  for (const entry of spcx.externalResearch) assert.ok(entry.target === null || entry.target > 0);
  assert.match(spcx.externalResearch[0].institution, /.+/);
  assert.ok(!spcx.valuationContribution.some((row) => /Goldman|JPMorgan|Morgan/.test(row.component)));
});

test("MU quality: reported anchors, product mix and the published value flow through the pipeline", async () => {
  const pack = await buildAutomatedValuationPack("MU");
  const output = engine.runValuationProfile(pack.profile, { currentPrice: pack.quote?.price });
  const mu = output.mu;
  assert.ok(mu, "the MU detail must be published");

  // Reported anchors: latest quarter, fiscal year to date and the product table.
  assert.equal(mu.anchors.quarter.revenueM, 41_456);
  assert.equal(mu.anchors.quarter.grossProfitM, 35_056);
  assert.equal(mu.anchors.quarter.operatingIncomeM, 33_318);
  assert.equal(mu.anchors.yearToDate.revenueM, 78_959);
  // Trailing twelve months are rolled forward, not read as a single interim period.
  assert.equal(mu.anchors.ttm.revenueM, 37_378 + 78_959 - 26_063);
  assert.ok(Math.abs(mu.anchors.ttm.eps - (7.59 + 41.4 - 4.75)) < 1e-6, "trailing EPS is a real rollforward");
  assert.deepEqual(mu.anchors.productRevenue.quarter, { dramM: 31_328, nandM: 9_943, otherM: 185, totalM: 41_456 });
  assert.equal(mu.qualityGates.data, true);
  assert.equal(mu.qualityGates.publishable, true);

  // The published fair value is the MU model, and the homepage snapshot uses it.
  assert.equal(output.ensemble.fairValue, mu.weightedFairValue);
  assert.equal(output.releaseGate, "passed");
  const snapshot = snapshotModule.toInvestmentSnapshot(output, { issuerId: "micron" });
  assert.equal(snapshot.fairValue, mu.weightedFairValue);

  // HBM is its own business and legacy memory normalises one year at a time.
  const margins = mu.forecast.map((row) => row.grossMargin);
  for (let index = 1; index < margins.length; index += 1) assert.ok(margins[index] <= margins[index - 1]);
  assert.ok(margins[0] - margins[1] < 0.12);
  assert.ok(mu.forecast[1].hbmRevenueB > mu.forecast[0].hbmRevenueB);
  assert.ok(mu.forecast.at(-1).hbmShareOfDram > mu.forecast[0].hbmShareOfDram);
  assert.equal(mu.structuralChange.assessed, true);

  // The routed SOTP segments are the same engine, so the segment sum reconciles.
  const segments = pack.profile.baseline.sotpSegments ?? [];
  assert.ok(segments.length >= 4);
  const segmentSum = segments.reduce((total, segment) => total + segment.metricValueB * segment.multiple * (segment.probability ?? 1), 0);
  assert.ok(Math.abs(segmentSum - mu.segmentBreakdown.enterpriseValueB) < 0.5);
  assert.match(segments.map((segment) => segment.name).join(" | "), /HBM \/ AI memory/);

  // Market-implied expectations and the honest consensus note.
  assert.ok(mu.marketImplied.requiredTerminalGrossMargin > mu.legacy.terminalMargin);
  assert.ok(mu.marketImplied.explanation.length >= 3);
  assert.equal(mu.consensus.available, false);
  // The buy zone is expected-return based and the published rating uses it.
  assert.ok(mu.buyZone && mu.buyZone.buyPrice > 0);
  assert.equal(output.rating.buyZone, mu.buyZone.buyPrice);
  assert.equal(output.rating.strongBuyZone, mu.buyZone.strongBuyPrice);

  console.log("MU QUALITY " + JSON.stringify({
    fairValue: Number(mu.weightedFairValue.toFixed(2)),
    eps27: mu.sanity.forwardEps27,
    eps28: mu.sanity.forwardEps28,
    normalizedEps: mu.sanity.normalizedEps,
    fvOverEps27: mu.sanity.fairValueOverEps27,
    evEbitda28: mu.sanity.evEbitda28,
    terminalMargin: Number(mu.legacy.terminalMargin.toFixed(3)),
    requiredMarketMargin: mu.marketImplied.requiredTerminalGrossMargin,
    revenue2030: mu.forecast.at(-1).revenueB,
    hbm2030: mu.forecast.at(-1).hbmRevenueB,
    gates: mu.qualityGates.publishable,
  }));
});


/* ------------------------------------------------------------------ */
/* Shared valuation cache                                              */
/* ------------------------------------------------------------------ */

/** Stand-in for caches.default: shared across isolates, survives memory resets. */
function fakeEdgeCache() {
  const store = new Map();
  return {
    store,
    async match(key) {
      const entry = store.get(String(key));
      return entry ? new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json" } }) : undefined;
    },
    async put(key, response) {
      store.set(String(key), await response.json());
    },
  };
}

function ageSharedSnapshots(edge, ms) {
  for (const [key, entry] of edge.store) {
    if (String(key).includes("investment-snapshot")) entry.storedAt = Date.now() - ms;
  }
}

test("the pack cache key carries the engine and issuer profile versions", () => {
  const base = packCacheKey("AMD", "profile-v1");
  assert.ok(base.includes(ENGINE_VERSION), "a bumped engine version must change every key");
  assert.match(base, /AMD/);
  assert.notEqual(base, packCacheKey("AMD", "profile-v2"), "a new issuer profile version invalidates");
  assert.notEqual(base, packCacheKey("AMD", null));
  assert.notEqual(base, packCacheKey("META", "profile-v1"), "tickers do not share an entry");
});

test("P0: shared views never reuse a snapshot from before the financial-basis fix", async () => {
  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
  snapshotModule.resetSnapshotMemory();
  resetPackCache();
  try {
    for (const version of ["signal-ledger.investment-snapshot.v2", "signal-ledger.investment-snapshot.v2.universal-v5"]) {
      edge.store.set(`https://signal-ledger.internal/investment-snapshot/${version}/GOOG`, {
        storedAt: Date.now(), snapshot: { ticker: "GOOG", fairValue: 999999 },
      });
    }
    const before = secCalls;
    const snapshot = await snapshotModule.getInvestmentSnapshot("GOOG");
    assert.ok(snapshot?.fairValue > 0);
    assert.notEqual(snapshot.fairValue, 999999);
    assert.ok(secCalls > before, "an old-version snapshot cannot bypass the repaired engine");
    assert.ok(snapshot.cache.engineVersion.includes(ENGINE_VERSION));
  } finally {
    delete globalThis.caches;
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
  }
});

test("a cold isolate reuses another isolate's retrieval instead of re-running SEC", async () => {
  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
  try {
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const before = secCalls;
    const warm = await snapshotModule.getInvestmentSnapshot("NVDA");
    assert.ok(warm, "the first isolate values the security");
    // The shared-cache write is deliberately not awaited on the caller's path.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterFirst = secCalls;
    assert.ok(afterFirst > before, "the first isolate had to retrieve from SEC");
    assert.ok([...edge.store.keys()].some((k) => k.includes("valuation-pack")), "the pack is published");
    assert.ok([...edge.store.keys()].some((k) => k.includes("investment-snapshot") && k.includes(ENGINE_VERSION)), "shared views are versioned with the calculation engine");

    // A new isolate: same shared cache, empty in-memory caches.
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const cold = await snapshotModule.getInvestmentSnapshot("NVDA");
    assert.ok(cold, "the cold isolate still answers");
    assert.equal(secCalls, afterFirst, "no SEC retrieval for a shared-cache hit");
    assert.equal(cold.fairValue, warm.fairValue, "and it answers with the same valuation");
  } finally {
    delete globalThis.caches;
  }
});

test("a stale shared snapshot is served immediately while a refresh runs behind it", async () => {
  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
  try {
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const fresh = await snapshotModule.getInvestmentSnapshot("GOOG");
    assert.ok(fresh);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok([...edge.store.keys()].some((k) => k.includes("investment-snapshot")), "the snapshot reached the shared cache");
    ageSharedSnapshots(edge, snapshotModule.SNAPSHOT_TTL_MS + 60_000);
    snapshotModule.resetSnapshotMemory();
    resetPackCache();

    const served = await snapshotModule.getInvestmentSnapshot("GOOG");
    assert.ok(served, "the last released valuation is returned rather than nothing");
    assert.equal(served.stale, true, "and it is flagged as being refreshed");
    assert.equal(served.fairValue, fresh.fairValue, "no recomputation was awaited");
  } finally {
    delete globalThis.caches;
  }
});

test("a failed refresh preserves the last released valuation", async () => {
  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
  try {
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const released = await snapshotModule.getInvestmentSnapshot("JPM");
    assert.ok(released);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ageSharedSnapshots(edge, snapshotModule.SNAPSHOT_TTL_MS + 60_000);
    snapshotModule.resetSnapshotMemory();
    resetPackCache();

    failSec = true;
    try {
      const served = await snapshotModule.getInvestmentSnapshot("JPM");
      assert.ok(served, "an upstream outage must not erase a good valuation");
      assert.equal(served.fairValue, released.fairValue);
    } finally {
      failSec = false;
    }
  } finally {
    delete globalThis.caches;
  }
});

test("the batch endpoint serves shared-cache hits without re-retrieving", async () => {
  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
  try {
    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const seed = TICKERS.map(([ticker]) => ticker);
    await snapshotModule.getInvestmentSnapshots(seed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok([...edge.store.keys()].some((k) => k.includes("investment-snapshot")), "the batch published to the shared cache");

    snapshotModule.resetSnapshotMemory();
    resetPackCache();
    const before = secCalls;
    const snapshots = await snapshotModule.getInvestmentSnapshots(seed);

    assert.equal(snapshots.length, seed.length, "every ticker still resolves");
    assert.equal(secCalls, before, "cached tickers never wait on, or repeat, a SEC retrieval");
  } finally {
    delete globalThis.caches;
  }
});

/* ------------------------------------------------------------------ */
/* Task D: latest evidence drives the current valuation (AMD/ORCL)     */
/* ------------------------------------------------------------------ */

// AMD reports four operating segments in its 10-Q. The scoped provider below
// supplies that segment table so the parser builds a live SOTP instead of
// falling back to the frozen Sep-11 research snapshot. Other tickers, and the
// Nasdaq quote, are delegated unchanged.
async function withAmdFiling(segmentRevenueM, verify) {
  const originalFetch = globalThis.fetch;
  resetPackCache();
  globalThis.fetch = async (...args) => {
    const url = String(args[0]);
    if (url.startsWith("https://data.sec.gov/submissions/")) {
      const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
      if (cik === 2488) {
        return Response.json({
          name: "Advanced Micro Devices",
          sic: "3674",
          sicDescription: "Semiconductors",
          filings: { recent: {
            form: ["10-Q"], accessionNumber: ["0000002488-26-000015"], primaryDocument: ["amd-20260630.htm"],
            filingDate: ["2026-08-04"], reportDate: ["2026-06-30"],
          } },
        });
      }
    }
    if (url.startsWith("https://www.sec.gov/Archives/") && url.includes("amd-20260630")) {
      const { dataCenter, client, gaming, embedded } = segmentRevenueM;
      // Mirrors AMD's real 10-Q: `$` only on the Data Center row, bare numbers
      // on the rest, and a "Client and Gaming" subtotal header the word
      // boundary must skip so "Client" reads the segment row, not the header.
      return new Response([
        "Net revenue:",
        `Data Center $ ${dataCenter}`,
        "Client and Gaming",
        `Client ${client}`,
        `Gaming ${gaming}`,
        `Total Client and Gaming ${client + gaming}`,
        `Embedded ${embedded}`,
        `Total net revenue ${dataCenter + client + gaming + embedded}`,
      ].join(" "), { headers: { "content-type": "text/html" } });
    }
    return originalFetch(...args);
  };
  try {
    return await verify(await buildAutomatedValuationPack("AMD"));
  } finally {
    globalThis.fetch = originalFetch;
    resetPackCache();
  }
}

const AMD_Q = { dataCenter: 7169, client: 1872, gaming: 418, embedded: 829 };

test("Task D: AMD segment evidence builds a live SOTP and demotes the curated baseline to a frozen reference", async () => {
  const pack = await withAmdFiling(AMD_Q, (pack) => pack);
  const baseline = pack.profile.baseline;
  // The current valuation is the SEC-derived segment SOTP, not the imported snapshot.
  const names = (baseline.sotpSegments ?? []).map((segment) => segment.name).join(" | ");
  assert.match(names, /Data Center/);
  assert.match(names, /Client/);
  assert.match(names, /Gaming/);
  assert.match(names, /Embedded/);
  // No invented AI line: the parser reads only the four disclosed segments.
  assert.doesNotMatch(names, /\bAI\b/);
  // forwardRevenueB is the annualized grown segment sum, not the curated $87.7B.
  assert.ok(baseline.forwardRevenueB > 40 && baseline.forwardRevenueB < 60, `forward revenue ${baseline.forwardRevenueB}`);
  // The frozen reference is retained as a historical snapshot, but the live
  // baseline is a different object driven by the filing.
  assert.ok(pack.profile.importedResearch, "the frozen snapshot must remain for comparison");
  assert.notEqual(baseline, pack.profile.importedResearch.baseline);
  assert.equal(pack.profile.importedResearch.asOf, "2026-09-11");
  // The pack is a reported internal forecast, not relabelled imported research.
  assert.equal(pack.profile.sourcePosture, "reported_internal_forecast");
  const check = pack.profile.dataQuality?.checks.find((c) => c.id === "company-specific-driver-pack");
  assert.equal(check?.status, "passed", "the segment parser must pass, not warn");

  // The segment SOTP is the company-specific model: it must dominate and be the
  // published basis rather than blending in a generic historical-growth DCF.
  const output = engine.runValuationProfile(pack.profile, { currentPrice: 210 });
  const sotp = output.models.find((m) => m.model === "sotp");
  assert.ok(sotp && sotp.value > 0, "the SOTP must calculate");
  assert.ok(sotp.effectiveWeight >= 0.6, `the segment SOTP must dominate (weight ${sotp.effectiveWeight})`);
  assert.equal(output.engine.publishedBasis, "reconciled_segment_sotp");
  assert.ok(Math.abs(output.ensemble.fairValue - sotp.value) < 0.01);
});

test("Task D: a change in reported AMD segment revenue flows into the forecast and value", async () => {
  const base = await withAmdFiling(AMD_Q, (pack) => pack);
  const raised = await withAmdFiling({ ...AMD_Q, dataCenter: 9000 }, (pack) => pack);
  const baseDc = base.profile.baseline.sotpSegments.find((segment) => segment.name === "Data Center");
  const raisedDc = raised.profile.baseline.sotpSegments.find((segment) => segment.name === "Data Center");
  assert.ok(raisedDc.metricValueB > baseDc.metricValueB, "a larger reported Data Center revenue must raise its segment value");
  assert.ok(raised.profile.baseline.forwardRevenueB > base.profile.baseline.forwardRevenueB);
  const run = (pack) => engine.runValuationProfile(pack.profile, { currentPrice: 210 }).models.find((m) => m.model === "sotp");
  assert.ok(run(raised).value > run(base).value, "the SOTP value must move with the operating input");
});

test("Task D: the frozen curated research snapshot is immutable", () => {
  const curated = engine.getCuratedValuationProfile("AMD");
  assert.ok(curated, "AMD must keep its curated research version");
  assert.deepEqual(curated.baseline.cashFlows, [16, 30, 36, 43, 52, 63]);
  assert.equal(curated.baseline.forwardRevenueB, 87.7);
  assert.equal(curated.referencePrice.value, 516.11);
  assert.equal(curated.referencePrice.asOf, "2026-09-11");
});

test("Task D: without segment evidence AMD labels the frozen fallback explicitly", async () => {
  const pack = await buildAutomatedValuationPack("AMD");
  assert.ok(pack.profile.importedResearch, "the frozen reference is retained");
  assert.ok((pack.profile.evidenceMissing ?? []).some((message) => /沿用/.test(message)), "the fallback must state it is reusing a dated research assumption");
  const forecast = pack.pipeline.find((stage) => stage.id === "forecast");
  assert.equal(forecast.status, "partial");
  assert.match(forecast.detail, /沿用/);
});

test("Task D: a quote-only change moves the price frame, never the intrinsic value", async () => {
  const pack = await withAmdFiling(AMD_Q, (pack) => pack);
  const atLow = engine.runValuationProfile(pack.profile, { currentPrice: 100 });
  const atHigh = engine.runValuationProfile(pack.profile, { currentPrice: 500 });
  assert.equal(atLow.ensemble.fairValue, atHigh.ensemble.fairValue, "intrinsic value must not be a function of the quote");
  assert.equal(atLow.currentPrice.value, 100);
  assert.equal(atHigh.currentPrice.value, 500);
});

test("Task D: AMD segment units are billions and the equity bridge is hand-checkable", async () => {
  const pack = await withAmdFiling(AMD_Q, (pack) => pack);
  const dc = pack.profile.baseline.sotpSegments.find((segment) => segment.name === "Data Center");
  // 7169M → 7.169B, annualized ×4, grown +15%.
  assert.ok(Math.abs(dc.metricValueB - 7.169 * 4 * 1.15) < 1e-6, `Data Center value ${dc.metricValueB}`);
  assert.ok(Math.abs(pack.profile.baseline.forwardRevenueB - (7.169 * 4 * 1.15 + 1.872 * 4 * 1.05 + 0.418 * 4 + 0.829 * 4 * 0.95)) < 1e-6, `forward revenue ${pack.profile.baseline.forwardRevenueB}`);
  // Generic fixture: 11B cash − 2B debt = 9B net cash; 1.2B diluted shares.
  assert.ok(Math.abs(pack.profile.baseline.netCashB - 9) < 1e-9, `net cash ${pack.profile.baseline.netCashB}`);
  assert.ok(Math.abs(pack.profile.baseline.dilutedSharesB - 1.2) < 1e-9, `diluted shares ${pack.profile.baseline.dilutedSharesB}`);
});

// Oracle reports four revenue types. The scoped provider supplies that revenue
// table so the parser builds a live SOTP instead of falling back to the frozen
// Sep-11 research snapshot.
async function withOrclFiling(segmentRevenueM, verify) {
  const originalFetch = globalThis.fetch;
  resetPackCache();
  globalThis.fetch = async (...args) => {
    const url = String(args[0]);
    if (url.startsWith("https://data.sec.gov/submissions/")) {
      const cik = Number(url.replace(/\D+/g, "").replace(/^0+/, ""));
      if (cik === 1341439) {
        return Response.json({
          name: "Oracle Corporation",
          sic: "7372",
          sicDescription: "Services-Prepackaged Software",
          filings: { recent: {
            form: ["10-Q"], accessionNumber: ["0001341439-26-000015"], primaryDocument: ["orcl-20260630.htm"],
            filingDate: ["2026-08-04"], reportDate: ["2026-06-30"],
          } },
        });
      }
    }
    if (url.startsWith("https://www.sec.gov/Archives/") && url.includes("orcl-20260630")) {
      const { cloud, software, hardware, services } = segmentRevenueM;
      // Mirrors Oracle's real Q1 FY2027 income statement: the first revenue row
      // carries `$` and the remaining rows are bare numbers.
      return new Response([
        "Revenues:",
        `Cloud $ ${cloud}`,
        `Software ${software}`,
        `Hardware ${hardware}`,
        `Services ${services}`,
        `Total revenues ${cloud + software + hardware + services}`,
      ].join(" "), { headers: { "content-type": "text/html" } });
    }
    return originalFetch(...args);
  };
  try {
    return await verify(await buildAutomatedValuationPack("ORCL"));
  } finally {
    globalThis.fetch = originalFetch;
    resetPackCache();
  }
}

const ORCL_Q = { cloud: 11607, software: 5550, hardware: 774, services: 1414 };

test("Task D: ORCL segment evidence builds a live SOTP and demotes the curated baseline to a frozen reference", async () => {
  const pack = await withOrclFiling(ORCL_Q, (pack) => pack);
  const baseline = pack.profile.baseline;
  const names = (baseline.sotpSegments ?? []).map((segment) => segment.name).join(" | ");
  assert.match(names, /Cloud/);
  assert.match(names, /Software/);
  assert.match(names, /Hardware/);
  assert.match(names, /Services/);
  // The cloud/software hybrid keeps the disclosed revenue types; no business-line
  // split (OCI / applications / database) is reverse-engineered from revenue.
  assert.doesNotMatch(names, /\bOCI\b/);
  assert.ok(baseline.forwardRevenueB > 80 && baseline.forwardRevenueB < 90, `forward revenue ${baseline.forwardRevenueB}`);
  // The frozen reference is retained as a historical snapshot, not the live value.
  assert.ok(pack.profile.importedResearch, "the frozen snapshot must remain for comparison");
  assert.notEqual(baseline, pack.profile.importedResearch.baseline);
  assert.equal(pack.profile.importedResearch.asOf, "2026-09-11");
  assert.equal(pack.profile.sourcePosture, "reported_internal_forecast");
  const check = pack.profile.dataQuality?.checks.find((c) => c.id === "company-specific-driver-pack");
  assert.equal(check?.status, "passed", "the segment parser must pass, not warn");

  const output = engine.runValuationProfile(pack.profile, { currentPrice: 180 });
  const sotp = output.models.find((m) => m.model === "sotp");
  assert.ok(sotp && sotp.value > 0, "the SOTP must calculate");
  assert.ok(sotp.effectiveWeight >= 0.6, `the segment SOTP must dominate (weight ${sotp.effectiveWeight})`);
  assert.equal(output.engine.publishedBasis, "reconciled_segment_sotp");
  assert.ok(Math.abs(output.ensemble.fairValue - sotp.value) < 0.01);
});

test("Task D: a change in reported ORCL cloud revenue flows into the forecast and value", async () => {
  const base = await withOrclFiling(ORCL_Q, (pack) => pack);
  const raised = await withOrclFiling({ ...ORCL_Q, cloud: 12500 }, (pack) => pack);
  const baseCloud = base.profile.baseline.sotpSegments.find((segment) => segment.name === "Cloud");
  const raisedCloud = raised.profile.baseline.sotpSegments.find((segment) => segment.name === "Cloud");
  assert.ok(raisedCloud.metricValueB > baseCloud.metricValueB, "a larger reported cloud revenue must raise its segment value");
  assert.ok(raised.profile.baseline.forwardRevenueB > base.profile.baseline.forwardRevenueB);
  const run = (pack) => engine.runValuationProfile(pack.profile, { currentPrice: 180 }).models.find((m) => m.model === "sotp");
  assert.ok(run(raised).value > run(base).value, "the SOTP value must move with the operating input");
});

test("Task D: without segment evidence ORCL labels the frozen fallback explicitly", async () => {
  const pack = await buildAutomatedValuationPack("ORCL");
  assert.ok(pack.profile.importedResearch, "the frozen reference is retained");
  assert.ok((pack.profile.evidenceMissing ?? []).some((message) => /沿用/.test(message)), "the fallback must state it is reusing a dated research assumption");
  const forecast = pack.pipeline.find((stage) => stage.id === "forecast");
  assert.equal(forecast.status, "partial");
  assert.match(forecast.detail, /沿用/);
});

test("Task D: ORCL segment units are billions and the equity bridge is hand-checkable", async () => {
  const pack = await withOrclFiling(ORCL_Q, (pack) => pack);
  const cloud = pack.profile.baseline.sotpSegments.find((segment) => segment.name === "Cloud");
  // 11607M → 11.607B, annualized ×4, grown +12%.
  assert.ok(Math.abs(cloud.metricValueB - 11.607 * 4 * 1.12) < 1e-6, `cloud value ${cloud.metricValueB}`);
  assert.ok(Math.abs(pack.profile.baseline.forwardRevenueB - (11.607 * 4 * 1.12 + 5.55 * 4 * 1.05 + 0.774 * 4 + 1.414 * 4 * 1.03)) < 1e-6, `forward revenue ${pack.profile.baseline.forwardRevenueB}`);
  // Generic fixture: 11B cash − 2B debt = 9B net cash; 1.2B diluted shares.
  assert.ok(Math.abs(pack.profile.baseline.netCashB - 9) < 1e-9, `net cash ${pack.profile.baseline.netCashB}`);
  assert.ok(Math.abs(pack.profile.baseline.dilutedSharesB - 1.2) < 1e-9, `diluted shares ${pack.profile.baseline.dilutedSharesB}`);
});



test("P0: a failed candidate cannot replace last good memory or shared snapshot", async () => {
  const edge = fakeEdgeCache(); globalThis.caches = { default: edge };
  snapshotModule.resetSnapshotMemory(); resetPackCache();
  try {
    const good = await snapshotModule.getInvestmentSnapshot("GOOG");
    assert.ok(good?.fairValue > 0);
    const pack = structuredClone(await buildAutomatedValuationPack("GOOG"));
    pack.profile.dataQuality = { status: "failed", valuationRelease: "withheld", checks: [{ id: "research-failed", status: "failed", label: "failed", detail: "injected invalid candidate" }] };
    globalThis.__p0SnapshotPack = async () => pack;
    ageSharedSnapshots(edge, snapshotModule.SNAPSHOT_TTL_MS + 1000);
    const key = [...edge.store.keys()].find(k => k.includes("investment-snapshot"));
    const before = JSON.stringify(edge.store.get(key));
    snapshotModule.resetSnapshotMemory();
    const stale = await snapshotModule.getInvestmentSnapshot("GOOG");
    const after = await snapshotModule.getInvestmentSnapshot("GOOG");
    assert.equal(stale.stale, true); assert.equal(after.stale, true);
    assert.equal(after.snapshotId, good.snapshotId); assert.equal(after.fairValue, good.fairValue);
    assert.equal(JSON.stringify(edge.store.get(key)), before, "failed refresh must not overwrite or extend last-good cache");
    snapshotModule.resetSnapshotMemory();
    ageSharedSnapshots(edge, 8 * 24 * 60 * 60 * 1000);
    assert.equal(await snapshotModule.getInvestmentSnapshot("GOOG"), null, "expired last-good is not relabelled fresh");
  } finally {
    delete globalThis.__p0SnapshotPack; delete globalThis.caches;
    snapshotModule.resetSnapshotMemory(); resetPackCache();
  }
});

test("P0: AMD narrative and numerical forecast use the same live version", async () => {
  const pack = await withAmdFiling(AMD_Q, pack => pack);
  assert.notEqual(pack.profile.variantPath, pack.profile.importedResearch.variantPath);
  assert.ok(pack.profile.variantPath.includes(pack.profile.baseline.forwardRevenueB.toFixed(2)));
  for (const value of pack.profile.baseline.cashFlows) assert.ok(pack.profile.variantPath.includes(value.toFixed(2)));
  assert.notEqual(pack.profile.downsideMechanism, pack.profile.importedResearch.downsideMechanism);
});


test("P0-R1: late hard failures clear all publication fields and snapshot eligibility", async () => {
  const pack = await buildAutomatedValuationPack("AMD");
  const profile = structuredClone(pack.profile);
  profile.sourcePosture = "reported_internal_forecast";
  profile.capitalBridge = { cashB: 2000, investmentsB: 0, debtB: 0, otherClaimsB: 0 };
  const output = engine.runValuationProfile(profile, { currentPrice: pack.quote.price });
  assert.equal(output.releaseGate, "model_check_required");
  assert.equal(output.dataQuality.valuationRelease, "withheld");
  assert.equal(output.status, "unavailable");
  assert.equal(output.ensemble.fairValue, null);
  assert.equal(output.ensemble.expectedReturn, null);
  assert.equal(output.ensemble.confidence, 0);
  assert.ok(Object.values(output.ensemble.probabilityDistribution).every(v => v === null));
  assert.ok(Object.values(output.ensemble.scenarios).every(v => v === null));
  assert.ok(output.models.filter(m => m.role === "valuation").every(m => m.value === null && m.effectiveWeight === 0));
  assert.equal(output.rating.riskAdjustedUpside, null);
  assert.equal(output.rating.buyZone, null);
  assert.equal(output.rating.strongBuyZone, null);
  assert.equal(output.reconciliation.perShare, null);
  assert.equal(output.qualityReview.publishable, false);
  assert.ok(output.qualityReview.preliminaryFairValue > 0, "preliminary FV is explicitly audit-only");
  assert.equal(snapshotModule.canRetainSnapshot(snapshotModule.toInvestmentSnapshot(output)), false);
});
