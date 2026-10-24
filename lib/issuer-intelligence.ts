import { validateResearchPayload } from "./research-validate";
import { getBindings } from "./runtime";
import type { ModelFamilyId, ValuationModelId } from "./universal-valuation";
import type { ResearchPlan } from "./research-plan";

export type IssuerProfileSource = "verified_registry" | "d1_ai_profile" | "rule_based" | "ai_classifier";

export type IssuerIntelligenceProfile = {
  issuerId: string;
  canonicalName: string;
  tickers: string[];
  cik: string | null;
  valuationFamily: ModelFamilyId;
  businessModel: string;
  segmentStructure: string[];
  driverSchema: string[];
  preferredModels: ValuationModelId[];
  rejectedModels: ValuationModelId[];
  peerGroup: string[];
  profileSource: IssuerProfileSource;
  profileVersion: string;
  classificationConfidence: number;
  lastAiReviewedAt: string | null;
  materialChangeHash: string;
  investmentQuestion: string;
  thesisSummary: string;
  riskSummary: string;
  businessModelSummary: string;
  updatedAt: string;
};

export type AiCallReason =
  | "NEW_ISSUER"
  | "PROFILE_REFRESH"
  | "BUSINESS_MODEL_CHANGE"
  | "LOW_CLASSIFICATION_CONFIDENCE"
  | "MODEL_DISPERSION_REVIEW"
  | "COMPLEX_SOTP_REVIEW";

// Bumping the registry version invalidates persisted issuer profiles and the
// cached valuation package, which is required whenever an issuer's identity or
// economics change materially.
const VERSION = "issuer-registry-2026-09-15";
const NOW = "2026-09-14T00:00:00.000Z";
const PROFILE_TTL_MS = 180 * 86_400_000;
const memoryProfiles = new Map<string, IssuerIntelligenceProfile>();
const memoryAiUsage = new Map<string, number>();
const memoryResearchPlans = new Map<string, StoredResearchPlan>();
let tablesReady: Promise<void> | null = null;
// Counts every write that actually reached a production D1 binding. The isolated
// dry-run harness leaves `getBindings().DB` undefined, so this stays 0 and the
// acceptance report can assert "Production D1 mutations = 0".
let productionD1Mutations = 0;

export type StoredResearchPlan = {
  issuerId: string;
  policyVersion: string;
  evidenceVersion: string;
  assumptionVersion: string;
  plan: ResearchPlan;
  approval?: { compilerVersion: string; evidenceIds: string[]; planOrigin: "ai"; reviewStatus: "passed" };
};

const hash = (value: string) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
};

const FAMILY_MODELS: Record<ModelFamilyId, ValuationModelId[]> = {
  ai_compute_platform: ["dcf", "forward_pe", "ev_fcf", "ev_sales", "reverse_dcf"],
  ai_semiconductor: ["dcf", "forward_pe", "ev_fcf", "ev_sales", "reverse_dcf"],
  cyclical_semiconductor: ["sotp", "normalized_dcf", "ev_ebitda", "forward_pe", "reverse_dcf"],
  memory_cycle_semiconductor: ["normalized_dcf", "ev_ebitda", "sotp", "forward_pe", "reverse_dcf"],
  mature_semiconductor: ["normalized_dcf", "forward_pe", "ev_fcf", "ev_ebitda", "reverse_dcf"],
  foundry_semiconductor: ["sotp", "normalized_dcf", "ev_ebitda", "forward_pe", "reverse_dcf"],
  semiconductor_infrastructure: ["normalized_dcf", "forward_pe", "ev_fcf", "ev_ebitda", "reverse_dcf"],
  consumer_tech_platform: ["normalized_dcf", "forward_pe", "ev_fcf", "reverse_dcf"],
  digital_platform: ["normalized_dcf", "forward_pe", "ev_fcf", "sotp", "reverse_dcf"],
  cloud_software_platform: ["normalized_dcf", "forward_pe", "ev_fcf", "reverse_dcf"],
  cloud_software_hybrid: ["normalized_dcf", "forward_pe", "sotp", "ev_fcf", "reverse_dcf"],
  commerce_cloud_hybrid: ["normalized_dcf", "sotp", "ev_fcf", "ev_sales", "reverse_dcf"],
  ecommerce_platform: ["normalized_dcf", "sotp", "ev_fcf", "ev_sales", "reverse_dcf"],
  saas_growth: ["normalized_dcf", "ev_sales", "ev_fcf", "forward_pe", "reverse_dcf"],
  mature_software: ["normalized_dcf", "forward_pe", "ev_fcf", "reverse_dcf"],
  bank: ["residual_income", "p_tbv", "forward_pe"],
  insurance: ["residual_income", "p_tbv", "forward_pe"],
  asset_manager: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  payments: ["normalized_dcf", "forward_pe", "ev_fcf", "reverse_dcf"],
  stablecoin_network: ["sotp", "forward_pe", "ev_sales", "reverse_dcf"],
  crypto_exchange: ["sotp", "normalized_dcf", "ev_ebitda", "reverse_dcf"],
  reit: ["nav", "affo", "dcf"],
  utility: ["dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  oil_gas: ["commodity_scenario", "nav", "normalized_dcf", "ev_ebitda"],
  commodity_producer: ["commodity_scenario", "nav", "normalized_dcf", "ev_ebitda"],
  industrial: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  airline: ["normalized_dcf", "ev_ebitda", "forward_pe", "reverse_dcf"],
  auto: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  auto_energy_optionality_sotp: ["sotp", "normalized_dcf", "ev_fcf", "reverse_dcf"],
  integrated_space_connectivity_ai_platform: ["sotp", "rnpv", "ev_sales", "dcf"],
  bitcoin_treasury: ["bitcoin_nav", "ev_sales", "forward_pe", "reverse_dcf"],
  advanced_nuclear_project_npv: ["project_npv", "normalized_dcf", "ev_sales", "reverse_dcf"],
  consumer_staples: ["dcf", "forward_pe", "ev_fcf", "reverse_dcf"],
  consumer_discretionary: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  pharma: ["normalized_dcf", "forward_pe", "rnpv", "reverse_dcf"],
  biotech: ["rnpv", "dcf", "ev_sales"],
  medtech: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  telecom: ["normalized_dcf", "forward_pe", "ev_ebitda", "reverse_dcf"],
  media: ["sotp", "normalized_dcf", "ev_ebitda", "reverse_dcf"],
  general_equity: ["normalized_dcf", "forward_pe", "ev_fcf", "ev_ebitda", "reverse_dcf"],
};

type Seed = {
  issuerId: string;
  name: string;
  tickers: string[];
  cik?: string;
  family: ModelFamilyId;
  business: string;
  segments?: string[];
  drivers: string[];
  peers?: string[];
  rejected?: ValuationModelId[];
};

function seeded(seed: Seed): IssuerIntelligenceProfile {
  const preferredModels = FAMILY_MODELS[seed.family];
  const material = `${seed.family}|${seed.business}|${(seed.segments ?? []).join("|")}`;
  return {
    issuerId: seed.issuerId,
    canonicalName: seed.name,
    tickers: seed.tickers,
    cik: seed.cik ?? null,
    valuationFamily: seed.family,
    businessModel: seed.business,
    segmentStructure: seed.segments ?? [seed.business],
    driverSchema: seed.drivers,
    preferredModels,
    rejectedModels: seed.rejected ?? [],
    peerGroup: seed.peers ?? [],
    profileSource: "verified_registry",
    profileVersion: VERSION,
    classificationConfidence: 0.94,
    lastAiReviewedAt: null,
    materialChangeHash: hash(material),
    investmentQuestion: `Do ${seed.drivers.slice(0, 3).join(", ")} support the valuation implied by the current price?`,
    thesisSummary: `Value is driven primarily by ${seed.drivers.join(", ")}.`,
    riskSummary: `The valuation is most exposed to adverse changes in ${seed.drivers.slice(0, 3).join(", ")}.`,
    businessModelSummary: seed.business,
    updatedAt: NOW,
  };
}

const SEEDS: Seed[] = [
  { issuerId: "apple", name: "Apple", tickers: ["AAPL"], family: "consumer_tech_platform", business: "Device ecosystem with recurring services and capital return", segments: ["Products", "Services"], drivers: ["installed base", "services mix", "gross margin", "buybacks"], peers: ["MSFT", "GOOGL"] },
  { issuerId: "microsoft", name: "Microsoft", tickers: ["MSFT"], family: "cloud_software_platform", business: "Enterprise software and hyperscale cloud platform", segments: ["Productivity", "Intelligent Cloud", "More Personal Computing"], drivers: ["Azure growth", "recurring software", "AI monetization", "FCF conversion"], peers: ["GOOGL", "ORCL", "AMZN"] },
  { issuerId: "nvidia", name: "NVIDIA", tickers: ["NVDA"], family: "ai_compute_platform", business: "Accelerated-computing platform spanning silicon, networking and software", segments: ["Compute & Networking", "Graphics"], drivers: ["accelerator demand", "networking", "software mix", "FCF durability"], peers: ["AMD", "AVGO"] },
  { issuerId: "amd", name: "Advanced Micro Devices", tickers: ["AMD"], family: "ai_semiconductor", business: "Fabless compute and accelerator semiconductor", segments: ["Data Center", "Client", "Gaming", "Embedded"], drivers: ["data-center revenue", "AI accelerator adoption", "gross margin", "FCF conversion"], peers: ["NVDA", "INTC"] },
  { issuerId: "broadcom", name: "Broadcom", tickers: ["AVGO"], family: "semiconductor_infrastructure", business: "Semiconductor infrastructure plus recurring infrastructure software", segments: ["Semiconductor Solutions", "Infrastructure Software"], drivers: ["AI networking", "custom silicon", "software cash flow", "leverage"], peers: ["NVDA", "QCOM"] },
  { issuerId: "intel", name: "Intel", tickers: ["INTC"], family: "cyclical_semiconductor", business: "Integrated device manufacturer and foundry turnaround", segments: ["Client Computing", "Data Center & AI", "Intel Foundry", "Other"], drivers: ["product share", "foundry utilization", "normalized margin", "capital expenditure"], peers: ["AMD", "TSM"], rejected: ["ev_fcf", "ev_sales"] },
  { issuerId: "arm", name: "Arm Holdings", tickers: ["ARM"], family: "semiconductor_infrastructure", business: "CPU architecture licensing and royalty platform", segments: ["Licensing", "Royalties"], drivers: ["royalty rate", "v9 adoption", "data-center share", "R&D leverage"], peers: ["QCOM", "NVDA"] },
  { issuerId: "micron", name: "Micron Technology", tickers: ["MU"], family: "memory_cycle_semiconductor", business: "DRAM and NAND memory producer with cycle-sensitive pricing", segments: ["DRAM", "NAND"], drivers: ["DRAM pricing", "NAND pricing", "bit shipments", "cycle-normalized margins"], peers: ["WDC", "STX"] },
  { issuerId: "qualcomm", name: "Qualcomm", tickers: ["QCOM"], family: "mature_semiconductor", business: "Wireless chipset and patent-licensing platform", segments: ["QCT", "QTL"], drivers: ["handset units", "content per device", "licensing", "automotive backlog"], peers: ["AVGO", "TXN"] },
  { issuerId: "alphabet", name: "Alphabet", tickers: ["GOOG", "GOOGL"], family: "digital_platform", business: "Advertising, cloud and AI platform", segments: ["Google Services", "Google Cloud", "Other Bets"], drivers: ["search monetization", "cloud margin", "AI capital expenditure", "FCF"], peers: ["META", "MSFT"] },
  { issuerId: "meta", name: "Meta Platforms", tickers: ["META"], family: "digital_platform", business: "Advertising and social platform with AI investment", segments: ["Family of Apps", "Reality Labs"], drivers: ["ad monetization", "engagement", "AI capital expenditure", "FCF"], peers: ["GOOGL", "SNAP"] },
  { issuerId: "amazon", name: "Amazon", tickers: ["AMZN"], family: "ecommerce_platform", business: "Commerce, cloud and advertising platform", segments: ["North America", "International", "AWS", "Advertising"], drivers: ["AWS growth", "retail margin", "advertising", "capital expenditure"], peers: ["MSFT", "WMT"] },
  { issuerId: "netflix", name: "Netflix", tickers: ["NFLX"], family: "media", business: "Global subscription and advertising streaming network", segments: ["Streaming"], drivers: ["members", "pricing", "advertising", "content amortization"], peers: ["DIS", "CMCSA"] },
  { issuerId: "tesla", name: "Tesla", tickers: ["TSLA"], family: "auto_energy_optionality_sotp", business: "Automotive, energy and autonomy platform with probability-weighted optionality", segments: ["Automotive", "Energy", "FSD", "Robotaxi", "Optimus", "Other"], drivers: ["auto volume and margin", "energy deployments", "autonomy probability", "capital expenditure"], peers: ["GM", "BYDDF"], rejected: ["ev_fcf", "forward_pe"] },
  { issuerId: "oracle", name: "Oracle", tickers: ["ORCL"], family: "cloud_software_hybrid", business: "Enterprise software plus AI cloud infrastructure", segments: ["Cloud and software", "Hardware", "Services"], drivers: ["OCI growth", "RPO conversion", "normalized FCF", "net debt"], peers: ["MSFT", "CRM"] },
  { issuerId: "salesforce", name: "Salesforce", tickers: ["CRM"], family: "cloud_software_platform", business: "Enterprise subscription software platform", drivers: ["subscription growth", "remaining obligations", "operating margin", "FCF"], peers: ["ORCL", "NOW"] },
  { issuerId: "palantir", name: "Palantir Technologies", tickers: ["PLTR"], family: "saas_growth", business: "AI software platform for government and commercial customers", segments: ["Government", "Commercial"], drivers: ["customer growth", "remaining deal value", "stock compensation", "FCF margin"], peers: ["SNOW", "CRM"] },
  { issuerId: "jpmorgan", name: "JPMorgan Chase", tickers: ["JPM"], family: "bank", business: "Diversified regulated bank", drivers: ["ROTCE", "tangible book", "credit costs", "capital return"], peers: ["BAC", "C", "WFC"] },
  { issuerId: "bank-of-america", name: "Bank of America", tickers: ["BAC"], family: "bank", business: "Diversified regulated bank", drivers: ["net interest income", "ROTCE", "tangible book", "credit costs"], peers: ["JPM", "C", "WFC"] },
  { issuerId: "goldman-sachs", name: "Goldman Sachs", tickers: ["GS"], family: "asset_manager", business: "Investment banking, markets and asset-management franchise", drivers: ["fee revenue", "trading activity", "ROE", "book value"], peers: ["MS", "JPM"] },
  { issuerId: "morgan-stanley", name: "Morgan Stanley", tickers: ["MS"], family: "asset_manager", business: "Wealth management, investment banking and markets platform", drivers: ["wealth assets", "fee margin", "trading activity", "ROE"], peers: ["GS", "SCHW"] },
  { issuerId: "wells-fargo", name: "Wells Fargo", tickers: ["WFC"], family: "bank", business: "U.S. commercial and consumer bank", drivers: ["net interest income", "expense efficiency", "ROTCE", "credit costs"], peers: ["JPM", "BAC"] },
  { issuerId: "citigroup", name: "Citigroup", tickers: ["C"], family: "bank", business: "Global institutional and consumer bank in restructuring", drivers: ["ROTCE", "tangible book", "expenses", "capital return"], peers: ["JPM", "BAC"] },
  { issuerId: "visa", name: "Visa", tickers: ["V"], family: "payments", business: "Global card-network payments platform", drivers: ["payment volume", "cross-border volume", "take rate", "operating leverage"], peers: ["MA", "AXP"] },
  { issuerId: "mastercard", name: "Mastercard", tickers: ["MA"], family: "payments", business: "Global card-network payments platform", drivers: ["payment volume", "cross-border volume", "services mix", "operating leverage"], peers: ["V", "AXP"] },
  { issuerId: "american-express", name: "American Express", tickers: ["AXP"], family: "payments", business: "Closed-loop payments network and card lender", drivers: ["billings", "net interest yield", "credit losses", "premium customer growth"], peers: ["V", "MA"] },
  { issuerId: "exxon", name: "Exxon Mobil", tickers: ["XOM"], cik: "0000034088", family: "oil_gas", business: "Integrated oil, gas and chemicals producer", segments: ["Upstream", "Energy Products", "Chemical Products", "Specialty Products"], drivers: ["commodity prices", "production", "unit costs", "capital returns"], peers: ["CVX", "COP"] },
  { issuerId: "chevron", name: "Chevron", tickers: ["CVX"], family: "oil_gas", business: "Integrated oil and gas producer", drivers: ["commodity prices", "production", "unit costs", "capital returns"], peers: ["XOM", "COP"] },
  { issuerId: "conocophillips", name: "ConocoPhillips", tickers: ["COP"], family: "oil_gas", business: "Upstream oil and gas producer", drivers: ["commodity prices", "production", "inventory depth", "capital returns"], peers: ["XOM", "CVX"] },
  { issuerId: "eli-lilly", name: "Eli Lilly", tickers: ["LLY"], family: "pharma", business: "Global biopharmaceutical portfolio and pipeline", drivers: ["volume growth", "manufacturing capacity", "pipeline probability", "patent duration"], peers: ["NVO", "MRK"] },
  { issuerId: "novo-nordisk", name: "Novo Nordisk", tickers: ["NVO"], family: "pharma", business: "Global diabetes and obesity therapeutics platform", drivers: ["GLP-1 volume", "manufacturing capacity", "pricing", "pipeline"], peers: ["LLY", "MRK"] },
  { issuerId: "johnson-johnson", name: "Johnson & Johnson", tickers: ["JNJ"], family: "pharma", business: "Innovative medicine and medical technology portfolio", segments: ["Innovative Medicine", "MedTech"], drivers: ["product growth", "pipeline", "procedure volumes", "litigation"], peers: ["MRK", "ABT"] },
  { issuerId: "merck", name: "Merck", tickers: ["MRK"], family: "pharma", business: "Global pharmaceuticals and vaccines portfolio", drivers: ["Keytruda durability", "pipeline", "patent risk", "launch execution"], peers: ["LLY", "PFE"] },
  { issuerId: "pfizer", name: "Pfizer", tickers: ["PFE"], family: "pharma", business: "Global pharmaceuticals and vaccines portfolio", drivers: ["product erosion", "pipeline productivity", "cost savings", "capital allocation"], peers: ["MRK", "BMY"] },
  { issuerId: "costco", name: "Costco Wholesale", tickers: ["COST"], family: "consumer_staples", business: "Membership warehouse retailer", drivers: ["comparable sales", "membership renewal", "membership fees", "store growth"], peers: ["WMT", "TGT"] },
  { issuerId: "walmart", name: "Walmart", tickers: ["WMT"], family: "consumer_staples", business: "Omnichannel mass retailer and marketplace", drivers: ["comparable sales", "ecommerce economics", "advertising", "inventory turns"], peers: ["COST", "TGT"] },
  { issuerId: "home-depot", name: "Home Depot", tickers: ["HD"], family: "consumer_discretionary", business: "Home-improvement retailer", drivers: ["comparable sales", "transactions", "ticket", "housing cycle"], peers: ["LOW"] },
  { issuerId: "mcdonalds", name: "McDonald's", tickers: ["MCD"], family: "consumer_discretionary", business: "Global franchised restaurant system", drivers: ["comparable sales", "unit growth", "franchise margin", "capital return"], peers: ["YUM", "SBUX"] },
  { issuerId: "coca-cola", name: "Coca-Cola", tickers: ["KO"], family: "consumer_staples", business: "Global beverage concentrate and bottling system", drivers: ["organic sales", "price mix", "volume", "currency"], peers: ["PEP"] },
  { issuerId: "pepsico", name: "PepsiCo", tickers: ["PEP"], family: "consumer_staples", business: "Global snacks and beverages portfolio", drivers: ["organic sales", "volume", "price mix", "productivity"], peers: ["KO", "MDLZ"] },
  { issuerId: "circle", name: "Circle Internet Group", tickers: ["CRCL"], family: "stablecoin_network", business: "Stablecoin network, reserve income and payments infrastructure", segments: ["Reserve income", "Distribution costs", "Other revenue", "Network optionality"], drivers: ["USDC circulation", "reserve yield", "distribution costs", "network revenue"], peers: ["COIN"], rejected: ["p_tbv", "residual_income"] },
  { issuerId: "coinbase", name: "Coinbase", tickers: ["COIN"], family: "crypto_exchange", business: "Crypto trading, custody and subscription-services platform", drivers: ["trading volume", "take rate", "USDC economics", "subscription revenue"], peers: ["CRCL"] },
  { issuerId: "strategy", name: "Strategy", tickers: ["MSTR"], family: "bitcoin_treasury", business: "Bitcoin treasury company with enterprise software operations", segments: ["Bitcoin treasury", "Software"], drivers: ["bitcoin holdings", "reference bitcoin price", "debt and preferred claims", "financing dilution", "software cash flow"], peers: ["COIN"] },
  { issuerId: "oklo", name: "Oklo", tickers: ["OKLO"], family: "advanced_nuclear_project_npv", business: "Advanced fission reactor design, licensing and power-project developer", segments: ["Reactor licensing", "Power projects", "Fuel and development pipeline"], drivers: ["licensed project pipeline", "delivery probability", "capital cost", "power purchase economics"], peers: ["SMR", "NNE"] },
  // Space Exploration Technologies listed on Nasdaq under SPCX in June 2026.
  // The pre-2026 SPCX ticker belonged to an unrelated ETF (now SPCK), so no
  // legacy price, fundamentals or private-company profile may be attached here.
  { issuerId: "spacex", name: "Space Exploration Technologies", tickers: ["SPCX"], family: "integrated_space_connectivity_ai_platform", business: "Public launch-services, Starlink connectivity and Starship development platform", segments: ["Starlink connectivity", "Launch services", "Starship and launch-cost optionality", "Direct-to-device connectivity", "Other development optionality"], drivers: ["Starlink subscribers and ARPU", "launch cadence and price per kilogram", "Starship reusability", "direct-to-device revenue", "net cash or debt and dilution"], peers: ["RKLB", "ASTS", "IRDM"] },
  { issuerId: "realty-income", name: "Realty Income", tickers: ["O"], family: "reit", business: "Net-lease real-estate investment trust", drivers: ["AFFO", "cap rates", "occupancy", "cost of capital"], peers: ["NNN", "WPC"] },
  { issuerId: "prologis", name: "Prologis", tickers: ["PLD"], family: "reit", business: "Industrial logistics real-estate owner and operator", drivers: ["NAV", "AFFO", "occupancy", "cap rates"], peers: ["REXR", "FR"] },
  { issuerId: "american-tower", name: "American Tower", tickers: ["AMT"], family: "reit", business: "Communications infrastructure real-estate trust", drivers: ["AFFO", "organic tenant billings", "churn", "cost of capital"], peers: ["CCI", "SBAC"] },
  { issuerId: "berkshire", name: "Berkshire Hathaway", tickers: ["BRK.A", "BRK.B"], family: "insurance", business: "Insurance-led conglomerate with operating businesses and investments", segments: ["Insurance", "Railroad", "Energy", "Manufacturing and retail", "Investments"], drivers: ["insurance float", "underwriting", "operating earnings", "investment value"], peers: ["CB"] },
  { issuerId: "abbott", name: "Abbott Laboratories", tickers: ["ABT"], family: "medtech", business: "Medical devices, diagnostics and nutrition portfolio", drivers: ["procedure volumes", "device adoption", "diagnostics normalization", "margin"], peers: ["MDT", "JNJ"] },
  { issuerId: "boeing", name: "Boeing", tickers: ["BA"], family: "industrial", business: "Commercial aerospace and defense manufacturer", drivers: ["deliveries", "cash margins", "working capital", "program risk"], peers: ["AIR.PA", "RTX"] },
  { issuerId: "disney", name: "Walt Disney", tickers: ["DIS"], family: "media", business: "Entertainment, streaming, parks and experiences portfolio", segments: ["Entertainment", "Sports", "Experiences"], drivers: ["streaming margin", "parks attendance", "content economics", "sports rights"], peers: ["NFLX", "CMCSA"] },
  { issuerId: "ibm", name: "IBM", tickers: ["IBM"], family: "mature_software", business: "Hybrid-cloud software, consulting and infrastructure platform", drivers: ["software growth", "consulting backlog", "FCF", "capital return"], peers: ["ORCL", "ACN"] },
  { issuerId: "nextera", name: "NextEra Energy", tickers: ["NEE"], family: "utility", business: "Regulated utility and renewable generation platform", drivers: ["rate base", "allowed returns", "renewables backlog", "financing cost"], peers: ["DUK", "SO"] },
  { issuerId: "tmobile", name: "T-Mobile US", tickers: ["TMUS"], family: "telecom", business: "Wireless communications network", drivers: ["postpaid net adds", "ARPU", "churn", "FCF"], peers: ["VZ", "T"] },
];

type MajorIssuerSeed = [ticker: string, name: string, family: ModelFamilyId, business: string];
const MAJOR_FAMILY_DRIVERS: Partial<Record<ModelFamilyId, string[]>> = {
  asset_manager: ["assets under management", "fee rate", "fundraising", "operating margin"],
  bank: ["ROTCE", "tangible book", "credit costs", "capital return"],
  biotech: ["commercial products", "pipeline probability", "cash runway", "patent duration"],
  cloud_software_platform: ["recurring revenue", "retention", "operating margin", "FCF conversion"],
  commodity_producer: ["commodity prices", "volume", "unit costs", "capital returns"],
  consumer_discretionary: ["comparable demand", "unit economics", "margin", "capital return"],
  consumer_staples: ["volume", "price mix", "margin", "capital return"],
  digital_platform: ["users", "monetization", "operating leverage", "FCF"],
  industrial: ["orders", "backlog", "normalized margin", "cash conversion"],
  insurance: ["underwriting", "investment income", "book value", "capital return"],
  mature_semiconductor: ["end-market demand", "content", "cycle-normalized margin", "FCF"],
  media: ["audience", "pricing", "content economics", "cash conversion"],
  medtech: ["procedure volume", "product adoption", "margin", "pipeline"],
  oil_gas: ["commodity prices", "production", "unit costs", "capital returns"],
  payments: ["payment volume", "take rate", "credit or fraud costs", "operating leverage"],
  pharma: ["product volume", "pricing", "pipeline", "patent duration"],
  reit: ["NAV", "AFFO", "occupancy", "capitalization rates"],
  saas_growth: ["revenue growth", "retention", "operating margin", "FCF conversion"],
  semiconductor_infrastructure: ["wafer-fab spending", "content", "cycle-normalized margin", "FCF"],
  telecom: ["subscribers", "ARPU", "churn", "network capital expenditure"],
  utility: ["rate base", "allowed returns", "load growth", "financing cost"],
};

// Broad preclassification for frequently requested S&P 100, Nasdaq-100 and
// Dow constituents. These records persist economic architecture only; every
// financial input and fair value is still refreshed and calculated at runtime.
const ADDITIONAL_MAJOR_ISSUERS: MajorIssuerSeed[] = [
  ["ABBV", "AbbVie", "pharma", "Global biopharmaceutical portfolio and pipeline"],
  ["ACN", "Accenture", "industrial", "Technology consulting and managed-services platform"],
  ["ADBE", "Adobe", "cloud_software_platform", "Creative and document subscription software platform"],
  ["AIG", "American International Group", "insurance", "Commercial and consumer insurance group"],
  ["AMGN", "Amgen", "biotech", "Commercial biotechnology portfolio and pipeline"],
  ["BK", "Bank of New York Mellon", "asset_manager", "Asset servicing and investment-management platform"],
  ["BKNG", "Booking Holdings", "digital_platform", "Online travel marketplace"],
  ["BLK", "BlackRock", "asset_manager", "Global investment-management and technology platform"],
  ["BMY", "Bristol Myers Squibb", "pharma", "Global pharmaceuticals portfolio and pipeline"],
  ["CAT", "Caterpillar", "industrial", "Construction and mining equipment manufacturer"],
  ["CHTR", "Charter Communications", "telecom", "Broadband and communications network"],
  ["CL", "Colgate-Palmolive", "consumer_staples", "Global household and personal-care portfolio"],
  ["CMCSA", "Comcast", "media", "Broadband, media and entertainment portfolio"],
  ["COF", "Capital One Financial", "bank", "Consumer lender and regulated bank"],
  ["CSCO", "Cisco Systems", "mature_software", "Networking hardware and recurring software platform"],
  ["CVS", "CVS Health", "insurance", "Health insurer, pharmacy and care-delivery platform"],
  ["DHR", "Danaher", "medtech", "Life-sciences and diagnostics portfolio"],
  ["DOW", "Dow", "commodity_producer", "Global chemicals producer"],
  ["DUK", "Duke Energy", "utility", "Regulated electric and gas utility"],
  ["EMR", "Emerson Electric", "industrial", "Industrial automation and control platform"],
  ["FDX", "FedEx", "industrial", "Global parcel and freight network"],
  ["GD", "General Dynamics", "industrial", "Aerospace and defense manufacturer"],
  ["GE", "GE Aerospace", "industrial", "Commercial and defense aerospace platform"],
  ["GEV", "GE Vernova", "industrial", "Power equipment and electrification platform"],
  ["GILD", "Gilead Sciences", "biotech", "Commercial biopharmaceutical portfolio and pipeline"],
  ["GM", "General Motors", "auto", "Global automotive manufacturer"],
  ["KHC", "Kraft Heinz", "consumer_staples", "Packaged food portfolio"],
  ["LIN", "Linde", "industrial", "Global industrial gases platform"],
  ["LMT", "Lockheed Martin", "industrial", "Defense systems and aerospace manufacturer"],
  ["LOW", "Lowe's", "consumer_discretionary", "Home-improvement retailer"],
  ["MDLZ", "Mondelez International", "consumer_staples", "Global snacks portfolio"],
  ["MDT", "Medtronic", "medtech", "Global medical-device portfolio"],
  ["MMM", "3M", "industrial", "Diversified industrial products manufacturer"],
  ["MO", "Altria", "consumer_staples", "U.S. tobacco and nicotine portfolio"],
  ["NKE", "Nike", "consumer_discretionary", "Global athletic footwear and apparel brand"],
  ["NOW", "ServiceNow", "cloud_software_platform", "Enterprise workflow subscription platform"],
  ["PG", "Procter & Gamble", "consumer_staples", "Global household and personal-care portfolio"],
  ["PM", "Philip Morris International", "consumer_staples", "Global tobacco and smoke-free products portfolio"],
  ["RTX", "RTX", "industrial", "Commercial aerospace and defense systems portfolio"],
  ["SBUX", "Starbucks", "consumer_discretionary", "Global coffee retail and consumer brand"],
  ["SCHW", "Charles Schwab", "asset_manager", "Brokerage, wealth and asset-management platform"],
  ["SHW", "Sherwin-Williams", "consumer_discretionary", "Paints and coatings manufacturer and retailer"],
  ["SO", "Southern Company", "utility", "Regulated electric and gas utility"],
  ["SPG", "Simon Property Group", "reit", "Retail real-estate investment trust"],
  ["T", "AT&T", "telecom", "Wireless and fiber communications network"],
  ["TGT", "Target", "consumer_staples", "Omnichannel mass retailer"],
  ["TMO", "Thermo Fisher Scientific", "medtech", "Life-sciences tools and diagnostics platform"],
  ["TXN", "Texas Instruments", "mature_semiconductor", "Analog and embedded semiconductor manufacturer"],
  ["UNH", "UnitedHealth Group", "insurance", "Health insurance and care-services platform"],
  ["UNP", "Union Pacific", "industrial", "North American freight railroad"],
  ["UPS", "United Parcel Service", "industrial", "Global parcel and logistics network"],
  ["USB", "U.S. Bancorp", "bank", "U.S. commercial and consumer bank"],
  ["VZ", "Verizon", "telecom", "Wireless and fiber communications network"],
  ["ABNB", "Airbnb", "digital_platform", "Global lodging marketplace"],
  ["ADI", "Analog Devices", "mature_semiconductor", "Analog and mixed-signal semiconductor manufacturer"],
  ["ADP", "Automatic Data Processing", "cloud_software_platform", "Payroll and human-capital-management platform"],
  ["ADSK", "Autodesk", "cloud_software_platform", "Design and engineering subscription software platform"],
  ["AEP", "American Electric Power", "utility", "Regulated electric utility"],
  ["AMAT", "Applied Materials", "semiconductor_infrastructure", "Semiconductor manufacturing equipment platform"],
  ["APP", "AppLovin", "digital_platform", "Advertising technology and software platform"],
  ["ASML", "ASML Holding", "semiconductor_infrastructure", "Lithography systems platform"],
  ["AZN", "AstraZeneca", "pharma", "Global pharmaceuticals portfolio and pipeline"],
  ["BIIB", "Biogen", "biotech", "Neuroscience biotechnology portfolio and pipeline"],
  ["BKR", "Baker Hughes", "oil_gas", "Energy technology and oilfield-services platform"],
  ["CCEP", "Coca-Cola Europacific Partners", "consumer_staples", "Beverage bottling and distribution platform"],
  ["CDNS", "Cadence Design Systems", "cloud_software_platform", "Electronic-design automation software platform"],
  ["CPRT", "Copart", "digital_platform", "Vehicle auction marketplace"],
  ["CRWD", "CrowdStrike", "saas_growth", "Cloud-native cybersecurity subscription platform"],
  ["CSX", "CSX", "industrial", "North American freight railroad"],
  ["CTAS", "Cintas", "industrial", "Route-based workplace products and services platform"],
  ["CTSH", "Cognizant", "industrial", "Technology consulting and services platform"],
  ["DASH", "DoorDash", "digital_platform", "Local-commerce marketplace"],
  ["DDOG", "Datadog", "saas_growth", "Cloud observability subscription platform"],
  ["DXCM", "DexCom", "medtech", "Continuous glucose-monitoring platform"],
  ["EA", "Electronic Arts", "media", "Interactive entertainment and live-services portfolio"],
  ["EXC", "Exelon", "utility", "Regulated electric and gas utility"],
  ["FANG", "Diamondback Energy", "oil_gas", "U.S. upstream oil and gas producer"],
  ["FAST", "Fastenal", "industrial", "Industrial and construction supplies distribution platform"],
  ["FTNT", "Fortinet", "saas_growth", "Cybersecurity products and subscription platform"],
  ["IDXX", "IDEXX Laboratories", "medtech", "Veterinary diagnostics platform"],
  ["INTU", "Intuit", "cloud_software_platform", "Financial and tax software platform"],
  ["ISRG", "Intuitive Surgical", "medtech", "Robotic surgery systems and instruments platform"],
  ["KDP", "Keurig Dr Pepper", "consumer_staples", "Beverage portfolio and brewing systems platform"],
  ["KLAC", "KLA", "semiconductor_infrastructure", "Semiconductor process-control equipment platform"],
  ["LRCX", "Lam Research", "semiconductor_infrastructure", "Semiconductor wafer-fabrication equipment platform"],
  ["MAR", "Marriott International", "consumer_discretionary", "Global hotel management and franchise platform"],
  ["MELI", "MercadoLibre", "ecommerce_platform", "Latin American commerce and payments platform"],
  ["MNST", "Monster Beverage", "consumer_staples", "Global energy-drink portfolio"],
  ["MRVL", "Marvell Technology", "ai_semiconductor", "Data-infrastructure semiconductor platform"],
  ["NXPI", "NXP Semiconductors", "mature_semiconductor", "Automotive and industrial semiconductor platform"],
  ["ODFL", "Old Dominion Freight Line", "industrial", "Less-than-truckload freight network"],
  ["ORLY", "O'Reilly Automotive", "consumer_discretionary", "Automotive aftermarket parts retailer"],
  ["PANW", "Palo Alto Networks", "saas_growth", "Cybersecurity platform and subscriptions"],
  ["PAYX", "Paychex", "cloud_software_platform", "Payroll and human-capital-management platform"],
  ["PCAR", "PACCAR", "industrial", "Commercial truck manufacturer and finance platform"],
  ["PDD", "PDD Holdings", "ecommerce_platform", "Global ecommerce marketplace portfolio"],
  ["PYPL", "PayPal", "payments", "Digital wallet and merchant payments platform"],
  ["REGN", "Regeneron Pharmaceuticals", "biotech", "Commercial biotechnology portfolio and pipeline"],
  ["ROST", "Ross Stores", "consumer_discretionary", "Off-price apparel retailer"],
  ["SNPS", "Synopsys", "cloud_software_platform", "Electronic-design automation software platform"],
  ["TEAM", "Atlassian", "saas_growth", "Team-collaboration subscription software platform"],
  ["TTWO", "Take-Two Interactive", "media", "Interactive entertainment portfolio"],
  ["VRSK", "Verisk Analytics", "cloud_software_platform", "Insurance data and analytics platform"],
  ["VRTX", "Vertex Pharmaceuticals", "biotech", "Commercial biotechnology portfolio and pipeline"],
  ["WBD", "Warner Bros. Discovery", "media", "Film, television and streaming portfolio"],
  ["WDAY", "Workday", "cloud_software_platform", "Financial and human-capital-management subscription platform"],
  ["XEL", "Xcel Energy", "utility", "Regulated electric and gas utility"],
  ["ZS", "Zscaler", "saas_growth", "Cloud-native cybersecurity subscription platform"],
];

const VERIFIED_BY_TICKER = new Map<string, IssuerIntelligenceProfile>();
for (const seed of SEEDS) {
  const profile = seeded(seed);
  for (const ticker of profile.tickers) VERIFIED_BY_TICKER.set(ticker, profile);
}
for (const [ticker, name, family, business] of ADDITIONAL_MAJOR_ISSUERS) {
  if (VERIFIED_BY_TICKER.has(ticker)) continue;
  const profile = seeded({
    issuerId: `major-${ticker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    tickers: [ticker],
    family,
    business,
    drivers: MAJOR_FAMILY_DRIVERS[family] ?? ["revenue growth", "normalized margin", "cash conversion", "capital structure"],
  });
  VERIFIED_BY_TICKER.set(ticker, profile);
}

export const VERIFIED_MAJOR_STOCK_TICKERS = Object.freeze([...VERIFIED_BY_TICKER.keys()].sort());

export function getVerifiedIssuerProfile(ticker: string) {
  const profile = VERIFIED_BY_TICKER.get(ticker.trim().toUpperCase());
  return profile ? structuredClone(profile) : null;
}

function parseArray<T extends string>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is T => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToProfile(row: Record<string, unknown>): IssuerIntelligenceProfile {
  return {
    issuerId: String(row.issuer_id), canonicalName: String(row.canonical_name), tickers: parseArray(row.tickers_json),
    cik: row.cik ? String(row.cik) : null, valuationFamily: String(row.valuation_family) as ModelFamilyId,
    businessModel: String(row.business_model), segmentStructure: parseArray(row.segment_structure_json), driverSchema: parseArray(row.driver_schema_json),
    preferredModels: parseArray<ValuationModelId>(row.preferred_models_json), rejectedModels: parseArray<ValuationModelId>(row.rejected_models_json), peerGroup: parseArray(row.peer_group_json),
    profileSource: String(row.profile_source) as IssuerProfileSource, profileVersion: String(row.profile_version), classificationConfidence: Number(row.classification_confidence),
    lastAiReviewedAt: row.last_ai_reviewed_at_ms ? new Date(Number(row.last_ai_reviewed_at_ms)).toISOString() : null, materialChangeHash: String(row.material_change_hash),
    investmentQuestion: String(row.investment_question ?? ""), thesisSummary: String(row.thesis_summary ?? ""), riskSummary: String(row.risk_summary ?? ""),
    businessModelSummary: String(row.business_model_summary ?? row.business_model), updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

async function ensureTables(db: D1Database) {
  if (!tablesReady) tablesReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS issuer_profiles (issuer_id TEXT PRIMARY KEY NOT NULL, canonical_name TEXT NOT NULL, tickers_json TEXT NOT NULL, cik TEXT, valuation_family TEXT NOT NULL, business_model TEXT NOT NULL, segment_structure_json TEXT NOT NULL, driver_schema_json TEXT NOT NULL, preferred_models_json TEXT NOT NULL, rejected_models_json TEXT NOT NULL, peer_group_json TEXT NOT NULL, profile_source TEXT NOT NULL, profile_version TEXT NOT NULL, classification_confidence REAL NOT NULL, last_ai_reviewed_at_ms INTEGER, material_change_hash TEXT NOT NULL, investment_question TEXT NOT NULL, thesis_summary TEXT NOT NULL, risk_summary TEXT NOT NULL, business_model_summary TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS issuer_profiles_cik_unique ON issuer_profiles(cik)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS issuer_profile_securities (ticker TEXT PRIMARY KEY NOT NULL, issuer_id TEXT NOT NULL REFERENCES issuer_profiles(issuer_id) ON DELETE CASCADE)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS issuer_profile_securities_issuer_idx ON issuer_profile_securities(issuer_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS issuer_ai_usage (issuer_id TEXT NOT NULL, usage_date TEXT NOT NULL, role TEXT NOT NULL, call_count INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(issuer_id, usage_date, role))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS research_plans (issuer_id TEXT NOT NULL, policy_version TEXT NOT NULL, evidence_version TEXT NOT NULL, assumption_version TEXT NOT NULL, plan_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(issuer_id, policy_version, evidence_version))`),
  ]).then(() => undefined).catch((error) => { tablesReady = null; throw error; });
  return tablesReady;
}

export async function loadPersistedIssuerProfile(ticker: string, cik?: string | null) {
  const symbol = ticker.trim().toUpperCase();
  const memory = memoryProfiles.get(symbol);
  if (memory) return structuredClone(memory);
  const db = getBindings().DB;
  if (!db) return null;
  try {
    await ensureTables(db);
    const row = cik
      ? await db.prepare(`SELECT * FROM issuer_profiles WHERE cik = ? LIMIT 1`).bind(cik).first<Record<string, unknown>>()
      : await db.prepare(`SELECT p.* FROM issuer_profiles p JOIN issuer_profile_securities s ON s.issuer_id = p.issuer_id WHERE s.ticker = ? LIMIT 1`).bind(symbol).first<Record<string, unknown>>();
    if (!row) return null;
    const profile = rowToProfile(row);
    for (const alias of profile.tickers) memoryProfiles.set(alias, profile);
    return structuredClone(profile);
  } catch {
    return null;
  }
}

export async function persistIssuerProfile(profile: IssuerIntelligenceProfile) {
  for (const ticker of profile.tickers) memoryProfiles.set(ticker, profile);
  const db = getBindings().DB;
  if (!db) return false;
  try {
    await ensureTables(db);
    const now = Date.now();
    await db.prepare(`INSERT INTO issuer_profiles (issuer_id, canonical_name, tickers_json, cik, valuation_family, business_model, segment_structure_json, driver_schema_json, preferred_models_json, rejected_models_json, peer_group_json, profile_source, profile_version, classification_confidence, last_ai_reviewed_at_ms, material_change_hash, investment_question, thesis_summary, risk_summary, business_model_summary, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issuer_id) DO UPDATE SET canonical_name=excluded.canonical_name, tickers_json=excluded.tickers_json, cik=excluded.cik, valuation_family=excluded.valuation_family, business_model=excluded.business_model, segment_structure_json=excluded.segment_structure_json, driver_schema_json=excluded.driver_schema_json, preferred_models_json=excluded.preferred_models_json, rejected_models_json=excluded.rejected_models_json, peer_group_json=excluded.peer_group_json, profile_source=excluded.profile_source, profile_version=excluded.profile_version, classification_confidence=excluded.classification_confidence, last_ai_reviewed_at_ms=excluded.last_ai_reviewed_at_ms, material_change_hash=excluded.material_change_hash, investment_question=excluded.investment_question, thesis_summary=excluded.thesis_summary, risk_summary=excluded.risk_summary, business_model_summary=excluded.business_model_summary, updated_at_ms=excluded.updated_at_ms`).bind(
      profile.issuerId, profile.canonicalName, JSON.stringify(profile.tickers), profile.cik, profile.valuationFamily, profile.businessModel,
      JSON.stringify(profile.segmentStructure), JSON.stringify(profile.driverSchema), JSON.stringify(profile.preferredModels), JSON.stringify(profile.rejectedModels), JSON.stringify(profile.peerGroup),
      profile.profileSource, profile.profileVersion, profile.classificationConfidence, profile.lastAiReviewedAt ? Date.parse(profile.lastAiReviewedAt) : null,
      profile.materialChangeHash, profile.investmentQuestion, profile.thesisSummary, profile.riskSummary, profile.businessModelSummary, now, now,
    ).run();
    await db.batch(profile.tickers.map((ticker) => db.prepare(`INSERT INTO issuer_profile_securities(ticker, issuer_id) VALUES(?, ?) ON CONFLICT(ticker) DO UPDATE SET issuer_id=excluded.issuer_id`).bind(ticker, profile.issuerId)));
    productionD1Mutations += 1;
    return true;
  } catch {
    return false;
  }
}

export function buildRuleBasedIssuerProfile(input: { ticker: string; issuerTicker: string; canonicalName: string; cik: string | null; family: ModelFamilyId; businessModel: string; drivers: string[] }) {
  const material = `${input.family}|${input.businessModel}`;
  return {
    issuerId: input.cik ? `sec:${input.cik}` : `ticker:${input.issuerTicker}`,
    canonicalName: input.canonicalName,
    tickers: [...new Set([input.issuerTicker, input.ticker])],
    cik: input.cik,
    valuationFamily: input.family,
    businessModel: input.businessModel,
    segmentStructure: [input.businessModel],
    driverSchema: input.drivers,
    preferredModels: FAMILY_MODELS[input.family],
    rejectedModels: [],
    peerGroup: [],
    profileSource: "rule_based" as const,
    profileVersion: "rule-v1",
    classificationConfidence: input.family === "general_equity" ? 0.5 : 0.64,
    lastAiReviewedAt: null,
    materialChangeHash: hash(material),
    investmentQuestion: `Which operating drivers justify the current valuation for ${input.canonicalName}?`,
    thesisSummary: `The provisional profile uses ${input.drivers.join(", ")} until a reviewed issuer profile is persisted.`,
    riskSummary: "Classification and model selection remain provisional until the issuer profile is reviewed.",
    businessModelSummary: input.businessModel,
    updatedAt: new Date().toISOString(),
  } satisfies IssuerIntelligenceProfile;
}

export function profileAgeMs(profile: IssuerIntelligenceProfile, now = Date.now()) {
  const updated = Date.parse(profile.updatedAt);
  return Number.isFinite(updated) ? Math.max(0, now - updated) : Number.POSITIVE_INFINITY;
}

export function issuerProfileNeedsPlanner(profile: IssuerIntelligenceProfile, currentMaterialHash?: string | null, now = Date.now()): AiCallReason | null {
  if (currentMaterialHash && profile.materialChangeHash && currentMaterialHash !== profile.materialChangeHash) return "BUSINESS_MODEL_CHANGE";
  if (profile.profileSource === "rule_based") return "NEW_ISSUER";
  if (profile.classificationConfidence < 0.7) return "LOW_CLASSIFICATION_CONFIDENCE";
  if (profile.profileSource !== "verified_registry" && profileAgeMs(profile, now) > PROFILE_TTL_MS) return "PROFILE_REFRESH";
  return null;
}

export type AiRole = "luna" | "sol" | "research_draft" | "research_finalize" | "research_reviewer";

export async function claimAiCall(issuerId: string, role: AiRole, force = false, now = new Date()) {
  if (force) return true;
  const date = now.toISOString().slice(0, 10);
  const key = `${issuerId}:${date}:${role}`;
  const db = getBindings().DB;
  if (!db) {
    const used = memoryAiUsage.get(key) ?? 0;
    if (used >= 1) return false;
    memoryAiUsage.set(key, used + 1);
    return true;
  }
  try {
    await ensureTables(db);
    const row = await db.prepare(`SELECT call_count FROM issuer_ai_usage WHERE issuer_id=? AND usage_date=? AND role=?`).bind(issuerId, date, role).first<{ call_count: number }>();
    if ((row?.call_count ?? 0) >= 1) return false;
    await db.prepare(`INSERT INTO issuer_ai_usage(issuer_id, usage_date, role, call_count, updated_at_ms) VALUES(?, ?, ?, 1, ?) ON CONFLICT(issuer_id, usage_date, role) DO UPDATE SET call_count=call_count+1, updated_at_ms=excluded.updated_at_ms`).bind(issuerId, date, role, now.getTime()).run();
    productionD1Mutations += 1;
    return true;
  } catch {
    const used = memoryAiUsage.get(key) ?? 0;
    if (used >= 1) return false;
    memoryAiUsage.set(key, used + 1);
    return true;
  }
}

export function aiProfileFromPlan(base: IssuerIntelligenceProfile, plan: { recommendedFamily: ModelFamilyId; businessModel: string; drivers: string[]; confidence: number; modelApplicability: Array<{ model: ValuationModelId; action: "use" | "reduce" | "reject" }>; rationale: string }, now = new Date()): IssuerIntelligenceProfile {
  const preferred = plan.modelApplicability.filter((item) => item.action !== "reject").map((item) => item.model);
  const rejected = plan.modelApplicability.filter((item) => item.action === "reject").map((item) => item.model);
  return {
    ...base,
    valuationFamily: plan.recommendedFamily,
    businessModel: plan.businessModel,
    segmentStructure: base.segmentStructure.length ? base.segmentStructure : [plan.businessModel],
    driverSchema: plan.drivers,
    preferredModels: preferred.length ? preferred : FAMILY_MODELS[plan.recommendedFamily],
    rejectedModels: rejected,
    profileSource: "d1_ai_profile",
    profileVersion: `ai-${now.toISOString().slice(0, 10)}`,
    classificationConfidence: Math.max(0, Math.min(1, plan.confidence)),
    lastAiReviewedAt: now.toISOString(),
    materialChangeHash: hash(`${plan.recommendedFamily}|${plan.businessModel}|${base.segmentStructure.join("|")}`),
    investmentQuestion: MODEL_QUESTION[plan.recommendedFamily] ?? plan.rationale,
    thesisSummary: plan.rationale,
    riskSummary: "Model confidence falls when the issuer's reported drivers or segment economics diverge from this persisted profile.",
    businessModelSummary: plan.businessModel,
    updatedAt: now.toISOString(),
  };
}

/** Derives an issuer profile from an authoritative ResearchPlan (segment names become `segmentStructure`). */
export function aiProfileFromResearchPlan(base: IssuerIntelligenceProfile, plan: ResearchPlan, now = new Date()): IssuerIntelligenceProfile {
  const segmentNames = plan.businesses.map((business) => business.name);
  const preferred = [...new Set(plan.businesses.map((business) => business.valuationMethod))];
  const drivers = [...new Set(plan.businesses.map((business) => business.revenueDriver.formula))];
  return {
    ...base,
    businessModel: segmentNames.join(" / ") || base.businessModel,
    segmentStructure: segmentNames.length ? segmentNames : base.segmentStructure,
    driverSchema: drivers.length ? drivers : base.driverSchema,
    preferredModels: preferred.length ? preferred : base.preferredModels,
    profileSource: "d1_ai_profile",
    profileVersion: `research-${plan.policyVersion}`,
    classificationConfidence: Math.max(base.classificationConfidence, 0.8),
    lastAiReviewedAt: now.toISOString(),
    materialChangeHash: hash(`${plan.policyVersion}|${segmentNames.join("|")}|${plan.primaryMethod}`),
    investmentQuestion: MODEL_QUESTION[base.valuationFamily] ?? "Which operating drivers justify the value of each business?",
    thesisSummary: plan.crossChecks.join("; ") || plan.thesisChanges.join("; ") || base.thesisSummary,
    riskSummary: base.riskSummary,
    businessModelSummary: segmentNames.join(" / ") || base.businessModelSummary,
    updatedAt: now.toISOString(),
  };
}

/** Number of writes that reached a production D1 binding during this process. */
export function getProductionD1MutationCount(): number {
  return productionD1Mutations;
}

function researchPlanKey(issuerId: string, policyVersion: string, evidenceVersion: string): string {
  return `${issuerId}|${policyVersion}|${evidenceVersion}`;
}

export async function persistResearchPlan(entry: StoredResearchPlan): Promise<boolean> {
  // Reject before either cache can replace the last uncontaminated plan.
  validateResearchPayload<ResearchPlan>("plan", entry.plan);
  memoryResearchPlans.set(researchPlanKey(entry.issuerId, entry.policyVersion, entry.evidenceVersion), structuredClone(entry));
  const db = getBindings().DB;
  if (!db) return false;
  try {
    await ensureTables(db);
    await db.prepare(`INSERT INTO research_plans(issuer_id, policy_version, evidence_version, assumption_version, plan_json, created_at_ms) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(issuer_id, policy_version, evidence_version) DO UPDATE SET assumption_version=excluded.assumption_version, plan_json=excluded.plan_json, created_at_ms=excluded.created_at_ms`).bind(
      entry.issuerId, entry.policyVersion, entry.evidenceVersion, entry.assumptionVersion, JSON.stringify({ plan: entry.plan, approval: entry.approval }), Date.now(),
    ).run();
    productionD1Mutations += 1;
    return true;
  } catch {
    return false;
  }
}

export async function loadResearchPlan(issuerId: string, policyVersion: string, evidenceVersion: string): Promise<StoredResearchPlan | null> {
  const key = researchPlanKey(issuerId, policyVersion, evidenceVersion);
  const memory = memoryResearchPlans.get(key);
  if (memory) {
    try { validateResearchPayload<ResearchPlan>("plan", memory.plan); return structuredClone(memory); }
    catch { return null; }
  }
  const db = getBindings().DB;
  if (!db) return null;
  try {
    await ensureTables(db);
    const row = await db.prepare(`SELECT * FROM research_plans WHERE issuer_id=? AND policy_version=? AND evidence_version=? LIMIT 1`).bind(issuerId, policyVersion, evidenceVersion).first<Record<string, unknown>>();
    if (!row) return null;
    const stored = JSON.parse(String(row.plan_json)) as ResearchPlan | Pick<StoredResearchPlan, "plan" | "approval">;
    const entry: StoredResearchPlan = {
      issuerId: String(row.issuer_id),
      policyVersion: String(row.policy_version),
      evidenceVersion: String(row.evidence_version),
      assumptionVersion: String(row.assumption_version),
      plan: "plan" in stored ? stored.plan : stored,
      approval: "plan" in stored ? stored.approval : undefined,
    };
    validateResearchPayload<ResearchPlan>("plan", entry.plan);
    memoryResearchPlans.set(key, entry);
    return structuredClone(entry);
  } catch {
    return null;
  }
}

const MODEL_QUESTION: Partial<Record<ModelFamilyId, string>> = {
  ai_compute_platform: "How much durable compute growth, software mix and cash conversion is already priced in?",
  ai_semiconductor: "How much durable accelerator growth and cash conversion is capitalized?",
  auto_energy_optionality_sotp: "How much operating value and probability-weighted optionality is priced in?",
  integrated_space_connectivity_ai_platform: "What are launch, connectivity and development optionality worth after probability and liquidity discounts?",
  bitcoin_treasury: "What are reported bitcoin holdings, financing claims, dilution and software cash flows worth per share?",
  advanced_nuclear_project_npv: "What are licensed and development-stage projects worth after delivery probability and capital cost?",
  memory_cycle_semiconductor: "Where do pricing, bit shipments and normalized margins settle through the memory cycle?",
  stablecoin_network: "How do circulation, reserve yield and distribution economics translate into equity value?",
  cyclical_semiconductor: "What are normalized segment earnings through the investment and utilization cycle?",
};
