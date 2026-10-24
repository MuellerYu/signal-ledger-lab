import {
  collectOfficialFeeds,
  type OfficialFeedResult,
} from "./official-feeds";
import { createSnapshotCache, snapshotPayload } from "../../lib/snapshot-cache";
import { fetchDailyAdjustedBars, fetchIntradayBars } from "../../lib/alpaca-bars";
import {
  INSTRUMENTS,
  SEMICONDUCTOR_COHORT,
  PICK_NY_SYMBOLS,
  CHECKPOINT_UTC_HOUR,
  DAILY_BRIEF_ENGINE,
  attributeCatalyst,
  briefSendId,
  briefSubject,
  classifySemiconductorMove,
  closeAtHour,
  clusterEvents,
  compareValuationSnapshots,
  detectAnomalies,
  describeRegime,
  isTradingDay,
  portfolioDay,
  qualityGate,
  renderBrief,
  rollingContext,
  scoreEvent,
  sessionMetrics,
  valuationInputProjection,
  valuationThesisProjection,
  type BriefDraft,
  type NewsItem,
  type SessionMetrics,
  type ValuationSnapshotRow,
} from "../../lib/daily-brief";
import { CALENDAR_COMPANIES, collectCompanyCalendar, loadCalendar, storeCalendar, type CalendarEntry } from "./earnings-calendar";
import {
  gatePostCloseEmail,
  renderPostCloseEmail,
  toPostCloseEmailBrief,
} from "../../lib/postclose-email";
import { AUTH_LINK_PURPOSE, authLinkOrigin, deriveMagicToken } from "../../lib/auth-tokens";
import {
  readDailyBriefArtifact,
  upsertDailyBriefArtifact,
  validateCanonicalArtifact,
} from "../../lib/daily-brief-artifact";
import {
  deliverCanonicalDailyBrief,
  finalizeCanonicalDailyBrief,
} from "../../lib/daily-brief-delivery";
import { emailJobIdempotencyKey } from "../../lib/email-idempotency";
import { handleWhopWebhook } from "./whop-webhook";
import type { WhopBindings } from "../../lib/whop-billing";
import { handleStripeWebhook } from "./stripe-webhook";
import {
  processBtcResearch,
  processWorldNews,
  regionHeadlineRelevant,
  WORLD_NEWS_BRIEF_VERSION,
  type NewsAiBinding,
} from "./btc-news";

const getDashboardSnapshot = createSnapshotCache();

/*
 * Market Signal Lab — always-on ingestion and alert worker.
 *
 * This worker intentionally uses only Cloudflare's runtime APIs:
 * - fetch() for SEC, Alpaca, and Resend
 * - D1 for durable state, deduplication, runs, and the email outbox
 * - a one-minute Cron Trigger for autonomous execution
 */

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  error?: string;
  meta?: {
    changes?: number;
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };
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

interface ScheduledController {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

interface Env extends WhopBindings {
  DB: D1Database;
  earningsCalendar?: Map<string, CalendarEntry>;
  AI?: NewsAiBinding;
  SEC_USER_AGENT?: string;
  SEC_MAX_CONCURRENCY?: string;
  SEC_BOOTSTRAP_HOURS?: string;
  WATCHLIST_TIER_MAX?: string;
  ENABLE_ALPACA_NEWS?: string;
  ALPACA_BOOTSTRAP_HOURS?: string;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  ALPACA_DATA_FEED?: string;
  X_BEARER_TOKEN?: string;
  RESEND_API_KEY?: string;
  ALERT_FROM_EMAIL?: string;
  GMAIL_WEBHOOK_SECRET_URL?: string;
  GMAIL_WEBHOOK_URL?: string;
  GMAIL_WEBHOOK_SECRET?: string;
  EMAIL_DELIVERY_PROVIDER?: string;
  ALERT_TO_EMAIL?: string;
  CRON_SECRET?: string;
  DASHBOARD_READ_KEY?: string;
  DASHBOARD_ALLOWED_ORIGIN?: string;
  DRY_RUN?: string;
  SIGNAL_LEDGER_ORIGIN?: string;
  /** The canonical public origin, for links that leave the site. */
  SITE_ORIGIN?: string;
  /** Server-only. Derives magic-link tokens; the raw token is never stored. */
  AUTH_LINK_DERIVATION_SECRET?: string;
  /** Per-kind sender identities. Unset falls back to ALERT_FROM_EMAIL. */
  EMAIL_FROM_AUTH?: string;
  EMAIL_FROM_BRIEF?: string;
  /**
   * Shared secret for the server-to-server "flush now" nudge from Pages after
   * it queues an auth email. Distinct from CRON_SECRET so that nudging the
   * mail queue cannot also trigger a monitor run.
   */
  SERVICE_EMAIL_FLUSH_TOKEN?: string;
  /** Server-only. Verifies the Paddle-Signature header on inbound webhooks. */
  PADDLE_WEBHOOK_SECRET?: string;
  /** Server-only. Verifies the Stripe-Signature header on inbound webhooks. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** "sandbox" or "production". Must match the Paddle.js environment. */
  PADDLE_ENVIRONMENT?: string;
  /** The designated one-time annual price id; the only price that grants 365d. */
  PADDLE_PRICE_PRO_ONETIME_CNY?: string;
  /**
   * TEST MODE ONLY. Never set in production. When absent the post-close
   * preview route 404s, so the path is unreachable from the deployed worker.
   * Injected for a single `wrangler dev --remote` session via --var.
   */
  TESTMODE_POSTCLOSE?: string;
}

type Priority = "P0" | "P1" | "P2";
type Direction = "up" | "down" | "neutral";
type TriggerType = "cron" | "manual";

interface WatchlistRow {
  symbol: string;
  company_name: string;
  cik: string | null;
  tier: number;
  active: number;
  sec_forms: string;
  keywords: string;
  created_at: string;
  updated_at: string;
}

interface SourceDefinition {
  id: string;
  name: string;
  kind: string;
  tier: number;
  required: boolean;
  enabled: boolean;
}

interface SourceResult {
  status: "success" | "skipped" | "needs_setup" | "disabled";
  sourceStatus: "healthy" | "needs_setup" | "disabled";
  itemsSeen: number;
  itemsNew: number;
  cursor?: string | null;
  note?: string | null;
  alertsQueued?: number;
  alertsSent?: number;
  /** True once the session's canonical Daily Brief artifact has been validated and persisted. */
  canonicalBriefReady?: boolean;
}

interface SourceExecution extends Omit<SourceResult, "status"> {
  status: SourceResult["status"] | "failed";
  sourceId: string;
  required: boolean;
  enabled: boolean;
  latencyMs: number;
  error: string | null;
}

interface NormalizedEvent {
  id: string;
  sourceKey: string;
  sourceEventId: string;
  ticker: string;
  eventType: string;
  headline: string;
  summary: string;
  priority: Priority;
  sourceName: string;
  sourceTier: number;
  publishedAt: string;
  detectedAt: string;
  url: string;
  direction: Direction;
  confidence: number;
  rawJson: string | null;
}

interface EventInsertContext {
  dryRun: boolean;
  bootstrap: boolean;
}

interface EventInsertResult {
  inserted: boolean;
  alertQueued: boolean;
}

interface RunSummary {
  runId: string;
  status: string;
  triggerType: TriggerType;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourcesTotal: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  eventsSeen: number;
  eventsNew: number;
  alertsQueued: number;
  alertsSent: number;
  message?: string;
}

interface SecCompanyTicker {
  cik_str?: number | string;
  ticker?: string;
  title?: string;
}

interface SecSubmissionsPayload {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: {
    recent?: Record<string, unknown[]>;
    files?: Array<{ name?: string; filingCount?: number; filingFrom?: string; filingTo?: string }>;
  };
}

interface SecCompanyFactValue {
  start?: string;
  end?: string;
  val?: number | string;
  accn?: string;
  fy?: number | string;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

interface SecCompanyFactConcept {
  label?: string;
  description?: string;
  units?: Record<string, SecCompanyFactValue[]>;
}

interface SecCompanyFactsPayload {
  cik?: number | string;
  entityName?: string;
  facts?: Record<string, Record<string, SecCompanyFactConcept>>;
}

interface MetricFact {
  metricName: "revenue" | "eps";
  concept: string;
  value: number;
  unit: string;
  start: string;
  end: string;
  filedAt: string;
  accession: string;
  form: string;
  fiscalYear: number;
  fiscalPeriod: string;
  reportPeriod: string;
  durationDays: number;
  sourceUrl: string;
}

interface EarningsForecastRow {
  id: string;
  ticker: string;
  cik: string;
  fiscal_period: string;
  expected_window_start: string;
  expected_window_end: string;
  information_cutoff_at: string;
  revenue_estimate: number | null;
  eps_estimate: number | null;
  actual_revenue?: number | null;
  actual_eps?: number | null;
  status: string;
}

interface EarningsForecastForReactionRow extends EarningsForecastRow {
  basis_json: string;
}

interface EarningsReactionModel {
  probabilityUp: number;
  probabilityBase: number;
  probabilityDown: number;
  predictedDirection: "up" | "down" | "uncertain";
  expectedRelativeReturn: number | null;
  reactionLow: number;
  reactionHigh: number;
  reactionRangeBasis: string;
  sampleSize: number;
  modelConfidence: "low" | "medium" | "high";
  consensusStatus: "available" | "unavailable";
  keyDrivers: string[];
  invalidationCondition: string;
  featureSnapshot: Record<string, unknown>;
}

interface SecDirectoryItem {
  name?: string;
  type?: string;
  size?: number | string;
}

interface SecDirectoryIndex {
  directory?: {
    name?: string;
    item?: SecDirectoryItem[];
  };
}

interface FilingKeyPoint {
  label: string;
  text: string;
}

interface EarningsActualExtraction {
  revenue: number | null;
  eps: number | null;
  evidence: string[];
}

interface MaterialEarningsAlertAssessment {
  shouldAlert: boolean;
  score: number;
  direction: "positive" | "negative" | "mixed";
  headline: string;
  highlights: string[];
  reasons: string[];
  impact: string;
  watch: string;
  fiscalPeriod: string | null;
}

interface SecFilingResearch {
  documentType: string;
  documentUrl: string;
  sourceUrl: string;
  headline: string;
  keyMetrics: FilingKeyPoint[];
  keyPoints: FilingKeyPoint[];
  materialSignals: FilingKeyPoint[];
  epsQualityFlag: boolean;
  evidence: Array<{
    label: string;
    quote: string;
    sourceUrl: string;
  }>;
  earningsActual: EarningsActualExtraction | null;
  status: "ready" | "limited" | "failed";
}

interface MultisignalInputs {
  fundamentals: {
    revenueGrowth: number | null;
    epsDelta: number | null;
  };
  market: {
    provider: string;
    tickerReturn20d: number | null;
    spyReturn20d: number | null;
    relativeReturn20d: number | null;
    realizedVol20d: number | null;
    sampleSize: number;
  };
  revisions: {
    up: number | null;
    down: number | null;
    analystCount: number | null;
  };
  news: {
    positive: number;
    negative: number;
    neutral: number;
    total: number;
  };
  social: {
    xStatus: "available" | "not_configured";
  };
}

interface NasdaqEarningsForecastRow {
  fiscalEnd?: string;
  consensusEPSForecast?: number | string;
  highEPSForecast?: number | string;
  lowEPSForecast?: number | string;
  noOfEstimates?: number | string;
  up?: number | string;
  down?: number | string;
}

interface NasdaqEarningsForecastResponse {
  data?: {
    quarterlyForecast?: {
      rows?: NasdaqEarningsForecastRow[];
    };
  };
}

interface EarningsEventProfile {
  ticker: string;
  fiscalPeriod: string;
  date: string | null;
  dateLabel: string;
  timing: string;
  status:
    | "confirmed"
    | "secondary"
    | "estimated_official"
    | "estimated"
    | "reported";
  sourceName: string;
  sourceUrl: string;
  basis: string;
  expectedFiscalEnd: string;
  actual?: {
    revenue: number | null;
    eps: number | null;
    revenueConsensus: number | null;
    epsConsensus: number | null;
    provider: string;
    sourceUrl: string;
    comparabilityNote?: string;
    highlights?: string[];
    postmortem?: {
      verdict: string;
      summary: string;
      rootCauses: string[];
      missedEvidence: string[];
      modelChanges: string[];
    };
  };
}

interface AlpacaNewsItem {
  id?: number | string;
  headline?: string;
  summary?: string;
  content?: string;
  author?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
  symbols?: string[];
  source?: string;
}

interface AlpacaNewsResponse {
  news?: AlpacaNewsItem[];
  next_page_token?: string | null;
}

interface AlpacaBar {
  t?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  n?: number;
  vw?: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
  symbol?: string;
}

interface NasdaqHistoricalResponse {
  data?: {
    tradesTable?: {
      rows?: Array<{
        date?: string;
        close?: string;
        volume?: string;
        open?: string;
        high?: string;
        low?: string;
      }> | null;
    } | null;
  } | null;
}

interface NasdaqEarningsSurpriseResponse {
  data?: {
    earningsSurpriseTable?: {
      rows?: Array<{
        fiscalQtrEnd?: string;
        dateReported?: string;
        eps?: number | string | null;
        consensusForecast?: number | string | null;
        percentageSurprise?: number | string | null;
      }> | null;
    } | null;
  } | null;
}

interface NasdaqQuoteData {
  symbol?: string;
  companyName?: string;
  exchange?: string;
  primaryData?: {
    lastSalePrice?: string;
    netChange?: string;
    percentageChange?: string;
    lastTradeTimestamp?: string;
    isRealTime?: boolean;
    bidPrice?: string;
    askPrice?: string;
    volume?: string;
    currency?: string | null;
  } | null;
  marketStatus?: string;
  assetClass?: string;
}

interface NasdaqQuoteResponse {
  data?: NasdaqQuoteData | null;
  message?: string | null;
  status?: {
    rCode?: number;
    developerMessage?: string | null;
  } | null;
}

interface MarketBarsResult {
  bars: AlpacaBar[];
  provider: string;
}

interface LatestQuoteRow {
  ticker: string;
  price: number;
  quote_as_of_at: string;
  provider: string;
  source_url: string;
  market_status: string;
  is_real_time: number;
  delay_minutes: number;
}

interface EarningsPriceForecastDueRow {
  id: string;
  ticker: string;
  target_session: string;
  settlement_due_at: string;
  reference_price: number;
  predicted_post_price: number;
  predicted_change_pct: number;
  forecast_stance: "bullish" | "neutral" | "bearish";
}

interface OpenForecastRow {
  id: string;
  ticker: string;
  benchmark: string;
  forecast_type: string;
  probability_up: number;
  probability_base: number;
  probability_down: number;
  information_cutoff_at: string;
  resolution_at: string;
}

interface OutboxRow {
  id: string;
  event_id: string;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string;
  status: string;
  attempts: number;
}

interface EmailOutboxItem {
  id: string;
  recipient: string;
  subject: string;
  text_body: string;
  html_body: string;
  status: string;
  attempts: number;
  /** Per-kind sender. Absent falls back to the configured default sender. */
  from_address?: string | null;
  /**
   * How the body is produced. Absent or "stored" means `text_body`/`html_body`
   * are what goes out. "derived_auth_link" means the caller rebuilt the body
   * from a secret, so those fields carry a bearer token and must stay out of
   * the provider idempotency fingerprint — see lib/email-idempotency.
   */
  body_mode?: string | null;
}

class SetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupRequiredError";
  }
}

const DEFAULT_ALERT_RECIPIENT = "owner@example.com";
const SEC_COMPANY_TICKERS_URL =
  "https://www.sec.gov/files/company_tickers.json";
const SEC_SUBMISSIONS_BASE_URL = "https://data.sec.gov/submissions";
const SEC_COMPANY_FACTS_BASE_URL =
  "https://data.sec.gov/api/xbrl/companyfacts";
const ALPACA_NEWS_URL = "https://data.alpaca.markets/v1beta1/news";
const RESEND_EMAIL_URL = "https://api.resend.com/emails";
const MONITOR_LOCK = "market-monitor";
const MONITOR_LOCK_TTL_MS = 110_000;
const SEC_TICKER_REFRESH_MS = 24 * 60 * 60 * 1_000;
const MAX_SEC_FILINGS_PER_TICKER_PER_RUN = 100;
const MAX_ALPACA_PAGES_PER_RUN = 3;
const MAX_OUTBOX_SENDS_PER_RUN = 20;
const SEC_FACTS_REFRESH_MS = 30 * 60 * 1_000;
const EARNINGS_FORECAST_LOOKAHEAD_MS = 45 * 24 * 60 * 60 * 1_000;
const EARNINGS_ACTUAL_GRACE_MS = 45 * 24 * 60 * 60 * 1_000;
const NASDAQ_CONSENSUS_REFRESH_MS = 6 * 60 * 60 * 1_000;
const NASDAQ_QUOTE_REFRESH_MS = 60 * 1_000;
const SEC_RESEARCH_REFRESH_MS = 10 * 60 * 1_000;
const MULTISIGNAL_FORECAST_REFRESH_MS = 6 * 60 * 60 * 1_000;
const MAX_SEC_RESEARCH_PER_RUN = 8;
const MATERIAL_EARNINGS_ALERT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const MATERIAL_EARNINGS_ALERT_SCORE = 4;
const OFFICIAL_FEED_INGEST_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const IMMEDIATE_ALERT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

const EARNINGS_EVENT_PROFILES: Record<string, EarningsEventProfile> = {
  "AMD:2026-Q2": {
    ticker: "AMD",
    fiscalPeriod: "2026-Q2",
    date: "2026-08-04",
    dateLabel: "2026年8月4日（美股盘后）",
    timing: "盘后发布；电话会 17:00 ET",
    status: "confirmed",
    sourceName: "AMD Investor Relations",
    sourceUrl:
      "https://ir.amd.com/news-events/press-releases/detail/1289/amd-to-report-fiscal-second-quarter-2026-financial-results",
    basis: "公司投资者关系公告",
    expectedFiscalEnd: "Jun 2026",
  },
  "AMZN:2026-Q2": {
    ticker: "AMZN",
    fiscalPeriod: "2026-Q2",
    date: "2026-07-30",
    dateLabel: "2026年7月30日（已公布）",
    timing: "盘后发布；电话会 17:00 ET",
    status: "reported",
    sourceName: "Amazon Investor Relations",
    sourceUrl:
      "https://ir.aboutamazon.com/news-release/news-release-details/2026/Amazon-com-Announces-Second-Quarter-Results/default.aspx",
    basis: "公司投资者关系财报新闻稿",
    expectedFiscalEnd: "Jun 2026",
    actual: {
      revenue: 200_600_000_000,
      eps: 5.75,
      revenueConsensus: null,
      epsConsensus: null,
      provider: "Amazon Investor Relations",
      sourceUrl:
        "https://ir.aboutamazon.com/news-release/news-release-details/2026/Amazon-com-Announces-Second-Quarter-Results/default.aspx",
      comparabilityNote:
        "实际 EPS 为 GAAP 稀释每股收益，包含主要来自 Anthropic 投资的 534 亿美元税前非经营性收益；与经营口径模型及分析师口径不可直接机械比较。",
      highlights: [
        "营收 2,006 亿美元，同比增长 20%；高于财报前模型预测 1,901.8 亿美元。",
        "AWS 营收 422 亿美元，同比增长 37%；AWS 营业利润 166 亿美元。",
        "营业利润 275 亿美元，同比增长 43%；过去十二个月自由现金流为净流出 76 亿美元，主要受 AI 资本开支增加影响。",
        "第三季度营收指引 1,970 亿–2,020 亿美元，营业利润指引 225 亿–265 亿美元。",
      ],
    },
  },
  "AVGO:2026-Q3": {
    ticker: "AVGO",
    fiscalPeriod: "2026-Q3",
    date: null,
    dateLabel: "预计2026年9月；官方尚未公布具体日期",
    timing: "时间待公司确认",
    status: "estimated",
    sourceName: "Broadcom Investor Relations",
    sourceUrl:
      "https://investors.broadcom.com/news-releases/news-release-details/broadcom-inc-announces-second-quarter-fiscal-year-2026-financial",
    basis: "公司已给出 Q3 业务展望，但尚未发布 Q3 财报日期",
    expectedFiscalEnd: "Jul 2026",
  },
  "COIN:2026-Q2": {
    ticker: "COIN",
    fiscalPeriod: "2026-Q2",
    date: "2026-07-30",
    dateLabel: "2026年7月30日（美股盘后）",
    timing: "盘后发布",
    status: "confirmed",
    sourceName: "Coinbase Investor Relations",
    sourceUrl:
      "https://investor.coinbase.com/news/news-details/2026/Coinbase-Announces-Date-of-Second-Quarter-2026-Financial-Results/default.aspx",
    basis: "公司投资者关系公告",
    expectedFiscalEnd: "Jun 2026",
  },
  "META:2026-Q2": {
    ticker: "META",
    fiscalPeriod: "2026-Q2",
    date: "2026-07-29",
    dateLabel: "2026年7月29日（已公布）",
    timing: "盘后发布",
    status: "reported",
    sourceName: "Meta Investor Relations",
    sourceUrl:
      "https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-to-Announce-Second-Quarter-2026-Results/default.aspx",
    basis: "公司投资者关系公告",
    expectedFiscalEnd: "Jun 2026",
    actual: {
      revenue: 60_800_000_000,
      eps: 6.18,
      revenueConsensus: 60_220_000_000,
      epsConsensus: 7.19,
      provider: "FactSet（经 AP 报道）",
      sourceUrl:
        "https://apnews.com/article/bcbc62dde6d2cac724e3b3385fcabeab",
    },
  },
  "MSTR:2026-Q2": {
    ticker: "MSTR",
    fiscalPeriod: "2026-Q2",
    date: "2026-07-30",
    dateLabel: "2026年7月30日（已公布）",
    timing: "电话会 17:00 ET",
    status: "reported",
    sourceName: "Strategy SEC 8-K 财报附件",
    sourceUrl:
      "https://www.sec.gov/Archives/edgar/data/1050446/000162828026051027/mstr-20260730x8kxex991.htm",
    basis: "公司向 SEC 提交的 Q2 2026 财报新闻稿",
    expectedFiscalEnd: "Jun 2026",
    actual: {
      revenue: 122_400_000,
      eps: -24.45,
      revenueConsensus: null,
      epsConsensus: 52.04,
      provider: "Strategy SEC 8-K；一致预期为财报前 Nasdaq 快照",
      sourceUrl:
        "https://www.sec.gov/Archives/edgar/data/1050446/000162828026051027/mstr-20260730x8kxex991.htm",
      comparabilityNote:
        "GAAP EPS 主要受比特币公允价值变动和税项影响，不能按普通软件公司 EPS 机械估值；但这也说明原模型采用通用 EPS 季节性基线属于口径错误。",
      highlights: [
        "营业亏损 83.3 亿美元，其中数字资产未实现亏损约 83.2 亿美元；GAAP 稀释 EPS 为 -24.45 美元。",
        "营收 1.224 亿美元，同比增长 6.9%，但毛利率由 68.8% 降至 66.6%；软件业务改善不足以抵消比特币与资本结构压力。",
        "截至 7 月 26 日持有 843,775 枚 BTC，成本 636.9 亿美元，市值 547.7 亿美元；BTC Yield 年初至今仅 4.5%。",
        "年初至今融资 170.6 亿美元、优先股累计分红 10.6 亿美元，并已出售约 2.184 亿美元 BTC 支付部分优先股股息。",
      ],
      postmortem: {
        verdict: "方向错误：事前预测上涨 9%，财报后盘中明显下跌",
        summary:
          "本次不是正常噪音，而是证据权重错误。历史波动只能决定幅度，不能决定方向；MSTR 必须按比特币资产负债表、mNAV、稀释和优先资本成本建模。",
        rootCauses: [
          "把软件营收历史趋势 +10.9% 当作核心基本面，忽略 MSTR 的股价本质上由 BTC、每股 BTC 和资本结构主导。",
          "把财报前相对 SPY 强势 +9.7% 当成正面确认，没有识别为拥挤交易和‘买预期、卖事实’风险。",
          "使用历史财报绝对振幅确定 +9% 幅度，但方向模型没有纳入 BTC 价格、mNAV、ATM 稀释、优先股股息和 BTC 出售。",
        ],
        missedEvidence: [
          "7 月 6 日 SEC 已披露 Q2 数字资产亏损约 83.2 亿美元、BTC 成本高于公允价值；系统因启动回溯窗口过短没有纳入冻结证据。",
          "公司已出售 BTC 支付优先股分红，且 STRC 股息率升至 12%，说明资本结构成本和普通股剩余索取权压力上升。",
        ],
        modelChanges: [
          "MSTR 停用通用财报方向模型，改用 BTC 30 日走势、mNAV/每股 BTC、ATM 稀释、优先股成本、BTC 出售和储备覆盖率的专用模型。",
          "重大预披露进入 45 日财报证据窗，并拥有覆盖营收趋势与短期相对强势的否决权。",
          "财报发布后立即展示盘中初步复盘；首个完整交易日收盘后再冻结最终误差和方向命中。",
        ],
      },
    },
  },
  "ORCL:2027-Q1": {
    ticker: "ORCL",
    fiscalPeriod: "2027-Q1",
    date: "2026-09-10",
    dateLabel: "September 10, 2026 (after market close)",
    timing: "After market close; conference call 17:00 ET",
    status: "confirmed",
    sourceName: "Oracle Investor Relations",
    sourceUrl:
      "https://investor.oracle.com/investor-news/news-details/2026/Oracle-Sets-the-Date-for-its-First-Quarter-Fiscal-Year-2027-Earnings-Announcement/default.aspx",
    basis: "Official announcement published September 2, 2026; webcast at 16:00 Central / 17:00 Eastern.",
    expectedFiscalEnd: "Aug 2026",
  },
  "SMCI:2026-FY": {
    ticker: "SMCI",
    fiscalPeriod: "2026-FY",
    date: "2026-08-11",
    dateLabel: "2026年8月11日（美股盘后）",
    timing: "电话会 17:00 ET / 14:00 PT",
    status: "confirmed",
    sourceName: "Supermicro Investor Relations",
    sourceUrl:
      "https://ir.supermicro.com/events-and-presentations/event-details/2026/Fiscal-4Q-2026-Results-2026-g23ewVabuT/default.aspx",
    basis: "公司投资者关系公告",
    expectedFiscalEnd: "Jun 2026",
  },
};

const P0_TERMS = [
  "bankruptcy",
  "chapter 11",
  "insolvency",
  "default",
  "non-reliance",
  "restatement",
  "accounting irregularit",
  "fraud",
  "criminal charge",
  "criminal investigation",
  "cyberattack",
  "cyber attack",
  "data breach",
  "delisting",
  "going concern",
  "merger agreement",
  "definitive merger",
  "acquisition agreement",
  "tender offer",
  "withdraws guidance",
  "withdrawal of guidance",
];

const P1_TERMS = [
  "earnings",
  "revenue",
  "guidance",
  "outlook",
  "forecast",
  "quarterly results",
  "annual results",
  "sec investigation",
  "regulatory investigation",
  "lawsuit",
  "settlement",
  "offering",
  "convertible",
  "capital raise",
  "partnership",
  "strategic agreement",
  "material contract",
  "chief executive officer",
  "chief financial officer",
  "ceo resign",
  "cfo resign",
  "product launch",
  "fda",
  "export control",
  "antitrust",
];

const POSITIVE_TERMS = [
  "beats",
  "beat estimates",
  "raises guidance",
  "raised guidance",
  "record revenue",
  "record earnings",
  "approval",
  "approved",
  "wins contract",
  "contract award",
  "expands",
  "growth",
  "accelerates",
  "partnership",
  "buyback",
  "repurchase",
  "dividend increase",
  "upgrade",
  "acquire",
  "acquisition",
];

const NEGATIVE_TERMS = [
  "misses",
  "missed estimates",
  "cuts guidance",
  "lowered guidance",
  "withdraws guidance",
  "decline",
  "decelerates",
  "loss",
  "bankruptcy",
  "default",
  "restatement",
  "non-reliance",
  "material weakness",
  "investigation",
  "lawsuit",
  "downgrade",
  "delisting",
  "resigns",
  "resignation",
  "layoff",
  "recall",
  "breach",
  "cyberattack",
  "offering",
  "dilution",
];

const P0_SEC_ITEMS = new Set(["1.03", "2.01", "2.04", "4.02"]);
const P1_SEC_FORMS = new Set([
  "8-K",
  "6-K",
  "10-K",
  "10-Q",
  "20-F",
  "40-F",
  "S-1",
  "F-1",
  "S-3",
  "F-3",
  "S-4",
  "424B3",
  "424B4",
  "424B5",
  "SC 13D",
  "SC 13D/A",
  "SC 13G",
  "SC 13G/A",
  "DEF 14A",
  "NT 10-K",
  "NT 10-Q",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function envBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function truncate(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonRecordArray(
  value: string | null | undefined,
): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeJson(value: unknown, limit = 12_000): string {
  try {
    return truncate(JSON.stringify(value), limit);
  } catch {
    return "{}";
  }
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");
}

function normalizeCik(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.padStart(10, "0").slice(-10) : null;
}

function parseSecTimestamp(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  if (/^\d{14}$/.test(text)) {
    const formatted = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(
      6,
      8,
    )}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}Z`;
    const date = new Date(formatted);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseDateOnly(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return parseSecTimestamp(
    /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text,
    fallback,
  );
}

function subtractMinutes(iso: string, minutes: number): string {
  const value = new Date(iso).getTime();
  return new Date(
    (Number.isNaN(value) ? Date.now() : value) - minutes * 60_000,
  ).toISOString();
}

function newYorkDate(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function newYorkWeekday(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date(iso));
}

function newYorkHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso)),
  );
}

function newYorkMinute(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      minute: "2-digit",
    }).format(new Date(iso)),
  );
}

function businessSessionResolution(iso: string, businessDayOffset: number): string {
  const [year, month, day] = newYorkDate(iso).split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day, 22, 30, 0));
  let remaining = businessDayOffset;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      remaining -= 1;
    }
  }
  return cursor.toISOString();
}

function nextBusinessSessionResolution(iso: string): string {
  return businessSessionResolution(iso, 1);
}

function isRecent(iso: string | null | undefined, withinMs: number): boolean {
  if (!iso) return false;
  const value = new Date(iso).getTime();
  return Number.isFinite(value) && Date.now() - value < withinMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function changes(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestBearer(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function constantTimeEqual(left: string | null, right: string): boolean {
  if (left == null) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const configured = (env.DASHBOARD_ALLOWED_ORIGIN ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  let allowedOrigin = "*";
  if (!configured.includes("*")) {
    allowedOrigin =
      origin && configured.includes(origin) ? origin : configured[0] ?? "null";
  }
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, X-Dashboard-Key",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request timeout"), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    const body = truncate(await response.text(), 500);
    throw new Error(
      `${new URL(url).hostname} returned ${response.status}: ${body}`,
    );
  }
  return (await response.json()) as T;
}

async function fetchText(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<string> {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    const body = truncate(await response.text(), 500);
    throw new Error(
      `${new URL(url).hostname} returned ${response.status}: ${body}`,
    );
  }
  return response.text();
}

function secHeaders(env: Env): HeadersInit {
  const userAgent = env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    throw new SetupRequiredError(
      "SEC_USER_AGENT is required and must identify the project plus a contact email.",
    );
  }
  return {
    accept: "application/json",
    "user-agent": userAgent,
  };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name] ?? match);
}

function filingHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<ix:hidden\b[\s\S]*?<\/ix:hidden>/gi, " ")
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<\/(p|div|li|tr|h[1-6]|table|section)>|<br\s*\/?>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function filingHeadline(html: string, text: string): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? filingHtmlToText(titleMatch[1]).replace(/^EX-\d+(?:\.\d+)?\s*/i, "")
    : "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 18 &&
        line.length <= 180 &&
        !/^(united states|securities and exchange commission|form \d|current report|exhibit \d)/i.test(
          line,
        ),
    );
  return truncate(
    title && !/^(8-k|10-k|10-q|form )$/i.test(title)
      ? title
      : lines[0] || "SEC 原始文件关键内容",
    220,
  );
}

const FILING_METRIC_RULES: Array<{
  label: string;
  pattern: RegExp;
  priority: number;
}> = [
  {
    label: "营收",
    pattern: /\b(?:net sales|total revenues?|revenues?)\b/i,
    priority: 10,
  },
  {
    label: "资本开支相关应付款",
    pattern:
      /purchases of property and equipment remaining in accounts payable/i,
    priority: 11,
  },
  {
    label: "CapEx",
    pattern:
      /capital expenditures?|additions to property and equipment|purchases of property and equipment/i,
    priority: 10,
  },
  {
    label: "营业利润",
    pattern: /operating income|operating loss|operating margin/i,
    priority: 9,
  },
  {
    label: "EPS",
    pattern:
      /diluted earnings per share|diluted eps|per common share on a diluted basis/i,
    priority: 9,
  },
  {
    label: "现金流",
    pattern: /free cash flow|net cash from operations|operating cash flow/i,
    priority: 8,
  },
  {
    label: "核心业务",
    pattern:
      /\bazure\b|\baws\b|remaining performance obligation|cloud revenue|paid seats|active users|bookings|backlog|bitcoin holdings|ai revenue/i,
    priority: 8,
  },
  {
    label: "指引",
    pattern: /\bguidance\b|\boutlook\b|\bwe expect\b|\bexpects\b/i,
    priority: 7,
  },
];

function filingSentenceCandidates(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .flatMap((line) =>
      line
        .split(/(?<=[.!?])\s+(?=[A-Z“])/)
        .map((part) => part.trim()),
    )
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(
      (line) =>
        line.length >= 24 &&
        line.length <= 420 &&
        /[$€£¥]?\d[\d,.]*(?:\s?(?:million|billion|%))?/i.test(line),
    );
  return Array.from(new Set(lines));
}

function extractFilingKeyPoints(text: string): FilingKeyPoint[] {
  const candidates = filingSentenceCandidates(text);
  const selected: FilingKeyPoint[] = [];
  const used = new Set<string>();
  for (const rule of [...FILING_METRIC_RULES].sort(
    (left, right) => right.priority - left.priority,
  )) {
    const ranked = candidates
      .filter((candidate) => rule.pattern.test(candidate))
      .map((candidate) => ({
        candidate,
        score:
          (/\$[\d,.]+/.test(candidate) ? 4 : 0) +
          (/%/.test(candidate) ? 3 : 0) +
          (/\b(increased|decreased|grew|declined|up|down|versus|compared)\b/i.test(
            candidate,
          )
            ? 3
            : 0) +
          (candidate.length <= 220 ? 2 : 0) +
          (/\b(?:total revenues?|net sales)\b/i.test(candidate) ? 5 : 0) -
          (/deferred revenue|advance payments/i.test(candidate) ? 10 : 0),
      }))
      .sort((left, right) => right.score - left.score);
    const best = ranked.find(({ candidate }) => !used.has(candidate));
    if (!best) continue;
    used.add(best.candidate);
    selected.push({
      label: rule.label,
      text: truncate(best.candidate, 300),
    });
    if (selected.length >= 5) break;
  }
  return selected;
}

function percentageValues(text: string): number[] {
  return Array.from(text.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function extractMaterialEarningsSignals(text: string): FilingKeyPoint[] {
  const candidates = filingSentenceCandidates(text);
  const ranked = candidates
    .map((candidate) => {
      const normalized = candidate.toLowerCase();
      const percentages = percentageValues(candidate);
      const maxMove = percentages.length
        ? Math.max(...percentages.map((value) => Math.abs(value)))
        : 0;
      let score = 0;
      if (
        /will restate|restatement of|non-reliance|no longer be relied|going concern|substantial doubt|fraud|withdraws? guidance/.test(
          normalized,
        )
      ) {
        score += 8;
      }
      if (
        /\brecord (?:revenue|sales|income|bookings|backlog|customers?|users?|volume|margin|cash flow|market share)|all-time high|\bath\b|fastest growth|triple-digit/.test(
          normalized,
        )
      ) {
        score += 5;
      }
      if (
        /material weakness/.test(normalized) &&
        /identified|newly|not effective|ineffective|not remediated/.test(
          normalized,
        )
      ) {
        score += 8;
      }
      if (
        /impairment/.test(normalized) &&
        /recognized|recorded|charge/.test(normalized) &&
        /\$[\d,.]+/.test(candidate)
      ) {
        score += 8;
      }
      if (
        /(?:operating loss|loss on digital assets|digital asset loss|unrealized loss)/.test(
          normalized,
        ) &&
        /\$[\d,.]+\s*billion/i.test(candidate)
      ) {
        score += 9;
      }
      if (
        /(?:sold|sale of|monetiz(?:e|ed|ation)).{0,100}(?:bitcoin|btc)|(?:bitcoin|btc).{0,100}(?:sold|sale|monetiz)/.test(
          normalized,
        )
      ) {
        score += 6;
      }
      if (
        /preferred (?:stock )?dividend|dividend rate|preferred dividends/.test(
          normalized,
        )
      ) {
        score += 6;
      }
      if (
        /(?:market value|fair value).{0,120}(?:below|less than|lower than).{0,120}(?:cost|carrying value)|(?:cost|carrying value).{0,120}(?:exceed|above|greater than).{0,120}(?:market value|fair value)/.test(
          normalized,
        )
      ) {
        score += 7;
      }
      if (
        /free cash flow.*(?:outflow|decreased|declined|negative)|cash burn/.test(
          normalized,
        )
      ) {
        score += 5;
      }
      if (
        /\b(?:raise[sd]?|lower(?:ed|s)?|cut|withdraws?)\b.{0,40}\b(?:guidance|outlook)\b|\b(?:guidance|outlook)\b.{0,40}\b(?:raise[sd]?|lower(?:ed|s)?|cut|withdrawn)\b/.test(
          normalized,
        )
      ) {
        score += 5;
      }
      if (
        maxMove >= 30 &&
        /revenue|sales|volume|income|margin|customers?|users?|bookings|backlog|cash flow|market share|subscriptions?|services/.test(
          normalized,
        )
      ) {
        score += 4;
      }
      return { candidate, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.length - right.candidate.length,
    );
  return Array.from(
    new Map(ranked.map((item) => [item.candidate, item])).values(),
  )
    .slice(0, 5)
    .map((item) => ({
      label: /guidance|outlook/i.test(item.candidate)
        ? "指引"
        : /free cash flow|cash burn/i.test(item.candidate)
          ? "现金流"
          : /bitcoin|btc|digital asset|preferred dividend/i.test(
                item.candidate,
              )
            ? "比特币与资本结构"
          : /restatement|material weakness|going concern|non-reliance/i.test(
                item.candidate,
              )
            ? "会计风险"
            : "核心业务",
      text: truncate(item.candidate, 360),
    }));
}

function earningsEpsQualityFlag(text: string): boolean {
  return /non-operating|mark-to-market|fair value|investment gain|investment loss|tax benefit|tax expense|restructuring|litigation|asset sale|impairment|one-time|discrete items/i.test(
    text,
  );
}

function scaledUsdAmount(value: string, scale: string): number | null {
  const amount = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const multiplier = /^(?:billion|b)$/i.test(scale)
    ? 1_000_000_000
    : /^(?:million|m)$/i.test(scale)
      ? 1_000_000
      : 1;
  return amount * multiplier;
}

export function extractEarningsActuals(text: string): EarningsActualExtraction | null {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
  if (
    !/(announc(?:es|ed).*financial results|quarterly results|results for (?:its|the) (?:fiscal )?(?:first|second|third|fourth) quarter|reports? (?:its )?(?:fiscal )?(?:first|second|third|fourth) quarter(?: \d{4})? results|earnings release)/i.test(
      normalized,
    )
  ) {
    return null;
  }

  // Prefer explicit consolidated labels. A generic `revenues` match can pick up
  // a segment line such as "Services revenues were $1.4 billion" and must not be
  // treated as total company revenue.
  const revenuePatterns = [
    /\b(net sales|total(?:\s+quarterly)? revenues?|revenue for the quarter)\s+(?:was|were)\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
    /\b(net sales|total(?:\s+quarterly)? revenues?|revenue for the quarter)\s+(?:increased|grew|rose|decreased|declined|(?:was|were)?\s*up|(?:was|were)?\s*down)[^.]{0,160}?\bto\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
    /\b(net sales|total(?:\s+quarterly)? revenues?|revenue for the quarter)\s+of\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
    /\b(net sales|total(?:\s+quarterly)? revenues?|revenue for the quarter)\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
    /(?:^|[.!?]\s+)(revenue)\s+(?:was|were)\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
    /(?:^|[.!?]\s+)(revenue)\s+(?:increased|grew|rose|decreased|declined)[^.]{0,160}?\bto\s+\$?\s*([\d,.]+)\s*(billion|million|b|m)\b/i,
  ];
  let revenue: number | null = null;
  let revenueEvidence = "";
  for (const pattern of revenuePatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const candidate = scaledUsdAmount(match[2], match[3]);
    if (candidate !== null && candidate >= 100_000_000) {
      revenue = candidate;
      revenueEvidence = match[0];
      break;
    }
  }

  const epsPatterns = [
    /\b(?:or|to|was|were|of)\s+\$?\s*([+-]?[\d,.]+)\s+per diluted share\b/i,
    /\bdiluted (?:earnings per share|EPS)[^.]{0,80}?(?:was|were|of|to)?\s*\$?\s*([+-]?[\d,.]+)\b/i,
    /\bnet (income|loss)[^.]{0,220}?\$?\s*([\d,.]+)\s+per common share on a diluted basis\b/i,
  ];
  let eps: number | null = null;
  let epsEvidence = "";
  for (const pattern of epsPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const amountIndex = match.length >= 3 ? 2 : 1;
    const rawAmount = match[amountIndex];
    const sign = match.length >= 3 && /loss/i.test(match[1]) ? -1 : 1;
    const candidate = sign * Number(rawAmount.replace(/,/g, ""));
    if (Number.isFinite(candidate) && Math.abs(candidate) < 100) {
      eps = candidate;
      epsEvidence = match[0];
      break;
    }
  }

  if (revenue === null && eps === null) return null;
  return {
    revenue,
    eps,
    evidence: [revenueEvidence, epsEvidence].filter(Boolean),
  };
}

function filingBaseUrl(url: string): string {
  return url.slice(0, url.lastIndexOf("/") + 1);
}

async function resolveSecDocumentUrl(
  env: Env,
  primaryUrl: string,
  form: string,
): Promise<{ url: string; documentType: string }> {
  if (!/^(8-K|6-K)$/i.test(form)) {
    return { url: primaryUrl, documentType: form || "SEC filing" };
  }
  const baseUrl = filingBaseUrl(primaryUrl);
  const indexUrl = `${baseUrl}index.json`;
  const index = await fetchJson<SecDirectoryIndex>(
    indexUrl,
    { headers: secHeaders(env) },
    15_000,
  );
  const candidates = (index.directory?.item ?? [])
    .filter((item) => /\.(?:html?|txt)$/i.test(item.name ?? ""))
    .map((item) => {
      const name = item.name ?? "";
      const type = item.type ?? "";
      const score =
        (/ex(?:hibit)?[-_ ]?99|99[-_.]?1|earnings|release/i.test(name) ? 12 : 0) +
        (/EX-99/i.test(type) ? 10 : 0) +
        (/press|result/i.test(name) ? 5 : 0) -
        (primaryUrl.endsWith(`/${name}`) ? 4 : 0);
      return { name, type, score };
    })
    .sort((left, right) => right.score - left.score);
  if (!candidates.length || candidates[0].score <= 0) {
    return { url: primaryUrl, documentType: form || "SEC filing" };
  }
  return {
    url: new URL(candidates[0].name, baseUrl).toString(),
    documentType: candidates[0].type || "Exhibit 99.1",
  };
}

async function analyzeSecFiling(
  env: Env,
  primaryUrl: string,
  form: string,
): Promise<SecFilingResearch> {
  const resolved = await resolveSecDocumentUrl(env, primaryUrl, form);
  const html = await fetchText(
    resolved.url,
    {
      headers: {
        ...secHeaders(env),
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    },
    25_000,
  );
  const text = filingHtmlToText(html);
  const keyMetrics = extractFilingKeyPoints(text);
  const materialSignals = extractMaterialEarningsSignals(text);
  const earningsActual = extractEarningsActuals(text);
  const headline = filingHeadline(html, text);
  const keyPoints = keyMetrics.length
    ? keyMetrics
    : [
        {
          label: "正文",
          text: "SEC 正文已抓取，但当前规则没有可靠提取到可展示的关键数字。",
        },
      ];
  return {
    documentType: resolved.documentType,
    documentUrl: resolved.url,
    sourceUrl: primaryUrl,
    headline,
    keyMetrics,
    keyPoints,
    materialSignals,
    epsQualityFlag: earningsEpsQualityFlag(text),
    evidence: keyMetrics.map((point) => ({
      label: point.label,
      quote: point.text,
      sourceUrl: resolved.url,
    })),
    earningsActual,
    status: keyMetrics.length >= 2 ? "ready" : "limited",
  };
}

function compactAlertUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未取得";
  if (Math.abs(value) >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)} 亿美元`;
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)} 百万美元`;
  }
  return `${value.toFixed(2)} 美元`;
}

function localizedMaterialSignal(point: FilingKeyPoint): string {
  const text = point.text.replace(/\s+/g, " ").trim();
  if (/[\u3400-\u9fff]/.test(text)) return `${point.label}：${text}`;
  let match = text.match(
    /AWS net sales increased ([\d.]+)%.*?to a \$([\d.]+) billion annualized revenue run rate/i,
  );
  if (match) {
    return `核心业务：AWS 营收同比增长 ${match[1]}%，年化收入运行率达到 ${match[2]} 十亿美元。`;
  }
  match = text.match(
    /operating income was \$([\d.]+) billion.*?up ([\d.]+)%/i,
  );
  if (match) {
    return `营业利润：达到 ${match[1]} 十亿美元，同比增长 ${match[2]}%。`;
  }
  match = text.match(
    /free cash flow decreased to an outflow of \$([\d.]+) billion.*?increase of \$([\d.]+) billion in purchases of property and equipment/i,
  );
  if (match) {
    return `现金流：过去十二个月自由现金流转为净流出 ${match[1]} 十亿美元，房产及设备采购同比增加 ${match[2]} 十亿美元。`;
  }
  match = text.match(
    /operating loss was \$([\d.]+) billion.*?(?:unrealized )?loss on digital assets of \$([\d.]+) billion/i,
  );
  if (match) {
    return `比特币与损益：营业亏损 ${match[1]} 十亿美元，其中数字资产未实现亏损约 ${match[2]} 十亿美元。`;
  }
  match = text.match(
    /(?:held|holdings of)\s+([\d,]+)\s+(?:bitcoin|BTC).*?(?:aggregate )?cost basis (?:was|of) \$([\d.]+) billion.*?(?:market|fair) value (?:was|of) \$([\d.]+) billion/i,
  );
  if (match) {
    return `比特币资产负债表：持有 ${match[1]} 枚 BTC，成本 ${match[2]} 十亿美元，市值 ${match[3]} 十亿美元。`;
  }
  if (/preferred (?:stock )?dividend|dividend rate/i.test(text)) {
    const rate = text.match(/([\d.]+)%/);
    const amount = text.match(/\$([\d.]+)\s*billion/i);
    return `资本结构：优先股分红负担${
      amount ? `累计约 ${amount[1]} 十亿美元` : "继续上升"
    }${rate ? `，披露股息率 ${rate[1]}%` : ""}。`;
  }
  if (/(?:sold|sale of).{0,120}(?:bitcoin|btc)|(?:bitcoin|btc).{0,120}(?:sold|sale)/i.test(text)) {
    const amount = text.match(/\$([\d.]+)\s*(billion|million)/i);
    return `资本结构：公司已出售 BTC 筹资${
      amount ? `约 ${amount[1]} ${/^billion$/i.test(amount[2]) ? "十亿美元" : "百万美元"}` : ""
    }，需关注是否由累积转向资产变现。`;
  }
  if (
    /consumer transaction revenue/i.test(text) &&
    /Crypto Spot Trading Volume/i.test(text)
  ) {
    const moves = percentageValues(text)
      .map((value) => `${Math.abs(value)}%`)
      .slice(0, 3);
    return `核心业务：消费者交易收入受到加密现货交易量下降拖累，披露中的主要降幅为 ${moves.join(
      "、",
    ) || "显著下降"}。`;
  }
  if (/prediction markets/i.test(text) && /Subscription & Services/i.test(text)) {
    const percentages = percentageValues(text)
      .map((value) => `${Math.abs(value)}%`)
      .slice(0, 2);
    const annualized = text.match(/\$([\d.]+)M\+?\s+Annualized prediction markets/i);
    return `核心业务：订阅及服务收入占比${
      percentages[0] ? `达到 ${percentages[0]}` : "显著提升"
    }；预测市场业务年化收入${
      annualized ? `超过 ${annualized[1]} 百万美元` : "进入重要增长阶段"
    }。`;
  }
  const percentages = percentageValues(text)
    .map((value) => `${Math.abs(value)}%`)
    .slice(0, 3);
  const amounts = Array.from(
    text.matchAll(/\$[\d,.]+\s*(?:billion|million|B|M)?/gi),
  )
    .map((item) => item[0])
    .slice(0, 3);
  const numbers = [...percentages, ...amounts].join("、");
  return `${point.label}：披露出现${numbers ? ` ${numbers} 等` : ""}显著变化；具体业务口径见公司原文。`;
}

async function assessMaterialEarningsDisclosure(
  env: Env,
  event: NormalizedEvent,
  research: SecFilingResearch,
): Promise<MaterialEarningsAlertAssessment> {
  const raw = parseJsonRecord(event.rawJson);
  const items = String(raw.items ?? "");
  const isEarningsDisclosure =
    research.earningsActual !== null ||
    /(?:^|[,;\s])2\.02(?:$|[,;\s])/.test(items) ||
    ["sec_10_q", "sec_10_k", "sec_6_k"].includes(event.eventType);
  if (!isEarningsDisclosure) {
    return {
      shouldAlert: false,
      score: 0,
      direction: "mixed",
      headline: "",
      highlights: [],
      reasons: [],
      impact: "",
      watch: "",
      fiscalPeriod: null,
    };
  }

  const releaseMs = new Date(event.publishedAt).getTime();
  const releaseWindowStart = new Date(
    releaseMs - 3 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const releaseWindowEnd = new Date(
    releaseMs + 3 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const forecast = await queryFirst<{
    fiscal_period: string;
    revenue_estimate: number | null;
    eps_estimate: number | null;
    actual_revenue: number | null;
    actual_eps: number | null;
  }>(
    env.DB,
    `SELECT fiscal_period, revenue_estimate, eps_estimate,
            actual_revenue, actual_eps
     FROM earnings_forecasts
     WHERE ticker = ?
       AND information_cutoff_at <= ?
       AND expected_window_start <= ?
       AND expected_window_end >= ?
     ORDER BY created_at DESC
     LIMIT 1`,
    event.ticker,
    event.publishedAt,
    releaseWindowEnd,
    releaseWindowStart,
  );
  const consensus = forecast
    ? await queryFirst<{
        revenue_consensus: number | null;
        eps_consensus: number | null;
      }>(
        env.DB,
        `SELECT revenue_consensus, eps_consensus
         FROM earnings_consensus_snapshots
         WHERE ticker = ? AND fiscal_period = ?
           AND as_of_at <= ?
         ORDER BY as_of_at DESC
         LIMIT 1`,
        event.ticker,
        forecast.fiscal_period,
        event.publishedAt,
      )
    : null;

  const actualRevenue =
    research.earningsActual?.revenue ??
    finiteNumber(forecast?.actual_revenue);
  const actualEps =
    research.earningsActual?.eps ?? finiteNumber(forecast?.actual_eps);
  const modelRevenue = finiteNumber(forecast?.revenue_estimate);
  const consensusRevenue = finiteNumber(consensus?.revenue_consensus);
  const consensusEps = finiteNumber(consensus?.eps_consensus);
  const reasons: string[] = [];
  let score = 0;
  let positiveSignals = 0;
  let negativeSignals = 0;

  const revenueBar = consensusRevenue ?? modelRevenue;
  if (
    actualRevenue !== null &&
    revenueBar !== null &&
    Math.abs(revenueBar) >= 1
  ) {
    const surprisePct = ((actualRevenue - revenueBar) / Math.abs(revenueBar)) * 100;
    if (Math.abs(surprisePct) >= 5) {
      score = Math.max(score, 5);
      reasons.push(
        `实际营收较${
          consensusRevenue !== null ? "市场一致预期" : "事前模型"
        }${surprisePct > 0 ? "高" : "低"} ${Math.abs(surprisePct).toFixed(
          1,
        )}%`,
      );
      if (surprisePct > 0) positiveSignals += 1;
      else negativeSignals += 1;
    }
  }

  if (
    !research.epsQualityFlag &&
    actualEps !== null &&
    consensusEps !== null &&
    Math.abs(consensusEps) >= 0.1
  ) {
    const epsSurprisePct =
      ((actualEps - consensusEps) / Math.abs(consensusEps)) * 100;
    if (Math.abs(epsSurprisePct) >= 20) {
      score = Math.max(score, 4);
      reasons.push(
        `实际 EPS 较市场一致预期${epsSurprisePct > 0 ? "高" : "低"} ${Math.abs(
          epsSurprisePct,
        ).toFixed(1)}%`,
      );
      if (epsSurprisePct > 0) positiveSignals += 1;
      else negativeSignals += 1;
    }
  }

  for (const signal of research.materialSignals) {
    const normalized = signal.text.toLowerCase();
    const maxMove = Math.max(
      0,
      ...percentageValues(signal.text).map((value) => Math.abs(value)),
    );
    if (
      /will restate|restatement of|non-reliance|no longer be relied|going concern|substantial doubt|fraud|material weakness/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 8);
      reasons.push("出现重大会计、内控或持续经营风险");
      negativeSignals += 2;
    } else if (
      /(?:operating loss|loss on digital assets|digital asset loss|unrealized loss)/.test(
        normalized,
      ) &&
      /\$[\d,.]+\s*billion/.test(normalized)
    ) {
      score = Math.max(score, 9);
      reasons.push("出现数十亿美元级营业或数字资产亏损");
      negativeSignals += 2;
    } else if (
      /(?:sold|sale of|monetiz(?:e|ed|ation)).{0,100}(?:bitcoin|btc)|(?:bitcoin|btc).{0,100}(?:sold|sale|monetiz)/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 6);
      reasons.push("公司出售比特币用于融资或支付资本成本");
      negativeSignals += 1;
    } else if (
      /preferred (?:stock )?dividend|dividend rate|preferred dividends/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 6);
      reasons.push("优先股分红和资本结构成本显著上升");
      negativeSignals += 1;
    } else if (/withdraws? guidance/.test(normalized)) {
      score = Math.max(score, 7);
      reasons.push("公司撤回业绩指引");
      negativeSignals += 2;
    } else if (
      /free cash flow.*(?:outflow|decreased|declined|negative)|cash burn/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 5);
      reasons.push("自由现金流转为流出或出现显著恶化");
      negativeSignals += 1;
    } else if (
      /\b(?:raise[sd]?|lower(?:ed|s)?|cut)\b.{0,40}\b(?:guidance|outlook)\b|\b(?:guidance|outlook)\b.{0,40}\b(?:raise[sd]?|lower(?:ed|s)?|cut)\b/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 5);
      reasons.push("管理层显著调整业绩指引");
      if (/lower|cut/.test(normalized)) negativeSignals += 1;
      else positiveSignals += 1;
    } else if (
      /\brecord (?:revenue|sales|income|bookings|backlog|customers?|users?|volume|margin|cash flow|market share)|all-time high|\bath\b|fastest growth|triple-digit/.test(
        normalized,
      )
    ) {
      score = Math.max(score, 4);
      reasons.push("核心业务创纪录、历史高位或出现多年最快增速");
      positiveSignals += 1;
    } else if (maxMove >= 30) {
      score = Math.max(score, 4);
      reasons.push(`核心业务指标出现 ${maxMove.toFixed(0)}% 的大幅变动`);
      if (/decrease|decline|down|loss|outflow/.test(normalized)) {
        negativeSignals += 1;
      } else {
        positiveSignals += 1;
      }
    }
  }

  const uniqueReasons = Array.from(new Set(reasons)).slice(0, 4);
  const signalPoints = [
    ...research.materialSignals,
    ...research.keyMetrics,
  ].filter(
    (point, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.label === point.label && candidate.text === point.text,
      ) === index,
  );
  const highlights = signalPoints
    .slice(0, 4)
    .map(localizedMaterialSignal);
  if (actualRevenue !== null) {
    highlights.unshift(
      `公司公布营收 ${compactAlertUsd(actualRevenue)}${
        modelRevenue !== null
          ? `；事前模型为 ${compactAlertUsd(modelRevenue)}`
          : ""
      }。`,
    );
  }
  if (actualEps !== null) {
    highlights.splice(
      1,
      0,
      `公司公布 GAAP 稀释 EPS ${actualEps.toFixed(2)} 美元${
        consensusEps !== null
          ? `；市场一致预期为 ${consensusEps.toFixed(2)} 美元`
          : ""
      }。`,
    );
  }
  if (research.epsQualityFlag && actualEps !== null) {
    highlights.push(
      "EPS 可能受到投资收益、税项或其他非经营项目影响，不能只看表面 beat/miss。",
    );
  }
  const direction: MaterialEarningsAlertAssessment["direction"] =
    positiveSignals > 0 && negativeSignals === 0
      ? "positive"
      : negativeSignals > 0 && positiveSignals === 0
        ? "negative"
        : "mixed";
  const headline = uniqueReasons[0]
    ? `${event.ticker} 财报异动：${uniqueReasons[0]}`
    : `${event.ticker} 财报出现高影响变化`;
  const impact =
    direction === "positive"
      ? "这些变化可能推动盈利预测上修并提高估值支撑，但仍需确认指引、利润质量和盘后价格是否同步验证。"
      : direction === "negative"
        ? "这些变化可能导致盈利预测下修、现金流折价或风险溢价上升，需要警惕财报后的继续重定价。"
        : "本次财报同时存在正负信号，标题数字可能掩盖利润质量或业务结构变化，不能只按单一 EPS 判断方向。";
  return {
    shouldAlert: score >= MATERIAL_EARNINGS_ALERT_SCORE,
    score,
    direction,
    headline,
    highlights: highlights.slice(0, 5),
    reasons: uniqueReasons,
    impact,
    watch:
      "立即核对公司下一季指引、核心业务增速、利润率与现金流，并观察盘后价格和电话会是否验证这一变化。",
    fiscalPeriod: forecast?.fiscal_period ?? null,
  };
}

function buildMaterialEarningsAlertContent(
  event: NormalizedEvent,
  research: SecFilingResearch,
  assessment: MaterialEarningsAlertAssessment,
): { subject: string; text: string; html: string } {
  const publishedAt = formatEtDateTime(event.publishedAt);
  const detectedAt = formatEtDateTime(event.detectedAt);
  const subject = `【财报异动｜${event.ticker}】${truncate(
    assessment.reasons[0] || "出现高影响变化",
    70,
  )}`;
  const text = [
    `财报异动｜${event.ticker}`,
    "",
    assessment.headline,
    "",
    "最值得立刻看的数字",
    ...assessment.highlights.map((item) => `• ${item}`),
    "",
    "为什么可能影响股价",
    assessment.impact,
    "",
    "下一步看什么",
    assessment.watch,
    "",
    `公司原文：${research.documentUrl}`,
    `发布时间：${publishedAt}`,
    `系统发现：${detectedAt}`,
    "",
    "本邮件只在披露出现显著异常时发送；单纯提交 SEC 表单不会触发邮件。",
    "自动化监控信息，不构成投资建议。",
  ].join("\n");
  const highlightsHtml = assessment.highlights
    .map((item) => `<li style="margin:7px 0">${escapeHtml(item)}</li>`)
    .join("");
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#15211b;line-height:1.55">',
    '<div style="max-width:680px;margin:auto;border:1px solid #d9e1dc;border-radius:12px;overflow:hidden">',
    '<div style="padding:16px 20px;background:#8b1e2d;color:white">',
    `<strong>财报异动 · ${escapeHtml(event.ticker)}</strong></div>`,
    `<div style="padding:22px"><h2 style="margin-top:0">${escapeHtml(
      assessment.headline,
    )}</h2>`,
    '<p style="font-weight:700;margin-bottom:6px">最值得立刻看的数字</p>',
    `<ul style="margin-top:0;padding-left:20px">${highlightsHtml}</ul>`,
    '<p style="font-weight:700;margin-bottom:6px">为什么可能影响股价</p>',
    `<p style="margin-top:0">${escapeHtml(assessment.impact)}</p>`,
    '<p style="font-weight:700;margin-bottom:6px">下一步看什么</p>',
    `<p style="margin-top:0">${escapeHtml(assessment.watch)}</p>`,
    '<table style="border-collapse:collapse;width:100%;margin-top:18px"><tbody>',
    `<tr><td style="padding:5px 12px 5px 0;color:#647067">发布时间</td><td>${escapeHtml(
      publishedAt,
    )}</td></tr>`,
    `<tr><td style="padding:5px 12px 5px 0;color:#647067">发现时间</td><td>${escapeHtml(
      detectedAt,
    )}</td></tr>`,
    `</tbody></table><p><a href="${escapeHtml(
      research.documentUrl,
    )}">查看公司财报原文</a></p>`,
    '<p style="font-size:12px;color:#6b746f">只发送高影响异常；单纯提交 SEC 表单不会触发邮件。自动化监控信息，不构成投资建议。</p>',
    "</div></div></body></html>",
  ].join("");
  return { subject, text, html };
}

function matchCount(text: string, terms: string[]): number {
  return terms.reduce(
    (count, term) => count + (text.includes(term) ? 1 : 0),
    0,
  );
}

function inferDirection(text: string): {
  direction: Direction;
  confidence: number;
} {
  const normalized = text.toLowerCase();
  const positive = matchCount(normalized, POSITIVE_TERMS);
  const negative = matchCount(normalized, NEGATIVE_TERMS);
  if (positive === negative) {
    return { direction: "neutral", confidence: 0.52 };
  }
  const margin = Math.abs(positive - negative);
  return {
    direction: positive > negative ? "up" : "down",
    confidence: Math.min(0.9, 0.68 + margin * 0.05),
  };
}

function classifyNews(
  headline: string,
  summary: string,
): {
  priority: Priority;
  direction: Direction;
  confidence: number;
  eventType: string;
} {
  const text = `${headline} ${summary}`.toLowerCase();
  const priority: Priority = P0_TERMS.some((term) => text.includes(term))
    ? "P0"
    : P1_TERMS.some((term) => text.includes(term))
      ? "P1"
      : "P2";
  const { direction, confidence } = inferDirection(text);
  let eventType = "news";
  if (/earnings|revenue|guidance|quarterly results|annual results/.test(text)) {
    eventType = "earnings";
  } else if (/merger|acquisition|tender offer|acquire/.test(text)) {
    eventType = "merger_acquisition";
  } else if (/sec |regulat|antitrust|export control|fda/.test(text)) {
    eventType = "regulatory";
  } else if (/lawsuit|litigation|settlement|criminal/.test(text)) {
    eventType = "legal";
  } else if (/offering|convertible|capital raise|debt|financing/.test(text)) {
    eventType = "financing";
  } else if (/launch|product|chip|platform|service/.test(text)) {
    eventType = "product";
  }
  return { priority, direction, confidence, eventType };
}

function classifySecFiling(
  form: string,
  items: string,
  description: string,
): {
  priority: Priority;
  direction: Direction;
  confidence: number;
  eventType: string;
} {
  const normalizedForm = form.trim().toUpperCase();
  const itemSet = new Set(
    items
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const text = `${form} ${items} ${description}`.toLowerCase();
  const p0Item = Array.from(itemSet).some((item) => P0_SEC_ITEMS.has(item));
  const priority: Priority =
    p0Item || P0_TERMS.some((term) => text.includes(term))
      ? "P0"
      : P1_SEC_FORMS.has(normalizedForm) ||
          P1_TERMS.some((term) => text.includes(term))
        ? "P1"
        : "P2";
  const { direction, confidence } = inferDirection(text);
  return {
    priority,
    direction,
    confidence,
    eventType: `sec_${normalizedForm
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "filing"}`,
  };
}

function forecastForEvent(event: NormalizedEvent): {
  probabilityUp: number;
  probabilityBase: number;
  probabilityDown: number;
  returnLow: number;
  returnHigh: number;
  rationale: string;
} {
  if (event.direction === "up") {
    return {
      probabilityUp: event.priority === "P0" ? 0.65 : 0.6,
      probabilityBase: 0.22,
      probabilityDown: event.priority === "P0" ? 0.13 : 0.18,
      returnLow: event.priority === "P0" ? -0.04 : -0.03,
      returnHigh: event.priority === "P0" ? 0.14 : 0.09,
      rationale: `${event.priority} event with deterministic positive-language signal from a tier-${event.sourceTier} source.`,
    };
  }
  if (event.direction === "down") {
    return {
      probabilityUp: event.priority === "P0" ? 0.13 : 0.18,
      probabilityBase: 0.2,
      probabilityDown: event.priority === "P0" ? 0.67 : 0.62,
      returnLow: event.priority === "P0" ? -0.14 : -0.09,
      returnHigh: event.priority === "P0" ? 0.04 : 0.03,
      rationale: `${event.priority} event with deterministic negative-language signal from a tier-${event.sourceTier} source.`,
    };
  }
  return {
    probabilityUp: 0.34,
    probabilityBase: 0.32,
    probabilityDown: 0.34,
    returnLow: event.priority === "P0" ? -0.1 : -0.06,
    returnHigh: event.priority === "P0" ? 0.1 : 0.06,
    rationale: `${event.priority} material event with ambiguous directional language; the forecast intentionally preserves symmetric uncertainty.`,
  };
}

function alertRecipient(env: Env): string {
  return env.ALERT_TO_EMAIL?.trim() || DEFAULT_ALERT_RECIPIENT;
}

function emailDeliveryProvider(env: Env): "gmail" | "resend" | null {
  const gmailWebhookUrl =
    env.GMAIL_WEBHOOK_SECRET_URL?.trim() || env.GMAIL_WEBHOOK_URL?.trim();
  const gmailReady =
    Boolean(gmailWebhookUrl && env.GMAIL_WEBHOOK_SECRET?.trim());
  const resendReady = Boolean(
    env.RESEND_API_KEY?.trim() && env.ALERT_FROM_EMAIL?.trim(),
  );
  const preference = env.EMAIL_DELIVERY_PROVIDER?.trim().toLowerCase();
  if (preference === "resend") return resendReady ? "resend" : null;
  if (preference === "gmail") return gmailReady ? "gmail" : null;
  if (gmailReady) return "gmail";
  if (resendReady) return "resend";
  return null;
}

function emailReady(env: Env): boolean {
  return Boolean(alertRecipient(env) && emailDeliveryProvider(env));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatEtDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间待核验";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}年${Number(values.month)}月${Number(values.day)}日 ${values.hour}:${values.minute} ET`;
}

interface ChineseMailEvent {
  title: string;
  whatHappened: string;
  whyItMatters: string;
  whatToWatch: string;
  semanticType: string;
}

function signedPercentValue(direction: string, value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return /fell|falls|decreased|declined|down|contracted/i.test(direction)
    ? -Math.abs(parsed)
    : Math.abs(parsed);
}

function signedPercentLabel(value: number | null): string {
  if (value === null) return "未取得";
  if (value === 0) return "0%";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function englishMonthZh(text: string): string {
  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  );
  if (!match) return "最新";
  const months: Record<string, string> = {
    january: "1月",
    february: "2月",
    march: "3月",
    april: "4月",
    may: "5月",
    june: "6月",
    july: "7月",
    august: "8月",
    september: "9月",
    october: "10月",
    november: "11月",
    december: "12月",
  };
  return months[match[1].toLowerCase()] ?? "最新";
}

function chinesePayroll(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${(Math.abs(value) / 10_000).toFixed(1)}万`;
}

function chineseMailEvent(event: {
  ticker: string;
  eventType: string;
  headline: string;
  summary: string;
  direction?: string;
}): ChineseMailEvent | null {
  const ticker = normalizeSymbol(event.ticker) || "MARKET";
  const text = `${event.headline} ${event.summary}`.replace(/\s+/g, " ").trim();
  const normalized = text.toLowerCase();
  const issuer = ticker === "MARKET" ? "美股市场" : ticker;

  if (
    /fomc statement|federal funds rate|interest rate decision|monetary policy decision/.test(
      normalized,
    )
  ) {
    const range = text.match(
      /(\d+(?:\.\d+)?)\s*(?:percent\s*)?(?:to|[-–])\s*(\d+(?:\.\d+)?)\s*percent/i,
    );
    if (!range) return null;
    const action = /lower|cut|reduce/i.test(text)
      ? "下调"
      : /raise|increase|hike/i.test(text)
        ? "上调"
        : /maintain|keep|unchanged|leave/i.test(text)
          ? "维持"
          : "设定";
    return {
      title: `美联储${action}利率至 ${range[1]}%–${range[2]}%`,
      whatHappened: `美联储${action}联邦基金利率目标区间在 ${range[1]}%–${range[2]}%。这是实际政策决定，不是旧会议纪要或一般监管公告。`,
      whyItMatters:
        action === "下调"
          ? "直接传导是短端美债收益率和融资成本下行，通常有利于高估值成长股；若降息源于增长骤弱，周期股和小盘股可能反而承压。"
          : action === "上调"
            ? "更高利率会抬升折现率和融资成本，通常压制高估值成长股，并增加高负债公司的盈利与估值压力。"
            : "利率不变本身未必构成 surprise，真正决定股价的是声明相对市场预期更偏鹰还是偏鸽。",
      whatToWatch:
        "立即对比市场事前预期和上次声明措辞，并观察两年期美债收益率、美元指数与纳斯达克期货是否同向验证。",
      semanticType: "fomc_rate_decision",
    };
  }

  if (/gross domestic product|\bgdp\b/.test(normalized)) {
    const actualMatch = text.match(
      /annual rate of\s+(-?\d+(?:\.\d+)?)\s*percent/i,
    );
    const actual = actualMatch ? Number(actualMatch[1]) : null;
    if (actual === null || !Number.isFinite(actual)) return null;
    const priorMatch = text.match(
      /(?:first|previous|prior) quarter[^.]{0,80}?(?:increased|decreased|grew|contracted)\s+(-?\d+(?:\.\d+)?)\s*percent/i,
    );
    const prior = priorMatch ? Number(priorMatch[1]) : null;
    return {
      title: `美国 GDP 年化增长 ${actual.toFixed(1)}%`,
      whatHappened: `美国实际 GDP 最新季度按年率增长 ${actual.toFixed(1)}%${prior !== null ? `，前一季度为 ${prior.toFixed(1)}%` : ""}。`,
      whyItMatters:
        prior !== null && actual < prior
          ? "经济增速较前季放缓，可能压低利率预期、支撑长久期成长股估值，但会削弱周期股和小盘股的盈利预期。"
          : "增长仍具韧性，有利于企业收入预期；若同时推高利率，成长股估值可能受到抵消。",
      whatToWatch:
        "核对市场一致预期、前值修订和消费/投资分项，并观察两年期美债收益率与周期股相对表现。",
      semanticType: "gdp",
    };
  }

  if (/personal income|personal consumption|personal outlays|\bpce\b/.test(normalized)) {
    const incomeMatch = text.match(
      /personal income[^.]{0,160}?\((-?\d+(?:\.\d+)?)\s*percent/i,
    );
    const spendingMatch = text.match(
      /personal consumption expenditures[^.]{0,180}?\((-?\d+(?:\.\d+)?)\s*percent/i,
    );
    const income = incomeMatch ? Number(incomeMatch[1]) : null;
    const spending = spendingMatch ? Number(spendingMatch[1]) : null;
    if (income === null && spending === null) return null;
    const month = englishMonthZh(text);
    return {
      title: `美国${month}收入${signedPercentLabel(income)}、消费${signedPercentLabel(spending)}`,
      whatHappened: `美国${month}个人收入环比${signedPercentLabel(income)}，个人消费支出环比${signedPercentLabel(spending)}。这是收入和消费金额变化；如果正文没有 PCE 价格指数，就不能把它当成通胀读数。`,
      whyItMatters:
        spending !== null && spending >= 0.3
          ? "消费仍有韧性，对零售、支付和广告收入预期偏正面；但需求过强也可能令降息预期后移。"
          : "消费动能偏弱会增加增长担忧，并可能压低利率；对高估值成长股和周期股的影响方向可能分化。",
      whatToWatch:
        "继续核对总体与核心 PCE 价格指数、市场预期和储蓄率，再观察两年期美债收益率及零售消费股反应。",
      semanticType: "personal_income_outlays",
    };
  }

  if (/consumer price index|\bcpi\b/.test(normalized)) {
    const allMomMatch = text.match(
      /(?:all items|consumer price index)[^.]{0,140}?\b(fell|falls|rose|rises|increased|decreased|declined)\s+([\d.]+)\s*(?:percent|%)/i,
    );
    const allYoyMatch =
      text.match(
        /\b(fell|falls|rose|rises|increased|decreased|declined|up|down)\s+([\d.]+)\s*(?:percent|%)\s+(?:over (?:the )?(?:last )?12 months|over the year|year-over-year)/i,
      ) ??
      text.match(
        /(?:over (?:the )?(?:last )?12 months|for the 12 months ending)[^.]{0,100}?\ball items index\b[^.]{0,80}?\b(fell|falls|rose|rises|increased|decreased|declined|up|down)\s+([\d.]+)\s*(?:percent|%)/i,
      );
    const coreSegment =
      text.match(/all items less food and energy[^.]{0,260}/i)?.[0] ?? "";
    const coreMomMatch = coreSegment.match(
      /\b(fell|falls|rose|rises|increased|decreased|declined|up|down)\s+([\d.]+)\s*(?:percent|%)/i,
    );
    const coreYoyMatch =
      coreSegment.match(
        /\b(fell|falls|rose|rises|increased|decreased|declined|up|down)\s+([\d.]+)\s*(?:percent|%)\s+(?:over the year|year-over-year)/i,
      ) ??
      text.match(
        /all items less food and energy index\s+(fell|falls|rose|rises|increased|decreased|declined|up|down)\s+([\d.]+)\s*(?:percent|%)\s+(?:over the year|over the past 12 months|year-over-year)/i,
      );
    const allMom = allMomMatch
      ? signedPercentValue(allMomMatch[1], allMomMatch[2])
      : null;
    const allYoy = allYoyMatch
      ? signedPercentValue(allYoyMatch[1], allYoyMatch[2])
      : null;
    const coreMom = /\bunchanged\b/i.test(coreSegment)
      ? 0
      : coreMomMatch
        ? signedPercentValue(coreMomMatch[1], coreMomMatch[2])
        : null;
    const coreYoy = coreYoyMatch
      ? signedPercentValue(coreYoyMatch[1], coreYoyMatch[2])
      : null;
    if (allMom === null || allYoy === null) return null;
    const month = englishMonthZh(text);
    const energyMatch = text.match(
      /(?:index for )?energy\s+(fell|falls|rose|rises|increased|decreased|declined)\s+([\d.]+)\s*(?:percent|%)/i,
    );
    const gasolineMatch = text.match(
      /gasoline(?: index| prices)?\s+(fell|falls|rose|rises|increased|decreased|declined)\s+([\d.]+)\s*(?:percent|%)/i,
    );
    const energy = energyMatch
      ? signedPercentValue(energyMatch[1], energyMatch[2])
      : null;
    const gasoline = gasolineMatch
      ? signedPercentValue(gasolineMatch[1], gasolineMatch[2])
      : null;
    const energyDetail =
      energy !== null
        ? `；能源价格环比${signedPercentLabel(energy)}${gasoline !== null ? `，其中汽油${signedPercentLabel(gasoline)}` : ""}`
        : "";
    return {
      title: `美国${month} CPI 环比${signedPercentLabel(allMom)}、同比${signedPercentLabel(allYoy)}`,
      whatHappened: `美国${month}总体 CPI 经季调环比${signedPercentLabel(allMom)}、未经季调同比${signedPercentLabel(allYoy)}；核心 CPI 环比${signedPercentLabel(coreMom)}、同比${signedPercentLabel(coreYoy)}${energyDetail}。`,
      whyItMatters:
        coreMom !== null && coreMom <= 0.2
          ? "核心通胀的绝对读数偏温和，通常会压低短端利率并支持高估值成长股；但只有低于市场预期，才构成真正的增量利多。"
          : "核心通胀仍偏热，可能推迟降息并抬升折现率，对高估值成长股偏负面。",
      whatToWatch:
        "立即核对总体/核心 CPI 与一致预期及前值，并观察两年期美债收益率、美元和纳斯达克期货是否同步验证。",
      semanticType: "cpi",
    };
  }

  if (/producer price index|\bppi\b/.test(normalized)) {
    const moveMatch = text.match(
      /(?:producer price index|final demand)[^.]{0,160}?\b(fell|falls|rose|rises|increased|decreased|declined)\s+([\d.]+)\s*(?:percent|%)/i,
    );
    const move = moveMatch
      ? signedPercentValue(moveMatch[1], moveMatch[2])
      : null;
    if (move === null) return null;
    const month = englishMonthZh(text);
    return {
      title: `美国${month} PPI 环比${signedPercentLabel(move)}`,
      whatHappened: `美国${month}生产者价格指数环比${signedPercentLabel(move)}。邮件只采用正文明确给出的口径，不把其他百分比误当成总体 PPI。`,
      whyItMatters:
        move <= 0.2
          ? "上游价格压力偏温和，有利于部分企业利润率，并可能压低通胀与利率预期。"
          : "上游成本压力偏强，可能压缩成本敏感行业利润率，并推迟降息预期。",
      whatToWatch:
        "核对总体与核心 PPI、市场预期和前值，并观察美债收益率以及成本敏感行业的反应。",
      semanticType: "ppi",
    };
  }

  if (/employment situation|nonfarm|payroll|unemployment|job openings/.test(normalized)) {
    const payrollMatch = text.match(
      /(?:nonfarm )?payroll employment\s*\(([+-]?[\d,]+)\)/i,
    );
    const unemploymentMatch = text.match(
      /unemployment rate\s*\(([\d.]+)\s*percent\)/i,
    );
    const payroll = payrollMatch
      ? Number(payrollMatch[1].replace(/,/g, ""))
      : null;
    const unemployment = unemploymentMatch
      ? Number(unemploymentMatch[1])
      : null;
    if (payroll === null || unemployment === null) return null;
    const month = englishMonthZh(text);
    const payrollDescription = `${payroll >= 0 ? "增加" : "减少"} ${(Math.abs(payroll) / 10_000).toFixed(1)}万`;
    const revisionMatch = text.match(
      /combined (?:is|were)\s+([\d,]+)\s+lower than previously reported/i,
    );
    const participationMatch = text.match(
      /labor force participation rate\s+(increased|decreased|rose|fell)[^.]{0,80}?to\s+([\d.]+)\s*percent/i,
    );
    const wageMatch = text.match(
      /average hourly earnings[^.]{0,180}?(?:rose|increased)\s+by[^.]{0,80}?\bor\s+([\d.]+)\s*percent[^.]*\.[^.]{0,100}?over the year[^.]{0,80}?(?:increased|rose)\s+(?:by\s+)?([\d.]+)\s*percent/i,
    );
    const revision = revisionMatch
      ? Number(revisionMatch[1].replace(/,/g, ""))
      : null;
    const participation = participationMatch
      ? Number(participationMatch[2])
      : null;
    const participationDirection = participationMatch?.[1]
      ? /decreased|fell/i.test(participationMatch[1])
        ? "降至"
        : "升至"
      : "变为";
    const wageMom = wageMatch ? Number(wageMatch[1]) : null;
    const wageYoy = wageMatch ? Number(wageMatch[2]) : null;
    const details = [
      revision !== null
        ? `前两个月合计下修 ${(revision / 10_000).toFixed(1)}万`
        : null,
      participation !== null
        ? `劳动参与率${participationDirection} ${participation.toFixed(1)}%`
        : null,
      wageMom !== null && wageYoy !== null
        ? `平均时薪环比 +${wageMom.toFixed(1)}%、同比 +${wageYoy.toFixed(1)}%`
        : null,
    ].filter((detail): detail is string => Boolean(detail));
    return {
      title: `美国${month}非农${chinesePayroll(payroll)}，失业率 ${unemployment.toFixed(1)}%`,
      whatHappened: `美国${month}非农就业人数${payrollDescription}，失业率为 ${unemployment.toFixed(1)}%${details.length ? `；${details.join("；")}` : ""}。${/leisure and hospitality lost jobs/i.test(text) ? "专业与商业服务、社会援助和医疗就业增加，但休闲与酒店业减少岗位。" : ""}`,
      whyItMatters:
        payroll < 100_000
          ? "新增就业明显偏弱：利率层面可能强化降息预期、支持长久期成长股；增长层面则会压低周期股和小盘股盈利预期。是否构成 surprise 仍要与一致预期比较。"
          : "就业仍有韧性，有利于消费和盈利预期，但也可能令市场推迟降息、抬高成长股折现率。",
      whatToWatch:
        "核对非农一致预期、前两个月修订和工资增速，并观察两年期美债收益率、小盘股与纳斯达克的相对反应。",
      semanticType: "employment",
    };
  }

  if (event.eventType === "trade_halt") {
    return {
      title: `${issuer} 出现交易暂停`,
      whatHappened: `${issuer} 的正常交易或报价被交易所暂停，原因仍需以交易所与公司公告为准。`,
      whyItMatters:
        "停牌会中断价格发现，复牌时可能出现跳空和流动性风险；仅凭停牌本身无法判断涨跌方向。",
      whatToWatch:
        "查看交易所停牌原因代码、公司公告、SEC 披露及预计复牌时间。",
      semanticType: "trade_halt",
    };
  }

  if (
    event.eventType === "earnings" ||
    /earnings|quarterly results|annual results/.test(normalized)
  ) {
    // Earnings emails are owned by the filing-research path. It sends only
    // after extracting the actual figures and assessing materiality.
    return null;
  }

  if (event.eventType.startsWith("sec_")) {
    return null;
  }

  if (/merger|acquisition|tender offer|acquire/.test(normalized)) {
    return null;
  }

  if (/offering|convertible|capital raise|financing|dilution/.test(normalized)) {
    return null;
  }

  if (/investigation|lawsuit|litigation|settlement|antitrust|regulat/.test(normalized)) {
    return null;
  }

  // A vague headline is still stored on the website, but never promoted to
  // an immediate email. The alert path requires a concrete Chinese fact set.
  return null;
}

function buildAlertContent(
  event: NormalizedEvent,
  presentation: ChineseMailEvent,
): {
  subject: string;
  text: string;
  html: string;
} {
  const scope = event.ticker === "MARKET" ? "市场" : event.ticker;
  const urgency = event.priority === "P0" ? "紧急突发" : "重要事件";
  const subject = `【${urgency}｜${scope}】${truncate(
    presentation.title,
    80,
  )}`;
  const publishedAt = formatEtDateTime(event.publishedAt);
  const detectedAt = formatEtDateTime(event.detectedAt);
  const text = [
    `${urgency}｜${scope}`,
    "",
    presentation.title,
    "",
    "发生了什么",
    presentation.whatHappened,
    "",
    "为什么重要 / 有什么影响",
    presentation.whyItMatters,
    "",
    "下一步看什么",
    presentation.whatToWatch,
    "",
    `来源：${event.sourceName}`,
    `发布时间：${publishedAt}`,
    `发现时间：${detectedAt}`,
    `查看原始来源：${event.url}`,
    "",
    "自动化监控信息，不构成投资建议。",
  ].join("\n");
  const html = [
    "<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#15211b;line-height:1.5\">",
    `<div style="max-width:680px;margin:auto;border:1px solid #d9e1dc;border-radius:12px;overflow:hidden">`,
    `<div style="padding:16px 20px;background:${event.priority === "P0" ? "#8b1e2d" : "#9a6114"};color:white">`,
    `<strong>${escapeHtml(urgency)} · ${escapeHtml(scope)}</strong></div>`,
    `<div style="padding:22px"><h2 style="margin-top:0">${escapeHtml(presentation.title)}</h2>`,
    '<p style="font-weight:700;margin-bottom:6px">发生了什么</p>',
    `<p style="margin-top:0">${escapeHtml(presentation.whatHappened)}</p>`,
    '<p style="font-weight:700;margin-bottom:6px">为什么重要 / 有什么影响</p>',
    `<p style="margin-top:0">${escapeHtml(presentation.whyItMatters)}</p>`,
    '<p style="font-weight:700;margin-bottom:6px">下一步看什么</p>',
    `<p style="margin-top:0">${escapeHtml(presentation.whatToWatch)}</p>`,
    `<table style="border-collapse:collapse;width:100%;margin-top:18px"><tbody>`,
    `<tr><td style="padding:5px 12px 5px 0;color:#647067">来源</td><td>${escapeHtml(event.sourceName)}</td></tr>`,
    `<tr><td style="padding:5px 12px 5px 0;color:#647067">发布时间</td><td>${escapeHtml(publishedAt)}</td></tr>`,
    `<tr><td style="padding:5px 12px 5px 0;color:#647067">发现时间</td><td>${escapeHtml(detectedAt)}</td></tr>`,
    `</tbody></table><p><a href="${escapeHtml(event.url)}">查看原始来源</a></p>`,
    `<p style="font-size:12px;color:#6b746f">自动化监控信息，不构成投资建议。</p>`,
    "</div></div></body></html>",
  ].join("");
  return { subject, text, html };
}

async function acquireLock(
  db: D1Database,
  ownerId: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await execute(
    db,
    `INSERT INTO worker_locks (name, owner_id, expires_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       owner_id = excluded.owner_id,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE worker_locks.expires_at < excluded.updated_at`,
    MONITOR_LOCK,
    ownerId,
    now + MONITOR_LOCK_TTL_MS,
    now,
  );
  return changes(result) > 0;
}

async function releaseLock(db: D1Database, ownerId: string): Promise<void> {
  await execute(
    db,
    "DELETE FROM worker_locks WHERE name = ? AND owner_id = ?",
    MONITOR_LOCK,
    ownerId,
  );
}

async function ensureSource(
  db: D1Database,
  source: SourceDefinition,
  at: string,
): Promise<void> {
  await execute(
    db,
    `INSERT INTO sources
       (id, name, kind, tier, required, enabled, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       kind = excluded.kind,
       tier = excluded.tier,
       required = excluded.required,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at
     WHERE sources.name IS NOT excluded.name
        OR sources.kind IS NOT excluded.kind
        OR sources.tier IS NOT excluded.tier
        OR sources.required IS NOT excluded.required
        OR sources.enabled IS NOT excluded.enabled`,
    source.id,
    source.name,
    source.kind,
    source.tier,
    source.required ? 1 : 0,
    source.enabled ? 1 : 0,
    source.enabled ? "starting" : "disabled",
    at,
    at,
  );
}

async function runTrackedSource(
  env: Env,
  runId: string,
  source: SourceDefinition,
  task: () => Promise<SourceResult>,
): Promise<SourceExecution> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  await ensureSource(env.DB, source, startedAt);

  let result: SourceResult;
  let error: string | null = null;
  try {
    if (!source.enabled) {
      result = {
        status: "disabled",
        sourceStatus: "disabled",
        itemsSeen: 0,
        itemsNew: 0,
      };
    } else {
      result = await task();
    }
  } catch (caught) {
    error = truncate(
      caught instanceof Error ? caught.message : "Unknown source failure",
      1_500,
    );
    if (caught instanceof SetupRequiredError) {
      result = {
        status: "needs_setup",
        sourceStatus: "needs_setup",
        itemsSeen: 0,
        itemsNew: 0,
        note: error,
      };
    } else {
      result = {
        status: "skipped",
        sourceStatus: "needs_setup",
        itemsSeen: 0,
        itemsNew: 0,
        note: error,
      };
    }
  }

  const finishedAt = nowIso();
  const latencyMs = Date.now() - startedMs;
  const executionStatus =
    error && !(error && result.status === "needs_setup")
      ? "failed"
      : result.status;
  const sourceStatus =
    executionStatus === "failed" ? "degraded" : result.sourceStatus;

  // A task that was not due did not fetch new data. Preserve its last real
  // source timestamp and do not append another no-op log every minute.
  if (!error && (result.status === "skipped" || result.status === "disabled") &&
      !result.cursor && result.itemsSeen === 0 && result.itemsNew === 0 &&
      !result.alertsQueued && !result.alertsSent) {
    return {
      ...result, status: executionStatus, sourceId: source.id,
      required: source.required, enabled: source.enabled, latencyMs, error,
    };
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE sources SET
           status = ?,
           cursor = COALESCE(?, cursor),
           last_checked_at = ?,
           last_success_at = CASE WHEN ? IN ('success', 'skipped') THEN ? ELSE last_success_at END,
           last_failure_at = CASE WHEN ? = 'failed' THEN ? ELSE last_failure_at END,
           last_latency_ms = ?,
           items_seen = items_seen + ?,
           items_new = items_new + ?,
           last_error = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        sourceStatus,
        result.cursor ?? null,
        finishedAt,
        executionStatus,
        finishedAt,
        executionStatus,
        finishedAt,
        latencyMs,
        result.itemsSeen,
        result.itemsNew,
        error ?? result.note ?? null,
        finishedAt,
        source.id,
      ),
    env.DB
      .prepare(
        `INSERT INTO run_sources
           (id, run_id, source_id, status, started_at, finished_at, latency_ms,
            items_seen, items_new, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        runId,
        source.id,
        executionStatus,
        startedAt,
        finishedAt,
        latencyMs,
        result.itemsSeen,
        result.itemsNew,
        error ?? result.note ?? null,
      ),
  ]);

  return {
    ...result,
    status: executionStatus as SourceExecution["status"],
    sourceId: source.id,
    required: source.required,
    enabled: source.enabled,
    latencyMs,
    error,
  };
}

async function getWatchlist(
  db: D1Database,
  maxTier: number,
): Promise<WatchlistRow[]> {
  return queryAll<WatchlistRow>(
    db,
    `SELECT symbol, company_name, cik, tier, active, sec_forms, keywords,
            created_at, updated_at
     FROM watchlist
     WHERE active = 1 AND tier <= ?
     ORDER BY tier, symbol`,
    maxTier,
  );
}

async function createWeeklyPreEventBaselines(
  env: Env,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  const frozenAt = nowIso();
  if (newYorkWeekday(frozenAt) !== "Mon") {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "Weekly pre-event baselines are frozen on Monday in America/New_York.",
    };
  }

  const tierOne = watchlist.filter((row) => row.tier === 1);
  const weekKey = newYorkDate(frozenAt);
  // Before Monday's close, Monday through Friday are the five future sessions.
  // If the worker is first activated after the close, start with Tuesday instead.
  const businessDayOffset = newYorkHour(frozenAt) < 16 ? 4 : 5;
  const resolutionAt = businessSessionResolution(
    frozenAt,
    businessDayOffset,
  );
  let inserted = 0;
  for (const row of tierOne) {
    const forecastKey = `pre-event-baseline-v1:${row.symbol}:${weekKey}`;
    const id = await sha256Hex(forecastKey);
    const result = await execute(
      env.DB,
      `INSERT OR IGNORE INTO forecasts
         (id, event_id, forecast_key, ticker, forecast_type, target_definition,
          horizon, probability_up, probability_base, probability_down,
          return_low, return_high, benchmark, rationale, status, created_at,
          information_cutoff_at, resolution_at, quality_flag)
       VALUES (?, NULL, ?, ?, 'pre_event_incidence_baseline_v1',
          'At least one Tier-1 SEC P0/P1 event during the next five US business dates; the two 5% tails together represent event incidence',
          '5d', 0.05, 0.90, 0.05, NULL, NULL, 'N/A',
          'baseline-v1 pooled prior: 10% material-event probability split equally across positive and non-positive tails; no post-cutoff information used',
          'open', ?, ?, ?, 'baseline_v1_weekday_calendar')`,
      id,
      forecastKey,
      row.symbol,
      frozenAt,
      frozenAt,
      resolutionAt,
    );
    inserted += changes(result);
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: tierOne.length,
    itemsNew: inserted,
    cursor: weekKey,
    note:
      inserted > 0
        ? "Frozen before-event baseline-v1 forecasts using only the pooled prior available at the information cutoff."
        : "This Monday's pre-event baselines were already frozen.",
  };
}

async function insertForecast(
  db: D1Database,
  event: NormalizedEvent,
): Promise<void> {
  if (event.priority === "P2" || event.ticker === "MARKET") return;
  const forecast = forecastForEvent(event);
  const id = await sha256Hex(`forecast|${event.id}`);
  const resolutionAt = nextBusinessSessionResolution(event.detectedAt);
  await execute(
    db,
    `INSERT OR IGNORE INTO forecasts
       (id, event_id, forecast_key, ticker, forecast_type, target_definition, horizon,
        probability_up, probability_base, probability_down, return_low,
        return_high, benchmark, rationale, status, created_at,
        information_cutoff_at, resolution_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    id,
    event.id,
    `event-reaction:${event.id}`,
    event.ticker,
    "event_reaction",
    "Prior-session close to next-session close return versus SPY after the information cutoff",
    "1d",
    forecast.probabilityUp,
    forecast.probabilityBase,
    forecast.probabilityDown,
    forecast.returnLow,
    forecast.returnHigh,
    "SPY",
    forecast.rationale,
    event.detectedAt,
    event.detectedAt,
    resolutionAt,
  );
}

async function enqueueAlert(
  env: Env,
  event: NormalizedEvent,
  context: EventInsertContext,
): Promise<boolean> {
  if (
    event.priority === "P2" ||
    event.sourceKey === "sec-edgar" ||
    event.eventType === "earnings"
  ) {
    return false;
  }
  const publishedMs = new Date(event.publishedAt).getTime();
  const eventAgeMs = Date.now() - publishedMs;
  if (
    !Number.isFinite(publishedMs) ||
    eventAgeMs < -5 * 60 * 1_000 ||
    eventAgeMs > IMMEDIATE_ALERT_MAX_AGE_MS
  ) {
    return false;
  }
  const alertText = `${event.headline} ${event.summary}`.toLowerCase();
  const immediateMarketAlert =
    event.ticker === "MARKET" &&
    /fomc|federal funds rate|rate (?:cut|hike|decision)|interest rate decision|cpi|consumer price index|pce|personal consumption expenditures|nonfarm payroll|payrolls|unemployment rate|gdp|gross domestic product|tariff|sanction|emergency lending|bank failure|systemic risk|market-wide trading halt/.test(
      alertText,
    );
  const immediateCompanyAlert =
    event.ticker !== "MARKET" &&
    /merger|acquisition|tender offer|bankrupt|default|fraud|restatement|non-reliance|trade halt|guidance (?:raised|lowered|cut|withdrawn)|withdraws? guidance|offering|capital raise|convertible|antitrust|fda (?:approval|rejection)|criminal|cease and desist/.test(
      alertText,
    );
  if (
    event.priority !== "P0" &&
    !immediateMarketAlert &&
    !immediateCompanyAlert
  ) {
    return false;
  }
  let analyzedEvent = event;
  if (event.ticker === "MARKET" && immediateMarketAlert) {
    try {
      const html = await fetchText(
        event.url,
        {
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
            "user-agent": "SignalLedger/1.0 owner@example.com",
          },
        },
        12_000,
      );
      analyzedEvent = {
        ...event,
        // BLS and BEA releases place revisions and labor/price subcomponents
        // below the headline paragraph, so keep enough official text to
        // analyze those facts before writing the email.
        summary: truncate(filingHtmlToText(html), 60_000),
      };
    } catch {
      analyzedEvent = event;
    }
  }
  const presentation = chineseMailEvent(analyzedEvent);
  if (!presentation) return false;
  const recipient = alertRecipient(env);
  const content = buildAlertContent(analyzedEvent, presentation);
  const status = context.bootstrap
    ? "suppressed_bootstrap"
    : context.dryRun
      ? "dry_run"
      : emailReady(env)
        ? "queued"
        : "needs_setup";
  const semanticDate = newYorkDate(event.publishedAt);
  const semanticKey =
    event.ticker === "MARKET"
      ? `market:${presentation.semanticType}:${semanticDate}`
      : `${event.ticker}:${presentation.semanticType}:${semanticDate}`;
  const id = await sha256Hex(`email|${semanticKey}|${recipient}`);
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO alert_outbox
       (id, event_id, channel, recipient, subject, text_body, html_body,
        status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    id,
    event.id,
    recipient,
    content.subject,
    content.text,
    content.html,
    status,
    status === "queued" ? event.detectedAt : null,
    event.detectedAt,
    event.detectedAt,
  );
  return changes(result) > 0 && status === "queued";
}

async function enqueueMaterialEarningsAlert(
  env: Env,
  event: NormalizedEvent,
  research: SecFilingResearch,
  context: EventInsertContext,
): Promise<boolean> {
  const ageMs = Date.now() - new Date(event.detectedAt).getTime();
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > MATERIAL_EARNINGS_ALERT_MAX_AGE_MS
  ) {
    return false;
  }
  const assessment = await assessMaterialEarningsDisclosure(
    env,
    event,
    research,
  );
  if (!assessment.shouldAlert) return false;

  const recipient = alertRecipient(env);
  const alertPeriod =
    assessment.fiscalPeriod || `release-${newYorkDate(event.publishedAt)}`;
  const alertKey = `earnings-impact:${event.ticker}:${alertPeriod}`;
  const id = await sha256Hex(`email|${alertKey}|${recipient}`);
  const content = buildMaterialEarningsAlertContent(
    event,
    research,
    assessment,
  );
  const status = context.bootstrap
    ? "suppressed_bootstrap"
    : context.dryRun
      ? "dry_run"
      : emailReady(env)
        ? "queued"
        : "needs_setup";
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO alert_outbox
       (id, event_id, channel, recipient, subject, text_body, html_body,
        status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    id,
    event.id,
    recipient,
    content.subject,
    content.text,
    content.html,
    status,
    status === "queued" ? event.detectedAt : null,
    event.detectedAt,
    event.detectedAt,
  );
  return changes(result) > 0 && status === "queued";
}

async function insertEvent(
  env: Env,
  event: NormalizedEvent,
  context: EventInsertContext,
): Promise<EventInsertResult> {
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO events
       (id, source_key, source_event_id, ticker, event_type, headline, summary,
        priority, source_name, source_tier, published_at, detected_at, url,
        direction, confidence, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.sourceKey,
    event.sourceEventId,
    event.ticker,
    event.eventType,
    event.headline,
    event.summary,
    event.priority,
    event.sourceName,
    event.sourceTier,
    event.publishedAt,
    event.detectedAt,
    event.url,
    event.direction,
    event.confidence,
    event.rawJson,
    event.detectedAt,
  );
  if (changes(result) === 0) {
    return { inserted: false, alertQueued: false };
  }
  await insertForecast(env.DB, event);
  const alertQueued = await enqueueAlert(env, event, context);
  return { inserted: true, alertQueued };
}

async function insertEventResearchNote(
  db: D1Database,
  event: Pick<NormalizedEvent, "id" | "ticker" | "detectedAt">,
  research: SecFilingResearch,
): Promise<number> {
  const researchKey = `sec-filing-content-v1:${event.id}`;
  const id = await sha256Hex(`event-research|${researchKey}`);
  const result = await execute(
    db,
    `INSERT OR IGNORE INTO event_research_notes
       (id, event_id, research_key, ticker, document_type, document_url,
        source_url, information_cutoff_at, headline, key_metrics_json,
        key_points_json, evidence_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    event.id,
    researchKey,
    event.ticker,
    research.documentType,
    research.documentUrl,
    research.sourceUrl,
    event.detectedAt,
    research.headline,
    safeJson(research.keyMetrics),
    safeJson(research.keyPoints),
    safeJson(research.evidence),
    research.status,
    event.detectedAt,
  );
  return changes(result);
}

function researchSummary(research: SecFilingResearch): string {
  return truncate(
    research.keyPoints
      .slice(0, 3)
      .map((point) => `${point.label}：${point.text}`)
      .join("；"),
    1_500,
  );
}

async function upsertEarningsActualFromSecResearch(
  env: Env,
  input: {
    eventId: string;
    ticker: string;
    fiscalPeriod: string;
    accession: string;
    availableAt: string;
  },
  research: SecFilingResearch,
): Promise<number> {
  const actual = research.earningsActual;
  if (!actual || (actual.revenue === null && actual.eps === null)) return 0;
  const accession = input.accession || input.eventId;
  const id = await sha256Hex(
    `earnings-actual|${input.ticker}|${input.fiscalPeriod}|${accession}`,
  );
  const at = nowIso();
  const result = await execute(
    env.DB,
    `INSERT INTO earnings_actuals
       (id, ticker, fiscal_period, accession, event_id, available_at,
        revenue, revenue_unit, eps, eps_unit, source_name, source_url,
        source_quality, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'USD/shares', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, fiscal_period, accession) DO UPDATE SET
       event_id = COALESCE(earnings_actuals.event_id, excluded.event_id),
       available_at = excluded.available_at,
       revenue = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.revenue
         ELSE COALESCE(excluded.revenue, earnings_actuals.revenue)
       END,
       eps = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.eps
         ELSE COALESCE(excluded.eps, earnings_actuals.eps)
       END,
       source_name = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.source_name
         ELSE excluded.source_name
       END,
       source_url = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.source_url
         ELSE excluded.source_url
       END,
       source_quality = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.source_quality
         ELSE excluded.source_quality
       END,
       evidence_json = CASE
         WHEN earnings_actuals.source_name LIKE '%Company Facts%'
           THEN earnings_actuals.evidence_json
         ELSE excluded.evidence_json
       END,
       updated_at = excluded.updated_at`,
    id,
    input.ticker,
    input.fiscalPeriod,
    accession,
    input.eventId,
    input.availableAt,
    actual.revenue,
    actual.eps,
    "SEC 财报附件",
    research.documentUrl,
    "Tier 1；财报实际值从公司提交给 SEC 的业绩附件提取，后续由 XBRL Company Facts 复核。",
    safeJson({
      evidence: research.evidence,
      extracted: actual,
      documentType: research.documentType,
    }),
    at,
    at,
  );
  return changes(result);
}

async function resolveEarningsForecastFromSecResearch(
  env: Env,
  event: {
    id: string;
    ticker: string;
    publishedAt: string;
    detectedAt: string;
    rawJson: string | null;
  },
  research: SecFilingResearch,
): Promise<number> {
  const actual = research.earningsActual;
  if (!actual || (actual.revenue === null && actual.eps === null)) return 0;
  const raw = parseJsonRecord(event.rawJson);
  const accession = String(raw.accession ?? "").trim();
  const eventSession = newYorkDate(event.publishedAt);
  const forecasts = await queryAll<EarningsForecastRow>(
    env.DB,
    `SELECT id, ticker, cik, fiscal_period, expected_window_start,
            expected_window_end, information_cutoff_at, revenue_estimate,
            eps_estimate, actual_revenue, actual_eps, status
     FROM earnings_forecasts
     WHERE ticker = ?
     ORDER BY created_at DESC`,
    event.ticker,
  );
  let resolved = 0;
  for (const forecast of forecasts) {
    const profile = earningsEventProfile(
      forecast.ticker,
      forecast.fiscal_period,
      env.earningsCalendar,
    );
    if (!profile?.date) continue;
    const eventDay = Date.parse(`${eventSession}T00:00:00Z`);
    const profileDay = Date.parse(`${profile.date}T00:00:00Z`);
    if (
      !Number.isFinite(eventDay) ||
      !Number.isFinite(profileDay) ||
      Math.abs(eventDay - profileDay) > 2 * 24 * 60 * 60 * 1_000
    ) {
      continue;
    }
    resolved += await upsertEarningsActualFromSecResearch(
      env,
      {
        eventId: event.id,
        ticker: event.ticker,
        fiscalPeriod: forecast.fiscal_period,
        accession,
        availableAt: event.publishedAt,
      },
      research,
    );
    // Resolved forecasts are immutable by design. Corrections are written to
    // earnings_actuals and overlaid at read time, preserving the frozen record.
    if (forecast.status === "resolved") continue;
    if (!['open', 'awaiting_actual'].includes(forecast.status)) continue;
    if (event.publishedAt <= forecast.information_cutoff_at) {
      const expired = await execute(
        env.DB,
        `UPDATE earnings_forecasts SET
           status = 'expired',
           resolution_notes = '该记录生成时本期财报已公开，因此只展示实际值，不纳入事前预测回测。',
           updated_at = ?
         WHERE id = ? AND status IN ('open', 'awaiting_actual')`,
        nowIso(),
        forecast.id,
      );
      resolved += changes(expired);
      continue;
    }
    const revenueErrorPct =
      forecast.revenue_estimate == null || actual.revenue === null
        ? null
        : (Number(forecast.revenue_estimate) - actual.revenue) /
          Math.abs(actual.revenue);
    const epsError =
      forecast.eps_estimate == null || actual.eps === null
        ? null
        : Number(forecast.eps_estimate) - actual.eps;
    const resolvedAt = nowIso();
    const status = actual.revenue === null ? "awaiting_actual" : "resolved";
    const result = await execute(
      env.DB,
      `UPDATE earnings_forecasts SET
         status = ?,
         actual_event_id = ?,
         actual_accession = ?,
         actual_filed_at = ?,
         actual_revenue = COALESCE(?, actual_revenue),
         actual_eps = COALESCE(?, actual_eps),
         revenue_error_pct = ?,
         eps_error = ?,
         resolution_notes = ?,
         resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
         updated_at = ?
       WHERE id = ? AND status IN ('open', 'awaiting_actual')`,
      status,
      event.id,
      accession || null,
      event.publishedAt,
      actual.revenue,
      actual.eps,
      revenueErrorPct,
      epsError,
      actual.revenue === null
        ? "已从 SEC 财报附件提取 EPS；总营收仍在核验，不作推算。"
        : "已从 SEC 财报附件即时取得实际值，后续再由 SEC Company Facts 复核。",
      status,
      resolvedAt,
      resolvedAt,
      forecast.id,
    );
    resolved += changes(result);
  }
  return resolved;
}

async function processSecFilingResearch(env: Env): Promise<SourceResult> {
  const at = nowIso();
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "research:sec-filing-content-v1",
  );
  if (isRecent(source?.cursor, SEC_RESEARCH_REFRESH_MS)) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "SEC filing-content backfill is not due.",
    };
  }
  const rows = await queryAll<{
    id: string;
    source_key: string;
    source_event_id: string;
    ticker: string;
    event_type: string;
    headline: string;
    summary: string;
    priority: Priority;
    source_name: string;
    source_tier: number;
    published_at: string;
    url: string;
    detected_at: string;
    direction: Direction;
    confidence: number;
    raw_json: string | null;
  }>(
    env.DB,
    `SELECT e.id, e.source_key, e.source_event_id, e.ticker, e.event_type,
            e.headline, e.summary, e.priority, e.source_name, e.source_tier,
            e.published_at, e.url, e.detected_at, e.direction, e.confidence,
            e.raw_json
     FROM events e
     LEFT JOIN event_research_notes n ON n.event_id = e.id
     WHERE e.source_key = 'sec-edgar'
       AND e.priority IN ('P0', 'P1')
       AND e.event_type IN ('sec_8_k', 'sec_6_k', 'sec_10_q', 'sec_10_k')
       AND n.id IS NULL
     ORDER BY e.detected_at DESC
     LIMIT ?`,
    MAX_SEC_RESEARCH_PER_RUN,
  );
  let inserted = 0;
  let failed = 0;
  let alertsQueued = 0;
  for (const row of rows) {
    const raw = parseJsonRecord(row.raw_json);
    const form = String(raw.form ?? row.event_type.replace(/^sec_/, ""));
    try {
      const research = await analyzeSecFiling(env, row.url, form);
      const event: NormalizedEvent = {
        id: row.id,
        sourceKey: row.source_key,
        sourceEventId: row.source_event_id,
        ticker: row.ticker,
        eventType: row.event_type,
        headline: row.headline,
        summary: row.summary,
        priority: row.priority,
        sourceName: row.source_name,
        sourceTier: row.source_tier,
        publishedAt: row.published_at,
        detectedAt: row.detected_at,
        url: row.url,
        direction: row.direction,
        confidence: row.confidence,
        rawJson: row.raw_json,
      };
      inserted += await insertEventResearchNote(
        env.DB,
        event,
        research,
      );
      await resolveEarningsForecastFromSecResearch(env, event, research);
      if (
        await enqueueMaterialEarningsAlert(env, event, research, {
          dryRun: envBoolean(env.DRY_RUN),
          bootstrap: false,
        })
      ) {
        alertsQueued += 1;
      }
    } catch {
      failed += 1;
    }
    await sleep(120);
  }
  return {
    status: "success",
    sourceStatus: failed && !inserted ? "needs_setup" : "healthy",
    itemsSeen: rows.length,
    itemsNew: inserted,
    cursor: at,
    alertsQueued,
    note:
      failed > 0
        ? `${inserted} SEC research note(s) stored; ${failed} filing(s) remain for retry.`
        : `${inserted} SEC research note(s) stored from filing bodies or exhibits.`,
  };
}

async function processSecEarningsActualBackfill(
  env: Env,
): Promise<SourceResult> {
  const at = nowIso();
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "actual:sec-earnings-release-v1",
  );
  if (isRecent(source?.cursor, SEC_RESEARCH_REFRESH_MS)) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "SEC earnings-release actual refresh is not due.",
    };
  }
  const rows = await queryAll<{
    event_id: string;
    ticker: string;
    url: string;
    published_at: string;
    detected_at: string;
    raw_json: string | null;
  }>(
    env.DB,
    `SELECT DISTINCT e.id AS event_id, e.ticker, e.url, e.published_at,
            e.detected_at, e.raw_json
     FROM earnings_forecasts ef
     JOIN events e
       ON e.ticker = ef.ticker
      AND e.source_key = 'sec-edgar'
      AND e.event_type IN ('sec_8_k', 'sec_6_k')
     WHERE (
         ef.status IN ('open', 'awaiting_actual')
         OR (
           ef.status = 'resolved'
           AND ef.revenue_estimate IS NOT NULL
           AND ef.actual_revenue IS NOT NULL
           AND (
             ABS(ef.actual_revenue) < ABS(ef.revenue_estimate) * 0.25
             OR ABS(ef.actual_revenue) > ABS(ef.revenue_estimate) * 4
           )
           AND NOT EXISTS (
             SELECT 1
             FROM earnings_actuals ea
             WHERE ea.ticker = ef.ticker
               AND ea.fiscal_period = ef.fiscal_period
               AND ea.revenue IS NOT NULL
               AND ABS(ea.revenue) >= ABS(ef.revenue_estimate) * 0.25
               AND ABS(ea.revenue) <= ABS(ef.revenue_estimate) * 4
           )
         )
       )
       AND (
         e.raw_json LIKE '%2.02%'
         OR e.headline LIKE '%result%'
         OR e.summary LIKE '%revenue%'
         OR e.summary LIKE '%EPS%'
       )
     ORDER BY e.detected_at DESC
     LIMIT ?`,
    MAX_SEC_RESEARCH_PER_RUN,
  );
  let resolved = 0;
  let failed = 0;
  for (const row of rows) {
    const raw = parseJsonRecord(row.raw_json);
    const form = String(raw.form ?? "8-K");
    try {
      const research = await analyzeSecFiling(env, row.url, form);
      resolved += await resolveEarningsForecastFromSecResearch(
        env,
        {
          id: row.event_id,
          ticker: row.ticker,
          publishedAt: row.published_at,
          detectedAt: row.detected_at,
          rawJson: row.raw_json,
        },
        research,
      );
    } catch {
      failed += 1;
    }
    await sleep(120);
  }
  return {
    status: "success",
    sourceStatus: failed && !resolved ? "needs_setup" : "healthy",
    itemsSeen: rows.length,
    itemsNew: resolved,
    cursor: at,
    note:
      failed > 0
        ? `${resolved} earnings forecast(s) resolved from SEC release exhibits; ${failed} filing(s) remain for retry.`
        : `${resolved} earnings forecast(s) resolved from SEC release exhibits without waiting for Company Facts.`,
  };
}

async function syncSecCompanyTickers(
  env: Env,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  const existing = await queryFirst<{ last_success_at: string | null }>(
    env.DB,
    "SELECT last_success_at FROM sources WHERE id = ?",
    "sec:company-tickers",
  );
  if (
    watchlist.every((row) => Boolean(row.cik)) &&
    isRecent(existing?.last_success_at, SEC_TICKER_REFRESH_MS)
  ) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "Daily ticker map refresh is not due yet.",
    };
  }

  const payload = await fetchJson<Record<string, SecCompanyTicker>>(
    SEC_COMPANY_TICKERS_URL,
    { headers: secHeaders(env) },
    20_000,
  );
  const wanted = new Set(watchlist.map((row) => row.symbol));
  const matches = Object.values(payload).filter((entry) =>
    wanted.has(normalizeSymbol(entry.ticker)),
  );
  const at = nowIso();
  let changed = 0;
  const statements = matches.map((entry) => {
    const symbol = normalizeSymbol(entry.ticker);
    const cik = normalizeCik(entry.cik_str);
    const title = truncate(entry.title || symbol, 300);
    return env.DB
      .prepare(
        `UPDATE watchlist SET
           company_name = CASE WHEN ? <> '' THEN ? ELSE company_name END,
           cik = COALESCE(?, cik),
           updated_at = ?
         WHERE symbol = ?`,
      )
      .bind(title, title, cik, at, symbol);
  });
  if (statements.length) {
    const results = await env.DB.batch(statements);
    changed = results.reduce((sum, result) => sum + changes(result), 0);
  }
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: Object.keys(payload).length,
    itemsNew: changed,
    cursor: at,
  };
}

function recentField(
  recent: Record<string, unknown[]>,
  field: string,
  index: number,
): unknown {
  const values = recent[field];
  return Array.isArray(values) ? values[index] : undefined;
}

async function ingestSecSubmissions(
  env: Env,
  row: WatchlistRow,
): Promise<SourceResult> {
  if (!row.cik) {
    throw new Error(
      `No SEC CIK is available for ${row.symbol}; company ticker sync did not resolve it.`,
    );
  }
  const cik = normalizeCik(row.cik);
  if (!cik) throw new Error(`Invalid SEC CIK for ${row.symbol}.`);

  const sourceId = `sec:submissions:${row.symbol}`;
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    sourceId,
  );
  const previousCursor = source?.cursor ?? null;
  const bootstrap = !previousCursor;
  const bootstrapHours = envInteger(
    env.SEC_BOOTSTRAP_HOURS,
    72,
    1,
    24 * 30,
  );
  const bootstrapCutoff = Date.now() - bootstrapHours * 60 * 60 * 1_000;

  const payload = await fetchJson<SecSubmissionsPayload>(
    `${SEC_SUBMISSIONS_BASE_URL}/CIK${cik}.json`,
    { headers: secHeaders(env) },
    15_000,
  );
  const recent = payload.filings?.recent ?? {};
  const accessionNumbers = Array.isArray(recent.accessionNumber)
    ? recent.accessionNumber.map((value) => String(value ?? ""))
    : [];
  const latestCursor = accessionNumbers[0] || previousCursor;
  let cursorFound = !previousCursor;
  let itemsSeen = 0;
  let itemsNew = 0;
  let alertsQueued = 0;
  const detectedAt = nowIso();

  for (
    let index = 0;
    index <
    Math.min(accessionNumbers.length, MAX_SEC_FILINGS_PER_TICKER_PER_RUN);
    index += 1
  ) {
    const accession = accessionNumbers[index];
    if (!accession) continue;
    if (previousCursor && accession === previousCursor) {
      cursorFound = true;
      break;
    }

    const acceptanceValue = recentField(
      recent,
      "acceptanceDateTime",
      index,
    );
    const filingDateValue = recentField(recent, "filingDate", index);
    const publishedAt = acceptanceValue
      ? parseSecTimestamp(acceptanceValue, detectedAt)
      : parseDateOnly(filingDateValue, detectedAt);
    if (
      (!previousCursor || !cursorFound) &&
      new Date(publishedAt).getTime() < bootstrapCutoff
    ) {
      continue;
    }

    itemsSeen += 1;
    const form = String(recentField(recent, "form", index) ?? "FILING");
    const items = String(recentField(recent, "items", index) ?? "");
    const reportDate = String(
      recentField(recent, "reportDate", index) ?? "",
    );
    const description = truncate(
      recentField(recent, "primaryDocDescription", index) ?? "",
      500,
    );
    const primaryDocument = String(
      recentField(recent, "primaryDocument", index) ?? "",
    );
    const classification = classifySecFiling(form, items, description);
    const accessionPath = accession.replace(/-/g, "");
    const cikPath = String(Number.parseInt(cik, 10));
    const url = primaryDocument
      ? `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}/${encodeURIComponent(
          primaryDocument,
        )}`
      : `https://www.sec.gov/edgar/browse/?CIK=${cikPath}`;
    const sourceEventId = `${row.symbol}:${accession}`;
    const id = await sha256Hex(`sec|${sourceEventId}`);
    const details = [
      reportDate ? `Report date ${reportDate}.` : "",
      items ? `Items ${items}.` : "",
      `Accession ${accession}.`,
    ]
      .filter(Boolean)
      .join(" ");
    let event: NormalizedEvent = {
      id,
      sourceKey: "sec-edgar",
      sourceEventId,
      ticker: row.symbol,
      eventType: classification.eventType,
      headline: truncate(
        `${row.symbol} filed ${form}${description ? ` — ${description}` : ""}`,
        500,
      ),
      summary: truncate(details, 1_500),
      priority: classification.priority,
      sourceName: "SEC EDGAR",
      sourceTier: 1,
      publishedAt,
      detectedAt,
      url,
      direction: classification.direction,
      confidence: classification.confidence,
      rawJson: safeJson({
        cik,
        companyName: payload.name ?? row.company_name,
        accession,
        form,
        items,
        reportDate,
        filingDate: filingDateValue,
        acceptanceDateTime: acceptanceValue,
        primaryDocument,
        primaryDocDescription: description,
      }),
    };
    let filingResearch: SecFilingResearch | null = null;
    if (
      classification.priority !== "P2" &&
      ["sec_8_k", "sec_6_k", "sec_10_q", "sec_10_k"].includes(
        classification.eventType,
      )
    ) {
      try {
        filingResearch = await analyzeSecFiling(env, url, form);
        const researchedSummary = researchSummary(filingResearch);
        const researchedDirection = inferDirection(researchedSummary);
        event = {
          ...event,
          headline: truncate(
            `${row.symbol}｜${filingResearch.headline}`,
            500,
          ),
          summary: researchedSummary || event.summary,
          direction: researchedDirection.direction,
          confidence: Math.max(
            event.confidence,
            researchedDirection.confidence,
          ),
        };
      } catch {
        filingResearch = null;
      }
    }
    const inserted = await insertEvent(env, event, {
      dryRun: envBoolean(env.DRY_RUN),
      bootstrap,
    });
    let materialAlertQueued = false;
    if (inserted.inserted) {
      itemsNew += 1;
      if (filingResearch) {
        await insertEventResearchNote(env.DB, event, filingResearch);
        await resolveEarningsForecastFromSecResearch(
          env,
          {
            id: event.id,
            ticker: event.ticker,
            publishedAt: event.publishedAt,
            detectedAt: event.detectedAt,
            rawJson: event.rawJson,
          },
          filingResearch,
        );
        materialAlertQueued = await enqueueMaterialEarningsAlert(
          env,
          event,
          filingResearch,
          {
            dryRun: envBoolean(env.DRY_RUN),
            bootstrap,
          },
        );
      }
    }
    if (inserted.alertQueued || materialAlertQueued) alertsQueued += 1;
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen,
    itemsNew,
    cursor: latestCursor,
    alertsQueued,
    note:
      previousCursor && !cursorFound
        ? "Previous SEC cursor was not present in the recent filing window; lookback protection was applied."
        : bootstrap
          ? "Bootstrap filings were stored without sending historical alerts."
          : null,
  };
}

const REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "SalesRevenueGoodsNet",
] as const;

const EPS_CONCEPTS = [
  "EarningsPerShareDiluted",
  "EarningsPerShareBasicAndDiluted",
] as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function dateOnlyToIso(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function metricFactScore(fact: MetricFact): number {
  const targetDays = fact.fiscalPeriod === "FY" ? 365 : 91;
  const preferredForm =
    fact.fiscalPeriod === "FY" ? fact.form === "10-K" : fact.form === "10-Q";
  return Math.abs(fact.durationDays - targetDays) + (preferredForm ? 0 : 30);
}

function extractMetricFacts(
  payload: SecCompanyFactsPayload,
  metricName: MetricFact["metricName"],
  sourceUrl: string,
  cutoffAt: string,
): MetricFact[] {
  const concepts = metricName === "revenue" ? REVENUE_CONCEPTS : EPS_CONCEPTS;
  const unit = metricName === "revenue" ? "USD" : "USD/shares";
  const taxonomy = payload.facts?.["us-gaap"] ?? {};
  const cutoffMs = new Date(cutoffAt).getTime();

  for (const concept of concepts) {
    const values = taxonomy[concept]?.units?.[unit] ?? [];
    const candidates: MetricFact[] = [];
    for (const value of values) {
      const number = numericValue(value.val);
      const start = dateOnlyToIso(value.start);
      const end = dateOnlyToIso(value.end);
      const filedAt = dateOnlyToIso(value.filed);
      const accession = String(value.accn ?? "").trim();
      const form = String(value.form ?? "").trim().toUpperCase();
      const fiscalYear = Number.parseInt(String(value.fy ?? ""), 10);
      const fiscalPeriod = String(value.fp ?? "").trim().toUpperCase();
      if (
        number == null ||
        !start ||
        !end ||
        !filedAt ||
        !accession ||
        !/^10-[QK](?:\/A)?$/.test(form) ||
        !Number.isFinite(fiscalYear) ||
        !["Q1", "Q2", "Q3", "Q4", "FY"].includes(fiscalPeriod) ||
        new Date(filedAt).getTime() > cutoffMs
      ) {
        continue;
      }
      const durationDays = Math.round(
        (new Date(end).getTime() - new Date(start).getTime()) /
          (24 * 60 * 60 * 1_000),
      );
      const durationOkay =
        fiscalPeriod === "FY"
          ? durationDays >= 240 && durationDays <= 430
          : durationDays >= 45 && durationDays <= 180;
      if (!durationOkay) continue;
      candidates.push({
        metricName,
        concept,
        value: number,
        unit,
        start,
        end,
        filedAt,
        accession,
        form,
        fiscalYear,
        fiscalPeriod,
        reportPeriod: end.slice(0, 10),
        durationDays,
        sourceUrl,
      });
    }
    if (!candidates.length) continue;

    // A single filing often exposes both quarter-only and year-to-date facts.
    // Keep the duration closest to one quarter (or one fiscal year), preferring
    // the original 10-Q/10-K over amendments. This rule is deterministic and
    // is part of the frozen evidence snapshot.
    const byPeriod = new Map<string, MetricFact>();
    for (const candidate of candidates) {
      const key = `${candidate.reportPeriod}|${candidate.fiscalPeriod}`;
      const existing = byPeriod.get(key);
      if (
        !existing ||
        metricFactScore(candidate) < metricFactScore(existing) ||
        (metricFactScore(candidate) === metricFactScore(existing) &&
          candidate.filedAt < existing.filedAt)
      ) {
        byPeriod.set(key, candidate);
      }
    }
    return Array.from(byPeriod.values()).sort(
      (left, right) =>
        new Date(left.end).getTime() - new Date(right.end).getTime(),
    );
  }
  return [];
}

function priorComparable(
  fact: MetricFact,
  series: MetricFact[],
): MetricFact | null {
  const factEnd = new Date(fact.end).getTime();
  const candidates = series.filter((candidate) => {
    if (candidate.fiscalPeriod !== fact.fiscalPeriod) return false;
    const dayGap =
      (factEnd - new Date(candidate.end).getTime()) /
      (24 * 60 * 60 * 1_000);
    return dayGap >= 300 && dayGap <= 430;
  });
  return (
    candidates.sort((left, right) => {
      const leftGap = Math.abs(
        (factEnd - new Date(left.end).getTime()) /
          (24 * 60 * 60 * 1_000) -
          365,
      );
      const rightGap = Math.abs(
        (factEnd - new Date(right.end).getTime()) /
          (24 * 60 * 60 * 1_000) -
          365,
      );
      return leftGap - rightGap;
    })[0] ?? null
  );
}

function nextFiscalPeriod(
  latest: MetricFact,
): { fiscalYear: number; fiscalPeriod: string; key: string } | null {
  let fiscalYear = latest.fiscalYear;
  let fiscalPeriod: string;
  if (latest.fiscalPeriod === "Q1") fiscalPeriod = "Q2";
  else if (latest.fiscalPeriod === "Q2") fiscalPeriod = "Q3";
  else if (latest.fiscalPeriod === "Q3") fiscalPeriod = "FY";
  else if (latest.fiscalPeriod === "FY" || latest.fiscalPeriod === "Q4") {
    fiscalYear += 1;
    fiscalPeriod = "Q1";
  } else {
    return null;
  }
  return { fiscalYear, fiscalPeriod, key: `${fiscalYear}-${fiscalPeriod}` };
}

function findTargetSeasonBaseline(
  series: MetricFact[],
  target: { fiscalYear: number; fiscalPeriod: string },
  latestEnd: string,
): MetricFact | null {
  const exact = series
    .filter(
      (fact) =>
        fact.fiscalYear === target.fiscalYear - 1 &&
        fact.fiscalPeriod === target.fiscalPeriod,
    )
    .at(-1);
  if (exact) return exact;
  const latestEndMs = new Date(latestEnd).getTime();
  return (
    series
      .filter((fact) => {
        const gapDays =
          (latestEndMs - new Date(fact.end).getTime()) /
          (24 * 60 * 60 * 1_000);
        return fact.fiscalPeriod === target.fiscalPeriod && gapDays >= 180;
      })
      .at(-1) ?? null
  );
}

function recentRevenueGrowthRates(series: MetricFact[]): number[] {
  return series
    .slice(-4)
    .map((fact) => {
      const prior = priorComparable(fact, series);
      return prior && prior.value !== 0
        ? fact.value / prior.value - 1
        : null;
    })
    .filter((value): value is number => value != null && Number.isFinite(value))
    .slice(-3);
}

function recentEpsDeltas(series: MetricFact[]): number[] {
  return series
    .slice(-4)
    .map((fact) => {
      const prior = priorComparable(fact, series);
      return prior ? fact.value - prior.value : null;
    })
    .filter((value): value is number => value != null && Number.isFinite(value))
    .slice(-3);
}

function inferEarningsWindow(
  revenueSeries: MetricFact[],
): {
  start: string;
  end: string;
  confidence: number;
  filingCount: number;
  medianGapDays: number;
} | null {
  const unique = new Map<string, MetricFact>();
  for (const fact of revenueSeries) {
    if (!unique.has(fact.accession)) unique.set(fact.accession, fact);
  }
  const filings = Array.from(unique.values())
    .sort(
      (left, right) =>
        new Date(left.filedAt).getTime() - new Date(right.filedAt).getTime(),
    )
    .slice(-8);
  if (filings.length < 4) return null;
  const gaps = filings
    .slice(1)
    .map(
      (fact, index) =>
        (new Date(fact.filedAt).getTime() -
          new Date(filings[index].filedAt).getTime()) /
        (24 * 60 * 60 * 1_000),
    )
    .filter((days) => days >= 45 && days <= 150);
  const medianGapDays = median(gaps);
  if (medianGapDays == null) return null;
  const deviations = gaps.map((days) => Math.abs(days - medianGapDays));
  const spreadDays = clamp((median(deviations) ?? 7) + 10, 10, 28);
  const latestFiledMs = new Date(filings.at(-1)?.filedAt ?? "").getTime();
  const centerMs = latestFiledMs + medianGapDays * 24 * 60 * 60 * 1_000;
  const confidence =
    filings.length >= 8 ? 0.82 : filings.length >= 6 ? 0.72 : 0.62;
  return {
    start: new Date(
      centerMs - spreadDays * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    end: new Date(
      centerMs + spreadDays * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    confidence,
    filingCount: filings.length,
    medianGapDays,
  };
}

function fiscalPeriodMatches(fact: MetricFact, fiscalPeriod: string): boolean {
  const match = fiscalPeriod.match(/^(\d{4})-(Q1|Q2|Q3|Q4|FY)$/);
  return Boolean(
    match &&
      fact.fiscalYear === Number(match[1]) &&
      fact.fiscalPeriod === match[2],
  );
}

function earningsEvidencePayload(fact: MetricFact): Record<string, unknown> {
  return {
    concept: fact.concept,
    metricName: fact.metricName,
    value: fact.value,
    unit: fact.unit,
    start: fact.start,
    end: fact.end,
    filedAt: fact.filedAt,
    accession: fact.accession,
    form: fact.form,
    fiscalYear: fact.fiscalYear,
    fiscalPeriod: fact.fiscalPeriod,
    durationDays: fact.durationDays,
  };
}

async function insertEarningsEvidence(
  db: D1Database,
  forecastId: string,
  facts: MetricFact[],
  createdAt: string,
): Promise<void> {
  const unique = new Map<string, MetricFact>();
  for (const fact of facts) {
    const key = `${fact.metricName}|${fact.accession}|${fact.reportPeriod}`;
    if (!unique.has(key)) unique.set(key, fact);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [evidenceKey, fact] of unique) {
    const id = await sha256Hex(`earnings-evidence|${forecastId}|${evidenceKey}`);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO earnings_forecast_evidence
             (id, forecast_id, evidence_key, accession, form, filed_at,
              report_period, fiscal_year, fiscal_period, metric_name,
              metric_value, metric_unit, source_url, raw_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          forecastId,
          evidenceKey,
          fact.accession,
          fact.form,
          fact.filedAt,
          fact.reportPeriod,
          fact.fiscalYear,
          fact.fiscalPeriod,
          fact.metricName,
          fact.value,
          fact.unit,
          fact.sourceUrl,
          safeJson(earningsEvidencePayload(fact)),
          createdAt,
        ),
    );
  }
  if (statements.length) await db.batch(statements);
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map(finiteNumber)
        .filter((item): item is number => item !== null)
    : [];
}

function roundProbability(value: number): number {
  return Math.round(value * 20) / 20;
}

function buildEarningsReactionModel(
  basis: Record<string, unknown>,
): EarningsReactionModel {
  const revenueGrowthRates = finiteNumberArray(
    basis.recentRevenueGrowthRates,
  );
  const epsDeltas = finiteNumberArray(basis.recentEpsDeltas);
  const appliedRevenueGrowth =
    revenueGrowthRates.length >= 2
      ? finiteNumber(basis.appliedRevenueGrowth)
      : null;
  const appliedEpsDelta = epsDeltas.length >= 2 ? median(epsDeltas) : null;

  let probabilityUp = 0.35;
  const probabilityBase = 0.3;
  let probabilityDown = 0.35;
  const keyDrivers: string[] = [];
  let positiveSignals = 0;
  let negativeSignals = 0;

  if (appliedRevenueGrowth !== null && appliedRevenueGrowth >= 0.05) {
    probabilityUp += 0.05;
    probabilityDown -= 0.05;
    positiveSignals += 1;
    keyDrivers.push(
      `SEC 可比收入趋势为 +${(appliedRevenueGrowth * 100).toFixed(1)}%，提供一个温和正向信号。`,
    );
  } else if (
    appliedRevenueGrowth !== null &&
    appliedRevenueGrowth <= -0.05
  ) {
    probabilityUp -= 0.05;
    probabilityDown += 0.05;
    negativeSignals += 1;
    keyDrivers.push(
      `SEC 可比收入趋势为 ${(appliedRevenueGrowth * 100).toFixed(1)}%，提供一个温和负向信号。`,
    );
  } else if (appliedRevenueGrowth !== null) {
    keyDrivers.push(
      `SEC 可比收入趋势为 ${(appliedRevenueGrowth * 100).toFixed(1)}%，未达到方向阈值。`,
    );
  } else {
    keyDrivers.push("可比收入样本少于 2 个，未启用收入方向信号。");
  }

  if (appliedEpsDelta !== null && appliedEpsDelta > 0) {
    probabilityUp += 0.05;
    probabilityDown -= 0.05;
    positiveSignals += 1;
    keyDrivers.push(
      `可比 EPS 同比差额中位数为 +${appliedEpsDelta.toFixed(2)}，提供一个温和正向信号。`,
    );
  } else if (appliedEpsDelta !== null && appliedEpsDelta < 0) {
    probabilityUp -= 0.05;
    probabilityDown += 0.05;
    negativeSignals += 1;
    keyDrivers.push(
      `可比 EPS 同比差额中位数为 ${appliedEpsDelta.toFixed(2)}，提供一个温和负向信号。`,
    );
  } else if (appliedEpsDelta !== null) {
    keyDrivers.push("可比 EPS 趋势接近中性，未改变先验概率。");
  } else {
    keyDrivers.push("可比 EPS 样本少于 2 个，未启用 EPS 方向信号。");
  }

  probabilityUp = roundProbability(probabilityUp);
  probabilityDown = roundProbability(probabilityDown);
  const ranked = [
    { direction: "up" as const, value: probabilityUp },
    { direction: "base" as const, value: probabilityBase },
    { direction: "down" as const, value: probabilityDown },
  ].sort((left, right) => right.value - left.value);
  const predictedDirection =
    ranked[0].direction !== "base" &&
    ranked[0].value >= 0.45 &&
    ranked[0].value - ranked[1].value >= 0.1
      ? ranked[0].direction
      : "uncertain";
  const rawExpectedReturn =
    predictedDirection === "uncertain"
      ? null
      : (probabilityUp - probabilityDown) * 0.05;
  const expectedRelativeReturn =
    rawExpectedReturn === null
      ? null
      : Math.round(rawExpectedReturn / 0.005) * 0.005;

  keyDrivers.push(
    "市场一致预期尚未接入，模型没有使用 beat/miss 特征。",
    "价格反应历史与事件隔离期权数据尚未接入，±6% 仅为研究情景带，不是隐含波动。",
  );

  return {
    probabilityUp,
    probabilityBase,
    probabilityDown,
    predictedDirection,
    expectedRelativeReturn,
    reactionLow: -0.06,
    reactionHigh: 0.06,
    reactionRangeBasis: "research_scenario_band_not_options_implied",
    sampleSize: 0,
    modelConfidence: "low",
    consensusStatus: "unavailable",
    keyDrivers,
    invalidationCondition:
      "若公司正式财报日期、市场一致预期或可比历史价格反应在截止前可得，应以新模型版本重新冻结；不得覆盖本记录。",
    featureSnapshot: {
      prior: { up: 0.35, base: 0.3, down: 0.35 },
      revenueGrowthRates,
      appliedRevenueGrowth,
      epsDeltas,
      appliedEpsDelta,
      positiveSignals,
      negativeSignals,
      directionThreshold: {
        minimumProbability: 0.45,
        minimumLead: 0.1,
      },
      returnScenarioMidpoints: {
        up: 0.05,
        base: 0,
        down: -0.05,
      },
      consensusFeatureEnabled: false,
      priceHistorySampleSize: 0,
    },
  };
}

async function ensureEarningsReactionForecast(
  env: Env,
  forecast: EarningsForecastForReactionRow,
): Promise<number> {
  const modelVersion = "earnings_reaction_sec_signals_v2";
  const forecastKey = `${modelVersion}:${forecast.id}`;
  const id = await sha256Hex(forecastKey);
  const basis = parseJsonRecord(forecast.basis_json);
  const model = buildEarningsReactionModel(basis);
  const createdAt = nowIso();
  const targetDefinition =
    "Official earnings release: final normal-session close before publication to the first full normal-session close after publication, relative to SPY; up > +1%, down < -1%, otherwise base.";
  const releaseWindowBasis =
    "SEC filing-cadence proxy; company IR earnings date is not yet confirmed.";
  const inputHash = await sha256Hex(
    safeJson({
      financialForecastId: forecast.id,
      informationCutoffAt: forecast.information_cutoff_at,
      basis,
      modelVersion,
      generatedAt: createdAt,
    }),
  );
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO earnings_reaction_forecasts
       (id, forecast_key, financial_forecast_id, consensus_snapshot_id,
        ticker, fiscal_period, release_window_start, release_window_end,
        release_window_basis, information_cutoff_at, target_definition,
        threshold_up, threshold_down, benchmark, probability_up,
        probability_base, probability_down, predicted_direction,
        expected_relative_return, reaction_low, reaction_high,
        reaction_range_basis, sample_size, model_confidence, model_version,
        consensus_status, key_drivers_json, invalidation_condition,
        feature_snapshot_json, input_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0.01, -0.01, 'SPY',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id,
    forecastKey,
    forecast.id,
    forecast.ticker,
    forecast.fiscal_period,
    forecast.expected_window_start,
    forecast.expected_window_end,
    releaseWindowBasis,
    forecast.information_cutoff_at,
    targetDefinition,
    model.probabilityUp,
    model.probabilityBase,
    model.probabilityDown,
    model.predictedDirection,
    model.expectedRelativeReturn,
    model.reactionLow,
    model.reactionHigh,
    model.reactionRangeBasis,
    model.sampleSize,
    model.modelConfidence,
    modelVersion,
    model.consensusStatus,
    safeJson(model.keyDrivers),
    model.invalidationCondition,
    safeJson(model.featureSnapshot),
    inputHash,
    createdAt,
    createdAt,
  );
  return changes(result);
}

async function backfillEarningsReactionForecasts(env: Env): Promise<number> {
  const rows = await queryAll<EarningsForecastForReactionRow>(
    env.DB,
    `SELECT ef.id, ef.ticker, ef.cik, ef.fiscal_period,
            ef.expected_window_start, ef.expected_window_end,
            ef.information_cutoff_at, ef.revenue_estimate, ef.eps_estimate,
            ef.status, ef.basis_json
     FROM earnings_forecasts ef
     LEFT JOIN earnings_reaction_forecasts erf
       ON erf.financial_forecast_id = ef.id
      AND erf.model_version = 'earnings_reaction_sec_signals_v2'
     WHERE ef.status IN ('open', 'awaiting_actual')
       AND erf.id IS NULL
     ORDER BY ef.created_at
     LIMIT 200`,
  );
  let created = 0;
  for (const row of rows) {
    created += await ensureEarningsReactionForecast(env, row);
  }
  return created;
}

interface SecActualEvent {
  id: string;
  published_at: string;
  url: string;
}

async function secActualEventForAccession(
  env: Env,
  ticker: string,
  accession: string,
): Promise<SecActualEvent | null> {
  return queryFirst<SecActualEvent>(
    env.DB,
    `SELECT id, published_at, url
     FROM events
     WHERE source_key = 'sec-edgar' AND source_event_id = ?
     ORDER BY published_at DESC
     LIMIT 1`,
    `${ticker}:${accession}`,
  );
}

async function upsertEarningsActualsForTicker(
  env: Env,
  ticker: string,
  revenueSeries: MetricFact[],
  epsSeries: MetricFact[],
): Promise<number> {
  const periods = await queryAll<{ fiscal_period: string }>(
    env.DB,
    `SELECT DISTINCT fiscal_period
     FROM earnings_forecasts
     WHERE ticker = ?
     ORDER BY fiscal_period DESC
     LIMIT 8`,
    ticker,
  );
  let stored = 0;
  for (const period of periods) {
    const actualRevenue = revenueSeries
      .filter((fact) => fiscalPeriodMatches(fact, period.fiscal_period))
      .at(-1);
    if (!actualRevenue) continue;
    const actualEps =
      epsSeries.find((fact) => fact.accession === actualRevenue.accession) ??
      epsSeries
        .filter((fact) => fiscalPeriodMatches(fact, period.fiscal_period))
        .at(-1) ??
      null;
    const event = await secActualEventForAccession(
      env,
      ticker,
      actualRevenue.accession,
    );
    const availableAt = event?.published_at ?? actualRevenue.filedAt;
    const at = nowIso();
    const id = await sha256Hex(
      `earnings-actual|${ticker}|${period.fiscal_period}|${actualRevenue.accession}`,
    );
    const result = await execute(
      env.DB,
      `INSERT INTO earnings_actuals
         (id, ticker, fiscal_period, accession, event_id, available_at,
          revenue, revenue_unit, eps, eps_unit, source_name, source_url,
          source_quality, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, fiscal_period, accession) DO UPDATE SET
         event_id = excluded.event_id,
         available_at = excluded.available_at,
         revenue = excluded.revenue,
         revenue_unit = excluded.revenue_unit,
         eps = excluded.eps,
         eps_unit = excluded.eps_unit,
         source_name = excluded.source_name,
         source_url = excluded.source_url,
         source_quality = excluded.source_quality,
         evidence_json = excluded.evidence_json,
         updated_at = excluded.updated_at`,
      id,
      ticker,
      period.fiscal_period,
      actualRevenue.accession,
      event?.id ?? null,
      availableAt,
      actualRevenue.value,
      actualRevenue.unit,
      actualEps?.value ?? null,
      actualEps?.unit ?? null,
      event ? "SEC EDGAR + Company Facts" : "SEC Company Facts",
      event?.url ?? actualRevenue.sourceUrl,
      event
        ? "Tier 1；实际值来自 SEC XBRL，公开时间采用 EDGAR 接受时间。"
        : "Tier 1；实际值来自 SEC XBRL，EDGAR 接受时间尚待匹配。",
      safeJson({
        revenue: earningsEvidencePayload(actualRevenue),
        eps: actualEps ? earningsEvidencePayload(actualEps) : null,
        eventPublishedAt: event?.published_at ?? null,
      }),
      at,
      at,
    );
    stored += changes(result);
  }
  return stored;
}

async function resolveEarningsForecastsForTicker(
  env: Env,
  ticker: string,
  revenueSeries: MetricFact[],
  epsSeries: MetricFact[],
): Promise<number> {
  const open = await queryAll<EarningsForecastRow>(
    env.DB,
    `SELECT id, ticker, cik, fiscal_period, expected_window_start,
            expected_window_end, information_cutoff_at, revenue_estimate,
            eps_estimate, status
     FROM earnings_forecasts
     WHERE ticker = ? AND status IN ('open', 'awaiting_actual')
     ORDER BY created_at`,
    ticker,
  );
  let resolved = 0;
  for (const forecast of open) {
    const periodRevenueFacts = revenueSeries
      .filter((fact) => fiscalPeriodMatches(fact, forecast.fiscal_period))
      .reverse();
    let actualRevenue: MetricFact | null = null;
    let event: SecActualEvent | null = null;
    let publicActualBeforeCutoff = false;
    for (const fact of periodRevenueFacts) {
      const matchedEvent = await secActualEventForAccession(
        env,
        ticker,
        fact.accession,
      );
      if (!matchedEvent) continue;
      if (matchedEvent.published_at <= forecast.information_cutoff_at) {
        publicActualBeforeCutoff = true;
        continue;
      }
      actualRevenue = fact;
      event = matchedEvent;
      break;
    }
    if (!actualRevenue || !event) {
      if (publicActualBeforeCutoff) {
        await execute(
          env.DB,
          `UPDATE earnings_forecasts SET
             status = 'expired',
             resolution_notes = '该记录生成时本期财报已公开，因此只展示实际值，不纳入事前预测回测。',
             updated_at = ?
           WHERE id = ? AND status IN ('open', 'awaiting_actual')`,
          nowIso(),
          forecast.id,
        );
        continue;
      }
      const afterWindow =
        Date.now() > new Date(forecast.expected_window_end).getTime();
      if (afterWindow) {
        await execute(
          env.DB,
          `UPDATE earnings_forecasts SET
             status = 'awaiting_actual',
             resolution_notes = 'Expected window passed, but no comparable SEC Company Facts revenue actual is available; no value was fabricated.',
             updated_at = ?
           WHERE id = ? AND status IN ('open', 'awaiting_actual')`,
          nowIso(),
          forecast.id,
        );
      }
      continue;
    }
    const actualEps =
      epsSeries.find((fact) => fact.accession === actualRevenue.accession) ??
      epsSeries
        .filter(
          (fact) =>
            fiscalPeriodMatches(fact, forecast.fiscal_period) &&
            fact.end === actualRevenue.end,
        )
        .at(-1) ??
      null;
    const revenueErrorPct =
      forecast.revenue_estimate == null || actualRevenue.value === 0
        ? null
        : (Number(forecast.revenue_estimate) - actualRevenue.value) /
          Math.abs(actualRevenue.value);
    const epsError =
      forecast.eps_estimate == null || !actualEps
        ? null
        : Number(forecast.eps_estimate) - actualEps.value;
    const resolvedAt = nowIso();
    await execute(
      env.DB,
      `UPDATE earnings_forecasts SET
         status = 'resolved',
         actual_event_id = ?,
         actual_accession = ?,
         actual_filed_at = ?,
         actual_revenue = ?,
         actual_eps = ?,
         revenue_error_pct = ?,
         eps_error = ?,
         resolution_notes = ?,
         resolved_at = ?,
         updated_at = ?
       WHERE id = ? AND status IN ('open', 'awaiting_actual')`,
      event.id,
      actualRevenue.accession,
      event.published_at,
      actualRevenue.value,
      actualEps?.value ?? null,
      revenueErrorPct,
      epsError,
      actualEps
        ? "已用 SEC Company Facts 的本期营收与稀释每股收益实际值结算；公开时点采用 EDGAR 接受时间。"
        : "已用 SEC Company Facts 的本期营收实际值结算；未取得可比稀释每股收益时不作推算。",
      resolvedAt,
      resolvedAt,
      forecast.id,
    );
    resolved += 1;
  }
  return resolved;
}

async function createEarningsForecastForTicker(
  env: Env,
  row: WatchlistRow,
  sourceUrl: string,
  revenueSeries: MetricFact[],
  epsSeries: MetricFact[],
): Promise<number> {
  const latestRevenue = revenueSeries.at(-1);
  if (!latestRevenue) return 0;
  const target = nextFiscalPeriod(latestRevenue);
  const window = inferEarningsWindow(revenueSeries);
  if (!target || !window) return 0;
  const now = nowIso();
  const nowMs = new Date(now).getTime();
  const startMs = new Date(window.start).getTime();
  const endMs = new Date(window.end).getTime();
  if (
    startMs - nowMs > EARNINGS_FORECAST_LOOKAHEAD_MS ||
    nowMs >= endMs ||
    nowMs - endMs > EARNINGS_ACTUAL_GRACE_MS
  ) {
    return 0;
  }

  const targetRevenueBaseline = findTargetSeasonBaseline(
    revenueSeries,
    target,
    latestRevenue.end,
  );
  if (!targetRevenueBaseline) return 0;
  const growthRates = recentRevenueGrowthRates(revenueSeries);
  const growthTrend =
    growthRates.length >= 2
      ? clamp(median(growthRates) ?? 0, -0.5, 1)
      : 0;
  const revenueEstimate = targetRevenueBaseline.value * (1 + growthTrend);
  if (!Number.isFinite(revenueEstimate) || revenueEstimate < 0) return 0;

  const latestEps = epsSeries.at(-1) ?? null;
  const targetEpsBaseline = latestEps
    ? findTargetSeasonBaseline(epsSeries, target, latestEps.end)
    : null;
  const epsDeltas = recentEpsDeltas(epsSeries);
  const epsDelta = median(epsDeltas);
  const epsEstimate =
    targetEpsBaseline && epsDelta != null && epsDeltas.length >= 2
      ? targetEpsBaseline.value + epsDelta
      : null;
  const forecastKey = `sec-seasonal-baseline-v1:${row.symbol}:${target.key}`;
  const id = await sha256Hex(forecastKey);
  const evidence = [
    ...revenueSeries.slice(-8),
    ...epsSeries.slice(-8),
  ];
  const sourceQuality =
    epsEstimate == null
      ? "sec_companyfacts_comparable_revenue;eps_data_unavailable"
      : "sec_companyfacts_comparable_revenue_and_eps";
  const notes = [
    "SEC 季节性基线（非华尔街一致预期）。",
    `披露窗口由最近 ${window.filingCount} 次 10-Q/10-K 的申报间隔推断，中位间隔 ${window.medianGapDays.toFixed(1)} 天。`,
    growthRates.length >= 2
      ? `收入以同季历史值为季节基准，并应用最近 ${growthRates.length} 个可比同比增速的中位数趋势。`
      : "收入可比趋势样本少于 2 个，使用同季历史值且不叠加趋势。",
    epsEstimate == null
      ? "EPS XBRL 可比证据不足，保持为空（data_unavailable）。"
      : `EPS 以同季历史值加最近 ${epsDeltas.length} 个可比同比差额的中位数估计。`,
    "所有证据的 filed_at 均不晚于 informationCutoffAt；未使用分析师一致预期。",
  ].join(" ");
  const basis = {
    model: "SEC 季节性基线",
    version: "sec_seasonal_baseline_v1",
    notConsensus: true,
    sourceUrl,
    latestReportedPeriod: latestRevenue.reportPeriod,
    latestAccession: latestRevenue.accession,
    targetFiscalPeriod: target.key,
    targetRevenueBaseline: earningsEvidencePayload(targetRevenueBaseline),
    recentRevenueGrowthRates: growthRates,
    appliedRevenueGrowth: growthTrend,
    targetEpsBaseline: targetEpsBaseline
      ? earningsEvidencePayload(targetEpsBaseline)
      : null,
    recentEpsDeltas: epsDeltas,
    window,
  };
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO earnings_forecasts
       (id, forecast_key, ticker, cik, fiscal_period, expected_window_start,
        expected_window_end, window_confidence, information_cutoff_at,
        forecast_method, revenue_estimate, revenue_unit, eps_estimate,
        eps_unit, basis_json, source_quality, notes, status, created_at,
        updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sec_seasonal_baseline_v1',
       ?, 'USD', ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id,
    forecastKey,
    row.symbol,
    normalizeCik(row.cik),
    target.key,
    window.start,
    window.end,
    window.confidence,
    now,
    revenueEstimate,
    epsEstimate,
    epsEstimate == null ? null : "USD/shares",
    safeJson(basis),
    sourceQuality,
    notes,
    now,
    now,
  );
  const financialForecastCreated = changes(result);
  if (financialForecastCreated > 0) {
    await insertEarningsEvidence(env.DB, id, evidence, now);
  }
  await ensureEarningsReactionForecast(env, {
    id,
    ticker: row.symbol,
    cik: normalizeCik(row.cik) ?? "",
    fiscal_period: target.key,
    expected_window_start: window.start,
    expected_window_end: window.end,
    information_cutoff_at: now,
    revenue_estimate: revenueEstimate,
    eps_estimate: epsEstimate,
    status: "open",
    basis_json: safeJson(basis),
  });
  return financialForecastCreated;
}

async function processSecSeasonalEarningsForecasts(
  env: Env,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  const at = nowIso();
  const reactionForecastsCreated =
    await backfillEarningsReactionForecasts(env);
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "forecast:sec-seasonal-baseline-v1",
  );
  const newFilingRows = await queryAll<{ ticker: string }>(
    env.DB,
    `SELECT DISTINCT ticker
     FROM events
     WHERE source_key = 'sec-edgar'
       AND event_type IN ('sec_8_k', 'sec_6_k', 'sec_10_q', 'sec_10_k')
       AND detected_at > ?`,
    subtractMinutes(at, 5),
  );
  const urgent = new Set(newFilingRows.map((row) => row.ticker));
  const scheduledRefresh = !isRecent(source?.cursor, SEC_FACTS_REFRESH_MS);
  const targets = scheduledRefresh
    ? watchlist
    : watchlist.filter((row) => urgent.has(row.symbol));
  if (!targets.length) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: reactionForecastsCreated,
      note:
        reactionForecastsCreated > 0
          ? `SEC Company Facts refresh is not due; frozen ${reactionForecastsCreated} conservative earnings-reaction forecast(s) from existing cutoff-safe evidence.`
          : "SEC Company Facts refresh is not due and no new earnings-related SEC filing was detected.",
    };
  }

  let fetched = 0;
  let created = 0;
  let resolved = 0;
  let actualsStored = 0;
  let unavailable = 0;
  for (const row of targets) {
    const cik = normalizeCik(row.cik);
    if (!cik) {
      unavailable += 1;
      continue;
    }
    const sourceUrl = `${SEC_COMPANY_FACTS_BASE_URL}/CIK${cik}.json`;
    const payload = await fetchJson<SecCompanyFactsPayload>(
      sourceUrl,
      { headers: secHeaders(env) },
      20_000,
    );
    fetched += 1;
    const revenueSeries = extractMetricFacts(
      payload,
      "revenue",
      sourceUrl,
      at,
    );
    const epsSeries = extractMetricFacts(payload, "eps", sourceUrl, at);
    if (!revenueSeries.length) {
      unavailable += 1;
      continue;
    }
    actualsStored += await upsertEarningsActualsForTicker(
      env,
      row.symbol,
      revenueSeries,
      epsSeries,
    );
    resolved += await resolveEarningsForecastsForTicker(
      env,
      row.symbol,
      revenueSeries,
      epsSeries,
    );
    created += await createEarningsForecastForTicker(
      env,
      row,
      sourceUrl,
      revenueSeries,
      epsSeries,
    );
    await sleep(110);
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: fetched,
    itemsNew: created + resolved + actualsStored + reactionForecastsCreated,
    cursor: at,
    note:
      unavailable > 0
        ? `${unavailable} ticker(s) lacked comparable SEC Company Facts revenue; no estimate was fabricated.`
        : `Frozen ${created}, resolved ${resolved}, and refreshed ${actualsStored} SEC earnings actual record(s); added ${reactionForecastsCreated} conservative reaction forecast(s).`,
  };
}

function earningsEventProfile(
  ticker: unknown,
  fiscalPeriod: unknown,
  calendar?: Map<string, CalendarEntry>,
): EarningsEventProfile | null {
  const key = `${String(ticker ?? "").toUpperCase()}:${String(fiscalPeriod ?? "")}`;
  const legacy = EARNINGS_EVENT_PROFILES[key];
  const current = calendar?.get(key);
  if (!current) return legacy ?? null;
  // Live calendar facts take precedence, without changing any frozen forecast
  // or discarding previously verified company results.
  return { ...legacy, ...current, ...(legacy?.status === "reported" ? { status: "reported" as const } : {}) };
}

async function processNasdaqEarningsConsensus(
  env: Env,
): Promise<SourceResult> {
  const at = nowIso();
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "consensus:nasdaq-eps",
  );
  if (isRecent(source?.cursor, NASDAQ_CONSENSUS_REFRESH_MS)) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "Nasdaq EPS consensus refresh is not due.",
    };
  }

  const forecasts = await queryAll<{
    ticker: string;
    fiscal_period: string;
  }>(
    env.DB,
    `SELECT DISTINCT ticker, fiscal_period
     FROM earnings_forecasts
     WHERE status IN ('open', 'awaiting_actual')
     ORDER BY ticker`,
  );
  let seen = 0;
  let inserted = 0;
  let unavailable = 0;
  for (const forecast of forecasts) {
    const profile = earningsEventProfile(
      forecast.ticker,
      forecast.fiscal_period,
      env.earningsCalendar,
    );
    if (!profile || profile.status === "reported") {
      unavailable += 1;
      continue;
    }
    const sourceUrl = `https://api.nasdaq.com/api/analyst/${encodeURIComponent(
      forecast.ticker,
    )}/earnings-forecast`;
    const payload = await fetchJson<NasdaqEarningsForecastResponse>(
      sourceUrl,
      {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 SignalLedger/1.0",
        },
      },
      20_000,
    );
    seen += 1;
    const row = payload.data?.quarterlyForecast?.rows?.find(
      (item) => item.fiscalEnd === profile.expectedFiscalEnd,
    );
    const epsConsensus = finiteNumber(row?.consensusEPSForecast);
    if (!row || epsConsensus === null) {
      unavailable += 1;
      continue;
    }
    const snapshotKey = [
      "nasdaq-eps",
      forecast.ticker,
      forecast.fiscal_period,
      at.slice(0, 10),
    ].join(":");
    const id = await sha256Hex(`earnings-consensus|${snapshotKey}`);
    const result = await execute(
      env.DB,
      `INSERT OR IGNORE INTO earnings_consensus_snapshots
         (id, snapshot_key, ticker, fiscal_period, provider, as_of_at,
          source_url, revenue_consensus, revenue_unit, eps_consensus,
          eps_unit, analyst_count, raw_json, created_at)
       VALUES (?, ?, ?, ?, 'Nasdaq', ?, ?, NULL, NULL, ?,
         'USD/share (Nasdaq provider basis)', ?, ?, ?)`,
      id,
      snapshotKey,
      forecast.ticker,
      forecast.fiscal_period,
      at,
      sourceUrl,
      epsConsensus,
      finiteNumber(row.noOfEstimates),
      safeJson({
        fiscalEnd: row.fiscalEnd ?? null,
        consensusEPSForecast: epsConsensus,
        highEPSForecast: finiteNumber(row.highEPSForecast),
        lowEPSForecast: finiteNumber(row.lowEPSForecast),
        noOfEstimates: finiteNumber(row.noOfEstimates),
        revisionsUp: finiteNumber(row.up),
        revisionsDown: finiteNumber(row.down),
      }),
      at,
    );
    inserted += changes(result);
    await sleep(90);
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: seen,
    itemsNew: inserted,
    cursor: at,
    note:
      unavailable > 0
        ? `${unavailable} forecast(s) lacked a matching Nasdaq fiscal-period row; no consensus was inferred.`
        : `Stored ${inserted} immutable Nasdaq EPS consensus snapshot(s).`,
  };
}

function isSystemicFederalReserveRelease(text: string): boolean {
  return /fomc|federal funds rate|discount rate|monetary policy|economic projections|minutes of the federal open market committee|financial stability report|emergency lending|stress test results/.test(
    text.toLowerCase(),
  );
}

function isInstitutionSpecificFederalReserveAction(text: string): boolean {
  return /enforcement action|cease and desist|civil money penalty|prohibition order|written agreement|prompt corrective action|termination of (?:an )?enforcement action|bank supervision action|supervisory action against|approval of (?:an )?application by/.test(
    text.toLowerCase(),
  );
}

function isRoutineFederalReserveRelease(text: string): boolean {
  return /speech|testimony|conference|community banking|consumer advisory|appointment|appoints|names new|elects|meeting notice|public meeting|holiday|operating schedule|technical correction|administrative matter|request(?:s)? (?:public )?comment|proposal to|proposed rule|notice of proposed rulemaking|modernize(?:s|d)? rules/.test(
    text.toLowerCase(),
  );
}

function officialFeedPriority(
  result: OfficialFeedResult,
  item: OfficialFeedResult["items"][number],
  watchlist: Set<string>,
): Priority {
  if (item.eventType === "trade_halt") {
    return item.ticker !== "MARKET" && watchlist.has(item.ticker)
      ? "P0"
      : "P2";
  }
  const text = `${item.headline} ${item.summary}`.toLowerCase();
  const isFederalReserveFeed = result.feed.id.startsWith("fed:");
  if (
    isFederalReserveFeed &&
    /minutes of the board'?s discount rate meetings/.test(text)
  ) {
    return "P2";
  }
  if (
    isFederalReserveFeed &&
    isInstitutionSpecificFederalReserveAction(text) &&
    !isSystemicFederalReserveRelease(text)
  ) {
    return "P2";
  }
  if (
    isFederalReserveFeed &&
    isRoutineFederalReserveRelease(text) &&
    !isSystemicFederalReserveRelease(text)
  ) {
    return "P2";
  }
  if (
    isFederalReserveFeed &&
    /fomc statement|federal funds rate|discount rate|emergency/.test(text)
  ) {
    return "P0";
  }
  return "P1";
}

async function suppressStoredInstitutionSpecificFedAlerts(
  db: D1Database,
  at: string,
): Promise<void> {
  const rows = await queryAll<{
    id: string;
    headline: string;
    summary: string;
  }>(
    db,
    `SELECT id, headline, summary
     FROM events
     WHERE source_key LIKE 'fed:%'
       AND ticker = 'MARKET'
       AND priority IN ('P0', 'P1')
       AND (
         lower(headline || ' ' || summary) LIKE '%enforcement action%' OR
         lower(headline || ' ' || summary) LIKE '%cease and desist%' OR
         lower(headline || ' ' || summary) LIKE '%civil money penalty%' OR
         lower(headline || ' ' || summary) LIKE '%prohibition order%' OR
         lower(headline || ' ' || summary) LIKE '%written agreement%' OR
         lower(headline || ' ' || summary) LIKE '%prompt corrective action%' OR
         lower(headline || ' ' || summary) LIKE '%supervisory action against%' OR
         lower(headline || ' ' || summary) LIKE '%approval of application by%'
       )
     LIMIT 200`,
  );
  const irrelevant = rows.filter((row) => {
    const text = `${row.headline} ${row.summary}`;
    return (
      isInstitutionSpecificFederalReserveAction(text) &&
      !isSystemicFederalReserveRelease(text)
    );
  });
  if (!irrelevant.length) return;
  await db.batch(
    irrelevant.flatMap((row) => [
      db
        .prepare("UPDATE events SET priority = 'P2' WHERE id = ?")
        .bind(row.id),
      db
        .prepare(
          `UPDATE alert_outbox
           SET status = 'suppressed_irrelevant',
               next_attempt_at = NULL,
               updated_at = ?
           WHERE event_id = ?
             AND status IN ('queued', 'failed', 'needs_setup', 'dry_run')`,
        )
        .bind(at, row.id),
    ]),
  );
}

async function suppressQueuedRoutineSecAlerts(
  db: D1Database,
  at: string,
): Promise<void> {
  await execute(
    db,
    `UPDATE alert_outbox
     SET status = 'suppressed_irrelevant',
         next_attempt_at = NULL,
         last_error = 'Routine SEC form alert suppressed; only analyzed high-impact disclosures send immediately.',
         updated_at = ?
     WHERE status IN ('queued', 'failed', 'needs_setup', 'dry_run')
       AND EXISTS (
         SELECT 1
         FROM events
         WHERE events.id = alert_outbox.event_id
           AND source_key = 'sec-edgar'
           AND event_type IN ('sec_8_k', 'sec_6_k', 'sec_10_q', 'sec_10_k')
           AND priority = 'P1'
       )`,
    at,
  );
}

async function suppressQueuedStaleImmediateAlerts(
  db: D1Database,
  at: string,
): Promise<void> {
  await execute(
    db,
    `UPDATE alert_outbox
     SET status = 'suppressed_irrelevant',
         next_attempt_at = NULL,
         last_error = 'Immediate alert expired or was a routine discount-rate meeting record; retained on website only.',
         updated_at = ?
     WHERE status IN ('queued', 'failed', 'needs_setup', 'dry_run')
       AND EXISTS (
         SELECT 1
         FROM events
         WHERE events.id = alert_outbox.event_id
           AND (published_at < ? OR (
              source_key LIKE 'fed:%'
              AND lower(headline || ' ' || summary)
                LIKE '%minutes of the board%discount rate meetings%'
            ))
       )`,
    at,
    subtractMinutes(at, IMMEDIATE_ALERT_MAX_AGE_MS / 60_000),
  );
}

async function ingestOfficialFeedResult(
  env: Env,
  result: OfficialFeedResult,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  if (result.error) throw new Error(result.error);
  const detectedAt = nowIso();
  if (result.feed.id.startsWith("fed:")) {
    await suppressStoredInstitutionSpecificFedAlerts(env.DB, detectedAt);
  }
  const bootstrapState = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    result.feed.id,
  );
  const bootstrap = !bootstrapState?.cursor;
  const lookbackCutoff = Date.now() - OFFICIAL_FEED_INGEST_MAX_AGE_MS;
  const watched = new Set(watchlist.map((row) => row.symbol));
  let itemsSeen = 0;
  let itemsNew = 0;
  let alertsQueued = 0;
  for (const item of result.items) {
    if (new Date(item.publishedAt).getTime() < lookbackCutoff) continue;
    itemsSeen += 1;
    const priority = officialFeedPriority(result, item, watched);
    const inferred = inferDirection(`${item.headline} ${item.summary}`);
    const event: NormalizedEvent = {
      id: await sha256Hex(
        `official|${result.feed.id}|${item.sourceEventId}`,
      ),
      sourceKey: result.feed.id,
      sourceEventId: item.sourceEventId,
      ticker: item.ticker,
      eventType: item.eventType,
      headline: truncate(item.headline, 500),
      summary: truncate(item.summary, 1_500),
      priority,
      sourceName: item.sourceName,
      sourceTier: 1,
      publishedAt: item.publishedAt,
      detectedAt,
      url: item.url,
      direction: inferred.direction,
      confidence:
        item.eventType === "trade_halt" ? 0.98 : inferred.confidence,
      rawJson: safeJson({
        feedId: item.feedId,
        sourceUrl: item.sourceUrl,
        sourceEventId: item.sourceEventId,
      }),
    };
    const inserted = await insertEvent(env, event, {
      dryRun: envBoolean(env.DRY_RUN),
      bootstrap,
    });
    if (inserted.inserted) itemsNew += 1;
    if (inserted.alertQueued) alertsQueued += 1;
  }
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen,
    itemsNew,
    alertsQueued,
    cursor: detectedAt,
    note: bootstrap
      ? "Official feed bootstrap stored recent items without historical email."
      : null,
  };
}

async function ingestAlpacaNews(
  env: Env,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  const keyId = env.ALPACA_API_KEY_ID?.trim();
  const secret = env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new SetupRequiredError(
      "Alpaca News is enabled but ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY is missing.",
    );
  }
  const existing = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "alpaca:news",
  );
  const previousCursor = existing?.cursor ?? null;
  const bootstrap = !previousCursor;
  const bootstrapHours = envInteger(
    env.ALPACA_BOOTSTRAP_HOURS,
    6,
    1,
    24 * 14,
  );
  const cutoff = bootstrap
    ? new Date(Date.now() - bootstrapHours * 60 * 60 * 1_000).toISOString()
    : subtractMinutes(previousCursor, 2);
  const symbolSet = new Set(watchlist.map((row) => row.symbol));
  const symbolList = Array.from(symbolSet).join(",");
  let pageToken: string | null = null;
  let page = 0;
  let itemsSeen = 0;
  let itemsNew = 0;
  let alertsQueued = 0;
  let newestTimestamp = previousCursor;
  const detectedAt = nowIso();

  do {
    const url = new URL(ALPACA_NEWS_URL);
    url.searchParams.set("symbols", symbolList);
    url.searchParams.set("limit", "50");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("include_content", "false");
    url.searchParams.set("start", cutoff);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const payload = await fetchJson<AlpacaNewsResponse>(
      url.toString(),
      {
        headers: {
          accept: "application/json",
          "APCA-API-KEY-ID": keyId,
          "APCA-API-SECRET-KEY": secret,
        },
      },
      15_000,
    );
    const news = payload.news ?? [];
    for (const item of news) {
      const publishedAt = parseSecTimestamp(item.created_at, detectedAt);
      if (previousCursor && publishedAt <= previousCursor) continue;
      if (!newestTimestamp || publishedAt > newestTimestamp) {
        newestTimestamp = publishedAt;
      }
      const matchedSymbols = (item.symbols ?? [])
        .map(normalizeSymbol)
        .filter((symbol) => symbolSet.has(symbol));
      for (const ticker of matchedSymbols) {
        itemsSeen += 1;
        const headline = truncate(item.headline || "Untitled market news", 500);
        const summary = truncate(
          item.summary || item.content || "No summary supplied by the provider.",
          1_500,
        );
        const classification = classifyNews(headline, summary);
        const providerId = String(
          item.id ?? `${publishedAt}:${headline.slice(0, 100)}`,
        );
        const sourceEventId = `${providerId}:${ticker}`;
        const id = await sha256Hex(`alpaca-news|${sourceEventId}`);
        const event: NormalizedEvent = {
          id,
          sourceKey: "alpaca-news",
          sourceEventId,
          ticker,
          eventType: classification.eventType,
          headline,
          summary,
          priority: classification.priority,
          sourceName: item.source
            ? `${truncate(item.source, 100)} via Alpaca`
            : "Alpaca News",
          sourceTier: 2,
          publishedAt,
          detectedAt,
          url: item.url || "https://app.alpaca.markets/",
          direction: classification.direction,
          confidence: classification.confidence,
          rawJson: safeJson(item),
        };
        const inserted = await insertEvent(env, event, {
          dryRun: envBoolean(env.DRY_RUN),
          bootstrap,
        });
        if (inserted.inserted) itemsNew += 1;
        if (inserted.alertQueued) alertsQueued += 1;
      }
    }
    pageToken = payload.next_page_token ?? null;
    page += 1;
  } while (pageToken && page < MAX_ALPACA_PAGES_PER_RUN);

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen,
    itemsNew,
    cursor: newestTimestamp ?? detectedAt,
    alertsQueued,
    note: bootstrap
      ? "Bootstrap news was stored without sending historical alerts."
      : null,
  };
}

function alpacaHeaders(env: Env): HeadersInit {
  const keyId = env.ALPACA_API_KEY_ID?.trim();
  const secret = env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secret) {
    throw new SetupRequiredError(
      "ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required for forecast settlement.",
    );
  }
  return {
    accept: "application/json",
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
  };
}

async function fetchAlpacaDailyBars(
  env: Env,
  symbol: string,
  start: string,
  end: string,
): Promise<AlpacaBar[]> {
  const url = new URL(
    `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(
      symbol,
    )}/bars`,
  );
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("adjustment", "all");
  url.searchParams.set("feed", env.ALPACA_DATA_FEED?.trim() || "iex");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "100");
  const payload = await fetchJson<AlpacaBarsResponse>(
    url.toString(),
    { headers: alpacaHeaders(env) },
    15_000,
  );
  return (payload.bars ?? [])
    .filter(
      (bar) =>
        typeof bar.t === "string" &&
        typeof bar.c === "number" &&
        Number.isFinite(bar.c) &&
        bar.c > 0,
    )
    .sort(
      (left, right) =>
        new Date(left.t as string).getTime() -
        new Date(right.t as string).getTime(),
    );
}

function nasdaqPrice(value: unknown): number | null {
  const parsed = Number(
    String(value ?? "")
      .replace(/[$,]/g, "")
      .trim(),
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nasdaqSignedNumber(value: unknown): number | null {
  const parsed = Number(
    String(value ?? "")
      .replace(/[$,%+,]/g, "")
      .trim(),
  );
  return Number.isFinite(parsed) ? parsed : null;
}

function newYorkWallClockToIso(value: unknown): string | null {
  const match = String(value ?? "")
    .trim()
    .match(
      /^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+ET$/,
    );
  if (!match) return null;
  const monthIndex = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].indexOf(match[1]);
  if (monthIndex < 0) return null;
  let hour = Number(match[4]) % 12;
  if (match[6] === "PM") hour += 12;
  const desiredWallClock = Date.UTC(
    Number(match[3]),
    monthIndex,
    Number(match[2]),
    hour,
    Number(match[5]),
  );
  let instant = desiredWallClock;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const displayedWallClock = Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
    );
    instant += desiredWallClock - displayedWallClock;
  }
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function fetchNasdaqLatestQuote(
  symbol: string,
): Promise<{
  sourceUrl: string;
  data: NasdaqQuoteData;
}> {
  const etfSymbols = new Set(["SPY", "QQQ", "DIA", "IWM"]);
  const assetClass = etfSymbols.has(symbol.toUpperCase()) ? "etf" : "stocks";
  const sourceUrl = `https://api.nasdaq.com/api/quote/${encodeURIComponent(
    symbol,
  )}/info?assetclass=${assetClass}`;
  const payload = await fetchJson<NasdaqQuoteResponse>(
    sourceUrl,
    {
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 SignalLedger/1.0",
      },
    },
    20_000,
  );
  const price = nasdaqPrice(payload.data?.primaryData?.lastSalePrice);
  if (!payload.data || price === null) {
    throw new Error(
      payload.message ||
        payload.status?.developerMessage ||
        `Nasdaq quote unavailable for ${symbol}.`,
    );
  }
  return { sourceUrl, data: payload.data };
}

async function processNasdaqLatestQuotes(
  env: Env,
  watchlist: WatchlistRow[],
): Promise<SourceResult> {
  const at = nowIso();
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "market:nasdaq-latest-quotes",
  );
  if (isRecent(source?.cursor, NASDAQ_QUOTE_REFRESH_MS)) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "Nasdaq quote refresh is not due.",
    };
  }

  let seen = 0;
  let stored = 0;
  const failures: string[] = [];
  const quoteSymbols = Array.from(
    new Set([...watchlist.map((security) => security.symbol), "SPY"]),
  );
  await runInBatches(quoteSymbols, 4, async (symbol) => {
    try {
      const { sourceUrl, data } = await fetchNasdaqLatestQuote(symbol);
      const primary = data.primaryData;
      const price = nasdaqPrice(primary?.lastSalePrice);
      if (price === null) throw new Error("lastSalePrice is missing.");
      const parsedQuoteAt = newYorkWallClockToIso(
        primary?.lastTradeTimestamp,
      );
      const quoteAsOfAt = parsedQuoteAt ?? at;
      const isRealTime = primary?.isRealTime === true;
      const result = await execute(
        env.DB,
        `INSERT INTO latest_quotes
           (ticker, price, currency, quote_as_of_at, received_at, provider,
            source_url, market_status, is_real_time, delay_minutes,
            timestamp_basis, net_change, percentage_change, bid_price,
            ask_price, volume, raw_json, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Nasdaq Quote API', ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?)
         ON CONFLICT(ticker) DO UPDATE SET
           price = excluded.price,
           currency = excluded.currency,
           quote_as_of_at = excluded.quote_as_of_at,
           received_at = excluded.received_at,
           provider = excluded.provider,
           source_url = excluded.source_url,
           market_status = excluded.market_status,
           is_real_time = excluded.is_real_time,
           delay_minutes = excluded.delay_minutes,
           timestamp_basis = excluded.timestamp_basis,
           net_change = excluded.net_change,
           percentage_change = excluded.percentage_change,
           bid_price = excluded.bid_price,
           ask_price = excluded.ask_price,
           volume = excluded.volume,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`,
        symbol,
        price,
        primary?.currency || "USD",
        quoteAsOfAt,
        at,
        sourceUrl,
        data.marketStatus || "Unknown",
        isRealTime ? 1 : 0,
        isRealTime ? 0 : 15,
        parsedQuoteAt
          ? "Nasdaq lastTradeTimestamp"
          : "worker_received_at_fallback",
        nasdaqSignedNumber(primary?.netChange),
        nasdaqSignedNumber(primary?.percentageChange),
        nasdaqPrice(primary?.bidPrice),
        nasdaqPrice(primary?.askPrice),
        nasdaqSignedNumber(primary?.volume),
        safeJson(data),
        at,
      );
      seen += 1;
      stored += changes(result);
    } catch (caught) {
      failures.push(
        `${symbol}: ${
          caught instanceof Error ? caught.message : "unknown quote error"
        }`,
      );
    }
  });

  if (!seen) {
    throw new Error(
      `No Nasdaq quotes were available. ${failures.slice(0, 3).join("; ")}`,
    );
  }
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: seen,
    itemsNew: stored,
    cursor: at,
    note: failures.length
      ? `${failures.length} quote(s) unavailable: ${truncate(
          failures.join("; "),
          600,
        )}`
      : "Nasdaq quote timestamps and real-time/delayed flags were stored explicitly.",
  };
}

async function fetchNasdaqDailyBars(
  symbol: string,
  start: string,
  end: string,
  limit = 100,
): Promise<AlpacaBar[]> {
  const url = new URL(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(
      symbol,
    )}/historical`,
  );
  const etfSymbols = new Set(["SPY", "QQQ", "DIA", "IWM"]);
  url.searchParams.set(
    "assetclass",
    etfSymbols.has(symbol.toUpperCase()) ? "etf" : "stocks",
  );
  url.searchParams.set("fromdate", newYorkDate(start));
  url.searchParams.set("todate", newYorkDate(end));
  url.searchParams.set("limit", String(limit));
  const payload = await fetchJson<NasdaqHistoricalResponse>(
    url.toString(),
    {
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 SignalLedger/1.0",
      },
    },
    20_000,
  );
  return (payload.data?.tradesTable?.rows ?? [])
    .map((row) => {
      const close = nasdaqPrice(row.close);
      const [month, day, year] = String(row.date ?? "")
        .split("/")
        .map(Number);
      const monthName = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ][month - 1];
      const timestamp =
        year && monthName && day
          ? newYorkWallClockToIso(
              `${monthName} ${day}, ${year} 4:00 PM ET`,
            ) ?? ""
          : "";
      return {
        t: timestamp,
        c: close ?? undefined,
        o: nasdaqPrice(row.open) ?? undefined,
        h: nasdaqPrice(row.high) ?? undefined,
        l: nasdaqPrice(row.low) ?? undefined,
        v: nasdaqPrice(row.volume) ?? undefined,
      };
    })
    .filter(
      (bar) =>
        Boolean(bar.t) &&
        typeof bar.c === "number" &&
        Number.isFinite(bar.c) &&
        bar.c > 0,
    )
    .sort(
      (left, right) =>
        new Date(left.t as string).getTime() -
        new Date(right.t as string).getTime(),
    );
}

interface HistoricalEarningsAmplitude {
  sampleCount: number;
  medianAbsMovePct: number;
  p75AbsMovePct: number;
  observations: Array<{
    reportedSession: string;
    reactionSession: string;
    movePct: number;
  }>;
  earningsSourceUrl: string;
  priceSourceUrl: string;
}

function parseNasdaqReportedSession(value: unknown): string | null {
  const [month, day, year] = String(value ?? "")
    .split("/")
    .map(Number);
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
    2,
    "0",
  )}`;
}

function percentile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function fetchHistoricalEarningsAmplitude(
  symbol: string,
): Promise<HistoricalEarningsAmplitude | null> {
  const earningsSourceUrl = `https://api.nasdaq.com/api/company/${encodeURIComponent(
    symbol,
  )}/earnings-surprise`;
  const earningsPayload = await fetchJson<NasdaqEarningsSurpriseResponse>(
    earningsSourceUrl,
    {
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 SignalLedger/1.0",
      },
    },
    20_000,
  );
  const reportedSessions = (
    earningsPayload.data?.earningsSurpriseTable?.rows ?? []
  )
    .map((row) => parseNasdaqReportedSession(row.dateReported))
    .filter((session): session is string => Boolean(session))
    .slice(0, 8);
  if (reportedSessions.length < 3) return null;

  const earliest = [...reportedSessions].sort()[0];
  const latest = [...reportedSessions].sort().at(-1) as string;
  const start = new Date(
    Date.parse(`${earliest}T12:00:00Z`) - 10 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const end = new Date(
    Date.parse(`${latest}T12:00:00Z`) + 10 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const priceSource = new URL(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(
      symbol,
    )}/historical`,
  );
  priceSource.searchParams.set("assetclass", "stocks");
  priceSource.searchParams.set("fromdate", newYorkDate(start));
  priceSource.searchParams.set("todate", newYorkDate(end));
  priceSource.searchParams.set("limit", "500");
  const bars = await fetchNasdaqDailyBars(symbol, start, end, 500);
  const observations: HistoricalEarningsAmplitude["observations"] = [];

  for (const reportedSession of reportedSessions) {
    const prior = bars
      .filter(
        (bar) =>
          typeof bar.t === "string" &&
          newYorkDate(bar.t) < reportedSession &&
          typeof bar.c === "number",
      )
      .at(-1);
    const candidates = bars
      .filter(
        (bar) =>
          typeof bar.t === "string" &&
          newYorkDate(bar.t) >= reportedSession &&
          typeof bar.c === "number",
      )
      .slice(0, 2);
    if (!prior?.c || !candidates.length) continue;
    const reaction = candidates
      .map((bar) => ({
        bar,
        movePct: ((Number(bar.c) / Number(prior.c)) - 1) * 100,
      }))
      .sort(
        (left, right) =>
          Math.abs(right.movePct) - Math.abs(left.movePct),
      )[0];
    if (!reaction?.bar.t || !Number.isFinite(reaction.movePct)) continue;
    observations.push({
      reportedSession,
      reactionSession: newYorkDate(reaction.bar.t),
      movePct: reaction.movePct,
    });
  }

  if (observations.length < 3) return null;
  const absoluteMoves = observations.map((item) => Math.abs(item.movePct));
  const medianAbsMovePct = percentile(absoluteMoves, 0.5);
  const p75AbsMovePct = percentile(absoluteMoves, 0.75);
  if (medianAbsMovePct === null || p75AbsMovePct === null) return null;
  return {
    sampleCount: observations.length,
    medianAbsMovePct,
    p75AbsMovePct,
    observations,
    earningsSourceUrl,
    priceSourceUrl: priceSource.toString(),
  };
}

async function fetchMarketDailyBars(
  env: Env,
  symbol: string,
  start: string,
  end: string,
): Promise<MarketBarsResult> {
  try {
    const alpacaBars = await fetchAlpacaDailyBars(env, symbol, start, end);
    if (alpacaBars.length >= 6) {
      return { bars: alpacaBars, provider: "Alpaca IEX" };
    }
  } catch {
    // Continue to the public Nasdaq historical endpoint.
  }
  const nasdaqBars = await fetchNasdaqDailyBars(symbol, start, end);
  return { bars: nasdaqBars, provider: "Nasdaq Historical" };
}

function marketReturn(bars: AlpacaBar[], sessions: number): number | null {
  const closes = bars
    .map((bar) => bar.c)
    .filter((value): value is number => typeof value === "number")
    .slice(-(sessions + 1));
  if (closes.length < Math.min(6, sessions + 1)) return null;
  return closes.at(-1)! / closes[0] - 1;
}

function realizedVolatility(bars: AlpacaBar[], sessions: number): number | null {
  const closes = bars
    .map((bar) => bar.c)
    .filter((value): value is number => typeof value === "number")
    .slice(-(sessions + 1));
  if (closes.length < 6) return null;
  const returns = closes
    .slice(1)
    .map((close, index) => close / closes[index] - 1);
  const average =
    returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function buildMultisignalReactionModel(
  inputs: MultisignalInputs,
): EarningsReactionModel {
  let probabilityUp = 0.35;
  const probabilityBase = 0.3;
  let probabilityDown = 0.35;
  let activeSignals = 0;
  const keyDrivers: string[] = [];

  const applySignal = (
    direction: "up" | "down" | "neutral",
    driver: string,
  ) => {
    keyDrivers.push(driver);
    if (direction === "neutral") return;
    activeSignals += 1;
    if (direction === "up") {
      probabilityUp += 0.05;
      probabilityDown -= 0.05;
    } else {
      probabilityUp -= 0.05;
      probabilityDown += 0.05;
    }
  };

  const revenueGrowth = inputs.fundamentals.revenueGrowth;
  const epsDelta = inputs.fundamentals.epsDelta;
  if (revenueGrowth !== null && revenueGrowth >= 0.05) {
    applySignal(
      "up",
      `[基本面] SEC 可比收入趋势 +${(revenueGrowth * 100).toFixed(1)}%，盈利路径偏正面。`,
    );
  } else if (revenueGrowth !== null && revenueGrowth <= -0.05) {
    applySignal(
      "down",
      `[基本面] SEC 可比收入趋势 ${(revenueGrowth * 100).toFixed(1)}%，盈利路径承压。`,
    );
  } else if (epsDelta !== null && Math.abs(epsDelta) >= 0.05) {
    applySignal(
      epsDelta > 0 ? "up" : "down",
      `[基本面] 可比 EPS 同比差额中位数 ${epsDelta > 0 ? "+" : ""}${epsDelta.toFixed(2)}。`,
    );
  } else {
    applySignal("neutral", "[基本面] 收入/EPS 可比趋势没有越过方向阈值。");
  }

  const relativeReturn = inputs.market.relativeReturn20d;
  const marketMomentum = relativeReturn ?? inputs.market.tickerReturn20d;
  const marketBasis =
    relativeReturn !== null ? "近20日相对 SPY" : "近20日个股走势";
  if (marketMomentum !== null && Math.abs(marketMomentum) >= 0.03) {
    applySignal(
      marketMomentum > 0 ? "up" : "down",
      `[市场·${inputs.market.provider}] ${marketBasis} ${marketMomentum > 0 ? "+" : ""}${(
        marketMomentum * 100
      ).toFixed(1)}%，反映财报前定价${marketMomentum > 0 ? "偏强" : "偏弱"}。`,
    );
  } else {
    applySignal(
      "neutral",
      marketMomentum === null
        ? `[市场·${inputs.market.provider}] 价格样本不足，未把动量强行计入。`
        : `[市场·${inputs.market.provider}] ${marketBasis} ${(marketMomentum * 100).toFixed(1)}%，没有形成明显方向。`,
    );
  }

  const revisionBreadth =
    inputs.revisions.up !== null && inputs.revisions.down !== null
      ? inputs.revisions.up - inputs.revisions.down
      : null;
  if (revisionBreadth !== null && Math.abs(revisionBreadth) >= 2) {
    applySignal(
      revisionBreadth > 0 ? "up" : "down",
      `[分析师] EPS 上调 ${inputs.revisions.up} 次、下调 ${inputs.revisions.down} 次，修订广度${
        revisionBreadth > 0 ? "偏正面" : "偏负面"
      }。`,
    );
  } else {
    applySignal(
      "neutral",
      revisionBreadth === null
        ? "[分析师] 一致预期修订广度缺失。"
        : `[分析师] EPS 上调 ${inputs.revisions.up} 次、下调 ${inputs.revisions.down} 次，修订信号中性。`,
    );
  }

  const newsBalance = inputs.news.positive - inputs.news.negative;
  if (inputs.news.total >= 2 && Math.abs(newsBalance) >= 2) {
    applySignal(
      newsBalance > 0 ? "up" : "down",
      `[新闻] 近7日 ${inputs.news.total} 条相关报道中，正向/负向为 ${inputs.news.positive}/${inputs.news.negative}。`,
    );
  } else {
    applySignal(
      "neutral",
      `[新闻] 近7日相关报道 ${inputs.news.total} 条，情绪差不足以形成独立方向。`,
    );
  }

  probabilityUp = roundProbability(probabilityUp);
  probabilityDown = roundProbability(probabilityDown);
  const ranked = [
    { direction: "up" as const, value: probabilityUp },
    { direction: "base" as const, value: probabilityBase },
    { direction: "down" as const, value: probabilityDown },
  ].sort((left, right) => right.value - left.value);
  const predictedDirection =
    ranked[0].direction !== "base" &&
    ranked[0].value >= 0.45 &&
    ranked[0].value - ranked[1].value >= 0.1
      ? ranked[0].direction
      : "uncertain";
  const rawExpectedReturn =
    predictedDirection === "uncertain"
      ? null
      : (probabilityUp - probabilityDown) * 0.08;
  const expectedRelativeReturn =
    rawExpectedReturn === null
      ? null
      : Math.round(rawExpectedReturn / 0.005) * 0.005;
  const realizedVol = inputs.market.realizedVol20d;
  const scenarioHalfWidth =
    realizedVol === null
      ? 0.06
      : Math.min(0.12, Math.max(0.04, realizedVol * Math.sqrt(5 / 252) * 1.5));
  const modelConfidence =
    activeSignals >= 3 &&
    marketMomentum !== null &&
    revisionBreadth !== null
      ? "medium"
      : "low";

  return {
    probabilityUp,
    probabilityBase,
    probabilityDown,
    predictedDirection,
    expectedRelativeReturn,
    reactionLow: -scenarioHalfWidth,
    reactionHigh: scenarioHalfWidth,
    reactionRangeBasis:
      realizedVol === null
        ? "research_scenario_band_not_options_implied"
        : "realized_volatility_context_not_options_implied",
    sampleSize: inputs.market.sampleSize,
    modelConfidence,
    consensusStatus:
      inputs.revisions.analystCount === null ? "unavailable" : "available",
    keyDrivers: [
      ...keyDrivers,
      inputs.social.xStatus === "available"
        ? "[社交] X 官方数据已接入。"
        : "[缺失] X/Twitter 官方数据权限未配置，社交舆情未参与概率。",
      "[缺失] 尚无事件隔离期权隐含波动；区间不是期权市场隐含涨跌幅。",
    ],
    invalidationCondition:
      "若公司更新指引、分析师一致预期显著修订、盘前价格出现跳空或取得 X/期权新证据，应以新模型版本重新冻结，不覆盖本记录。",
    featureSnapshot: {
      model: "earnings_reaction_multisignal_v5",
      inputs,
      activeSignals,
      directionThreshold: {
        minimumProbability: 0.45,
        minimumLead: 0.1,
      },
      evidenceCoverage: {
        secFundamentals: revenueGrowth !== null || epsDelta !== null,
        marketPrice: marketMomentum !== null,
        analystRevisions: revisionBreadth !== null,
        news: inputs.news.total > 0,
        x: inputs.social.xStatus === "available",
        options: false,
      },
    },
  };
}

async function createMultisignalReactionForecast(
  env: Env,
  forecast: EarningsForecastForReactionRow,
  barsCache: Map<string, Promise<MarketBarsResult>>,
  at: string,
): Promise<number> {
  const basis = parseJsonRecord(forecast.basis_json);
  const consensus = await queryFirst<{
    id: string;
    analyst_count: number | null;
    raw_json: string | null;
  }>(
    env.DB,
    `SELECT id, analyst_count, raw_json
     FROM earnings_consensus_snapshots
     WHERE ticker = ? AND fiscal_period = ?
     ORDER BY as_of_at DESC
     LIMIT 1`,
    forecast.ticker,
    forecast.fiscal_period,
  );
  const rawConsensus = parseJsonRecord(consensus?.raw_json);
  const newsRows = await queryAll<{ direction: string; count: number }>(
    env.DB,
    `SELECT direction, COUNT(*) AS count
     FROM events
     WHERE ticker = ?
       AND source_key <> 'sec-edgar'
       AND published_at >= ?
     GROUP BY direction`,
    forecast.ticker,
    new Date(new Date(at).getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
  );
  const news = { positive: 0, negative: 0, neutral: 0, total: 0 };
  for (const row of newsRows) {
    const count = Number(row.count);
    if (row.direction === "up") news.positive += count;
    else if (row.direction === "down") news.negative += count;
    else news.neutral += count;
    news.total += count;
  }

  const end = new Date(new Date(at).getTime() + 24 * 60 * 60 * 1_000).toISOString();
  const start = new Date(
    new Date(at).getTime() - 55 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const getBars = (symbol: string) => {
    const cached = barsCache.get(symbol);
    if (cached) return cached;
    const pending = fetchMarketDailyBars(env, symbol, start, end);
    barsCache.set(symbol, pending);
    return pending;
  };
  let tickerBars: AlpacaBar[] = [];
  let spyBars: AlpacaBar[] = [];
  let marketProvider = "Alpaca/Nasdaq";
  try {
    const [tickerMarket, spyMarket] = await Promise.all([
      getBars(forecast.ticker),
      getBars("SPY"),
    ]);
    tickerBars = tickerMarket.bars;
    spyBars = spyMarket.bars;
    marketProvider =
      tickerMarket.provider === spyMarket.provider
        ? tickerMarket.provider
        : `${tickerMarket.provider} + ${spyMarket.provider}`;
  } catch {
    tickerBars = [];
    spyBars = [];
  }
  const tickerReturn20d = marketReturn(tickerBars, 20);
  const spyReturn20d = marketReturn(spyBars, 20);
  const relativeReturn20d =
    tickerReturn20d !== null && spyReturn20d !== null
      ? tickerReturn20d - spyReturn20d
      : null;
  const revenueGrowthRates = finiteNumberArray(
    basis.recentRevenueGrowthRates,
  );
  const epsDeltas = finiteNumberArray(basis.recentEpsDeltas);
  const inputs: MultisignalInputs = {
    fundamentals: {
      revenueGrowth:
        revenueGrowthRates.length >= 2
          ? finiteNumber(basis.appliedRevenueGrowth)
          : null,
      epsDelta: epsDeltas.length >= 2 ? median(epsDeltas) : null,
    },
    market: {
      provider: marketProvider,
      tickerReturn20d,
      spyReturn20d,
      relativeReturn20d,
      realizedVol20d: realizedVolatility(tickerBars, 20),
      sampleSize:
        tickerBars.length > 0 && spyBars.length > 0
          ? Math.min(tickerBars.length, spyBars.length, 21)
          : Math.min(tickerBars.length, 21),
    },
    revisions: {
      up: finiteNumber(rawConsensus.revisionsUp),
      down: finiteNumber(rawConsensus.revisionsDown),
      analystCount:
        consensus?.analyst_count == null
          ? null
          : Number(consensus.analyst_count),
    },
    news,
    social: {
      xStatus: env.X_BEARER_TOKEN?.trim() ? "available" : "not_configured",
    },
  };
  const model = buildMultisignalReactionModel(inputs);
  const modelVersion = "earnings_reaction_multisignal_v5";
  const forecastKey = `${modelVersion}:${forecast.id}:${newYorkDate(at)}`;
  const id = await sha256Hex(forecastKey);
  const profile = earningsEventProfile(
    forecast.ticker,
    forecast.fiscal_period,
    env.earningsCalendar,
  );
  const releaseStart = profile?.date ?? forecast.expected_window_start;
  const releaseEnd = profile?.date ?? forecast.expected_window_end;
  const releaseWindowBasis = profile
    ? `${profile.basis}；${profile.dateLabel}`
    : "SEC filing-cadence proxy; company IR earnings date is not yet confirmed.";
  const targetDefinition =
    "Official earnings release: final normal-session close before publication to the first full normal-session close after publication, relative to SPY; up > +1%, down < -1%, otherwise base.";
  const inputHash = await sha256Hex(
    safeJson({ forecastId: forecast.id, consensusId: consensus?.id, inputs }),
  );
  const result = await execute(
    env.DB,
    `INSERT OR IGNORE INTO earnings_reaction_forecasts
       (id, forecast_key, financial_forecast_id, consensus_snapshot_id,
        ticker, fiscal_period, release_window_start, release_window_end,
        release_window_basis, information_cutoff_at, target_definition,
        threshold_up, threshold_down, benchmark, probability_up,
        probability_base, probability_down, predicted_direction,
        expected_relative_return, reaction_low, reaction_high,
        reaction_range_basis, sample_size, model_confidence, model_version,
        consensus_status, key_drivers_json, invalidation_condition,
        feature_snapshot_json, input_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.01, -0.01, 'SPY',
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    id,
    forecastKey,
    forecast.id,
    consensus?.id ?? null,
    forecast.ticker,
    forecast.fiscal_period,
    releaseStart,
    releaseEnd,
    releaseWindowBasis,
    at,
    targetDefinition,
    model.probabilityUp,
    model.probabilityBase,
    model.probabilityDown,
    model.predictedDirection,
    model.expectedRelativeReturn,
    model.reactionLow,
    model.reactionHigh,
    model.reactionRangeBasis,
    model.sampleSize,
    model.modelConfidence,
    modelVersion,
    model.consensusStatus,
    safeJson(model.keyDrivers),
    model.invalidationCondition,
    safeJson(model.featureSnapshot),
    inputHash,
    at,
    at,
  );
  return changes(result);
}

async function processMultisignalEarningsForecasts(
  env: Env,
): Promise<SourceResult> {
  const at = nowIso();
  const source = await queryFirst<{ cursor: string | null }>(
    env.DB,
    "SELECT cursor FROM sources WHERE id = ?",
    "forecast:earnings-multisignal-v5",
  );
  if (isRecent(source?.cursor, MULTISIGNAL_FORECAST_REFRESH_MS)) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "Multisignal earnings forecast refresh is not due.",
    };
  }
  const forecasts = await queryAll<EarningsForecastForReactionRow>(
    env.DB,
    `SELECT id, ticker, cik, fiscal_period, expected_window_start,
            expected_window_end, information_cutoff_at, revenue_estimate,
            eps_estimate, status, basis_json
     FROM earnings_forecasts
     WHERE status IN ('open', 'awaiting_actual')
     ORDER BY created_at DESC
     LIMIT 50`,
  );
  const barsCache = new Map<string, Promise<MarketBarsResult>>();
  let inserted = 0;
  for (const forecast of forecasts) {
    inserted += await createMultisignalReactionForecast(
      env,
      forecast,
      barsCache,
      at,
    );
    await sleep(100);
  }
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: forecasts.length,
    itemsNew: inserted,
    cursor: at,
    note: `Frozen ${inserted} market + revisions + news + SEC reaction forecast(s); X and options remain explicitly labeled when unavailable.`,
  };
}

function addWeekdaySessions(date: string, sessions: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day));
  let remaining = sessions;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      remaining -= 1;
    }
  }
  return cursor.toISOString().slice(0, 10);
}

function earningsReleaseTiming(
  profile: EarningsEventProfile,
): "after_market_close" | "before_market_open" {
  return /盘前|before market|pre-?market/i.test(
    `${profile.dateLabel} ${profile.timing}`,
  )
    ? "before_market_open"
    : "after_market_close";
}

function earningsPointForecastEligible(
  profile: EarningsEventProfile,
  at: string,
): boolean {
  if (
    !profile.date ||
    profile.status === "reported" ||
    !["confirmed", "secondary"].includes(profile.status)
  ) {
    return false;
  }
  const today = newYorkDate(at);
  const dayDifference = Math.round(
    (Date.parse(`${profile.date}T00:00:00Z`) -
      Date.parse(`${today}T00:00:00Z`)) /
      (24 * 60 * 60 * 1_000),
  );
  if (dayDifference < 0 || dayDifference > 7) return false;
  if (dayDifference > 0) return true;
  const hour = newYorkHour(at);
  const minute = newYorkMinute(at);
  const minutesSinceMidnight = hour * 60 + minute;
  return earningsReleaseTiming(profile) === "after_market_close"
    ? minutesSinceMidnight < 16 * 60
    : minutesSinceMidnight < 8 * 60;
}

function pointForecastStance(
  changePct: number,
): "bullish" | "neutral" | "bearish" {
  if (changePct >= 0.5) return "bullish";
  if (changePct <= -0.5) return "bearish";
  return "neutral";
}

function historicalPointForecastChangePct(
  probabilityUp: number,
  probabilityDown: number,
  amplitude: HistoricalEarningsAmplitude,
): number | null {
  const directionalBalance = probabilityUp - probabilityDown;
  if (Math.abs(directionalBalance) < 0.05) return null;
  const conviction = Math.min(
    1,
    Math.max(0, (Math.abs(directionalBalance) - 0.05) / 0.25),
  );
  const typicalMagnitude =
    amplitude.medianAbsMovePct +
    (amplitude.p75AbsMovePct - amplitude.medianAbsMovePct) * conviction;
  const signedMagnitude =
    Math.sign(directionalBalance) * Math.min(30, typicalMagnitude);
  return Math.round(signedMagnitude * 2) / 2;
}

async function processEarningsPointPriceForecasts(
  env: Env,
): Promise<SourceResult> {
  const at = nowIso();
  const candidates = await queryAll<{
    financial_forecast_id: string;
    reaction_forecast_id: string;
    ticker: string;
    fiscal_period: string;
    probability_up: number;
    probability_down: number;
    key_drivers_json: string;
    reaction_information_cutoff_at: string;
    reaction_model_version: string;
  }>(
    env.DB,
    `SELECT ef.id AS financial_forecast_id,
            erf.id AS reaction_forecast_id,
            ef.ticker,
            ef.fiscal_period,
            erf.probability_up,
            erf.probability_down,
            erf.key_drivers_json,
            erf.information_cutoff_at AS reaction_information_cutoff_at,
            erf.model_version AS reaction_model_version
     FROM earnings_forecasts ef
     JOIN earnings_reaction_forecasts erf
       ON erf.financial_forecast_id = ef.id
      AND erf.model_version = 'earnings_reaction_multisignal_v5'
      AND erf.id = (
        SELECT latest_erf.id
        FROM earnings_reaction_forecasts latest_erf
        WHERE latest_erf.financial_forecast_id = ef.id
          AND latest_erf.model_version = 'earnings_reaction_multisignal_v5'
        ORDER BY latest_erf.information_cutoff_at DESC
        LIMIT 1
     )
     WHERE ef.status IN ('open', 'awaiting_actual')
     ORDER BY erf.information_cutoff_at DESC
     LIMIT 100`,
  );

  let eligible = 0;
  let inserted = 0;
  let missingQuote = 0;
  let missingHistory = 0;
  let weakDirection = 0;
  let specialistModelRequired = 0;
  const amplitudeCache = new Map<
    string,
    Promise<HistoricalEarningsAmplitude | null>
  >();
  for (const candidate of candidates) {
    const profile = earningsEventProfile(
      candidate.ticker,
      candidate.fiscal_period,
      env.earningsCalendar,
    );
    if (!profile || !earningsPointForecastEligible(profile, at) || !profile.date) {
      continue;
    }
    eligible += 1;
    if (candidate.ticker === "MSTR") {
      specialistModelRequired += 1;
      continue;
    }
    const quote = await queryFirst<LatestQuoteRow>(
      env.DB,
      `SELECT ticker, price, quote_as_of_at, provider, source_url,
              market_status, is_real_time, delay_minutes
       FROM latest_quotes
       WHERE ticker = ?
       LIMIT 1`,
      candidate.ticker,
    );
    if (!quote) {
      missingQuote += 1;
      continue;
    }

    const modelVersion = "earnings_point_price_v2_historical_amplitude";
    const superseded = await queryFirst<{
      id: string;
      input_hash: string;
      reaction_forecast_id: string;
      forecast_role: "initial" | "revision" | "final";
      model_version: string;
    }>(
      env.DB,
      `SELECT id, input_hash, reaction_forecast_id, forecast_role,
              model_version
       FROM earnings_price_forecasts
       WHERE financial_forecast_id = ?
       ORDER BY information_cutoff_at DESC
       LIMIT 1`,
      candidate.financial_forecast_id,
    );
    const releaseTiming = earningsReleaseTiming(profile);
    const isReleaseDay = newYorkDate(at) === profile.date;
    const minutesSinceMidnight =
      newYorkHour(at) * 60 + newYorkMinute(at);
    const inFinalFreezeWindow =
      releaseTiming === "after_market_close" &&
      isReleaseDay &&
      minutesSinceMidnight >= 15 * 60 + 45 &&
      minutesSinceMidnight < 16 * 60;
    const forecastRole: "initial" | "revision" | "final" =
      inFinalFreezeWindow
        ? "final"
        : superseded
          ? "revision"
          : "initial";
    if (
      superseded?.forecast_role === "final" ||
      (!inFinalFreezeWindow &&
        superseded?.reaction_forecast_id === candidate.reaction_forecast_id &&
        superseded?.model_version === modelVersion)
    ) {
      continue;
    }

    let amplitudePromise = amplitudeCache.get(candidate.ticker);
    if (!amplitudePromise) {
      amplitudePromise = fetchHistoricalEarningsAmplitude(
        candidate.ticker,
      ).catch(() => null);
      amplitudeCache.set(candidate.ticker, amplitudePromise);
    }
    const amplitude = await amplitudePromise;
    if (!amplitude) {
      missingHistory += 1;
      continue;
    }
    const predictedChangePct = historicalPointForecastChangePct(
      Number(candidate.probability_up),
      Number(candidate.probability_down),
      amplitude,
    );
    if (predictedChangePct === null) {
      weakDirection += 1;
      continue;
    }
    const keyDrivers = [
      `【历史财报波动】过去 ${amplitude.sampleCount} 次财报窗口绝对涨跌中位数 ${amplitude.medianAbsMovePct.toFixed(
        1,
      )}%，75 分位 ${amplitude.p75AbsMovePct.toFixed(
        1,
      )}%；本次幅度以该股自身历史为基准。`,
      ...parseJsonArray(candidate.key_drivers_json).slice(0, 3),
    ];
    const predictedPostPrice =
      Math.round(
        Number(quote.price) * (1 + predictedChangePct / 100) * 100,
      ) / 100;
    const stance = pointForecastStance(predictedChangePct);
    const targetSession =
      releaseTiming === "after_market_close"
        ? addWeekdaySessions(profile.date, 1)
        : profile.date;
    const settlementDueAt = `${targetSession}T22:30:00.000Z`;
    const materialInput = {
      reactionModelVersion: candidate.reaction_model_version,
      referencePrice: Number(quote.price),
      referencePriceAt: quote.quote_as_of_at,
      predictedChangePct,
      historicalAmplitude: amplitude,
      keyDrivers,
      earningsDate: profile.date,
      releaseTiming,
      forecastRole,
    };
    const inputHash = await sha256Hex(safeJson(materialInput));
    if (superseded?.input_hash === inputHash) continue;
    const forecastKey = `${modelVersion}:${candidate.reaction_forecast_id}:${forecastRole}:${inputHash.slice(
      0,
      16,
    )}`;
    const id = await sha256Hex(`earnings-price-forecast|${forecastKey}`);
    const directionText =
      stance === "bullish" ? "上涨" : stance === "bearish" ? "下跌" : "基本持平";
    const thesis = `我们预测 ${candidate.ticker} 财报后目标交易日收盘价为 $${predictedPostPrice.toFixed(
      2,
    )}，较当前参考价 ${directionText} ${Math.abs(predictedChangePct).toFixed(
      1,
    )}%。方向由财报前已冻结的基本面、相对走势、分析师修订和新闻信号决定；幅度以该股过去 ${
      amplitude.sampleCount
    } 次财报窗口绝对涨跌中位数 ${amplitude.medianAbsMovePct.toFixed(
      1,
    )}% 和 75 分位 ${amplitude.p75AbsMovePct.toFixed(
      1,
    )}% 为基准，不使用统一的小幅度档位。`;
    const source = {
      quote: {
        provider: quote.provider,
        sourceUrl: quote.source_url,
        quoteAsOfAt: quote.quote_as_of_at,
        marketStatus: quote.market_status,
        isRealTime: Boolean(quote.is_real_time),
        delayMinutes: Number(quote.delay_minutes),
      },
      earningsEvent: {
        sourceName: profile.sourceName,
        sourceUrl: profile.sourceUrl,
        basis: profile.basis,
      },
      reactionForecast: {
        id: candidate.reaction_forecast_id,
        modelVersion: candidate.reaction_model_version,
        informationCutoffAt: candidate.reaction_information_cutoff_at,
      },
      historicalEarningsAmplitude: {
        provider: "Nasdaq Earnings Surprise + Nasdaq Historical",
        earningsSourceUrl: amplitude.earningsSourceUrl,
        priceSourceUrl: amplitude.priceSourceUrl,
        sampleCount: amplitude.sampleCount,
        medianAbsMovePct: amplitude.medianAbsMovePct,
        p75AbsMovePct: amplitude.p75AbsMovePct,
        observations: amplitude.observations,
        windowRule:
          "以财报日前一交易日收盘为基准，在财报日与下一交易日中取绝对变化较大者，以覆盖盘前或盘后发布时间差异。",
      },
      methodology:
        "方向由冻结的多信号差决定；幅度在个股历史财报绝对波动中位数与 75 分位之间按方向信号强度插值，再四舍五入到 0.5 个百分点。若历史样本不足 3 次或方向信号差小于 5 个百分点，则不生成目标价。",
    };
    const result = await execute(
      env.DB,
      `INSERT OR IGNORE INTO earnings_price_forecasts
         (id, forecast_key, financial_forecast_id, reaction_forecast_id,
          supersedes_forecast_id, ticker, fiscal_period, earnings_date,
          release_timing, target_session, settlement_due_at, reference_price,
          reference_price_at, reference_quote_provider,
          reference_quote_is_real_time, reference_quote_delay_minutes,
          predicted_post_price, predicted_change_pct, forecast_stance,
          forecast_role, thesis, key_drivers_json, information_cutoff_at,
          model_version, source_json, input_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?)`,
      id,
      forecastKey,
      candidate.financial_forecast_id,
      candidate.reaction_forecast_id,
      superseded?.id ?? null,
      candidate.ticker,
      candidate.fiscal_period,
      profile.date,
      releaseTiming,
      targetSession,
      settlementDueAt,
      Number(quote.price),
      quote.quote_as_of_at,
      quote.provider,
      Number(quote.is_real_time),
      Number(quote.delay_minutes),
      predictedPostPrice,
      predictedChangePct,
      stance,
      forecastRole,
      thesis,
      safeJson(keyDrivers),
      at,
      modelVersion,
      safeJson(source),
      inputHash,
      at,
    );
    inserted += changes(result);
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: eligible,
    itemsNew: inserted,
    cursor: at,
    note: `Frozen ${inserted} immutable historical-amplitude point-price forecast version(s), using only pre-release information; ${missingQuote} lacked a quote, ${missingHistory} lacked at least three usable historical earnings windows, ${weakDirection} had no minimum directional edge, and ${specialistModelRequired} MSTR forecast(s) were withheld because the generic model is no longer permitted for this BTC treasury security.`,
  };
}

async function settleEarningsPointPriceForecasts(
  env: Env,
): Promise<SourceResult> {
  const at = nowIso();
  const due = await queryAll<EarningsPriceForecastDueRow>(
    env.DB,
    `SELECT epf.id, epf.ticker, epf.target_session,
            epf.settlement_due_at, epf.reference_price,
            epf.predicted_post_price, epf.predicted_change_pct,
            epf.forecast_stance
     FROM earnings_price_forecasts epf
     LEFT JOIN earnings_price_forecast_settlements settlement
       ON settlement.price_forecast_id = epf.id
     WHERE settlement.id IS NULL
       AND epf.settlement_due_at <= ?
     ORDER BY epf.settlement_due_at
     LIMIT 50`,
    at,
  );
  if (!due.length) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "No earnings point-price forecast is due for settlement.",
    };
  }

  let settled = 0;
  let unavailable = 0;
  for (const forecast of due) {
    const start = new Date(
      Date.parse(`${forecast.target_session}T00:00:00Z`) -
        2 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const end = new Date(
      Date.parse(`${forecast.target_session}T00:00:00Z`) +
        8 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    let bars: AlpacaBar[] = [];
    try {
      bars = await fetchNasdaqDailyBars(forecast.ticker, start, end);
    } catch {
      unavailable += 1;
      continue;
    }
    const actualBar = bars.find(
      (bar) =>
        typeof bar.t === "string" &&
        newYorkDate(bar.t) >= forecast.target_session &&
        typeof bar.c === "number" &&
        bar.c > 0,
    );
    if (!actualBar?.t || !actualBar.c) {
      unavailable += 1;
      continue;
    }
    const actualPrice = actualBar.c;
    const actualChangePct =
      (actualPrice / Number(forecast.reference_price) - 1) * 100;
    const errorAmount =
      Number(forecast.predicted_post_price) - actualPrice;
    const errorPct = (errorAmount / actualPrice) * 100;
    const absoluteErrorPct = Math.abs(errorPct);
    const actualStance = pointForecastStance(actualChangePct);
    const directionHit = forecast.forecast_stance === actualStance;
    const evaluatedAt = nowIso();
    const id = await sha256Hex(
      `earnings-price-settlement|${forecast.id}`,
    );
    const result = await execute(
      env.DB,
      `INSERT OR IGNORE INTO earnings_price_forecast_settlements
         (id, price_forecast_id, actual_post_price, actual_price_at,
          actual_price_provider, actual_change_pct, error_amount, error_pct,
          absolute_error_pct, direction_hit, evaluated_at, quality_flag,
          source_json, created_at)
       VALUES (?, ?, ?, ?, 'Nasdaq Historical', ?, ?, ?, ?, ?, ?,
         'first_normal_session_close_on_or_after_target', ?, ?)`,
      id,
      forecast.id,
      actualPrice,
      actualBar.t,
      actualChangePct,
      errorAmount,
      errorPct,
      absoluteErrorPct,
      directionHit ? 1 : 0,
      evaluatedAt,
      safeJson({
        provider: "Nasdaq Historical",
        targetSession: forecast.target_session,
        actualBar,
        errorSignConvention: "predicted_minus_actual",
        errorPctDenominator: "actual_post_price",
        directionNeutralBandPct: 0.5,
      }),
      evaluatedAt,
    );
    settled += changes(result);
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: due.length,
    itemsNew: settled,
    cursor: at,
    note:
      unavailable > 0
        ? `Settled ${settled}; ${unavailable} due forecast(s) are waiting for a Nasdaq official close.`
        : `Settled ${settled} forecast(s) against the first target-session Nasdaq close.`,
  };
}

function barBySession(
  bars: AlpacaBar[],
  session: string,
): AlpacaBar | null {
  return (
    bars.find(
      (bar) => typeof bar.t === "string" && newYorkDate(bar.t) === session,
    ) ?? null
  );
}

function evaluationPair(
  bars: AlpacaBar[],
  cutoffSession: string,
  targetSession: string,
): {
  entry: AlpacaBar;
  exit: AlpacaBar;
  entrySession: string;
  exitSession: string;
} | null {
  const entryCandidates = bars.filter(
    (bar) =>
      typeof bar.t === "string" && newYorkDate(bar.t) < cutoffSession,
  );
  const exitCandidates = bars.filter(
    (bar) =>
      typeof bar.t === "string" && newYorkDate(bar.t) >= targetSession,
  );
  const entry = entryCandidates.at(-1);
  const exit = exitCandidates[0];
  if (!entry?.t || !exit?.t || !entry.c || !exit.c) return null;
  return {
    entry,
    exit,
    entrySession: newYorkDate(entry.t),
    exitSession: newYorkDate(exit.t),
  };
}

function multiclassBrier(
  probabilityUp: number,
  probabilityBase: number,
  probabilityDown: number,
  actualOutcome: "up" | "base" | "down",
): number {
  const actualUp = actualOutcome === "up" ? 1 : 0;
  const actualBase = actualOutcome === "base" ? 1 : 0;
  const actualDown = actualOutcome === "down" ? 1 : 0;
  return (
    ((probabilityUp - actualUp) ** 2 +
      (probabilityBase - actualBase) ** 2 +
      (probabilityDown - actualDown) ** 2) /
    3
  );
}

function predictedClass(
  probabilityUp: number,
  probabilityBase: number,
  probabilityDown: number,
): "up" | "base" | "down" {
  const values = [
    ["up", probabilityUp],
    ["base", probabilityBase],
    ["down", probabilityDown],
  ] as const;
  return values.reduce((best, candidate) =>
    candidate[1] > best[1] ? candidate : best,
  )[0];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericValue(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function probabilityValue(value: unknown): number | null {
  const parsed = numericValue(value);
  if (parsed == null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function manualForecastResolution(
  frozenAt: string,
  horizon: string,
): string | null {
  if (horizon === "1d") return businessSessionResolution(frozenAt, 1);
  if (horizon === "5d") return businessSessionResolution(frozenAt, 5);
  if (horizon === "30d" || horizon === "90d") {
    const days = horizon === "30d" ? 30 : 90;
    return new Date(
      new Date(frozenAt).getTime() + days * 24 * 60 * 60 * 1_000,
    ).toISOString();
  }
  return null;
}

async function createManualForecast(
  request: Request,
  env: Env,
): Promise<Response> {
  const configuredKey = env.DASHBOARD_READ_KEY?.trim();
  if (!configuredKey) {
    return jsonResponse(
      { error: "DASHBOARD_READ_KEY is not configured." },
      503,
    );
  }
  if (!constantTimeEqual(requestBearer(request), configuredKey)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = recordValue(await request.json());
  } catch {
    return jsonResponse({ error: "A JSON request body is required." }, 400);
  }

  const ticker = normalizeSymbol(payload.ticker ?? payload.symbol);
  const security = ticker
    ? await queryFirst<{ symbol: string }>(
        env.DB,
        "SELECT symbol FROM watchlist WHERE symbol = ? AND active = 1 LIMIT 1",
        ticker,
      )
    : null;
  if (!security) {
    return jsonResponse(
      { error: "A valid active watchlist ticker is required." },
      422,
    );
  }

  const targetDefinition = truncate(
    payload.targetDefinition ?? payload.target_definition ?? "",
    500,
  ).trim();
  const rationale = truncate(payload.rationale ?? "", 2_000).trim();
  if (!targetDefinition || !rationale) {
    return jsonResponse(
      { error: "targetDefinition and rationale are required." },
      422,
    );
  }

  const probabilityUp = probabilityValue(
    payload.probabilityUp ?? payload.probability_up,
  );
  const probabilityBase = probabilityValue(
    payload.probabilityBase ?? payload.probability_base,
  );
  const probabilityDown = probabilityValue(
    payload.probabilityDown ?? payload.probability_down,
  );
  if (
    probabilityUp == null ||
    probabilityBase == null ||
    probabilityDown == null ||
    [probabilityUp, probabilityBase, probabilityDown].some(
      (value) => value < 0 || value > 1,
    ) ||
    Math.abs(probabilityUp + probabilityBase + probabilityDown - 1) >
      0.000001
  ) {
    return jsonResponse(
      { error: "probabilityUp, probabilityBase, and probabilityDown must be between 0 and 1 and sum to 1." },
      422,
    );
  }

  const horizon = String(payload.horizon ?? "").trim().toLowerCase();
  const frozenAt = nowIso();
  const resolutionAt = manualForecastResolution(frozenAt, horizon);
  if (!resolutionAt) {
    return jsonResponse(
      { error: "horizon must be one of 1d, 5d, 30d, or 90d." },
      422,
    );
  }

  const returnLow = numericValue(payload.returnLow ?? payload.return_low);
  const returnHigh = numericValue(payload.returnHigh ?? payload.return_high);
  if (
    returnLow == null ||
    returnHigh == null ||
    returnLow >= returnHigh ||
    returnLow < -5 ||
    returnHigh > 5
  ) {
    return jsonResponse(
      { error: "returnLow and returnHigh are required and must form a valid decimal-return interval." },
      422,
    );
  }

  const benchmark =
    normalizeSymbol(payload.benchmark ?? "SPY") || "SPY";
  const forecastKey = `manual-return-v1:${crypto.randomUUID()}`;
  const id = await sha256Hex(forecastKey);
  await execute(
    env.DB,
    `INSERT INTO forecasts
       (id, event_id, forecast_key, ticker, forecast_type, target_definition,
        horizon, probability_up, probability_base, probability_down,
        return_low, return_high, benchmark, rationale, status, created_at,
        information_cutoff_at, resolution_at, quality_flag)
     VALUES (?, NULL, ?, ?, 'pre_event_return_manual_v1', ?, ?, ?, ?, ?, ?,
       ?, ?, ?, 'open', ?, ?, ?, 'server_frozen_manual_v1')`,
    id,
    forecastKey,
    ticker,
    targetDefinition,
    horizon,
    probabilityUp,
    probabilityBase,
    probabilityDown,
    returnLow,
    returnHigh,
    benchmark,
    rationale,
    frozenAt,
    frozenAt,
    resolutionAt,
  );

  return jsonResponse(
    {
      ok: true,
      status: "frozen",
      forecast: {
        id,
        ticker,
        forecastType: "pre_event_return_manual_v1",
        targetDefinition,
        horizon,
        probabilityUp,
        probabilityBase,
        probabilityDown,
        returnLow,
        returnHigh,
        benchmark,
        rationale,
        createdAt: frozenAt,
        informationCutoffAt: frozenAt,
        resolutionAt,
        eligibility: "official_manual",
      },
    },
    201,
  );
}

async function resolveOpenForecasts(env: Env): Promise<SourceResult> {
  const due = await queryAll<OpenForecastRow>(
    env.DB,
    `SELECT id, ticker, benchmark, forecast_type, probability_up, probability_base,
            probability_down, information_cutoff_at, resolution_at
     FROM forecasts
     WHERE status = 'open'
       AND forecast_type IN ('event_reaction', 'pre_event_return_manual_v1')
       AND resolution_at <= ?
     ORDER BY resolution_at
     LIMIT 10`,
    nowIso(),
  );
  if (!due.length) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "No market-return forecast is due for settlement.",
    };
  }

  if (
    !env.ALPACA_API_KEY_ID?.trim() ||
    !env.ALPACA_API_SECRET_KEY?.trim()
  ) {
    const at = nowIso();
    await env.DB.batch(
      due.map((forecast) =>
        env.DB
          .prepare(
            `UPDATE forecasts SET quality_flag = 'data_unavailable'
             WHERE id = ? AND status = 'open'`,
          )
          .bind(forecast.id),
      ),
    );
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: due.length,
      itemsNew: 0,
      cursor: at,
      note:
        "Due market-return forecasts remain unresolved because Alpaca market-data credentials are unavailable; no outcome was fabricated.",
    };
  }

  const cache = new Map<string, Promise<AlpacaBar[]>>();
  const loadBars = (
    symbol: string,
    start: string,
    end: string,
  ): Promise<AlpacaBar[]> => {
    const key = `${symbol}|${start}|${end}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = fetchAlpacaDailyBars(env, symbol, start, end);
      cache.set(key, pending);
    }
    return pending;
  };

  let resolved = 0;
  let unavailable = 0;
  for (const forecast of due) {
    const start = new Date(
      new Date(forecast.information_cutoff_at).getTime() -
        14 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const end = new Date(
      new Date(forecast.resolution_at).getTime() +
        8 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const [tickerBars, benchmarkBars] = await Promise.all([
      loadBars(forecast.ticker, start, end),
      loadBars(forecast.benchmark, start, end),
    ]);
    const pair = evaluationPair(
      tickerBars,
      newYorkDate(forecast.information_cutoff_at),
      newYorkDate(forecast.resolution_at),
    );
    if (!pair) {
      unavailable += 1;
      await execute(
        env.DB,
        `UPDATE forecasts SET quality_flag = 'data_unavailable'
         WHERE id = ? AND status = 'open'`,
        forecast.id,
      );
      continue;
    }
    const benchmarkEntry = barBySession(benchmarkBars, pair.entrySession);
    const benchmarkExit = barBySession(benchmarkBars, pair.exitSession);
    if (
      !benchmarkEntry?.c ||
      !benchmarkExit?.c ||
      !pair.entry.c ||
      !pair.exit.c
    ) {
      unavailable += 1;
      await execute(
        env.DB,
        `UPDATE forecasts SET quality_flag = 'data_unavailable'
         WHERE id = ? AND status = 'open'`,
        forecast.id,
      );
      continue;
    }

    const tickerReturn = pair.exit.c / pair.entry.c - 1;
    const benchmarkReturn = benchmarkExit.c / benchmarkEntry.c - 1;
    const relativeReturn = tickerReturn - benchmarkReturn;
    const actualOutcome: "up" | "base" | "down" =
      relativeReturn > 0.005
        ? "up"
        : relativeReturn < -0.005
          ? "down"
          : "base";
    const brierScore = multiclassBrier(
      Number(forecast.probability_up),
      Number(forecast.probability_base),
      Number(forecast.probability_down),
      actualOutcome,
    );
    const directionHit =
      predictedClass(
        Number(forecast.probability_up),
        Number(forecast.probability_base),
        Number(forecast.probability_down),
      ) === actualOutcome;
    const evaluatedAt = nowIso();
    const feed = env.ALPACA_DATA_FEED?.trim() || "iex";
    const qualityFlag = `alpaca_${feed}_daily_prior_to_next_session`;
    const evaluationId = await sha256Hex(`evaluation|${forecast.id}`);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO forecast_evaluations
             (id, forecast_id, evaluation_type, ticker_entry_price,
              ticker_exit_price, benchmark_entry_price, benchmark_exit_price,
              ticker_return, benchmark_return, relative_return, actual_outcome,
              brier_score, direction_hit, event_count, entry_session,
              exit_session, quality_flag, evaluated_at, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .bind(
          evaluationId,
          forecast.id,
          forecast.forecast_type === "event_reaction"
            ? "event_reaction_market_return"
            : "pre_event_manual_market_return",
          pair.entry.c,
          pair.exit.c,
          benchmarkEntry.c,
          benchmarkExit.c,
          tickerReturn,
          benchmarkReturn,
          relativeReturn,
          actualOutcome,
          brierScore,
          directionHit ? 1 : 0,
          pair.entrySession,
          pair.exitSession,
          qualityFlag,
          evaluatedAt,
          safeJson({
            ticker: forecast.ticker,
            benchmark: forecast.benchmark,
            tickerEntry: pair.entry,
            tickerExit: pair.exit,
            benchmarkEntry,
            benchmarkExit,
          }),
        ),
      env.DB
        .prepare(
          `UPDATE forecasts SET
             status = 'resolved',
             actual_outcome = ?,
             relative_return = ?,
             brier_score = ?,
             direction_hit = ?,
             quality_flag = ?,
             resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .bind(
          actualOutcome,
          relativeReturn,
          brierScore,
          directionHit ? 1 : 0,
          qualityFlag,
          evaluatedAt,
          forecast.id,
        ),
    ]);
    resolved += 1;
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: due.length,
    itemsNew: resolved,
    cursor: nowIso(),
    note:
      unavailable > 0
        ? `${unavailable} due forecast(s) remain unresolved with qualityFlag=data_unavailable; no price was inferred.`
        : null,
  };
}

async function resolvePreEventBaselines(env: Env): Promise<SourceResult> {
  const due = await queryAll<OpenForecastRow>(
    env.DB,
    `SELECT id, ticker, benchmark, probability_up, probability_base,
            probability_down, information_cutoff_at, resolution_at
     FROM forecasts
     WHERE status = 'open'
       AND forecast_type = 'pre_event_incidence_baseline_v1'
       AND resolution_at <= ?
     ORDER BY resolution_at
     LIMIT 100`,
    nowIso(),
  );
  if (!due.length) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: "No weekly pre-event baseline is due for resolution.",
    };
  }

  let resolved = 0;
  for (const forecast of due) {
    const events = await queryAll<{
      id: string;
      direction: string;
      priority: string;
      published_at: string;
    }>(
      env.DB,
      `SELECT id, direction, priority, published_at
       FROM events
       WHERE ticker = ?
         AND source_key = 'sec-edgar'
         AND source_tier = 1
         AND priority IN ('P0', 'P1')
         AND published_at > ?
         AND published_at <= ?
       ORDER BY published_at`,
      forecast.ticker,
      forecast.information_cutoff_at,
      forecast.resolution_at,
    );
    const eventOccurred = events.length > 0;
    const actualOutcome = eventOccurred ? "event" : "no_event";
    const probabilityEvent =
      Number(forecast.probability_up) + Number(forecast.probability_down);
    const brierScore =
      (probabilityEvent - (eventOccurred ? 1 : 0)) ** 2;
    const predictedEvent = probabilityEvent >= 0.5;
    const directionHit = predictedEvent === eventOccurred;
    const evaluatedAt = nowIso();
    const qualityFlag = "baseline_v1_weekday_calendar";
    const evaluationId = await sha256Hex(`evaluation|${forecast.id}`);
    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO forecast_evaluations
             (id, forecast_id, evaluation_type, ticker_entry_price,
              ticker_exit_price, benchmark_entry_price, benchmark_exit_price,
              ticker_return, benchmark_return, relative_return, actual_outcome,
              brier_score, direction_hit, event_count, entry_session,
              exit_session, quality_flag, evaluated_at, raw_json)
           VALUES (?, ?, 'pre_event_incidence', NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .bind(
          evaluationId,
          forecast.id,
          actualOutcome,
          brierScore,
          directionHit ? 1 : 0,
          events.length,
          qualityFlag,
          evaluatedAt,
          safeJson({ events }),
        ),
      env.DB
        .prepare(
          `UPDATE forecasts SET
             status = 'resolved',
             actual_outcome = ?,
             relative_return = NULL,
             brier_score = ?,
             direction_hit = ?,
             quality_flag = ?,
             resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .bind(
          actualOutcome,
          brierScore,
          directionHit ? 1 : 0,
          qualityFlag,
          evaluatedAt,
          forecast.id,
        ),
    ]);
    resolved += 1;
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: due.length,
    itemsNew: resolved,
    cursor: nowIso(),
  };
}

function dueBriefingType(
  at: string,
): "morning" | "after_close" | null {
  const weekday = newYorkWeekday(at);
  if (weekday === "Sat" || weekday === "Sun") return null;
  const hour = newYorkHour(at);
  const minute = newYorkMinute(at);
  // A small grace window avoids missing the briefing if one minute of Cron is
  // delayed. The briefing_key still guarantees only one record per session.
  if (hour === 7 && minute >= 45) return "morning";
  // 17:15 ET gives the session time to settle and the first after-hours
  // releases to land. The shared rule owns the holiday calendar.
  if (isTradingDay(newYorkDate(at)) && (hour === 17 && minute >= 15)) return "after_close";
  return null;
}

function buildBriefingContent(
  briefingType: "morning" | "after_close",
  sessionDate: string,
  title: string,
  summary: string,
  items: Array<Record<string, unknown>>,
): { subject: string; text: string; html: string } {
  const label = briefingType === "morning" ? "盘前简报" : "收盘后简报";
  const subject = `【美股${label}】${sessionDate}｜${title}`;
  const analyzedItems = items.flatMap((item) => {
    const ticker = String(item.ticker ?? "MARKET");
    const kind = String(item.kind ?? "event");
    const presentation =
      kind === "earningsForecast"
        ? {
            title: `${ticker} 财报时间观察`,
            whyItMatters:
              "观察变量以 Signal Ledger 冻结的预测为准。",
          }
        : chineseMailEvent({
            ticker,
            eventType: String(item.eventType ?? "news"),
            headline: String(item.title ?? ""),
            summary: String(item.summary ?? ""),
            direction: String(item.direction ?? ""),
          });
    return presentation ? [{ item, presentation }] : [];
  });
  const lines = analyzedItems.map(({ item, presentation }) => {
    const source = item.source ? `\n  来源：${String(item.source)}` : "";
    const publishedAt = item.publishedAt
      ? `\n  发布时间：${formatEtDateTime(String(item.publishedAt))}`
      : "";
    const url = item.url ? `\n  原始来源：${String(item.url)}` : "";
    return `- ${presentation.title}\n  影响：${presentation.whyItMatters}${source}${publishedAt}${url}`;
  });
  const text = [
    title,
    summary,
    "",
    ...(lines.length ? lines : ["- 本窗口没有新的紧急或重要事件。"]),
    "",
    "财报观察会分别标注模型预测和分析师一致预期，缺失数据不会用其他口径替代。",
    "自动化监控信息，不构成投资建议。",
  ].join("\n");
  const htmlItems = analyzedItems.length
    ? analyzedItems
        .map(({ item, presentation }) => {
          const url = String(item.url ?? "");
          const itemTitle = escapeHtml(presentation.title);
          const linkedTitle = url
            ? `<a href="${escapeHtml(url)}">${itemTitle}</a>`
            : itemTitle;
          const publishedAt = item.publishedAt
            ? `<div style="font-size:13px;color:#647067;margin-top:4px">发布时间：${escapeHtml(
                formatEtDateTime(String(item.publishedAt)),
              )}</div>`
            : "";
          return `<li style="margin:12px 0"><strong>${linkedTitle}</strong><div style="margin-top:4px">影响：${escapeHtml(
            presentation.whyItMatters,
          )}</div>${publishedAt}</li>`;
        })
        .join("")
    : "<li>本窗口没有新的紧急或重要事件。</li>";
  const html = [
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#15211b;line-height:1.5">',
    '<div style="max-width:720px;margin:auto;border:1px solid #d9e1dc;border-radius:12px;overflow:hidden">',
    `<div style="padding:16px 20px;background:#173f35;color:white"><strong>${escapeHtml(
      sessionDate,
    )} · ${escapeHtml(label)}</strong></div>`,
    `<div style="padding:22px"><h2 style="margin-top:0">${escapeHtml(title)}</h2>`,
    `<p>${escapeHtml(summary)}</p><ul>${htmlItems}</ul>`,
    '<p style="font-size:12px;color:#6b746f">财报观察会分别标注模型预测和分析师一致预期，缺失数据不会用其他口径替代。自动化监控信息，不构成投资建议。</p>',
    "</div></div></body></html>",
  ].join("");
  return { subject, text, html };
}


/* ------------------------------------------------------------------ */
/* Post-close intelligence brief                                       */
/* ------------------------------------------------------------------ */

type PostCloseOutcome =
  | {
    ready: true;
    subject: string;
    text: string;
    html: string;
    regime: string;
    theme: string;
    bodyHash: string;
    /**
     * What this session saw at the canonical endpoint. Returned rather than
     * written so the caller persists it after the quality gate, and so a
     * read-only TEST MODE run can never write it.
     */
    valuationCaptures: ValuationCaptureRow[];
  }
  | { ready: false; status: "needs_setup" | "failed"; note: string };

const BRIEF_NEWS_WINDOW_HOURS = 20;

/** One session's view of one instrument at the canonical valuation endpoint. */
type ValuationCaptureRow = {
  id: string;
  ticker: string;
  sessionDate: string;
  capturedAt: string;
  fairValue: number | null;
  fairValueLow: number | null;
  fairValueHigh: number | null;
  currentPrice: number | null;
  rating: string | null;
  confidence: number | null;
  modelFamily: string | null;
  modelVersion: string | null;
  modelInputHash: string | null;
  thesisHash: string | null;
  valuationUpdatedAt: string | null;
  snapshotJson: string;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Turns a canonical snapshot into the row that records it. The hashes come from
 * the shared projection, so price and timestamps can never enter them: the
 * projection is the contract, this only digests it.
 */
async function buildValuationCapture(
  sessionDate: string,
  snapshot: Record<string, unknown>,
  capturedAt: string,
): Promise<ValuationCaptureRow> {
  const ticker = String(snapshot.ticker ?? "").trim().toUpperCase();
  const modelRange = (snapshot.modelRange ?? {}) as { bear?: unknown; bull?: unknown };
  const thesisProjection = valuationThesisProjection(snapshot);
  return {
    id: await sha256Hex(`valuation|${ticker}|${sessionDate}`),
    ticker,
    sessionDate,
    capturedAt,
    fairValue: numberOrNull(snapshot.fairValue),
    fairValueLow: numberOrNull(modelRange.bear),
    fairValueHigh: numberOrNull(modelRange.bull),
    currentPrice: numberOrNull(snapshot.marketPrice),
    rating: typeof snapshot.rating === "string" ? snapshot.rating : null,
    confidence: numberOrNull(snapshot.confidence),
    modelFamily: typeof snapshot.valuationFamily === "string" ? snapshot.valuationFamily : null,
    modelVersion: typeof snapshot.engineVersion === "string" ? snapshot.engineVersion : null,
    modelInputHash: await sha256Hex(valuationInputProjection(snapshot)),
    thesisHash: thesisProjection === null ? null : await sha256Hex(thesisProjection),
    valuationUpdatedAt: typeof snapshot.valuationUpdatedAt === "string" ? snapshot.valuationUpdatedAt : null,
    snapshotJson: JSON.stringify(snapshot),
  };
}

/**
 * The most recent prior session's snapshot per instrument. Returns empty when
 * the history table does not exist yet, so an unmigrated deployment degrades to
 * "no comparable prior" instead of failing the brief.
 */
async function readPriorValuationSnapshots(env: Env, sessionDate: string): Promise<Map<string, ValuationSnapshotRow>> {
  const prior = new Map<string, ValuationSnapshotRow>();
  try {
    const rows = await queryAll<{
      ticker: string; session_date: string; fair_value: number | null;
      model_input_hash: string | null; thesis_hash: string | null; snapshot_json: string | null;
    }>(env.DB,
      `SELECT h.ticker, h.session_date, h.fair_value, h.model_input_hash, h.thesis_hash, h.snapshot_json
         FROM valuation_snapshot_history h
         JOIN (
           SELECT ticker, MAX(session_date) AS session_date
             FROM valuation_snapshot_history
            WHERE session_date < ?
            GROUP BY ticker
         ) latest ON latest.ticker = h.ticker AND latest.session_date = h.session_date`,
      sessionDate);
    for (const row of rows) {
      prior.set(row.ticker, {
        ticker: row.ticker,
        sessionDate: row.session_date,
        fairValue: row.fair_value,
        modelInputHash: row.model_input_hash,
        thesisHash: row.thesis_hash,
        snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) as Record<string, unknown> : null,
      });
    }
  } catch {
    // Pre-migration, or a transient read failure: compare against nothing.
  }
  return prior;
}

/**
 * Appends this session's snapshots. INSERT OR IGNORE against UNIQUE(ticker,
 * session_date) makes a retry of the same session a no-op, and the table's
 * triggers reject any UPDATE or DELETE.
 */
async function persistValuationCaptures(env: Env, captures: ValuationCaptureRow[]): Promise<number> {
  let written = 0;
  for (const row of captures) {
    const result = await execute(env.DB,
      `INSERT OR IGNORE INTO valuation_snapshot_history
         (id, ticker, session_date, captured_at, fair_value, fair_value_low, fair_value_high,
          current_price, rating, confidence, model_family, model_version,
          model_input_hash, thesis_hash, valuation_updated_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.ticker, row.sessionDate, row.capturedAt, row.fairValue, row.fairValueLow,
      row.fairValueHigh, row.currentPrice, row.rating, row.confidence, row.modelFamily,
      row.modelVersion, row.modelInputHash, row.thesisHash, row.valuationUpdatedAt, row.snapshotJson);
    written += result.meta?.changes ?? 0;
  }
  return written;
}

/** ISO date `days` before the session, for the prior-close read. */
function shiftDate(sessionDate: string, days: number): string {
  const date = new Date(`${sessionDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function readerTier(name: string, tier: number | null): 1 | 2 | 3 {
  if (tier === 1) return 1;
  if (/reuters|bloomberg|wsj|financial times|associated press|ap\b/i.test(name)) return 2;
  const numeric = Number(tier);
  return numeric === 1 ? 1 : numeric === 2 ? 2 : 3;
}

/**
 * Runs the whole post-close pipeline in the worker: market data first, then
 * anomalies, then news as a candidate cause. Nothing is written from a headline
 * alone, and a missing data source degrades the brief rather than inventing it.
 */
async function buildPostCloseBrief(env: Env, sessionDate: string): Promise<PostCloseOutcome> {
  try {
    return await buildPostCloseBriefInner(env, sessionDate);
  } catch (error) {
    // An unexpected failure degrades to "no brief" so the caller can drop the
    // row and retry, instead of leaving a half-written record and throwing.
    return {
      ready: false,
      status: "failed",
      note: `The brief could not be produced: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

async function buildPostCloseBriefInner(env: Env, sessionDate: string): Promise<PostCloseOutcome> {
  if (!env.ALPACA_API_KEY_ID?.trim() || !env.ALPACA_API_SECRET_KEY?.trim()) {
    return {
      ready: false,
      status: "needs_setup",
      note: "Alpaca market-data credentials are unavailable, so no session brief was generated. Nothing was fabricated.",
    };
  }

  const universe = [...new Set([...INSTRUMENTS, ...SEMICONDUCTOR_COHORT].map((entry) => entry.symbol))];
  let daily;
  let intraday;
  try {
    daily = await fetchDailyAdjustedBars(universe, { start: shiftDate(sessionDate, -12) });
    intraday = await fetchIntradayBars(universe, { start: sessionDate });
  } catch (error) {
    return {
      ready: false,
      status: "failed",
      note: `Market data could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }

  const priorCloseOf = (symbol: string): number | null => {
    const series = daily.get(symbol);
    if (!series) return null;
    const dates = [...series.keys()].filter((date) => date < sessionDate).sort();
    const last = dates.at(-1);
    return last ? series.get(last) ?? null : null;
  };

  const spyPrior = priorCloseOf("SPY");
  const qqqPrior = priorCloseOf("QQQ");
  const benchmarkReturns = {
    spy: spyPrior && spyPrior > 0 ? ((closeAtHour(intraday.get("SPY"), 20) ?? spyPrior) / spyPrior - 1) * 100 : null,
    qqq: qqqPrior && qqqPrior > 0 ? ((closeAtHour(intraday.get("QQQ"), 20) ?? qqqPrior) / qqqPrior - 1) * 100 : null,
  };

  const allInstruments = [...INSTRUMENTS, ...SEMICONDUCTOR_COHORT];
  const seen = new Set<string>();
  const metrics: SessionMetrics[] = [];
  for (const instrument of allInstruments) {
    if (seen.has(instrument.symbol)) continue;
    seen.add(instrument.symbol);
    const series = intraday.get(instrument.symbol);
    const prior = priorCloseOf(instrument.symbol);
    if (!series?.size && prior === null) continue;
    metrics.push(sessionMetrics(instrument, series, {
      close: closeAtHour(series, 20) ?? (priorCloseOf(instrument.symbol) ?? null),
      priorClose: prior,
    }, benchmarkReturns));
  }

  const anomalies = detectAnomalies(metrics);
  const { regime, rationale } = describeRegime(metrics);
  const bySymbol = new Map(metrics.map((entry) => [entry.symbol, entry]));
  const semiconductorMove = classifySemiconductorMove(
    metrics.filter((entry) => SEMICONDUCTOR_COHORT.some((chip) => chip.symbol === entry.symbol)),
    (bySymbol.get("SMH")?.returnPct ?? 0) >= 0 ? 1 : -1,
  );

  // News is read only now, after the price work, and only as candidate causes.
  const since = new Date(Date.now() - BRIEF_NEWS_WINDOW_HOURS * 3_600_000).toISOString();
  const newsRows = await queryAll<{
    id: string; headline: string; summary: string | null; url: string; ticker: string;
    source_name: string; source_tier: number | null; published_at: string;
  }>(env.DB,
    `SELECT id, headline, summary, url, ticker, source_name, source_tier, published_at
       FROM events WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 80`, since);

  const newsItems: NewsItem[] = newsRows.map((row) => ({
    id: row.id,
    headline: row.headline,
    summary: row.summary ?? undefined,
    url: row.url,
    source: row.source_name,
    sourceTier: readerTier(row.source_name, row.source_tier),
    publishedAt: row.published_at,
    tickers: [row.ticker].filter(Boolean),
    topics: [row.headline.split(/\s+/).slice(0, 4).join(" ")],
  }));
  const events = clusterEvents(newsItems).map((event) => ({
    ...event,
    impact: scoreEvent({
      marketImpact: Math.min(5, anomalies[0]?.magnitude ?? 0),
      portfolioRelevance: event.tickers.some((ticker) => PICK_NY_SYMBOLS.includes(ticker)) ? 5 : 1,
      coverageRelevance: event.tickers.length ? 3 : 1,
      ageHours: Math.max(0, (Date.now() - Date.parse(event.firstPublishedAt)) / 3_600_000),
      sourceTier: Math.min(...event.sources.map((source) => source.tier)) as 1 | 2 | 3,
      novelty: 3,
    }),
  })).sort((left, right) => right.impact - left.impact);

  const newsAvailable = newsItems.length > 0;

  // Portfolio attribution reuses the canonical Pick-NY engine.
  const priorCloses = new Map<string, number>();
  const todayCloses = new Map<string, number>();
  for (const ticker of PICK_NY_SYMBOLS) {
    const prior = priorCloseOf(ticker);
    const series = intraday.get(ticker);
    const close = closeAtHour(series, 20) ?? prior;
    if (prior !== null) priorCloses.set(ticker, prior);
    if (close !== null && close !== undefined) todayCloses.set(ticker, close);
  }
  const portfolio = priorCloses.size === PICK_NY_SYMBOLS.length
    ? portfolioDay(priorCloses, todayCloses, {
      previousClose: spyPrior,
      close: closeAtHour(intraday.get("SPY"), 20),
    })
    : null;

  // The canonical valuation is read from the published endpoint; the worker
  // never carries a second valuation engine. What it sees this session is
  // captured so the next session has a real prior to compare against, rather
  // than comparing a snapshot with itself.
  const origin = (env.SIGNAL_LEDGER_ORIGIN ?? "https://signalledgerlab.com").replace(/\/+$/, "");
  const capturedAt = nowIso();
  let valuationComparisons: ReturnType<typeof compareValuationSnapshots> = [];
  let valuationCaptures: ValuationCaptureRow[] = [];
  try {
    const response = await fetch(`${origin}/api/valuation/snapshot?tickers=${PICK_NY_SYMBOLS.join(",")}`, {
      headers: { Accept: "application/json", "User-Agent": env.SEC_USER_AGENT ?? "SignalLedger" },
    });
    if (response.ok) {
      const payload = await response.json() as { snapshots?: Array<Record<string, unknown>> };
      valuationCaptures = await Promise.all(
        (payload.snapshots ?? []).map((snapshot) => buildValuationCapture(sessionDate, snapshot, capturedAt)),
      );
      const priorByTicker = await readPriorValuationSnapshots(env, sessionDate);
      valuationComparisons = compareValuationSnapshots(valuationCaptures.map((capture) => ({
        ticker: capture.ticker,
        priceChangePct: bySymbol.get(capture.ticker)?.returnPct ?? null,
        prior: priorByTicker.get(capture.ticker) ?? null,
        current: {
          ticker: capture.ticker,
          sessionDate: capture.sessionDate,
          fairValue: capture.fairValue,
          modelInputHash: capture.modelInputHash,
          thesisHash: capture.thesisHash,
          snapshot: JSON.parse(capture.snapshotJson) as Record<string, unknown>,
        },
      })));
    }
  } catch {
    // A valuation outage must not block the session brief.
    valuationComparisons = [];
    valuationCaptures = [];
  }

  // Five-session context from what previous briefs actually concluded.
  const priorBriefs = await queryAll<{ session_date: string; regime: string | null; dominant_theme: string | null }>(
    env.DB,
    `SELECT session_date, regime, dominant_theme FROM briefings
      WHERE briefing_type = 'after_close' AND session_date < ? ORDER BY session_date DESC LIMIT 5`,
    sessionDate,
  );

  const mainAnomaly = anomalies[0] ?? null;
  const theme = mainAnomaly
    ? mainAnomaly.headline
    : regime === "MIXED"
      ? "市场缺乏单一主线"
      : `${regime} 主导，指数窄幅波动`;
  const subject = briefSubject(sessionDate, theme);

  const summaryBullets = ["Nasdaq", "S&P 500", "Dow", "Pick-NY"].map((label) => {
    const symbol = label === "Nasdaq" ? "QQQ" : label === "S&P 500" ? "SPY" : label === "Dow" ? "DIA" : null;
    const value = symbol ? bySymbol.get(symbol)?.returnPct ?? null : portfolio?.returnPct ?? null;
    return `${label} ${value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`}`;
  });
  summaryBullets.push(`${regime}：${rationale}`);
  for (const entry of anomalies.slice(0, 3)) summaryBullets.push(entry.detail);
  if (!newsAvailable) summaryBullets.push("新闻源部分不可用，因果判断降级。");

  // A move is only attributed to news that names the instrument, or a peer in
  // its cohort. When nothing qualifies the brief says so instead of dressing an
  // unrelated headline as the cause.
  const attribution = mainAnomaly
    ? attributeCatalyst({
      anomaly: mainAnomaly,
      events,
      metrics,
      sessionDate,
    })
    : null;

  const driver = mainAnomaly && attribution
    ? {
      event: attribution.event.headline,
      evidence: `${attribution.event.sources.length} source(s) ${attribution.symbolMatch ? `naming ${mainAnomaly.symbol}` : `naming a ${mainAnomaly.symbol} cohort peer`}; first published ${attribution.event.firstPublishedAt}.`,
      assets: [mainAnomaly.symbol, "SPY", "QQQ"].join(", "),
      causality: attribution.causality.label,
    }
    : null;

  const draft: BriefDraft = {
    sessionDate,
    subject,
    regime,
    summaryBullets,
    mainMove: mainAnomaly
      ? {
        headline: mainAnomaly.headline,
        analysis: `${mainAnomaly.detail} ${attribution ? `候选催化剂：${attribution.event.headline}` : "未发现可验证的单一催化剂。"} 半导体结构判断：${semiconductorMove}。`,
        causality: driver?.causality ?? "UNCLEAR",
      }
      : null,
    drivers: driver ? [driver] : [],
    movers: metrics
      .filter((entry) => entry.returnPct !== null && Math.abs(entry.returnPct) >= 2)
      .slice(0, 5)
      .map((entry) => ({ symbol: entry.symbol, returnPct: entry.returnPct, note: `${entry.label} 收盘 ${entry.returnPct! >= 0 ? "上涨" : "下跌"} ${Math.abs(entry.returnPct!).toFixed(2)}%${entry.lateMovePct !== null && Math.abs(entry.lateMovePct) >= 0.75 ? `，14:00 后 ${entry.lateMovePct! >= 0 ? "走强" : "走弱"} ${Math.abs(entry.lateMovePct!).toFixed(2)} 点` : ""}` })),
    portfolio,
    valuationMovements: valuationComparisons,
    afterHours: [],
    upcoming: [],
    text: "",
    html: "",
  };

  const gate = qualityGate({ ...draft, ...renderBrief(draft) });
  if (!gate.pass) {
    return { ready: false, status: "failed", note: `Quality gate rejected the brief: ${gate.failures.join("; ")}` };
  }
  const rendered = renderBrief(draft);
  return {
    ready: true,
    subject,
    text: rendered.text,
    html: rendered.html,
    regime,
    theme,
    bodyHash: await sha256Hex(rendered.text),
    // Persisted by the caller after the gate, never here: keeping the builder
    // read-only is what lets TEST MODE run it without writing anything.
    valuationCaptures,
  };
}

/* ------------------------------------------------------------------ */
/* TEST MODE post-close preview                                        */
/* ------------------------------------------------------------------ */

/**
 * TEST MODE ONLY — reachable only when TESTMODE_POSTCLOSE is set, which never
 * happens in production.
 *
 * Runs the real reasoner (`buildPostCloseBrief`) and reads market data with the
 * worker's own credentials, then returns a model for the ten-section preview.
 * It writes nothing at all: no briefings row, no briefing_outbox row, and no
 * call to Resend. All reads below are SELECTs.
 */
async function buildPostCloseTestModel(env: Env, sessionDate: string): Promise<Record<string, unknown>> {
  if (!env.ALPACA_API_KEY_ID?.trim() || !env.ALPACA_API_SECRET_KEY?.trim()) {
    return { ok: false, note: "Alpaca credentials are absent from this environment." };
  }
  if (!isTradingDay(sessionDate)) {
    return { ok: false, note: `${sessionDate} is not a US trading session.` };
  }

  // The production reasoner, run exactly as production would run it.
  const pipeline = await buildPostCloseBrief(env, sessionDate);

  const universe = [...new Set([...INSTRUMENTS, ...SEMICONDUCTOR_COHORT].map((entry) => entry.symbol))];

  // Diagnostic: the provider's own message says far more than the status code,
  // and the symbol mix is the usual cause of a 400 here.
  const probeBars = async (label: string, symbols: string[]) => {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", shiftDate(sessionDate, -12));
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", env.ALPACA_DATA_FEED?.trim() || "iex");
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID!,
        "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY!,
        accept: "application/json",
      },
    });
    return { label, status: response.status, body: (await response.text()).slice(0, 300) };
  };

  // P0-1 regression evidence. The equity endpoint rejects a crypto pair and
  // fails the whole request when one is batched in; the loader below splits the
  // two asset classes, so the full universe must now load regardless.
  const probes = [
    await probeBars("equity-endpoint-with-crypto", universe),
    await probeBars("equity-endpoint-equities-only", universe.filter((symbol) => !symbol.includes("-"))),
  ];

  let daily: Awaited<ReturnType<typeof fetchDailyAdjustedBars>> = new Map();
  let intraday: Awaited<ReturnType<typeof fetchIntradayBars>> = new Map();
  let marketDataNote: string | null = null;
  try {
    daily = await fetchDailyAdjustedBars(universe, { start: shiftDate(sessionDate, -12) });
    intraday = await fetchIntradayBars(universe, { start: sessionDate });
  } catch (error) {
    // A session the venue has no data for yet (a synthetic or future date) must
    // still be able to exercise the valuation comparison.
    marketDataNote = `Market data could not be read for this session (${error instanceof Error ? error.message.split("|")[0] : "unknown"}); price sections are empty.`;
  }
  const universeNote = marketDataNote ?? (intraday.has("BTC-USD") && (intraday.get("BTC-USD")?.size ?? 0) > 0
    ? "The full shared universe loaded, crypto included, through the separated sources."
    : "The full shared universe loaded, but the crypto series came back empty.");

  // Checkpoint semantics decide every close/14:00/15:00 reading. Alpaca stamps
  // a bar with the START of its period, so volume is what distinguishes the
  // regular-session bars from the thin extended-hours ones.
  const spyHourlyBars = await (async () => {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", "SPY");
    url.searchParams.set("timeframe", "1Hour");
    url.searchParams.set("start", sessionDate);
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", env.ALPACA_DATA_FEED?.trim() || "iex");
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": env.ALPACA_API_KEY_ID!,
        "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET_KEY!,
        accept: "application/json",
      },
    });
    const payload = await response.json() as { bars?: Record<string, Array<{ t?: string; c?: number; v?: number }>> };
    return (payload.bars?.SPY ?? []).map((bar) => ({ t: bar.t, c: bar.c, v: bar.v }));
  })();

  const priorCloseOf = (symbol: string): number | null => {
    const series = daily.get(symbol);
    if (!series) return null;
    const dates = [...series.keys()].filter((date) => date < sessionDate).sort();
    const last = dates.at(-1);
    return last ? series.get(last) ?? null : null;
  };

  const pctChange = (from: number | null, to: number | null) =>
    from !== null && to !== null && from > 0 ? (to / from - 1) * 100 : null;

  const spyPrior = priorCloseOf("SPY");
  const qqqPrior = priorCloseOf("QQQ");
  const spyClose = closeAtHour(intraday.get("SPY"), CHECKPOINT_UTC_HOUR.close);
  const qqqClose = closeAtHour(intraday.get("QQQ"), CHECKPOINT_UTC_HOUR.close);
  const benchmarkReturns = {
    spy: pctChange(spyPrior, spyClose),
    qqq: pctChange(qqqPrior, qqqClose),
  };

  const allInstruments = [...INSTRUMENTS, ...SEMICONDUCTOR_COHORT];
  const seenSymbols = new Set<string>();
  const metrics: SessionMetrics[] = [];
  for (const instrument of allInstruments) {
    if (seenSymbols.has(instrument.symbol)) continue;
    seenSymbols.add(instrument.symbol);
    const series = intraday.get(instrument.symbol);
    const prior = priorCloseOf(instrument.symbol);
    if (!series?.size && prior === null) continue;
    // The shared reader, so the preview and production cannot disagree on a
    // checkpoint reading.
    metrics.push(sessionMetrics(instrument, series, {
      close: closeAtHour(series, CHECKPOINT_UTC_HOUR.close) ?? prior,
      priorClose: prior,
    }, benchmarkReturns));
  }

  const anomalies = detectAnomalies(metrics);
  const { regime, rationale } = describeRegime(metrics);
  const bySymbol = new Map(metrics.map((entry) => [entry.symbol, entry]));
  const semiconductorMove = classifySemiconductorMove(
    metrics.filter((entry) => SEMICONDUCTOR_COHORT.some((chip) => chip.symbol === entry.symbol)),
    (bySymbol.get("SMH")?.returnPct ?? 0) >= 0 ? 1 : -1,
  );

  // News is read only now, after the price work, and only as candidate causes.
  const newsRows = await queryAll<{
    id: string; headline: string; summary: string | null; url: string; ticker: string;
    source_name: string; source_tier: number | null; published_at: string;
  }>(env.DB,
    `SELECT id, headline, summary, url, ticker, source_name, source_tier, published_at
       FROM events WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 80`,
    new Date(Date.now() - BRIEF_NEWS_WINDOW_HOURS * 3_600_000).toISOString());

  const newsItems: NewsItem[] = newsRows.map((row) => ({
    id: row.id,
    headline: row.headline,
    summary: row.summary ?? undefined,
    url: row.url,
    source: row.source_name,
    sourceTier: readerTier(row.source_name, row.source_tier),
    publishedAt: row.published_at,
    tickers: [row.ticker].filter(Boolean),
    topics: [row.headline.split(/\s+/).slice(0, 4).join(" ")],
  }));
  const events = clusterEvents(newsItems).map((event) => ({
    ...event,
    impact: scoreEvent({
      marketImpact: Math.min(5, anomalies[0]?.magnitude ?? 0),
      portfolioRelevance: event.tickers.some((ticker) => PICK_NY_SYMBOLS.includes(ticker)) ? 5 : 1,
      coverageRelevance: event.tickers.length ? 3 : 1,
      ageHours: Math.max(0, (Date.now() - Date.parse(event.firstPublishedAt)) / 3_600_000),
      sourceTier: Math.min(...event.sources.map((source) => source.tier)) as 1 | 2 | 3,
      novelty: 3,
    }),
  })).sort((left, right) => right.impact - left.impact);

  // Portfolio attribution, from the canonical Pick-NY engine.
  const priorCloses = new Map<string, number>();
  const todayCloses = new Map<string, number>();
  for (const ticker of PICK_NY_SYMBOLS) {
    const prior = priorCloseOf(ticker);
    const series = intraday.get(ticker);
    const close = closeAtHour(series, CHECKPOINT_UTC_HOUR.close) ?? prior;
    if (prior !== null) priorCloses.set(ticker, prior);
    if (close !== null && close !== undefined) todayCloses.set(ticker, close);
  }
  const portfolio = priorCloses.size === PICK_NY_SYMBOLS.length
    ? portfolioDay(priorCloses, todayCloses, {
      previousClose: spyPrior,
      close: spyClose,
    })
    : null;

  // Canonical valuation, from the published endpoint. The comparison reads the
  // same history the production path writes, but this run only reads it: the
  // captures are returned so the caller can see what would have been appended.
  const origin = (env.SIGNAL_LEDGER_ORIGIN ?? "https://signalledgerlab.com").replace(/\/+$/, "");
  let valuationComparisons: ReturnType<typeof compareValuationSnapshots> = [];
  let valuationCaptures: ValuationCaptureRow[] = [];
  let valuationRefreshedToday = 0;
  let valuationReachable = false;
  let historyRowsAvailable = 0;
  try {
    const response = await fetch(`${origin}/api/valuation/snapshot?tickers=${PICK_NY_SYMBOLS.join(",")}`, {
      headers: { Accept: "application/json", "User-Agent": env.SEC_USER_AGENT ?? "SignalLedger" },
    });
    if (response.ok) {
      valuationReachable = true;
      const payload = await response.json() as { snapshots?: Array<Record<string, unknown>> };
      const snapshots = payload.snapshots ?? [];
      valuationRefreshedToday = snapshots.filter((snapshot) => String(snapshot.valuationUpdatedAt ?? "").slice(0, 10) === sessionDate).length;
      valuationCaptures = await Promise.all(snapshots.map((snapshot) => buildValuationCapture(sessionDate, snapshot, nowIso())));
      const priorByTicker = await readPriorValuationSnapshots(env, sessionDate);
      historyRowsAvailable = priorByTicker.size;
      valuationComparisons = compareValuationSnapshots(valuationCaptures.map((capture) => ({
        ticker: capture.ticker,
        priceChangePct: bySymbol.get(capture.ticker)?.returnPct ?? null,
        prior: priorByTicker.get(capture.ticker) ?? null,
        current: {
          ticker: capture.ticker,
          sessionDate: capture.sessionDate,
          fairValue: capture.fairValue,
          modelInputHash: capture.modelInputHash,
          thesisHash: capture.thesisHash,
          snapshot: JSON.parse(capture.snapshotJson) as Record<string, unknown>,
        },
      })));
    }
  } catch {
    valuationComparisons = [];
    valuationCaptures = [];
  }

  // Extended-hours reads. A bar stamped 20:00Z is 16:00 ET, the first
  // after-hours bar, so the regular close is the last bar before it.
  const afterHours: Array<{ symbol: string; pct: number; last: number; stamp: string }> = [];
  let sawExtendedHours = false;
  const afterHoursSeen = new Set<string>();
  for (const instrument of allInstruments) {
    if (afterHoursSeen.has(instrument.symbol)) continue;
    afterHoursSeen.add(instrument.symbol);
    const series = intraday.get(instrument.symbol);
    if (!series?.size) continue;
    const stamps = [...series.keys()].sort();
    if (stamps.some((stamp) => Number(stamp.slice(11, 13)) >= 20)) sawExtendedHours = true;
    const regular = stamps.filter((stamp) => Number(stamp.slice(11, 13)) < 20).at(-1);
    const post = stamps.filter((stamp) => Number(stamp.slice(11, 13)) >= 20);
    if (!regular || !post.length) continue;
    const regularClosePrice = series.get(regular);
    const last = series.get(post.at(-1)!);
    if (!regularClosePrice || !last || regularClosePrice <= 0) continue;
    const movePct = (last / regularClosePrice - 1) * 100;
    if (Math.abs(movePct) >= 0.1) {
      afterHours.push({ symbol: instrument.symbol, pct: movePct, last, stamp: post.at(-1)! });
    }
  }
  afterHours.sort((left, right) => Math.abs(right.pct) - Math.abs(left.pct));

  // Upcoming earnings, read-only from the existing calendar table.
  const forecastRows = await queryAll<{
    ticker: string; fiscal_period: string; expected_window_start: string;
    expected_window_end: string; window_confidence: string | null;
  }>(env.DB,
    `SELECT ticker, fiscal_period, expected_window_start, expected_window_end, window_confidence
       FROM earnings_forecasts
      WHERE status IN ('open', 'awaiting_actual')
        AND expected_window_start <= ? AND expected_window_end >= ?
      ORDER BY expected_window_start LIMIT 20`,
    new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
    nowIso());

  const ranked = metrics.filter((entry) => entry.returnPct !== null).sort((left, right) => right.returnPct! - left.returnPct!);
  const cohort = metrics.filter((entry) => SEMICONDUCTOR_COHORT.some((chip) => chip.symbol === entry.symbol) && entry.returnPct !== null);
  const breadth = cohort.length
    ? {
      up: cohort.filter((entry) => entry.returnPct! > 0).length,
      total: cohort.length,
      pct: (cohort.filter((entry) => entry.returnPct! > 0).length / cohort.length) * 100,
    }
    : null;

  const groupReturns = new Map<string, number[]>();
  for (const entry of metrics) {
    if (entry.returnPct === null) continue;
    groupReturns.set(entry.group, [...(groupReturns.get(entry.group) ?? []), entry.returnPct]);
  }
  const sectorLeadership = [...groupReturns.entries()]
    .map(([group, values]) => ({ group, avgReturnPct: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length }))
    .sort((left, right) => right.avgReturnPct - left.avgReturnPct);

  const WATCHLIST = ["SOXL", "AMD", "ORCL", "MSTR", "TSLA", "ASTS", "SMH", "SOXX"];
  const mainAnomaly = anomalies[0] ?? null;
  // The same attribution production uses, so the preview cannot disagree with
  // it. Null means no cluster named the moved instrument or a cohort peer.
  const attribution = mainAnomaly
    ? attributeCatalyst({
      anomaly: mainAnomaly,
      events,
      metrics,
      sessionDate,
    })
    : null;

  let nextSession = shiftDate(sessionDate, 1);
  while (!isTradingDay(nextSession)) nextSession = shiftDate(nextSession, 1);

  return {
    ok: true,
    sessionDate,
    pipeline,
    probes,
    universeNote,
    spyBarStamps: [...(intraday.get("SPY")?.keys() ?? [])].sort(),
    spyHourlyBars,
    spyDailyCloses: [...(daily.get("SPY")?.entries() ?? [])].slice(-4).map(([date, close]) => ({ date, close })),
    spyPriorClose: spyPrior,
    // The two readings, side by side, so the drift is measurable rather than
    // asserted. The adjusted daily close is the arbiter.
    productionReading: {
      note: "Shared closeAtHour(series, 20) selects the 20:00Z bar, which is 16:00-17:00 ET.",
      spyClose: closeAtHour(intraday.get("SPY"), 20),
      spyReturnPct: pctChange(spyPrior, closeAtHour(intraday.get("SPY"), 20)),
      qqqReturnPct: pctChange(qqqPrior, closeAtHour(intraday.get("QQQ"), 20)),
    },
    correctedReading: {
      note: "Start-stamped reading selects the 19:00Z bar (15:00-16:00 ET), which matches the adjusted daily close.",
      spyClose,
      spyReturnPct: benchmarkReturns.spy,
      qqqReturnPct: benchmarkReturns.qqq,
    },
    newsItemCount: newsItems.length,
    indexReturns: Object.fromEntries(["SPY", "QQQ", "DIA", "IWM"].map((symbol) => [symbol, bySymbol.get(symbol)?.returnPct ?? null])),
    regime,
    rationale,
    semiconductorMove,
    anomalies: anomalies.slice(0, 5).map((entry) => ({ kind: entry.kind, symbol: entry.symbol, headline: entry.headline, detail: entry.detail, magnitude: entry.magnitude })),
    mainMove: mainAnomaly ? { headline: mainAnomaly.headline, detail: mainAnomaly.detail } : null,
    causality: attribution ? { label: attribution.causality.label, score: attribution.causality.score, components: attribution.causality.components, gapMinutes: attribution.gapMinutes } : null,
    catalyst: attribution ? { headline: attribution.event.headline, tickers: attribution.event.tickers, sources: attribution.event.sources.length, firstPublishedAt: attribution.event.firstPublishedAt, symbolMatch: attribution.symbolMatch, sectorMatch: attribution.sectorMatch } : null,
    leaders: ranked.slice(0, 5).map((entry) => ({ symbol: entry.symbol, label: entry.label, returnPct: entry.returnPct })),
    laggards: ranked.slice(-5).reverse().map((entry) => ({ symbol: entry.symbol, label: entry.label, returnPct: entry.returnPct })),
    breadth,
    sectorLeadership,
    movers: WATCHLIST.map((symbol) => bySymbol.get(symbol)).filter(Boolean).map((entry) => ({
      symbol: entry!.symbol, label: entry!.label, returnPct: entry!.returnPct,
      lateMovePct: entry!.lateMovePct, finalHourMovePct: entry!.finalHourMovePct,
    })),
    portfolio,
    valuationMovements: valuationComparisons,
    valuationReachable,
    valuationRefreshedToday,
    historyRowsAvailable,
    // The full capture objects, so a baseline can be seeded from exactly what
    // this run observed rather than re-typed by hand. TEST MODE still writes
    // nothing; it only reports what production would have appended.
    valuationCaptures: valuationCaptures.map((capture) => ({ ...capture })),
    afterHours: {
      available: sawExtendedHours,
      items: afterHours.slice(0, 6),
    },
    upcomingEarnings: forecastRows.map((row) => ({
      ticker: row.ticker,
      fiscalPeriod: row.fiscal_period,
      window: `${String(row.expected_window_start).slice(0, 10)} → ${String(row.expected_window_end).slice(0, 10)}`,
      confidence: row.window_confidence,
    })),
    nextSession,
  };
}

/* ------------------------------------------------------------------ */
/* TEST MODE manual send (one-time, gated, never on a schedule)        */
/* ------------------------------------------------------------------ */

/**
 * TEST MODE ONLY. Sends one post-close brief immediately using the shipped
 * ten-section email, and records it in the outbox under the caller's key.
 *
 * It refuses unless the key has never been used, so re-issuing the same key is
 * a no-op rather than a second email, and it never schedules anything: the cron
 * path is untouched and this is unreachable without TESTMODE_POSTCLOSE.
 */
async function sendManualPostCloseBrief(env: Env, sessionDate: string, sendKey: string): Promise<Record<string, unknown>> {
  const existing = await queryFirst<{
    id: string; status: string; provider_message_id: string | null; sent_at: string | null; created_at: string;
  }>(env.DB,
    "SELECT id, status, provider_message_id, sent_at, created_at FROM briefing_outbox WHERE id = ? LIMIT 1",
    sendKey);
  if (existing) {
    // The key has been used. Nothing is sent again, whatever the caller wanted.
    return { sent: false, alreadySent: true, duplicateOf: existing };
  }

  const model = await buildPostCloseTestModel(env, sessionDate);
  if (model.ok !== true) {
    return { sent: false, error: `The brief could not be produced: ${String(model.note ?? "unknown")}` };
  }

  const brief = toPostCloseEmailBrief(model);
  const rendered = renderPostCloseEmail(brief);
  const gate = gatePostCloseEmail(brief, rendered);
  if (!gate.pass) {
    // The same gate a scheduled send must clear. Nothing is written or sent.
    return { sent: false, error: `Quality gate rejected the brief: ${gate.failures.join("; ")}`, gate };
  }

  const recipient = alertRecipient(env);
  const at = nowIso();
  const briefingId = await sha256Hex(`manual-postclose|${sessionDate}|${sendKey}`);
  const bodyHash = await sha256Hex(rendered.text);

  // briefing_outbox.briefing_id is NOT NULL with a foreign key, so the send
  // needs a parent row. The briefings ledger is append-only: this is one new
  // insert under its own key, never a rewrite of an existing session row.
  await execute(env.DB,
    `INSERT OR IGNORE INTO briefings
       (id, briefing_key, briefing_type, session_date, title, summary,
        information_cutoff_at, generated_at, status, event_count, p0_count,
        p1_count, items_json, created_at, regime, dominant_theme, body_hash,
        engine_version, send_id)
     VALUES (?, ?, 'after_close', ?, ?, ?, ?, ?, 'generated', 0, 0, 0, '[]', ?, ?, ?, ?, ?, ?)`,
    briefingId,
    sendKey,
    sessionDate,
    `${sessionDate} 美股收盘后简报（手动补发）`,
    `手动补发：${brief.subject}`,
    at,
    at,
    at,
    "MANUAL SEND",
    "manual-postclose",
    bodyHash,
    DAILY_BRIEF_ENGINE,
    sendKey);

  await execute(env.DB,
    `INSERT OR IGNORE INTO briefing_outbox
       (id, briefing_id, channel, recipient, subject, text_body, html_body,
        scheduled_for, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    sendKey,
    briefingId,
    recipient,
    brief.subject,
    rendered.text,
    rendered.html,
    at,
    at,
    at,
    at);

  // Sent once, here, rather than left for a cron tick: this is an explicit
  // one-time send and must not become a recurring one.
  const result = await sendOutboxItem(env, {
    id: sendKey,
    recipient,
    subject: brief.subject,
    text_body: rendered.text,
    html_body: rendered.html,
    status: "queued",
    attempts: 0,
  });

  const sentAt = nowIso();
  await execute(env.DB,
    `UPDATE briefing_outbox
        SET status = ?, attempts = attempts + 1, provider_message_id = ?,
            last_error = ?, sent_at = ?, updated_at = ?
      WHERE id = ?`,
    result.sent ? "sent" : "failed",
    result.providerId ?? null,
    result.sent ? null : (result.error ?? "unknown"),
    result.sent ? sentAt : null,
    sentAt,
    sendKey);

  const outbox = await queryFirst<Record<string, unknown>>(env.DB,
    `SELECT id, status, recipient, subject, provider_message_id, sent_at, created_at, attempts
       FROM briefing_outbox WHERE id = ?`,
    sendKey);

  return {
    sent: result.sent,
    error: result.error ?? null,
    sessionDate,
    sendKey,
    briefingId,
    bodyHash,
    qualityGate: { pass: gate.pass, failures: gate.failures },
    outbox,
  };
}

/**
 * PRO Daily Brief subscriber fan-out.
 *
 * After a canonical post-close brief is complete, copy that ONE brief to every
 * eligible PRO subscriber. This is the delivery half of the Daily Brief: it
 * never generates content, it only fans the caller's rendered brief out through
 * the general service email queue, and it dedupes per (session, recipient) so a
 * retry can never double-send. Eligibility is the single source of truth in
 * lib/daily-brief-fanout (verified + opt-in + PRO with a future access_until).
 */
async function fanoutDailyBrief(
  env: Env,
  canonical: { sessionDate: string; subject: string; text: string; html: string },
): Promise<Record<string, unknown>> {
  const origin = authLinkOrigin(env.SITE_ORIGIN, env.SIGNAL_LEDGER_ORIGIN);
  if (!origin) {
    return {
      ok: false,
      error: "SITE_ORIGIN is not configured, so the /daily-brief link cannot be built.",
    };
  }
  const viewUrl = `${origin}/daily-brief`;
  const outcome = await deliverCanonicalDailyBrief(env.DB, {
    canonical,
    nowIso: nowIso(),
    nowMs: Date.now(),
    viewUrl,
    fromAddress: env.EMAIL_FROM_BRIEF?.trim() || null,
  });
  if (!outcome.ok) {
    return { ok: false, error: "rejected", problems: outcome.problems };
  }
  return {
    ok: true,
    sessionDate: canonical.sessionDate,
    eligibleRecipients: outcome.eligibleRecipients,
    queued: outcome.queued.length,
    skipped: outcome.alreadyQueued.length,
    alreadyQueued: outcome.alreadyQueued,
    failed: outcome.failed,
    canonicalBriefReady: outcome.canonicalBriefReady,
    viewUrl,
  };
}

/**
 * The scheduled subscriber fan-out. It runs every tick, reads the canonical
 * artifact for today's New York session, and fans it out to eligible PRO
 * subscribers. The fan-out is idempotent per (sessionDate, recipient), so on a
 * healthy day this is a near-no-op that re-confirms an already-complete fan-out;
 * on the day a fan-out failed partway, it reconstructs delivery from the
 * persisted artifact without re-running research. It never generates content.
 */
async function deliverScheduledDailyBrief(env: Env): Promise<SourceResult> {
  const sessionDate = newYorkDate(nowIso());
  const artifact = await readDailyBriefArtifact(env.DB, sessionDate);
  if (!artifact) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note: `No canonical daily brief artifact for ${sessionDate}; nothing to fan out.`,
    };
  }

  const origin = authLinkOrigin(env.SITE_ORIGIN, env.SIGNAL_LEDGER_ORIGIN);
  if (!origin) {
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: 0,
      itemsNew: 0,
      note: "SITE_ORIGIN is not configured, so the /daily-brief link cannot be built.",
    };
  }

  const outcome = await deliverCanonicalDailyBrief(env.DB, {
    canonical: {
      sessionDate,
      subject: artifact.subject,
      text: artifact.text,
      html: artifact.html,
    },
    nowIso: nowIso(),
    nowMs: Date.now(),
    viewUrl: `${origin}/daily-brief`,
    fromAddress: env.EMAIL_FROM_BRIEF?.trim() || null,
  });

  if (!outcome.ok) {
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: 0,
      itemsNew: 0,
      note: `Canonical brief for ${sessionDate} failed validation: ${outcome.problems.join("; ")}`,
    };
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: outcome.eligibleRecipients,
    itemsNew: outcome.queued.length,
    canonicalBriefReady: outcome.canonicalBriefReady,
    note:
      `Daily brief fan-out ${sessionDate}: ${outcome.eligibleRecipients} eligible, ` +
      `${outcome.queued.length} queued, ${outcome.alreadyQueued.length} already queued, ${outcome.failed.length} failed.`,
  };
}

async function generateScheduledBriefing(
  env: Env,
  dryRun: boolean,
): Promise<SourceResult> {
  const generatedAt = nowIso();
  const briefingType = dueBriefingType(generatedAt);
  if (!briefingType) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      note:
        "No weekday America/New_York briefing window is due (07:45 pre-market; 17:15 after-close).",
    };
  }
  const sessionDate = newYorkDate(generatedAt);
  const briefingKey =
    briefingType === "after_close"
      ? briefSendId(sessionDate)
      : `${briefingType}:${sessionDate}`;
  const existing = await queryFirst<{ id: string }>(
    env.DB,
    "SELECT id FROM briefings WHERE briefing_key = ? LIMIT 1",
    briefingKey,
  );
  if (existing) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: 0,
      itemsNew: 0,
      cursor: briefingKey,
      note: "This briefing window was already generated.",
    };
  }

  // The briefings ledger is append-only, so a failed post-close run must not
  // leave a row behind: build the brief first and return without writing when
  // it cannot be produced. The next tick then retries on its own.
  let postClose: PostCloseOutcome | null = null;
  if (briefingType === "after_close") {
    const brief = await buildPostCloseBrief(env, sessionDate);
    if (!brief.ready) {
      return {
        status: "needs_setup",
        sourceStatus: "needs_setup",
        itemsSeen: 0,
        itemsNew: 0,
        cursor: briefingKey,
        note: brief.note,
      };
    }
    postClose = brief;

    // Step G: the brief passed the quality gate, so this session's canonical
    // view is appended for the next session to compare against. INSERT OR
    // IGNORE against UNIQUE(ticker, session_date) makes a retry of the same
    // session idempotent, and the table is append-only by trigger.
    if (brief.valuationCaptures.length) {
      try {
        await persistValuationCaptures(env, brief.valuationCaptures);
      } catch (error) {
        // Losing the history row must not cost the session its brief; the next
        // session simply reports no comparable prior.
        console.error(`valuation history append failed: ${error instanceof Error ? error.message : "unknown"}`);
      }
    }
  }

  const recentEvents = await queryAll<Record<string, unknown>>(
    env.DB,
    `SELECT id, ticker, event_type, headline, summary, priority, direction, source_name,
            published_at, detected_at, url
     FROM events
     WHERE detected_at >= ?
       AND priority IN ('P0', 'P1')
       AND NOT (
         source_key = 'sec-edgar'
         AND event_type IN ('sec_8_k', 'sec_6_k', 'sec_10_q', 'sec_10_k')
         AND priority = 'P1'
       )
     ORDER BY priority, detected_at DESC
     LIMIT 100`,
    new Date(
      new Date(generatedAt).getTime() -
        (briefingType === "morning" ? 18 : 24) * 60 * 60 * 1_000,
    ).toISOString(),
  );
  const events =
    briefingType === "after_close"
      ? recentEvents.filter(
          (event) =>
            newYorkDate(String(event.detected_at)) === sessionDate,
        )
      : recentEvents;
  const upcomingForecasts = await queryAll<Record<string, unknown>>(
    env.DB,
    `SELECT id, ticker, fiscal_period, expected_window_start,
            expected_window_end, window_confidence, revenue_estimate,
            eps_estimate, source_quality
     FROM earnings_forecasts
     WHERE status IN ('open', 'awaiting_actual')
       AND expected_window_start <= ?
       AND expected_window_end >= ?
     ORDER BY expected_window_start
     LIMIT 20`,
    new Date(
      new Date(generatedAt).getTime() + 30 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    generatedAt,
  );
  const eventItems = events.map((event) => ({
    kind: "event",
    id: event.id,
    ticker: event.ticker,
    eventType: event.event_type,
    priority: event.priority,
    direction: event.direction,
    title: event.headline,
    summary: event.summary,
    source: event.source_name,
    publishedAt: event.published_at,
    detectedAt: event.detected_at,
    url: event.url,
  }));
  const forecastItems = upcomingForecasts.map((forecast) => ({
    kind: "earningsForecast",
    id: forecast.id,
    ticker: forecast.ticker,
    priority: "WATCH",
    title: `${forecast.ticker} ${forecast.fiscal_period} 财报时间观察`,
    summary: `预计披露窗口 ${String(forecast.expected_window_start).slice(
      0,
      10,
    )} 至 ${String(forecast.expected_window_end).slice(0, 10)}。`,
    source: "SEC Company Facts",
    url: null,
  }));
  const items = [...eventItems, ...forecastItems];
  const p0Count = events.filter((event) => event.priority === "P0").length;
  const p1Count = events.filter((event) => event.priority === "P1").length;
  const label = briefingType === "morning" ? "盘前简报" : "收盘后简报";
  const title = `${sessionDate} 美股${label}`;
  const summary = `${events.length} 条新的紧急或重要事件（紧急 ${p0Count} 条、重要 ${p1Count} 条），未来 30 天有 ${upcomingForecasts.length} 个待跟踪财报窗口。`;
  const briefingId = await sha256Hex(`briefing|${briefingKey}`);
  const insert = await execute(
    env.DB,
    `INSERT OR IGNORE INTO briefings
       (id, briefing_key, briefing_type, session_date, title, summary,
        information_cutoff_at, generated_at, status, event_count, p0_count,
        p1_count, items_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?, ?, ?, ?, ?)`,
    briefingId,
    briefingKey,
    briefingType,
    sessionDate,
    title,
    summary,
    generatedAt,
    generatedAt,
    events.length,
    p0Count,
    p1Count,
    safeJson(items),
    generatedAt,
  );
  if (changes(insert) === 0) {
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: events.length,
      itemsNew: 0,
      cursor: briefingKey,
      note: "This briefing window was concurrently generated.",
    };
  }

  const recipient = alertRecipient(env);

  // The post-close email is the session intelligence brief, not the event
  // ledger. It runs the price-first pipeline and refuses to send when the
  // market data it depends on is unavailable, rather than falling back to a
  // news summary.
  let content: { subject: string; text: string; html: string };
  if (postClose) {
    content = { subject: postClose.subject, text: postClose.text, html: postClose.html };
    await execute(
      env.DB,
      `UPDATE briefings SET regime = ?, dominant_theme = ?, body_hash = ?,
        engine_version = ?, send_id = ? WHERE id = ?`,
      postClose.regime,
      postClose.theme,
      postClose.bodyHash,
      DAILY_BRIEF_ENGINE,
      briefSendId(sessionDate),
      briefingId,
    );
  } else {
    content = buildBriefingContent(
      briefingType,
      sessionDate,
      title,
      summary,
      items,
    );
  }

  // Persist the canonical post-close brief as the durable recovery source the
  // subscriber fan-out reads. This runs only for the real post-close render —
  // the morning/event path has no canonical subscriber brief — and only after
  // generation and the briefings ledger row both succeeded. A validation miss
  // here must not cost the owner their briefing email, so it is logged and the
  // run continues; the fan-out source then finds no artifact and sends nothing.
  let canonicalReady = false;
  if (postClose) {
    const finalized = await finalizeCanonicalDailyBrief(env.DB, {
      sessionDate,
      subject: content.subject,
      text: content.text,
      html: content.html,
      nowIso: generatedAt,
    });
    canonicalReady = finalized.ok;
    if (!finalized.ok) {
      console.error(
        `canonical brief artifact rejected: ${finalized.problems.join("; ")}`,
      );
    }
  }

  const emailStatus = dryRun
    ? "dry_run"
    : emailReady(env)
      ? "queued"
      : "needs_setup";
  const outboxId = await sha256Hex(
    `briefing-email|${briefingId}|${recipient}`,
  );
  await execute(
    env.DB,
    `INSERT OR IGNORE INTO briefing_outbox
       (id, briefing_id, channel, recipient, subject, text_body, html_body,
        scheduled_for, status, attempts, next_attempt_at, created_at,
        updated_at)
     VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    outboxId,
    briefingId,
    recipient,
    content.subject,
    content.text,
    content.html,
    generatedAt,
    emailStatus,
    emailStatus === "queued" ? generatedAt : null,
    generatedAt,
    generatedAt,
  );
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: events.length,
    itemsNew: 1,
    cursor: briefingKey,
    alertsQueued: emailStatus === "queued" ? 1 : 0,
    canonicalBriefReady: canonicalReady,
    note: `${label} generated; email status=${emailStatus}; canonical brief ${canonicalReady ? "persisted" : "rejected/absent"}.`,
  };
}

async function sendOutboxItem(
  env: Env,
  item: EmailOutboxItem,
): Promise<{ sent: boolean; providerId?: string; error?: string; retry: boolean }> {
  const recipients = item.recipient
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  // Provider-side idempotency is keyed by the job *and* its exact payload. The
  // job id alone is deliberately stable across regenerations, so reusing it
  // bare would make the provider reject the second, legitimately different
  // send — Resend answers a reused key whose body moved with 409
  // invalid_idempotent_request. Same job and same bytes still produce the same
  // key, so ordinary retries dedupe exactly as before.
  const idempotencyKey = await emailJobIdempotencyKey({
    id: item.id,
    recipient: item.recipient,
    subject: item.subject,
    textBody: item.text_body,
    htmlBody: item.html_body,
    fromAddress: item.from_address ?? null,
    bodyMode: item.body_mode ?? null,
  });
  const provider = emailDeliveryProvider(env);
  const gmailWebhookUrl =
    env.GMAIL_WEBHOOK_SECRET_URL?.trim() || env.GMAIL_WEBHOOK_URL?.trim();
  const gmailWebhookSecret = env.GMAIL_WEBHOOK_SECRET?.trim();
  if (provider === "gmail" && gmailWebhookUrl && gmailWebhookSecret) {
    const response = await fetchWithTimeout(
      gmailWebhookUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          secret: gmailWebhookSecret,
          idempotencyKey,
          to: recipients.join(","),
          subject: item.subject,
          text: item.text_body,
          html: item.html_body,
        }),
      },
      20_000,
    );
    const body = truncate(await response.text(), 2_000);
    let result: {
      ok?: boolean;
      status?: string;
      error?: string;
      providerMessageId?: string;
    } = {};
    try {
      result = JSON.parse(body) as typeof result;
    } catch {
      result = {};
    }
    if (response.ok && result.ok) {
      return {
        sent: true,
        providerId:
          result.providerMessageId || `gmail-apps-script:${item.id}`,
        retry: false,
      };
    }
    const error =
      result.error || `Gmail Apps Script ${response.status}: ${body}`;
    return {
      sent: false,
      error,
      retry:
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    };
  }

  if (provider !== "resend") {
    return {
      sent: false,
      error: "No configured email delivery provider is ready.",
      retry: false,
    };
  }

  const resendFromAddress = (item.from_address?.trim() || env.ALERT_FROM_EMAIL || "").trim();
  const resendFrom = resendFromAddress.includes("<")
    ? resendFromAddress
    : `Signal Ledger <${resendFromAddress}>`;

  const response = await fetchWithTimeout(
    RESEND_EMAIL_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from: resendFrom,
        to: recipients,
        subject: item.subject,
        text: item.text_body,
        html: item.html_body,
      }),
    },
    12_000,
  );
  const body = truncate(await response.text(), 2_000);
  if (response.ok) {
    let providerId: string | undefined;
    try {
      providerId = (JSON.parse(body) as { id?: string }).id;
    } catch {
      providerId = undefined;
    }
    return { sent: true, providerId, retry: false };
  }
  return {
    sent: false,
    error: `Resend ${response.status}: ${body}`,
    retry: response.status === 429 || response.status >= 500,
  };
}

async function flushEmailOutbox(
  env: Env,
  dryRun: boolean,
): Promise<SourceResult> {
  if (dryRun) {
    const row = await queryFirst<{ count: number }>(
      env.DB,
      "SELECT COUNT(*) AS count FROM alert_outbox WHERE status = 'dry_run'",
    );
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: Number(row?.count ?? 0),
      itemsNew: 0,
      alertsSent: 0,
      note: "DRY_RUN is enabled; no email was sent.",
    };
  }

  if (!emailReady(env)) {
    await execute(
      env.DB,
      `UPDATE alert_outbox SET
         status = 'needs_setup',
         next_attempt_at = NULL,
         last_error = 'Configure Gmail webhook or a verified Resend sender.',
         updated_at = ?
       WHERE status IN ('queued', 'sending')`,
      nowIso(),
    );
    const row = await queryFirst<{ count: number }>(
      env.DB,
      "SELECT COUNT(*) AS count FROM alert_outbox WHERE status = 'needs_setup'",
    );
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: Number(row?.count ?? 0),
      itemsNew: 0,
      alertsSent: 0,
      note:
        "Email remains in needs_setup until Gmail webhook or verified Resend credentials are configured.",
    };
  }

  const at = nowIso();
  await execute(
    env.DB,
    `UPDATE alert_outbox SET
       status = 'queued',
       next_attempt_at = ?,
       last_error = NULL,
       updated_at = ?
     WHERE status = 'needs_setup'`,
    at,
    at,
  );
  const items = await queryAll<OutboxRow>(
    env.DB,
    `SELECT id, event_id, recipient, subject, text_body, html_body, status, attempts
     FROM alert_outbox
     WHERE status IN ('queued', 'failed')
       AND attempts < 5
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at
     LIMIT ?`,
    at,
    MAX_OUTBOX_SENDS_PER_RUN,
  );
  let sent = 0;
  for (const item of items) {
    const attemptAt = nowIso();
    await execute(
      env.DB,
      `UPDATE alert_outbox SET status = 'sending', attempts = attempts + 1,
       updated_at = ? WHERE id = ?`,
      attemptAt,
      item.id,
    );
    try {
      const delivery = await sendOutboxItem(env, item);
      if (delivery.sent) {
        sent += 1;
        await execute(
          env.DB,
          `UPDATE alert_outbox SET
             status = 'sent',
             provider_message_id = ?,
             last_error = NULL,
             next_attempt_at = NULL,
             sent_at = ?,
             updated_at = ?
           WHERE id = ?`,
          delivery.providerId ?? null,
          nowIso(),
          nowIso(),
          item.id,
        );
      } else {
        const nextAttemptNumber = item.attempts + 1;
        const exhausted = nextAttemptNumber >= 5 || !delivery.retry;
        const retryAt = new Date(
          Date.now() +
            Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, item.attempts)),
        ).toISOString();
        await execute(
          env.DB,
          `UPDATE alert_outbox SET
             status = ?,
             last_error = ?,
             next_attempt_at = ?,
             updated_at = ?
           WHERE id = ?`,
          exhausted ? "dead_letter" : "failed",
          truncate(delivery.error, 1_500),
          exhausted ? null : retryAt,
          nowIso(),
          item.id,
        );
      }
    } catch (caught) {
      const nextAttemptNumber = item.attempts + 1;
      const exhausted = nextAttemptNumber >= 5;
      const retryAt = new Date(
        Date.now() +
          Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, item.attempts)),
      ).toISOString();
      await execute(
        env.DB,
        `UPDATE alert_outbox SET
           status = ?,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
         WHERE id = ?`,
        exhausted ? "dead_letter" : "failed",
        truncate(
          caught instanceof Error ? caught.message : "Unknown Resend failure",
          1_500,
        ),
        exhausted ? null : retryAt,
        nowIso(),
        item.id,
      );
    }
  }

  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: items.length,
    itemsNew: sent,
    alertsSent: sent,
  };
}

/* ------------------------------------------------------------------ */
/* Service email (auth links and other non-brief mail)                 */
/* ------------------------------------------------------------------ */

const SERVICE_EMAIL_MAX_PER_RUN = 25;

/**
 * The From identity for a service email, by kind.
 *
 * Auth mail comes from the auth identity and everything else from the brief
 * identity, each falling back to the deployment's default sender until the
 * per-kind addresses are configured.
 */
function senderForKind(env: Env, kind: string): string | null {
  const fallback = env.ALERT_FROM_EMAIL?.trim() || null;
  if (kind === "auth_magic_link") return env.EMAIL_FROM_AUTH?.trim() || fallback;
  return env.EMAIL_FROM_BRIEF?.trim() || fallback;
}

/** The magic-link email. The URL is assembled here and nowhere else. */
function renderAuthLinkEmail(url: string): { subject: string; text: string; html: string } {
  const subject = "登录 Signal Ledger";
  const text = [
    "你好，",
    "",
    "点击下面的链接登录 Signal Ledger。链接 15 分钟内有效，且只能使用一次：",
    url,
    "",
    "如果不是你本人操作，请忽略这封邮件。",
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#14243a;max-width:560px">
<p>你好，</p>
<p>点击下面的按钮登录 Signal Ledger。链接 15 分钟内有效，且只能使用一次。</p>
<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="background:#0f5c4a;color:#fff;text-decoration:none;border-radius:8px;padding:12px 22px;font-weight:600;display:inline-block">登录 Signal Ledger</a></p>
<p style="color:#516074;font-size:13px">如果不是你本人操作，请忽略这封邮件。</p>
</div>`;
  return { subject, text, html };
}

/**
 * Drains the general service queue.
 *
 * An auth-link job carries no body — the schema forbids it — so the link is
 * rebuilt here from the job id. That is also what makes a retry safe: the same
 * job derives the same token, and D1 never held it. A job whose window has
 * closed is retired rather than delivered late, because a stale sign-in link is
 * worse than none.
 */
async function flushServiceEmailOutbox(env: Env): Promise<{ sent: number; expired: number; failed: number }> {
  const at = nowIso();
  // scheduled_for and next_attempt_at are stored as ISO8601 (T/Z), but SQLite's
  // datetime('now') is space-separated; comparing the two raw strings puts 'T'
  // (0x54) after ' ' (0x20), so a due row would sort as not-yet-ready. Normalize
  // both sides through datetime() so eligibility is a real time comparison.
  const rows = await queryAll<{
    id: string; kind: string; recipient: string; from_address: string | null; subject: string;
    body_mode: string; text_body: string | null; html_body: string | null;
    expires_at: string | null; attempts: number;
  }>(env.DB,
    `SELECT id, kind, recipient, from_address, subject, body_mode, text_body, html_body, expires_at, attempts
       FROM email_outbox
      WHERE status IN ('queued', 'failed') AND attempts < 5
        AND datetime(scheduled_for) <= datetime('now')
        AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
      ORDER BY scheduled_for
      LIMIT ?`,
    SERVICE_EMAIL_MAX_PER_RUN);

  let sent = 0;
  let expired = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.expires_at && Date.parse(row.expires_at) <= Date.parse(at)) {
      await execute(env.DB, `UPDATE email_outbox SET status = 'expired', updated_at = ? WHERE id = ?`, at, row.id);
      expired += 1;
      continue;
    }

    let body: { subject: string; text: string; html: string };
    if (row.body_mode === "derived_auth_link") {
      const secret = env.AUTH_LINK_DERIVATION_SECRET?.trim();
      if (!secret) {
        await execute(env.DB,
          `UPDATE email_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
          "AUTH_LINK_DERIVATION_SECRET is not configured", at, row.id);
        failed += 1;
        continue;
      }
      const token = await deriveMagicToken(secret, row.id, row.recipient, AUTH_LINK_PURPOSE);
      // The link origin must be explicit configuration; it is never defaulted
      // to a hardcoded production URL. Without it we fail closed rather than
      // email a link that points at the wrong (production) deployment.
      const origin = authLinkOrigin(env.SITE_ORIGIN, env.SIGNAL_LEDGER_ORIGIN);
      if (!origin) {
        await execute(env.DB,
          `UPDATE email_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
          "SITE_ORIGIN is not configured, so the auth link URL cannot be built", at, row.id);
        failed += 1;
        continue;
      }
      body = renderAuthLinkEmail(`${origin}/auth/verify?token=${encodeURIComponent(token)}`);
    } else {
      if (row.text_body === null || row.html_body === null) {
        failed += 1;
        continue;
      }
      body = { subject: row.subject, text: row.text_body, html: row.html_body };
    }

    // The sender belongs to the Worker, not to the caller that queued the job:
    // the Pages side has no EMAIL_FROM_* configuration by design, so an
    // explicit value is honoured but the per-kind identity is resolved here.
    // The resolved value is written back so the sender is auditable.
    const resolvedFrom = row.from_address?.trim() || senderForKind(env, row.kind);

    const result = await sendOutboxItem(env, {
      id: row.id,
      recipient: row.recipient,
      subject: body.subject,
      text_body: body.text,
      html_body: body.html,
      status: "queued",
      attempts: row.attempts,
      from_address: resolvedFrom,
      // Carried through so the sender can keep a secret-derived body out of the
      // provider idempotency fingerprint.
      body_mode: row.body_mode,
    });

    if (result.sent) {
      await execute(env.DB,
        `UPDATE email_outbox
            SET status = 'sent', attempts = attempts + 1, provider_message_id = ?,
                sent_at = ?, last_error = NULL, from_address = ?, updated_at = ?
          WHERE id = ?`,
        result.providerId ?? null, at, resolvedFrom, at, row.id);
      sent += 1;
    } else {
      await execute(env.DB,
        `UPDATE email_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        result.error ?? "unknown", at, row.id);
      failed += 1;
    }
  }

  return { sent, expired, failed };
}

/** The same flush, shaped for the run ledger and /health. */
async function flushServiceEmailSource(env: Env): Promise<SourceResult> {
  // The ledger's source vocabularies have no "degraded" for a delivery run, so
  // a missing signing secret is reported as needs_setup and individual send
  // failures are carried in the note (and in email_outbox.last_error).
  if (!env.AUTH_LINK_DERIVATION_SECRET?.trim()) {
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: 0,
      itemsNew: 0,
      note: "AUTH_LINK_DERIVATION_SECRET is not configured, so auth links cannot be built.",
    };
  }
  const result = await flushServiceEmailOutbox(env);
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: result.sent + result.expired + result.failed,
    itemsNew: result.sent,
    note: `${result.sent} sent, ${result.expired} expired, ${result.failed} failed.`,
  };
}

async function flushBriefingEmailOutbox(
  env: Env,
  dryRun: boolean,
): Promise<SourceResult> {
  if (dryRun) {
    const row = await queryFirst<{ count: number }>(
      env.DB,
      "SELECT COUNT(*) AS count FROM briefing_outbox WHERE status = 'dry_run'",
    );
    return {
      status: "skipped",
      sourceStatus: "healthy",
      itemsSeen: Number(row?.count ?? 0),
      itemsNew: 0,
      alertsSent: 0,
      note: "DRY_RUN is enabled; no briefing email was sent.",
    };
  }

  if (!emailReady(env)) {
    await execute(
      env.DB,
      `UPDATE briefing_outbox SET
         status = 'needs_setup',
         next_attempt_at = NULL,
         last_error = 'Configure Gmail webhook or a verified Resend sender.',
         updated_at = ?
       WHERE status IN ('queued', 'sending')`,
      nowIso(),
    );
    const row = await queryFirst<{ count: number }>(
      env.DB,
      "SELECT COUNT(*) AS count FROM briefing_outbox WHERE status = 'needs_setup'",
    );
    return {
      status: "needs_setup",
      sourceStatus: "needs_setup",
      itemsSeen: Number(row?.count ?? 0),
      itemsNew: 0,
      alertsSent: 0,
      note: "Briefing email is waiting for Gmail webhook or verified Resend configuration.",
    };
  }

  const at = nowIso();
  await execute(
    env.DB,
    `UPDATE briefing_outbox SET
       status = 'queued',
       next_attempt_at = scheduled_for,
       last_error = NULL,
       updated_at = ?
     WHERE status = 'needs_setup'`,
    at,
  );
  const items = await queryAll<EmailOutboxItem>(
    env.DB,
    `SELECT id, recipient, subject, text_body, html_body, status, attempts
     FROM briefing_outbox
     WHERE status IN ('queued', 'failed')
       AND attempts < 5
       AND scheduled_for <= ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at
     LIMIT ?`,
    at,
    at,
    MAX_OUTBOX_SENDS_PER_RUN,
  );
  let sent = 0;
  for (const item of items) {
    await execute(
      env.DB,
      `UPDATE briefing_outbox SET
         status = 'sending',
         attempts = attempts + 1,
         updated_at = ?
       WHERE id = ?`,
      nowIso(),
      item.id,
    );
    try {
      const delivery = await sendOutboxItem(env, item);
      if (delivery.sent) {
        sent += 1;
        const sentAt = nowIso();
        await execute(
          env.DB,
          `UPDATE briefing_outbox SET
             status = 'sent',
             provider_message_id = ?,
             last_error = NULL,
             next_attempt_at = NULL,
             sent_at = ?,
             updated_at = ?
           WHERE id = ?`,
          delivery.providerId ?? null,
          sentAt,
          sentAt,
          item.id,
        );
      } else {
        const exhausted = item.attempts + 1 >= 5 || !delivery.retry;
        const retryAt = new Date(
          Date.now() +
            Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, item.attempts)),
        ).toISOString();
        await execute(
          env.DB,
          `UPDATE briefing_outbox SET
             status = ?,
             last_error = ?,
             next_attempt_at = ?,
             updated_at = ?
           WHERE id = ?`,
          exhausted ? "dead_letter" : "failed",
          truncate(delivery.error, 1_500),
          exhausted ? null : retryAt,
          nowIso(),
          item.id,
        );
      }
    } catch (caught) {
      const exhausted = item.attempts + 1 >= 5;
      const retryAt = new Date(
        Date.now() +
          Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, item.attempts)),
      ).toISOString();
      await execute(
        env.DB,
        `UPDATE briefing_outbox SET
           status = ?,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = ?
         WHERE id = ?`,
        exhausted ? "dead_letter" : "failed",
        truncate(
          caught instanceof Error ? caught.message : "Unknown Resend failure",
          1_500,
        ),
        exhausted ? null : retryAt,
        nowIso(),
        item.id,
      );
    }
  }
  return {
    status: "success",
    sourceStatus: "healthy",
    itemsSeen: items.length,
    itemsNew: sent,
    alertsSent: sent,
  };
}

async function runInBatches<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    await Promise.all(batch.map(task));
    if (offset + concurrency < items.length) await sleep(250);
  }
}

async function runMonitor(
  env: Env,
  triggerType: TriggerType,
  requestedDryRun?: boolean,
): Promise<RunSummary> {
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  const startedMs = Date.now();
  const dryRun =
    requestedDryRun === true ||
    (requestedDryRun == null && envBoolean(env.DRY_RUN, true));

  await execute(
    env.DB,
    `INSERT INTO runs
       (id, trigger_type, dry_run, started_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
    runId,
    triggerType,
    dryRun ? 1 : 0,
    startedAt,
  );

  const acquired = await acquireLock(env.DB, runId);
  if (!acquired) {
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;
    await execute(
      env.DB,
      `UPDATE runs SET status = 'skipped', finished_at = ?, duration_ms = ?,
       error = 'Another monitor run still owns the D1 lock.' WHERE id = ?`,
      finishedAt,
      durationMs,
      runId,
    );
    return {
      runId,
      status: "skipped",
      triggerType,
      dryRun,
      startedAt,
      finishedAt,
      durationMs,
      sourcesTotal: 0,
      sourcesSucceeded: 0,
      sourcesFailed: 0,
      eventsSeen: 0,
      eventsNew: 0,
      alertsQueued: 0,
      alertsSent: 0,
      message: "Another monitor run is already in progress.",
    };
  }

  const executions: SourceExecution[] = [];
  try {
    await suppressQueuedRoutineSecAlerts(env.DB, startedAt);
    await suppressQueuedStaleImmediateAlerts(env.DB, startedAt);

    // Current-affairs news has a strict freshness SLA and needs only one
    // external request. Run it before the SEC/quote fan-out so a busy monitor
    // cycle cannot exhaust the Worker subrequest allowance first.
    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "news:gdelt-world",
          name: "Global current-affairs news index",
          kind: "world_news",
          tier: 2,
          required: false,
          enabled: true,
        },
        () => processWorldNews(env.DB, env.AI),
      ),
    );

    const maxTier = envInteger(env.WATCHLIST_TIER_MAX, 1, 1, 3);
    let watchlist = await getWatchlist(env.DB, maxTier);
    // One company per minute, each checked at least every 30 minutes while
    // cron is healthy. Bounded requests; no per-viewer external calendar calls.
    const companies = CALENDAR_COMPANIES.filter(company => watchlist.some(row => row.symbol === company.ticker));
    const checks = await queryAll<{ id: string; last_checked_at: string | null }>(env.DB,
      `SELECT id, last_checked_at FROM sources WHERE id IN (${companies.map(() => "?").join(",") || "NULL"})`,
      ...companies.map(company => `calendar:ir:${company.ticker}`));
    const lastChecks = new Map(checks.map(row => [row.id, row.last_checked_at]));
    const due = companies.filter(company => !isRecent(lastChecks.get(`calendar:ir:${company.ticker}`), 30 * 60_000))
      .sort((a, b) => (lastChecks.get(`calendar:ir:${a.ticker}`) ?? "").localeCompare(lastChecks.get(`calendar:ir:${b.ticker}`) ?? ""))[0];
    if (due) executions.push(await runTrackedSource(env, runId, {
      id: `calendar:ir:${due.ticker}`, name: `${due.name} earnings calendar`, kind: "earnings_calendar", tier: 1, required: true, enabled: true,
    }, async () => {
      const { entries, warning } = await collectCompanyCalendar(due);
      await storeCalendar(env.DB, entries);
      if (warning) throw new Error(warning);
      return { status: "success", sourceStatus: "healthy", itemsSeen: entries.length, itemsNew: 0,
        note: `Verified ${entries.length} official calendar announcement(s). Dates refresh independently of frozen forecasts.` };
    }));
    env = { ...env, earningsCalendar: await loadCalendar(env.DB) };

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "sec:company-tickers",
          name: "SEC company ticker map",
          kind: "sec_reference",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => syncSecCompanyTickers(env, watchlist),
      ),
    );

    watchlist = await getWatchlist(env.DB, maxTier);
    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "forecast:weekly-pre-event-baseline-v1",
          name: "Weekly pre-event baseline-v1 freeze",
          kind: "forecast_freeze",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => createWeeklyPreEventBaselines(env, watchlist),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "actual:sec-earnings-release-v1",
          name: "SEC earnings-release actuals",
          kind: "earnings_actual",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processSecEarningsActualBackfill(env),
      ),
    );

    const concurrency = envInteger(env.SEC_MAX_CONCURRENCY, 4, 1, 8);
    await runInBatches(watchlist, concurrency, async (row) => {
      const execution = await runTrackedSource(
        env,
        runId,
        {
          id: `sec:submissions:${row.symbol}`,
          name: `SEC submissions — ${row.symbol}`,
          kind: "sec_submissions",
          tier: 1,
          required: row.tier === 1,
          enabled: true,
        },
        () => ingestSecSubmissions({ ...env, DRY_RUN: String(dryRun) }, row),
      );
      executions.push(execution);
    });

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "research:sec-filing-content-v1",
          name: "SEC filing body and exhibit research",
          kind: "filing_research",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processSecFilingResearch(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "forecast:sec-seasonal-baseline-v1",
          name: "SEC seasonal earnings baseline",
          kind: "forecast_freeze_and_evaluation",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processSecSeasonalEarningsForecasts(env, watchlist),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "consensus:nasdaq-eps",
          name: "Nasdaq quarterly EPS consensus",
          kind: "analyst_consensus",
          tier: 2,
          required: false,
          enabled: true,
        },
        () => processNasdaqEarningsConsensus(env),
      ),
    );

    const officialFeedResults = await collectOfficialFeeds();
    for (const result of officialFeedResults) {
      executions.push(
        await runTrackedSource(
          env,
          runId,
          {
            id: result.feed.id,
            name: result.feed.name,
            kind:
              result.feed.eventType === "trade_halt"
                ? "market_status"
                : "official_macro",
            tier: 1,
            required: false,
            enabled: true,
          },
          () =>
            ingestOfficialFeedResult(
              { ...env, DRY_RUN: String(dryRun) },
              result,
              watchlist,
            ),
        ),
      );
    }

    const alpacaEnabled = envBoolean(env.ENABLE_ALPACA_NEWS, true);
    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "alpaca:news",
          name: "Alpaca News",
          kind: "news",
          tier: 2,
          required: false,
          enabled: alpacaEnabled,
        },
        () =>
          ingestAlpacaNews(
            { ...env, DRY_RUN: String(dryRun) },
            watchlist,
        ),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "market:nasdaq-latest-quotes",
          name: "Nasdaq latest quotes",
          kind: "market_quote",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processNasdaqLatestQuotes(env, watchlist),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "market:coinbase-btc",
          name: "Coinbase BTC research feed",
          kind: "crypto_market_and_forecast",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processBtcResearch(env.DB),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "forecast:earnings-multisignal-v5",
          name: "Multisignal earnings reaction forecast",
          kind: "forecast_freeze_and_evaluation",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processMultisignalEarningsForecasts(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "forecast:earnings-point-price-v1",
          name: "Earnings point-price forecast ledger",
          kind: "forecast_freeze",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => processEarningsPointPriceForecasts(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "evaluation:earnings-point-price-v1",
          name: "Earnings point-price settlement",
          kind: "forecast_evaluation",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => settleEarningsPointPriceForecasts(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "briefing:scheduled",
          name: "Weekday scheduled briefing",
          kind: "briefing",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => generateScheduledBriefing(env, dryRun),
      ),
    );

    // Runs after briefing:scheduled in the same tick, so on the day the brief is
    // generated the fan-out follows immediately; on every later tick it re-reads
    // the persisted artifact and reconstructs any delivery that failed partway.
    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "delivery:daily-brief-fanout",
          name: "Daily brief PRO subscriber fan-out",
          kind: "delivery",
          tier: 1,
          // Not required: a fan-out hiccup must not mark the whole run degraded,
          // and its failures are visible in email_outbox anyway.
          required: false,
          enabled: true,
        },
        () => deliverScheduledDailyBrief(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "evaluation:pre-event-baseline-v1",
          name: "Pre-event baseline-v1 settlement",
          kind: "forecast_evaluation",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => resolvePreEventBaselines(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "delivery:resend-briefings",
          name: "Resend briefing email delivery",
          kind: "delivery",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => flushBriefingEmailOutbox(env, dryRun),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "delivery:service-email",
          name: "Service email (auth links)",
          kind: "delivery",
          tier: 1,
          // Not required: an auth-email hiccup must not mark the whole run
          // degraded, and its failures are visible in email_outbox anyway.
          required: false,
          enabled: true,
        },
        () => flushServiceEmailSource(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "evaluation:alpaca-bars",
          name: "Alpaca post-event forecast settlement",
          kind: "forecast_evaluation",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => resolveOpenForecasts(env),
      ),
    );

    executions.push(
      await runTrackedSource(
        env,
        runId,
        {
          id: "delivery:resend",
          name: "Gmail/Resend email delivery",
          kind: "delivery",
          tier: 1,
          required: true,
          enabled: true,
        },
        () => flushEmailOutbox(env, dryRun),
      ),
    );

    const activeExecutions = executions.filter((item) => item.enabled);
    const sourcesTotal = activeExecutions.length;
    const sourcesSucceeded = activeExecutions.filter((item) =>
      ["success", "skipped"].includes(item.status),
    ).length;
    const sourcesFailed = activeExecutions.filter(
      (item) =>
        item.required &&
        (item.status === "needs_setup" || item.error != null),
    ).length;
    const eventExecutions = executions.filter(
      (item) =>
        item.sourceId.startsWith("sec:submissions:") ||
        item.sourceId === "alpaca:news",
    );
    const eventsSeen = eventExecutions.reduce(
      (sum, item) => sum + item.itemsSeen,
      0,
    );
    const eventsNew = eventExecutions.reduce(
      (sum, item) => sum + item.itemsNew,
      0,
    );
    const alertsQueued = eventExecutions.reduce(
      (sum, item) => sum + (item.alertsQueued ?? 0),
      0,
    );
    const alertsSent = executions.reduce(
      (sum, item) => sum + (item.alertsSent ?? 0),
      0,
    );
    const requiredExecutions = activeExecutions.filter((item) => item.required);
    const requiredFailures = requiredExecutions.filter(
      (item) =>
        item.status === "needs_setup" ||
        item.error != null ||
        item.sourceStatus === "needs_setup",
    ).length;
    const runStatus =
      requiredFailures === 0
        ? "success"
        : requiredFailures === requiredExecutions.length
          ? "failed"
          : "partial";
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;
    const errorSummary = executions
      .filter((item) => item.error || item.note)
      .map((item) => `${item.sourceId}: ${item.error ?? item.note}`)
      .slice(0, 8)
      .join(" | ");

    await execute(
      env.DB,
      `UPDATE runs SET
         finished_at = ?,
         status = ?,
         sources_total = ?,
         sources_succeeded = ?,
         sources_failed = ?,
         events_seen = ?,
         events_new = ?,
         alerts_queued = ?,
         alerts_sent = ?,
         duration_ms = ?,
         error = ?
       WHERE id = ?`,
      finishedAt,
      runStatus,
      sourcesTotal,
      sourcesSucceeded,
      sourcesFailed,
      eventsSeen,
      eventsNew,
      alertsQueued,
      alertsSent,
      durationMs,
      errorSummary || null,
      runId,
    );

    return {
      runId,
      status: runStatus,
      triggerType,
      dryRun,
      startedAt,
      finishedAt,
      durationMs,
      sourcesTotal,
      sourcesSucceeded,
      sourcesFailed,
      eventsSeen,
      eventsNew,
      alertsQueued,
      alertsSent,
    };
  } catch (caught) {
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;
    const error = truncate(
      caught instanceof Error ? caught.message : "Unknown monitor failure",
      1_500,
    );
    await execute(
      env.DB,
      `UPDATE runs SET status = 'failed', finished_at = ?, duration_ms = ?,
       error = ? WHERE id = ?`,
      finishedAt,
      durationMs,
      error,
      runId,
    );
    return {
      runId,
      status: "failed",
      triggerType,
      dryRun,
      startedAt,
      finishedAt,
      durationMs,
      sourcesTotal: executions.filter((item) => item.enabled).length,
      sourcesSucceeded: executions.filter((item) =>
        ["success", "skipped"].includes(item.status),
      ).length,
      sourcesFailed: 1,
      eventsSeen: executions
        .filter(
          (item) =>
            item.sourceId.startsWith("sec:submissions:") ||
            item.sourceId === "alpaca:news",
        )
        .reduce((sum, item) => sum + item.itemsSeen, 0),
      eventsNew: executions
        .filter(
          (item) =>
            item.sourceId.startsWith("sec:submissions:") ||
            item.sourceId === "alpaca:news",
        )
        .reduce((sum, item) => sum + item.itemsNew, 0),
      alertsQueued: executions
        .filter(
          (item) =>
            item.sourceId.startsWith("sec:submissions:") ||
            item.sourceId === "alpaca:news",
        )
        .reduce(
        (sum, item) => sum + (item.alertsQueued ?? 0),
        0,
      ),
      alertsSent: executions.reduce(
        (sum, item) => sum + (item.alertsSent ?? 0),
        0,
      ),
      message: error,
    };
  } finally {
    try {
      await releaseLock(env.DB, runId);
    } catch (error) {
      console.error("Failed to release monitor lock", error);
    }
  }
}

function dashboardAuthValid(request: Request, env: Env): boolean {
  const configured = env.DASHBOARD_READ_KEY?.trim();
  if (!configured) return true;
  const supplied =
    requestBearer(request) || request.headers.get("x-dashboard-key");
  return constantTimeEqual(supplied, configured);
}

function monitoringStatus(
  lastRun: { status: string; finished_at: string | null } | null,
  sources: Array<{
    required: number;
    enabled: number;
    status: string;
  }>,
): string {
  if (!lastRun) return "starting";
  if (!lastRun.finished_at || !isRecent(lastRun.finished_at, 5 * 60_000)) {
    return "stale";
  }
  if (lastRun.status === "failed") return "degraded";
  const unhealthyRequired = sources.some(
    (source) =>
      source.required === 1 &&
      source.enabled === 1 &&
      source.status !== "healthy",
  );
  return unhealthyRequired || lastRun.status === "partial"
    ? "degraded"
    : "healthy";
}

function percentile95(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function calibrationPayload(
  forecasts: Array<{
    status: string;
    probability_up: number;
    probability_base: number;
    probability_down: number;
    actual_outcome: string | null;
    brier_score: number | null;
    direction_hit: number | null;
  }>,
): {
  resolvedForecasts: number;
  brierScore: number | null;
  directionHitRate: number | null;
  buckets: Array<{
    probabilityBand: string;
    count: number;
    averageUpProbability: number | null;
    realizedUpRate: number | null;
    brierScore: number | null;
  }>;
} {
  const resolved = forecasts.filter(
    (forecast) => forecast.status === "resolved",
  );
  const average = (values: number[]): number | null =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const buckets = [
    { label: "0-20%", min: 0, max: 0.2 },
    { label: "20-40%", min: 0.2, max: 0.4 },
    { label: "40-60%", min: 0.4, max: 0.6 },
    { label: "60-80%", min: 0.6, max: 0.8 },
    { label: "80-100%", min: 0.8, max: 1.000001 },
  ].map((bucket) => {
    const members = resolved.filter(
      (forecast) =>
        forecast.probability_up >= bucket.min &&
        forecast.probability_up < bucket.max,
    );
    return {
      probabilityBand: bucket.label,
      count: members.length,
      averageUpProbability: average(
        members.map((forecast) => forecast.probability_up),
      ),
      realizedUpRate: average(
        members.map((forecast) =>
          forecast.actual_outcome === "up" ? 1 : 0,
        ),
      ),
      brierScore: average(
        members
          .map((forecast) => forecast.brier_score)
          .filter((value): value is number => value != null),
      ),
    };
  });
  return {
    resolvedForecasts: resolved.length,
    brierScore: average(
      resolved
        .map((forecast) => forecast.brier_score)
        .filter((value): value is number => value != null),
    ),
    directionHitRate: average(
      resolved
        .map((forecast) => forecast.direction_hit)
        .filter((value): value is number => value != null),
    ),
    buckets,
  };
}

function cleanSourceSummary(value: unknown): string {
  return truncate(
    String(value ?? "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim(),
    600,
  );
}

function eventAnalysisPayload(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const eventType = String(event.event_type ?? "other").toLowerCase();
  const ticker = String(event.ticker ?? "MARKET").toUpperCase();
  const headline = truncate(event.headline ?? "未命名事件", 500);
  const summary = cleanSourceSummary(event.summary);
  const sourceUrl = String(event.url ?? "");
  const sourceTier = Number(event.source_tier ?? 2);
  const direction = String(event.direction ?? "neutral").toLowerCase();
  const classificationConfidence = Number(event.confidence ?? 0);

  let whyItMatters =
    "这是一条已归档的新事实；是否改变盈利预期或估值，需要回到一手材料继续核验。";
  let impactPath = [
    "新增事实",
    "核验一手材料",
    "判断是否改变预期",
    "观察后续价格反应",
  ];
  let verificationPoints = [
    "打开原始来源，核验标题、时间与关键数字。",
    "确认该信息是否改变收入、利润、指引、风险或估值假设。",
  ];

  if (eventType === "sec_8_k") {
    whyItMatters =
      "8-K 可能包含业绩、指引或其他重大公司事项；表单本身不是利多或利空，关键在具体 Item 与数字。";
    impactPath = [
      "8-K 披露",
      "核验具体 Item 与数字",
      "更新业绩/风险假设",
      "观察价格反应",
    ];
    verificationPoints = [
      "核验 8-K 的 Item、附件和管理层原文。",
      "判断是否涉及业绩、指引、融资、并购或治理变化。",
    ];
  } else if (["sec_10_q", "sec_10_k"].includes(eventType)) {
    whyItMatters =
      "10-Q/10-K 是公司财务与风险的一手披露，可用于核验预测、更新模型并检查会计质量。";
    impactPath = [
      "定期报告",
      "核验营收/EPS/现金流",
      "检查指引与风险变化",
      "更新预测账本",
    ];
    verificationPoints = [
      "核验财务报表、MD&A、风险因素和会计政策变化。",
      "把实际收入/EPS 与事前冻结值并排比较。",
    ];
  } else if (eventType === "trade_halt") {
    whyItMatters =
      "停牌意味着正常价格发现暂时中断；方向必须等待停牌原因、公司公告和恢复交易后的市场反应确认。";
    impactPath = [
      "交易暂停",
      "核验原因代码",
      "等待公司/监管公告",
      "恢复交易后重新定价",
    ];
    verificationPoints = [
      "核验 Nasdaq 停牌原因代码与恢复报价/交易时间。",
      "检查公司 IR 与 SEC 是否发布后续公告。",
    ];
  } else if (
    ["macro", "fed", "bls", "bea", "economic_release"].includes(eventType)
  ) {
    whyItMatters =
      "官方宏观信息可能通过利率、增长预期和风险偏好影响广泛资产；需先与一致预期和前值对比。";
    impactPath = [
      "官方宏观发布",
      "对比一致预期与前值",
      "观察利率/美元/指数反应",
      "再判断个股传导",
    ];
    verificationPoints = [
      "核验 actual、consensus、prior 及修订值。",
      "观察美债收益率、美元和主要指数的同步反应。",
    ];
  } else if (eventType === "earnings") {
    whyItMatters =
      "业绩信息会直接影响收入、利润、指引和估值预期；必须区分实际值、公司指引与市场一致预期。";
    impactPath = [
      "业绩发布",
      "对比实际/指引/一致预期",
      "更新估值与情景",
      "观察首个完整交易日反应",
    ];
    verificationPoints = [
      "核验公司 IR、SEC 附件和电话会原文。",
      "对比收入、EPS、关键 KPI 与指引的事前冻结值。",
    ];
  }

  const stance =
    direction === "up"
      ? "bullish"
      : direction === "down"
        ? "bearish"
        : direction === "neutral"
          ? "neutral"
          : "uncertain";
  const affectedSecurities =
    ticker === "MARKET"
      ? [
          {
            ticker: "MARKET",
            relationship: "broad",
            basis: "官方宏观或市场级事件；具体个股传导仍待核验。",
            confidence: "low",
          },
        ]
      : [
          {
            ticker,
            relationship: "direct",
            basis: "来源记录直接绑定该证券。",
            confidence: "high",
          },
        ];

  return {
    whatHappened: summary || headline,
    whyItMatters,
    impactPath,
    affectedSecurities,
    impact: {
      stance,
      basis: "keyword_rule",
      classificationConfidence,
      horizon: "event_dependent",
      caveat:
        "这是文本分类倾向，不是财报后收益概率，也不代表确定的利多或利空。",
    },
    verificationPoints: verificationPoints.map((text) => ({
      text,
      sourceUrl,
      status: "open",
    })),
    evidence: {
      sourceTier,
      sourceUrl,
      sourceKey: event.source_key ?? null,
      sourceEventId: event.source_event_id ?? null,
    },
    analysisVersion: "rules-zh-v1",
    generatedAt: event.detected_at ?? event.published_at ?? nowIso(),
  };
}

const WORLD_NEWS_DASHBOARD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function dashboardNewsIsFresh(publishedAt: unknown, nowMs: number): boolean {
  const publishedMs = new Date(String(publishedAt ?? "")).getTime();
  const ageMs = nowMs - publishedMs;
  return (
    Number.isFinite(ageMs) &&
    ageMs >= -5 * 60 * 1_000 &&
    ageMs <= WORLD_NEWS_DASHBOARD_MAX_AGE_MS
  );
}

const GENERIC_DASHBOARD_NEWS_TEXT =
  /出现新的可定价事实|出现重要新进展|先判断这是新事实|只有能改变盈利|新事实\s*→\s*行业供需|核对第二个独立来源|美国官方发布新|官方宏观信息可能通过|这是一条已归档的新事实|相关资产价格|后续公司指引/;

function dashboardNewsBriefIsConcrete(
  item: Record<string, unknown>,
): boolean {
  const sections = [
    item.titleZh,
    item.factSummaryZh,
    item.commentaryZh,
    item.impactPathZh,
    item.verificationZh,
  ].map((value) => String(value ?? "").trim());
  const minimumLengths = [6, 55, 35, 28, 24];
  if (
    sections.some(
      (value, index) => value.length < (minimumLengths[index] ?? 20),
    )
  ) {
    return false;
  }
  return !GENERIC_DASHBOARD_NEWS_TEXT.test(sections.join(" "));
}

function officialDeskEventIsInvestable(event: Record<string, unknown>): boolean {
  const text = `${String(event.headline ?? "")} ${String(
    event.summary ?? "",
  )}`.toLowerCase();
  const ticker = String(event.ticker ?? "MARKET");
  if (
    /monument|memorial|ceremony|anniversary|appointment|meeting notice|enforcement action with (?:former|the)|requests? comment|proposal to modernize/.test(
      text,
    )
  ) {
    return false;
  }
  if (ticker !== "MARKET") {
    return /earnings|revenue|profit|guidance|forecast|merger|acquisition|offering|financing|bankrupt|default|fraud|restatement|non-reliance|trade halt|antitrust|export control|fda|major product/.test(
      text,
    );
  }
  return /fomc|federal funds rate|interest rate decision|economic projections|cpi|consumer price index|pce|personal income and outlays|payroll|employment situation|unemployment rate|gdp|gross domestic product|retail sales|ppi|producer price index|trade in goods and services|tariff|sanction|export control|emergency lending|financial stability|stress test results|opec|oil supply|energy infrastructure|shipping disruption|supply chain|airstrike|missile|conflict|war/.test(
    text,
  );
}

async function dashboardResponse(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!dashboardAuthValid(request, env)) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }
  const earningsCalendar = await loadCalendar(env.DB);

  const [
    watchlist,
    events,
    eventResearchRows,
    forecasts,
    earningsActualRows,
    earningsForecastRows,
    earningsReactionRows,
    earningsConsensusRows,
    latestQuoteRows,
    earningsPriceForecastRows,
    briefingRows,
    runs,
    sources,
    outbox,
    queuedRow,
    btcSnapshotRows,
    btcForecastRows,
    btcPathRows,
    btcActualRows,
    btcCandleRows,
    worldNewsRows,
  ] = await Promise.all([
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT w.*,
              (SELECT MAX(e.detected_at) FROM events e WHERE e.ticker = w.symbol)
                AS last_event_at
       FROM watchlist w
       WHERE w.active = 1
       ORDER BY w.tier, w.symbol`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, source_key, source_event_id, ticker, event_type, headline,
              summary, priority, source_name, source_tier, published_at,
              detected_at, url, direction, confidence
       FROM events
       ORDER BY detected_at DESC
       LIMIT 100`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, event_id, document_type, document_url, source_url,
              information_cutoff_at, headline, key_metrics_json,
              key_points_json, evidence_json, status, created_at
       FROM event_research_notes
       ORDER BY created_at DESC
       LIMIT 300`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, ticker, forecast_type, target_definition, horizon,
              probability_up, probability_base, probability_down, return_low,
              return_high, benchmark, rationale, status, created_at,
              information_cutoff_at, actual_outcome, relative_return,
              brier_score, direction_hit, resolution_at, quality_flag
       FROM forecasts
       ORDER BY created_at DESC
       LIMIT 200`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT ea.id, ea.ticker, ea.fiscal_period, ea.accession,
              ea.event_id, ea.available_at, ea.revenue, ea.revenue_unit,
              ea.eps, ea.eps_unit, ea.source_name, ea.source_url,
              ea.source_quality, ea.evidence_json, ea.updated_at
       FROM earnings_actuals ea
       ORDER BY ea.available_at DESC, ea.updated_at DESC
       LIMIT 300`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT ef.id, ef.ticker, ef.cik, ef.fiscal_period,
              ef.expected_window_start, ef.expected_window_end,
              ef.window_confidence, ef.information_cutoff_at,
              ef.forecast_method, ef.revenue_estimate, ef.revenue_unit,
              ef.eps_estimate, ef.eps_unit, ef.status, ef.actual_accession,
              ef.actual_filed_at, ef.actual_revenue, ef.actual_eps,
              ef.revenue_error_pct, ef.eps_error, ef.source_quality, ef.notes,
              ef.resolution_notes, ef.created_at, ef.resolved_at,
              actual_event.url AS actual_source_url
       FROM earnings_forecasts ef
       LEFT JOIN events actual_event ON actual_event.id = ef.actual_event_id
       ORDER BY ef.created_at DESC
       LIMIT 200`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, financial_forecast_id, consensus_snapshot_id, ticker,
              fiscal_period, release_window_start, release_window_end,
              release_window_basis, information_cutoff_at, target_definition,
              threshold_up, threshold_down, benchmark, probability_up,
              probability_base, probability_down, predicted_direction,
              expected_relative_return, reaction_low, reaction_high,
              reaction_range_basis, sample_size, model_confidence,
              model_version, consensus_status, key_drivers_json,
              invalidation_condition, feature_snapshot_json, status, actual_relative_return,
              actual_outcome, brier_score, direction_hit, interval_hit,
              resolution_notes, created_at, resolved_at
       FROM earnings_reaction_forecasts
       ORDER BY created_at DESC
       LIMIT 200`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, ticker, fiscal_period, provider, as_of_at, source_url,
              revenue_consensus, revenue_unit, eps_consensus, eps_unit,
              analyst_count, raw_json
       FROM earnings_consensus_snapshots
       ORDER BY as_of_at DESC
       LIMIT 500`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT ticker, price, currency, quote_as_of_at, received_at, provider,
              source_url, market_status, is_real_time, delay_minutes,
              timestamp_basis, net_change, percentage_change, bid_price,
              ask_price, volume, updated_at
       FROM latest_quotes
       ORDER BY ticker`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT epf.id, epf.financial_forecast_id, epf.reaction_forecast_id,
              epf.supersedes_forecast_id, epf.ticker, epf.fiscal_period,
              epf.earnings_date, epf.release_timing, epf.target_session,
              epf.reference_price, epf.reference_price_at,
              epf.reference_quote_provider,
              epf.reference_quote_is_real_time,
              epf.reference_quote_delay_minutes,
              epf.predicted_post_price, epf.predicted_change_pct,
              epf.forecast_stance, epf.forecast_role, epf.thesis,
              epf.key_drivers_json, epf.information_cutoff_at,
              epf.model_version, epf.source_json, epf.created_at,
              settlement.id AS settlement_id,
              settlement.actual_post_price, settlement.actual_price_at,
              settlement.actual_price_provider, settlement.actual_change_pct,
              settlement.error_amount, settlement.error_pct,
              settlement.absolute_error_pct, settlement.direction_hit,
              settlement.evaluated_at, settlement.quality_flag,
              CASE WHEN epf.id = (
                SELECT official.id
                FROM earnings_price_forecasts official
                WHERE official.financial_forecast_id =
                  epf.financial_forecast_id
                ORDER BY
                  CASE WHEN official.forecast_role = 'final' THEN 1 ELSE 0 END
                    DESC,
                  official.information_cutoff_at DESC
                LIMIT 1
              ) THEN 1 ELSE 0 END AS is_official
       FROM earnings_price_forecasts epf
       LEFT JOIN earnings_price_forecast_settlements settlement
         ON settlement.price_forecast_id = epf.id
       ORDER BY epf.earnings_date DESC, epf.information_cutoff_at DESC
       LIMIT 500`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT b.id, b.briefing_type, b.title, b.summary, b.generated_at,
              b.status, b.event_count, b.p0_count, b.p1_count, b.items_json,
              o.status AS email_status, o.recipient, o.sent_at,
              o.provider_message_id, o.last_error
       FROM briefings b
       LEFT JOIN briefing_outbox o ON o.briefing_id = b.id
       ORDER BY b.generated_at DESC
       LIMIT 60`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, trigger_type, dry_run, started_at, finished_at, status,
              sources_total, sources_succeeded, sources_failed, events_seen,
              events_new, alerts_queued, alerts_sent, duration_ms, error
       FROM runs
       ORDER BY started_at DESC
       LIMIT 30`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, name, kind, tier, required, enabled, status, cursor,
              last_checked_at, last_success_at, last_failure_at,
              last_latency_ms, items_seen, items_new, last_error
       FROM sources
       ORDER BY tier, kind, name`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT o.id, o.event_id, e.ticker, e.priority, o.channel, o.recipient,
              o.subject, o.status, o.attempts, o.next_attempt_at,
              o.provider_message_id, o.last_error, o.created_at, o.sent_at
       FROM alert_outbox o
       JOIN events e ON e.id = o.event_id
       ORDER BY o.created_at DESC
       LIMIT 100`,
    ),
    queryFirst<{ count: number }>(
      env.DB,
      `SELECT
         (SELECT COUNT(*) FROM alert_outbox
          WHERE status IN ('queued', 'sending', 'failed', 'needs_setup')) +
         (SELECT COUNT(*) FROM briefing_outbox
         WHERE status IN ('queued', 'sending', 'failed', 'needs_setup'))
         AS count`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, observed_at, price, open_24h, high_24h, low_24h,
              change_24h_pct, volume_24h_btc, volume_24h_usd,
              volume_30d_btc, source_name, source_url
       FROM btc_market_snapshots
       ORDER BY observed_at DESC
       LIMIT 288`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, forecast_date, baseline_price, target_date, target_price,
              predicted_return_pct, research_low, research_high, stance,
              thesis, drivers_json, invalidation_condition,
              feature_snapshot_json, model_version, source_json,
              information_cutoff_at, frozen_at
       FROM btc_30d_forecasts
       ORDER BY forecast_date DESC
       LIMIT 120`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT path.id, path.forecast_id, forecast.forecast_date,
              forecast.frozen_at, forecast.baseline_price,
              forecast.target_date AS forecast_target_date,
              forecast.target_price, path.target_date, path.day_offset,
              path.predicted_price
       FROM btc_forecast_path path
       JOIN btc_30d_forecasts forecast ON forecast.id = path.forecast_id
       WHERE path.forecast_id IN (
         SELECT id FROM btc_30d_forecasts
         ORDER BY forecast_date DESC
         LIMIT 120
       )
       ORDER BY forecast.forecast_date DESC, path.day_offset`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT actual.id, actual.forecast_id, actual.target_date,
              actual.actual_close, actual.error_amount, actual.error_pct,
              actual.absolute_error_pct, actual.direction_hit,
              actual.observed_at, forecast.forecast_date,
              forecast.target_date AS forecast_target_date,
              forecast.baseline_price, forecast.target_price,
              path.predicted_price AS predicted_path_price
       FROM btc_forecast_actuals actual
       JOIN btc_30d_forecasts forecast ON forecast.id = actual.forecast_id
       JOIN btc_forecast_path path
         ON path.forecast_id = actual.forecast_id
        AND path.target_date = actual.target_date
       ORDER BY actual.target_date DESC, forecast.forecast_date DESC
       LIMIT 4000`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT day, open, high, low, close, volume_btc, source_name,
              source_url, observed_at
       FROM btc_daily_candles
       ORDER BY day DESC
       LIMIT 180`,
    ),
    queryAll<Record<string, unknown>>(
      env.DB,
      `SELECT id, region, market_scope, category, importance_score,
              headline, title_zh, fact_summary_zh, commentary_zh,
              impact_path_zh, verification_zh, evidence_status,
              source_name, source_url, published_at, detected_at, brief_version
       FROM (
         SELECT id, region, market_scope, category, importance_score,
                headline, title_zh, fact_summary_zh, commentary_zh,
                impact_path_zh, verification_zh, evidence_status,
                source_name, source_url, published_at, detected_at, brief_version,
                ROW_NUMBER() OVER (
                  PARTITION BY region, lower(trim(headline))
                  ORDER BY importance_score DESC, published_at DESC,
                           detected_at ASC
                ) AS duplicate_rank
         FROM world_news INDEXED BY world_news_region_published_idx
         WHERE region IN ('US', 'JP', 'KR', 'CN', 'GLOBAL')
           AND published_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
       )
       WHERE duplicate_rank = 1
       ORDER BY published_at DESC, importance_score DESC
       LIMIT 160`,
    ),
  ]);

  // A newly announced quarter must be visible even before the financial
  // forecasting job has produced a model for that quarter.
  const existingPeriods = new Set(earningsForecastRows.map(row => `${row.ticker}:${row.fiscal_period}`));
  for (const [key, entry] of earningsCalendar) {
    if (existingPeriods.has(key) || entry.date < newYorkDate(nowIso()) || !watchlist.some(row => row.symbol === entry.ticker)) continue;
    earningsForecastRows.push({ id: `calendar:${key}`, ticker: entry.ticker, fiscal_period: entry.fiscalPeriod,
      expected_window_start: entry.date, expected_window_end: entry.date, revenue_estimate: null, eps_estimate: null,
      window_confidence: null, status: "calendar_only", forecast_method: "official_calendar_only",
      information_cutoff_at: null, created_at: entry.checkedAt });
  }

  const lastRun = runs[0]
    ? {
        status: String(runs[0].status),
        finished_at: (runs[0].finished_at as string | null) ?? null,
      }
    : null;
  const sourceHealthRows = sources.map((source) => ({
    required: Number(source.required),
    enabled: Number(source.enabled),
    status: String(source.status),
  }));
  const status = monitoringStatus(lastRun, sourceHealthRows);
  const mappedCalibrationForecasts = forecasts.map((forecast) => ({
      status: String(forecast.status),
      forecastType: String(forecast.forecast_type),
      probability_up: Number(forecast.probability_up),
      probability_base: Number(forecast.probability_base),
      probability_down: Number(forecast.probability_down),
      actual_outcome: (forecast.actual_outcome as string | null) ?? null,
      brier_score:
        forecast.brier_score == null ? null : Number(forecast.brier_score),
      direction_hit:
        forecast.direction_hit == null ? null : Number(forecast.direction_hit),
    }));
  const eventReactionCalibration = calibrationPayload(
    mappedCalibrationForecasts.filter(
      (forecast) => forecast.forecastType === "event_reaction",
    ),
  );
  const preEventResolved = mappedCalibrationForecasts.filter(
    (forecast) =>
      forecast.forecastType === "pre_event_incidence_baseline_v1" &&
      forecast.status === "resolved",
  );
  const preEventAverage = (values: number[]): number | null =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const preEventCalibration = {
    resolvedForecasts: preEventResolved.length,
    brierScore: preEventAverage(
      preEventResolved
        .map((forecast) => forecast.brier_score)
        .filter((value): value is number => value != null),
    ),
    hitRate: preEventAverage(
      preEventResolved
        .map((forecast) => forecast.direction_hit)
        .filter((value): value is number => value != null),
    ),
    model: "baseline-v1",
    target: "Tier-1 SEC P0/P1 event incidence over five US business dates",
  };
  const calibration = {
    ...eventReactionCalibration,
    byForecastType: {
      eventReaction: eventReactionCalibration,
      preEventBaseline: preEventCalibration,
    },
  };
  const enabledSources = sources.filter((source) => Number(source.enabled) === 1);
  const healthySources = enabledSources.filter(
    (source) => source.status === "healthy",
  ).length;
  const openForecasts = forecasts.filter(
    (forecast) => forecast.status === "open",
  ).length;
  const resolvedForecasts = forecasts.filter(
    (forecast) => forecast.status === "resolved",
  ).length;
  const earningsReactionByFinancialId = new Map<
    string,
    Record<string, unknown>
  >();
  for (const reaction of earningsReactionRows) {
    const financialForecastId = String(reaction.financial_forecast_id ?? "");
    if (
      financialForecastId &&
      !earningsReactionByFinancialId.has(financialForecastId)
    ) {
      earningsReactionByFinancialId.set(financialForecastId, reaction);
    }
  }
  const earningsActualByTickerPeriod = new Map<
    string,
    Record<string, unknown>
  >();
  for (const actual of earningsActualRows) {
    const key = `${String(actual.ticker)}:${String(actual.fiscal_period)}`;
    if (!earningsActualByTickerPeriod.has(key)) {
      earningsActualByTickerPeriod.set(key, actual);
    }
  }
  const earningsConsensusByTickerPeriod = new Map<
    string,
    Record<string, unknown>
  >();
  for (const consensus of earningsConsensusRows) {
    const key = `${String(consensus.ticker)}:${String(
      consensus.fiscal_period,
    )}`;
    if (!earningsConsensusByTickerPeriod.has(key)) {
      earningsConsensusByTickerPeriod.set(key, consensus);
    }
  }
  const eventResearchByEventId = new Map<string, Record<string, unknown>>();
  for (const note of eventResearchRows) {
    const eventId = String(note.event_id ?? "");
    if (eventId && !eventResearchByEventId.has(eventId)) {
      eventResearchByEventId.set(eventId, note);
    }
  }
  const priceForecastVersionCounts = new Map<string, number>();
  for (const forecast of earningsPriceForecastRows) {
    const financialForecastId = String(
      forecast.financial_forecast_id ?? "",
    );
    priceForecastVersionCounts.set(
      financialForecastId,
      (priceForecastVersionCounts.get(financialForecastId) ?? 0) + 1,
    );
  }
  const officialPriceForecastRows = earningsPriceForecastRows.filter(
    (forecast) => Number(forecast.is_official) === 1,
  );
  const resolvedOfficialPriceForecastRows = officialPriceForecastRows.filter(
    (forecast) => forecast.settlement_id != null,
  );
  const averageNumber = (values: number[]): number | null =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const medianNumber = (values: number[]): number | null => {
    if (!values.length) return null;
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 1
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const officialAbsoluteErrorPct = resolvedOfficialPriceForecastRows
    .map((forecast) => finiteNumber(forecast.absolute_error_pct))
    .filter((value): value is number => value !== null);
  const priceForecastScorecard = {
    officialForecasts: officialPriceForecastRows.length,
    resolvedForecasts: resolvedOfficialPriceForecastRows.length,
    openForecasts:
      officialPriceForecastRows.length -
      resolvedOfficialPriceForecastRows.length,
    meanAbsoluteErrorAmount: averageNumber(
      resolvedOfficialPriceForecastRows
        .map((forecast) =>
          forecast.error_amount == null
            ? null
            : Math.abs(Number(forecast.error_amount)),
        )
        .filter((value): value is number => value !== null),
    ),
    meanAbsoluteErrorPct: averageNumber(officialAbsoluteErrorPct),
    medianAbsoluteErrorPct: medianNumber(officialAbsoluteErrorPct),
    signedBiasPct: averageNumber(
      resolvedOfficialPriceForecastRows
        .map((forecast) => finiteNumber(forecast.error_pct))
        .filter((value): value is number => value !== null),
    ),
    directionHitRate: averageNumber(
      resolvedOfficialPriceForecastRows
        .map((forecast) => finiteNumber(forecast.direction_hit))
        .filter((value): value is number => value !== null),
    ),
    errorSignConvention: "predicted_minus_actual",
    percentageDenominator: "actual_post_price",
    officialVersionRule:
      "同一财报优先 final；否则使用发布前 informationCutoffAt 最晚的一版。旧版本保留但不重复计入主评分。",
    settlementRule:
      "盘后发布取下一交易日收盘；盘前发布取当天收盘。方向中性带为 ±0.5%。",
  };
  const btcPathDeviationPct = (row: Record<string, unknown>) => {
    const predicted = finiteNumber(row.predicted_path_price);
    const actual = finiteNumber(row.actual_close);
    return predicted != null && predicted > 0 && actual != null
      ? ((actual - predicted) / predicted) * 100
      : null;
  };
  const btcForecastCycleRows = [...btcForecastRows]
    .sort((left, right) =>
      String(left.forecast_date).localeCompare(String(right.forecast_date)),
    )
    .reduce<Record<string, unknown>[]>((cycles, row) => {
      const current = cycles.at(-1);
      if (
        !current ||
        String(row.forecast_date) > String(current.target_date)
      ) {
        cycles.push(row);
      }
      return cycles;
    }, []);
  const btcCanonicalForecastIds = new Set(
    btcForecastCycleRows.map((row) => String(row.id)),
  );
  const btcCurrentForecastRow =
    btcForecastCycleRows.at(-1) ?? btcForecastRows[0] ?? null;
  const btcScoredActualRows = btcActualRows.filter((row) =>
    btcCanonicalForecastIds.has(String(row.forecast_id)),
  );
  const btcAbsoluteErrors = btcScoredActualRows
    .map((row) => btcPathDeviationPct(row))
    .filter((value): value is number => value !== null)
    .map((value) => Math.abs(value))
    .filter((value): value is number => value !== null);
  const btcDirectionRows = btcScoredActualRows
    .map((row) => finiteNumber(row.direction_hit))
    .filter((value): value is number => value !== null);
  const btcTargetSettlements = btcScoredActualRows.filter(
    (row) => String(row.target_date) === String(row.forecast_target_date),
  );
  const btcActualByForecastDay = new Map(
    btcActualRows.map((row) => [
      `${String(row.forecast_id)}|${String(row.target_date)}`,
      row,
    ]),
  );
  const btcPathsByForecastId = new Map<string, Record<string, unknown>[]>();
  for (const row of btcPathRows) {
    const forecastId = String(row.forecast_id);
    const batch = btcPathsByForecastId.get(forecastId) ?? [];
    batch.push(row);
    btcPathsByForecastId.set(forecastId, batch);
  }
  const btcPathPointPayload = (row: Record<string, unknown>) => {
    const actual = btcActualByForecastDay.get(
      `${String(row.forecast_id)}|${String(row.target_date)}`,
    );
    const predictedPrice = Number(row.predicted_price);
    const actualClose =
      actual?.actual_close == null ? null : Number(actual.actual_close);
    const pathDeviationAmount =
      actualClose == null ? null : actualClose - predictedPrice;
    const pathDeviationPct =
      pathDeviationAmount == null || predictedPrice <= 0
        ? null
        : (pathDeviationAmount / predictedPrice) * 100;
    return {
      targetDate: row.target_date,
      dayOffset: Number(row.day_offset),
      predictedPrice,
      actualClose,
      pathDeviationAmount,
      pathDeviationPct,
      absoluteDeviationPct:
        pathDeviationPct == null ? null : Math.abs(pathDeviationPct),
      directionHit:
        actual?.direction_hit == null
          ? null
          : Boolean(actual.direction_hit),
      observedAt: actual?.observed_at ?? null,
    };
  };
  const btcForecastPathBatches = btcForecastCycleRows
    .map((forecast) => {
      const points = (btcPathsByForecastId.get(String(forecast.id)) ?? []).map(
        btcPathPointPayload,
      );
      return {
        forecastId: forecast.id,
        forecastDate: forecast.forecast_date,
        frozenAt: forecast.frozen_at,
        baselinePrice: Number(forecast.baseline_price),
        targetDate: forecast.target_date,
        targetPrice: Number(forecast.target_price),
        points,
      };
    })
    .filter((batch) => batch.points.length > 0);
  const btcCurrentPathBatch = btcForecastPathBatches.find(
    (batch) => String(batch.forecastId) === String(btcCurrentForecastRow?.id),
  );
  const btcVolumeRows = [...btcCandleRows].reverse();
  const recentBtcVolumes = btcVolumeRows
    .slice(-7)
    .map((row) => finiteNumber(row.volume_btc))
    .filter((value): value is number => value !== null);
  const priorBtcVolumes = btcVolumeRows
    .slice(-30)
    .map((row) => finiteNumber(row.volume_btc))
    .filter((value): value is number => value !== null);
  const btcVolume7dAverage = averageNumber(recentBtcVolumes);
  const btcVolume30dAverage = averageNumber(priorBtcVolumes);
  const dashboardNowMs = Date.now();
  const officialDeskItems = events
    .filter((event) => {
      const sourceKey = String(event.source_key ?? "");
      const priority = String(event.priority ?? "P2");
      return (
        dashboardNewsIsFresh(event.published_at, dashboardNowMs) &&
        officialDeskEventIsInvestable(event) &&
        (["P0", "P1"].includes(priority) ||
          sourceKey.startsWith("fed:") ||
          sourceKey.startsWith("bls:") ||
          sourceKey.startsWith("bea:"))
      );
    })
    .sort(
      (left, right) =>
        String(right.published_at).localeCompare(String(left.published_at)) ||
        String(right.priority).localeCompare(String(left.priority)),
    )
    .slice(0, 20)
    .map((event) => {
      const analysis = eventAnalysisPayload(event);
      return {
        id: `event-${String(event.id)}`,
        region: "US",
        marketScope:
          String(event.ticker ?? "MARKET") === "MARKET"
            ? "美股与美元资产"
            : `美股 · ${String(event.ticker)}`,
        category:
          String(event.event_type ?? "") === "macro"
            ? "美国宏观与政策"
            : "美股公司与市场",
        importanceScore:
          String(event.priority) === "P0"
            ? 96
            : String(event.priority) === "P1"
              ? 88
              : 74,
        headline: event.headline,
        titleZh: analysis.whatHappened,
        factSummaryZh: analysis.whatHappened,
        commentaryZh: analysis.whyItMatters,
        impactPathZh: analysis.impactPath,
        verificationZh: Array.isArray(analysis.verificationPoints)
          ? analysis.verificationPoints
              .map((point) => String(recordValue(point).text ?? ""))
              .filter(Boolean)
              .join("；")
          : "核对原始来源、市场价格反应与后续官方更新。",
        evidenceStatus: "官方发布",
        sourceName: event.source_name,
        sourceUrl: event.url,
        publishedAt: event.published_at,
        detectedAt: event.detected_at,
      };
    });
  const currentWorldNews = [
    ...officialDeskItems,
    ...worldNewsRows
      .filter((row) =>
        String(row.brief_version ?? "") === WORLD_NEWS_BRIEF_VERSION &&
        regionHeadlineRelevant(
          String(row.region ?? "GLOBAL"),
          String(row.headline ?? ""),
        ),
      )
      .map((row) => ({
        id: row.id,
        region: row.region,
        marketScope: row.market_scope,
        category: row.category,
        importanceScore: Number(row.importance_score),
        headline: row.headline,
        titleZh: row.title_zh,
        factSummaryZh: row.fact_summary_zh,
        commentaryZh: row.commentary_zh,
        impactPathZh: row.impact_path_zh,
        verificationZh: row.verification_zh,
        evidenceStatus: row.evidence_status,
        briefVersion: row.brief_version,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        publishedAt: row.published_at,
        detectedAt: row.detected_at,
      })),
  ]
    .filter((item) => dashboardNewsIsFresh(item.publishedAt, dashboardNowMs))
    .filter((item) => dashboardNewsBriefIsConcrete(item))
    .sort(
      (left, right) =>
        String(right.publishedAt).localeCompare(String(left.publishedAt)) ||
        Number(right.importanceScore) - Number(left.importanceScore),
    )
    .slice(0, 60);

  return jsonResponse(
    {
      snapshotAt: nowIso(),
      status,
      system: {
        monitoring: status,
        email: emailReady(env) ? "ready" : "needs_setup",
        dataMode: envBoolean(env.DRY_RUN, true) ? "dry_run" : "live",
        lastRunAt: lastRun?.finished_at ?? null,
        lastRunStatus: lastRun?.status ?? "not_started",
        scheduler: "cloudflare-cron:* * * * *",
        refreshPolicy: {
          earningsCalendar: "Official company announcements every 30 minutes; failures retain the last confirmed date and are recorded in source health.",
          ingestion: "每 1 分钟",
          browser: "页面打开时每 30 秒拉取一次最新快照",
          urgentEmail: "新发现 P0/P1 后同一轮入队并尝试发送",
          morningBriefing: "工作日 07:45 ET",
          afterCloseBriefing: "工作日 16:20 ET",
          btcMarket: "Coinbase 每 5 分钟；日线每 30 分钟",
          worldNews: "每 2 分钟轮换一个地区，约 10 分钟覆盖全球一轮；只展示最近 24 小时",
        },
        researchModel: {
          approach:
            "富途式实时监控 + Seeking Alpha 式预期修订/因子框架 + 可结算预测账本",
          sources:
            "SEC、公司 IR、Nasdaq 一致预期与最新报价、Alpaca 新闻、官方宏观源",
          xStatus: env.X_BEARER_TOKEN?.trim()
            ? "available"
            : "not_configured",
          optionsStatus: "not_configured",
        },
      },
      metrics: {
        watchlistCount: watchlist.length,
        healthySources,
        totalSources: enabledSources.length,
        openForecasts,
        resolvedForecasts,
        brierScore: calibration.brierScore,
        directionHitRate: calibration.directionHitRate,
        p95LatencyMs: percentile95(
          sources.map((row) => Number(row.last_latency_ms)).filter(Number.isFinite),
        ),
        latencyBasis: "Latest check per source (not a scan of historical run logs)",
        queuedAlerts: Number(queuedRow?.count ?? 0),
      },
      latestQuotes: latestQuoteRows.map((quote) => ({
        ticker: quote.ticker,
        price: Number(quote.price),
        currency: quote.currency ?? "USD",
        quoteAsOfAt: quote.quote_as_of_at,
        receivedAt: quote.received_at,
        marketStatus: quote.market_status,
        netChange:
          quote.net_change == null ? null : Number(quote.net_change),
        percentageChange:
          quote.percentage_change == null
            ? null
            : Number(quote.percentage_change),
        bidPrice:
          quote.bid_price == null ? null : Number(quote.bid_price),
        askPrice:
          quote.ask_price == null ? null : Number(quote.ask_price),
        volume: quote.volume == null ? null : Number(quote.volume),
        timestampBasis: quote.timestamp_basis,
        source: {
          provider: quote.provider,
          sourceUrl: quote.source_url,
          isRealtime: Boolean(quote.is_real_time),
          delayMinutes: Number(quote.delay_minutes),
        },
      })),
      btcResearch: {
        latest: btcSnapshotRows[0]
          ? {
              observedAt: btcSnapshotRows[0].observed_at,
              price: Number(btcSnapshotRows[0].price),
              open24h:
                btcSnapshotRows[0].open_24h == null
                  ? null
                  : Number(btcSnapshotRows[0].open_24h),
              high24h:
                btcSnapshotRows[0].high_24h == null
                  ? null
                  : Number(btcSnapshotRows[0].high_24h),
              low24h:
                btcSnapshotRows[0].low_24h == null
                  ? null
                  : Number(btcSnapshotRows[0].low_24h),
              change24hPct:
                btcSnapshotRows[0].change_24h_pct == null
                  ? null
                  : Number(btcSnapshotRows[0].change_24h_pct),
              volume24hBtc:
                btcSnapshotRows[0].volume_24h_btc == null
                  ? null
                  : Number(btcSnapshotRows[0].volume_24h_btc),
              volume24hUsd:
                btcSnapshotRows[0].volume_24h_usd == null
                  ? null
                  : Number(btcSnapshotRows[0].volume_24h_usd),
              volume30dBtc:
                btcSnapshotRows[0].volume_30d_btc == null
                  ? null
                  : Number(btcSnapshotRows[0].volume_30d_btc),
              source: {
                name: btcSnapshotRows[0].source_name,
                url: btcSnapshotRows[0].source_url,
              },
            }
          : null,
        snapshots: [...btcSnapshotRows].reverse().map((row) => ({
          observedAt: row.observed_at,
          price: Number(row.price),
          volume24hBtc:
            row.volume_24h_btc == null ? null : Number(row.volume_24h_btc),
        })),
        candles: btcVolumeRows.map((row) => ({
          day: row.day,
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volumeBtc: Number(row.volume_btc),
          observedAt: row.observed_at,
        })),
        forecasts: (btcCurrentForecastRow ? [btcCurrentForecastRow] : []).map((row) => ({
          id: row.id,
          forecastDate: row.forecast_date,
          baselinePrice: Number(row.baseline_price),
          targetDate: row.target_date,
          targetPrice: Number(row.target_price),
          predictedReturnPct: Number(row.predicted_return_pct),
          researchLow: Number(row.research_low),
          researchHigh: Number(row.research_high),
          stance: row.stance,
          thesis: row.thesis,
          drivers: parseJsonArray(row.drivers_json as string | null),
          invalidationCondition: row.invalidation_condition,
          features: parseJsonRecord(
            row.feature_snapshot_json as string | null,
          ),
          modelVersion: row.model_version,
          informationCutoffAt: row.information_cutoff_at,
          frozenAt: row.frozen_at,
        })),
        latestPath: btcCurrentPathBatch?.points ?? [],
        backtests: btcScoredActualRows.map((row) => ({
          forecastId: row.forecast_id,
          forecastDate: row.forecast_date,
          targetDate: row.target_date,
          forecastTargetDate: row.forecast_target_date,
          baselinePrice: Number(row.baseline_price),
          targetPrice: Number(row.target_price),
          actualClose: Number(row.actual_close),
          predictedPathPrice: Number(row.predicted_path_price),
          errorAmount:
            Number(row.actual_close) - Number(row.predicted_path_price),
          errorPct: btcPathDeviationPct(row),
          absoluteErrorPct:
            btcPathDeviationPct(row) == null
              ? null
              : Math.abs(btcPathDeviationPct(row) as number),
          directionHit:
            row.direction_hit == null ? null : Boolean(row.direction_hit),
          observedAt: row.observed_at,
        })),
        volume: {
          average7dBtc: btcVolume7dAverage,
          average30dBtc: btcVolume30dAverage,
          ratio7dTo30d:
            btcVolume7dAverage != null &&
            btcVolume30dAverage != null &&
            btcVolume30dAverage > 0
              ? btcVolume7dAverage / btcVolume30dAverage
              : null,
        },
        scorecard: {
          forecastsFrozen: btcForecastCycleRows.length,
          dailyComparisons: btcScoredActualRows.length,
          settled30dForecasts: btcTargetSettlements.length,
          settledDirectionHits: btcTargetSettlements.filter((row) => Boolean(row.direction_hit)).length,
          meanAbsoluteTargetErrorPct: averageNumber(
            btcTargetSettlements.map((row) =>
              Math.abs((Number(row.target_price) / Number(row.actual_close) - 1) * 100),
            ),
          ),
          noChangeMeanAbsoluteErrorPct: averageNumber(
            btcTargetSettlements.map((row) =>
              Math.abs((Number(row.baseline_price) / Number(row.actual_close) - 1) * 100),
            ),
          ),
          meanAbsolutePathDeviationPct: averageNumber(btcAbsoluteErrors),
          medianAbsolutePathDeviationPct: medianNumber(btcAbsoluteErrors),
          signedBiasPct: averageNumber(
            btcScoredActualRows
              .map((row) => btcPathDeviationPct(row))
              .filter((value): value is number => value !== null),
          ),
          dailyPathDirectionAlignment: averageNumber(btcDirectionRows),
          rule:
            "每30天只冻结一条预测路径；周期内不重新预测，只追加每日实际收盘和偏离。路径偏离=(实际-预测)/预测。",
        },
      },
      worldNews: currentWorldNews,
      earningsPriceForecasts: officialPriceForecastRows.map((forecast) => {
        const source = parseJsonRecord(forecast.source_json as string | null);
        const quoteSource = recordValue(source.quote);
        return {
          id: forecast.id,
          financialForecastId: forecast.financial_forecast_id,
          reactionForecastId: forecast.reaction_forecast_id,
          supersedesForecastId: forecast.supersedes_forecast_id ?? null,
          ticker: forecast.ticker,
          fiscalPeriod: forecast.fiscal_period,
          earningsDate: forecast.earnings_date,
          releaseTiming: forecast.release_timing,
          targetSession: forecast.target_session,
          referencePrice: Number(forecast.reference_price),
          referencePriceAt: forecast.reference_price_at,
          predictedPostPrice: Number(forecast.predicted_post_price),
          predictedChangePct: Number(forecast.predicted_change_pct),
          forecastStance: forecast.forecast_stance,
          forecastRole: forecast.forecast_role,
          thesis: forecast.thesis,
          keyDrivers: parseJsonArray(
            forecast.key_drivers_json as string | null,
          ),
          informationCutoffAt: forecast.information_cutoff_at,
          modelVersion: forecast.model_version,
          versionCount:
            priceForecastVersionCounts.get(
              String(forecast.financial_forecast_id),
            ) ?? 1,
          status:
            forecast.settlement_id == null ? "open" : "resolved",
          actualPostPrice:
            forecast.actual_post_price == null
              ? null
              : Number(forecast.actual_post_price),
          actualPriceAt: forecast.actual_price_at ?? null,
          actualChangePct:
            forecast.actual_change_pct == null
              ? null
              : Number(forecast.actual_change_pct),
          errorAmount:
            forecast.error_amount == null
              ? null
              : Number(forecast.error_amount),
          errorPct:
            forecast.error_pct == null
              ? null
              : Number(forecast.error_pct),
          absoluteErrorPct:
            forecast.absolute_error_pct == null
              ? null
              : Number(forecast.absolute_error_pct),
          directionHit:
            forecast.direction_hit == null
              ? null
              : Boolean(forecast.direction_hit),
          resolvedAt: forecast.evaluated_at ?? null,
          source: {
            provider:
              quoteSource.provider ??
              forecast.reference_quote_provider,
            sourceUrl: quoteSource.sourceUrl ?? null,
            isRealtime:
              quoteSource.isRealTime == null
                ? Boolean(forecast.reference_quote_is_real_time)
                : Boolean(quoteSource.isRealTime),
            delayMinutes:
              quoteSource.delayMinutes == null
                ? Number(forecast.reference_quote_delay_minutes)
                : Number(quoteSource.delayMinutes),
            quoteAsOfAt:
              quoteSource.quoteAsOfAt ?? forecast.reference_price_at,
            settlementProvider:
              forecast.actual_price_provider ?? null,
            evidence: source,
          },
        };
      }),
      priceForecastScorecard,
      events: events.map((event) => {
        const research = eventResearchByEventId.get(String(event.id));
        return {
        id: event.id,
        sourceKey: event.source_key,
        sourceEventId: event.source_event_id,
        ticker: event.ticker,
        eventType: event.event_type,
        headline: event.headline,
        summary: event.summary,
        priority: event.priority,
        sourceName: event.source_name,
        sourceTier: Number(event.source_tier),
        publishedAt: event.published_at,
        detectedAt: event.detected_at,
        url: event.url,
        direction: event.direction,
        confidence: Number(event.confidence),
        analysis: eventAnalysisPayload(event),
        contentResearch: research
          ? {
              id: research.id,
              documentType: research.document_type,
              documentUrl: research.document_url,
              sourceUrl: research.source_url,
              informationCutoffAt: research.information_cutoff_at,
              headline: research.headline,
              keyMetrics: parseJsonRecordArray(
                research.key_metrics_json as string | null,
              ).map((metric) =>
                String(metric.label) === "CapEx" &&
                /remaining in accounts payable/i.test(String(metric.text))
                  ? {
                      ...metric,
                      label: "资本开支相关应付款",
                      interpretation:
                        "这是尚在应付账款中的设备采购承诺，不等同于当期现金资本开支。",
                    }
                  : metric,
              ),
              keyPoints: parseJsonRecordArray(
                research.key_points_json as string | null,
              ),
              evidence: parseJsonRecordArray(
                research.evidence_json as string | null,
              ),
              status: research.status,
            }
          : null,
      };
      }),
      forecasts: forecasts.map((forecast) => ({
        id: forecast.id,
        ticker: forecast.ticker,
        forecastType: forecast.forecast_type,
        targetDefinition: forecast.target_definition,
        horizon: forecast.horizon,
        probabilityUp: Number(forecast.probability_up),
        probabilityBase: Number(forecast.probability_base),
        probabilityDown: Number(forecast.probability_down),
        returnLow:
          forecast.return_low == null ? null : Number(forecast.return_low),
        returnHigh:
          forecast.return_high == null ? null : Number(forecast.return_high),
        benchmark: forecast.benchmark,
        rationale: forecast.rationale,
        status: forecast.status,
        createdAt: forecast.created_at,
        informationCutoffAt: forecast.information_cutoff_at,
        resolutionAt: forecast.resolution_at,
        actualOutcome: forecast.actual_outcome ?? null,
        relativeReturn:
          forecast.relative_return == null
            ? null
            : Number(forecast.relative_return),
        brierScore:
          forecast.brier_score == null ? null : Number(forecast.brier_score),
        directionHit:
          forecast.direction_hit == null
            ? null
            : Boolean(forecast.direction_hit),
        qualityFlag: forecast.quality_flag ?? null,
      })),
      earningsForecasts: earningsForecastRows.map((forecast) => {
        const actual = earningsActualByTickerPeriod.get(
          `${String(forecast.ticker)}:${String(forecast.fiscal_period)}`,
        );
        const actualRevenue =
          actual?.revenue == null && forecast.actual_revenue == null
            ? null
            : Number(actual?.revenue ?? forecast.actual_revenue);
        const actualEps =
          actual?.eps == null && forecast.actual_eps == null
            ? null
            : Number(actual?.eps ?? forecast.actual_eps);
        const revenueEstimate =
          forecast.revenue_estimate == null
            ? null
            : Number(forecast.revenue_estimate);
        const epsEstimate =
          forecast.eps_estimate == null ? null : Number(forecast.eps_estimate);
        return {
        id: forecast.id,
        ticker: forecast.ticker,
        fiscalPeriod: forecast.fiscal_period,
        expectedWindow: {
          start: forecast.expected_window_start,
          end: forecast.expected_window_end,
        },
        windowConfidence: Number(forecast.window_confidence),
        informationCutoffAt: forecast.information_cutoff_at,
        forecastMethod: "SEC 季节性基线（非华尔街一致预期）",
        forecastMethodVersion: forecast.forecast_method,
        revenueEstimate:
          forecast.revenue_estimate == null
            ? null
            : Number(forecast.revenue_estimate),
        revenueUnit: forecast.revenue_unit ?? null,
        epsEstimate:
          forecast.eps_estimate == null
            ? null
            : Number(forecast.eps_estimate),
        epsUnit: forecast.eps_unit ?? null,
        status: forecast.status,
        actualRevenue,
        actualEps,
        revenueErrorPct:
          revenueEstimate === null || actualRevenue === null || actualRevenue === 0
            ? null
            : (revenueEstimate - actualRevenue) / Math.abs(actualRevenue),
        epsError:
          epsEstimate === null || actualEps === null
            ? null
            : epsEstimate - actualEps,
        sourceQuality: forecast.source_quality,
        notes: [forecast.notes, forecast.resolution_notes]
          .filter(Boolean)
          .join(" "),
        actualAccession:
          actual?.accession ?? forecast.actual_accession ?? null,
        actualFiledAt:
          actual?.available_at ?? forecast.actual_filed_at ?? null,
        actualSourceUrl:
          actual?.source_url ?? forecast.actual_source_url ?? null,
        actualSourceName: actual?.source_name ?? null,
        actualSourceQuality: actual?.source_quality ?? null,
        createdAt: forecast.created_at,
        resolvedAt: forecast.resolved_at ?? null,
        modelSource: {
          name: "SEC Company Facts",
          url: `${SEC_COMPANY_FACTS_BASE_URL}/CIK${String(
            forecast.cik,
          )}.json`,
          basis:
            "公司 XBRL 历史可比数据；模型值不是公司指引，也不是分析师一致预期。",
        },
        earningsEvent: earningsEventProfile(
          forecast.ticker,
          forecast.fiscal_period,
          earningsCalendar,
        ),
        analystConsensus: (() => {
          const consensus = earningsConsensusByTickerPeriod.get(
            `${String(forecast.ticker)}:${String(forecast.fiscal_period)}`,
          );
          if (!consensus) return null;
          const raw = parseJsonRecord(consensus.raw_json as string | null);
          return {
            id: consensus.id,
            provider: consensus.provider,
            asOfAt: consensus.as_of_at,
            sourceUrl: consensus.source_url,
            revenue:
              consensus.revenue_consensus == null
                ? null
                : Number(consensus.revenue_consensus),
            revenueUnit: consensus.revenue_unit ?? null,
            eps:
              consensus.eps_consensus == null
                ? null
                : Number(consensus.eps_consensus),
            epsUnit: consensus.eps_unit ?? null,
            analystCount:
              consensus.analyst_count == null
                ? null
                : Number(consensus.analyst_count),
            fiscalEnd: raw.fiscalEnd ?? null,
            epsHigh:
              raw.highEPSForecast == null
                ? null
                : Number(raw.highEPSForecast),
            epsLow:
              raw.lowEPSForecast == null
                ? null
                : Number(raw.lowEPSForecast),
            revisionsUp:
              raw.revisionsUp == null ? null : Number(raw.revisionsUp),
            revisionsDown:
              raw.revisionsDown == null ? null : Number(raw.revisionsDown),
          };
        })(),
        marketReaction: (() => {
          const reaction = earningsReactionByFinancialId.get(
            String(forecast.id),
          );
          if (!reaction) return null;
          return {
            id: reaction.id,
            forecastId: reaction.id,
            financialForecastId: reaction.financial_forecast_id,
            releaseWindow: {
              start: reaction.release_window_start,
              end: reaction.release_window_end,
            },
            releaseWindowBasis: reaction.release_window_basis,
            informationCutoffAt: reaction.information_cutoff_at,
            targetDefinition: reaction.target_definition,
            probabilityUp: Number(reaction.probability_up),
            probabilityBase: Number(reaction.probability_base),
            probabilityDown: Number(reaction.probability_down),
            predictedDirection: reaction.predicted_direction,
            expectedRelativeReturn:
              reaction.expected_relative_return == null
                ? null
                : Number(reaction.expected_relative_return),
            reactionLow:
              reaction.reaction_low == null
                ? null
                : Number(reaction.reaction_low),
            reactionHigh:
              reaction.reaction_high == null
                ? null
                : Number(reaction.reaction_high),
            reactionRangeBasis: reaction.reaction_range_basis,
            benchmark: reaction.benchmark,
            sampleSize: Number(reaction.sample_size),
            modelConfidence: reaction.model_confidence,
            modelVersion: reaction.model_version,
            consensusStatus: reaction.consensus_status,
            keyDrivers: parseJsonArray(
              reaction.key_drivers_json as string | null,
            ),
            featureSnapshot: parseJsonRecord(
              reaction.feature_snapshot_json as string | null,
            ),
            invalidationCondition: reaction.invalidation_condition,
            status: reaction.status,
            actualRelativeReturn:
              reaction.actual_relative_return == null
                ? null
                : Number(reaction.actual_relative_return),
            actualOutcome: reaction.actual_outcome ?? null,
            brierScore:
              reaction.brier_score == null
                ? null
                : Number(reaction.brier_score),
            directionHit:
              reaction.direction_hit == null
                ? null
                : Boolean(reaction.direction_hit),
            intervalHit:
              reaction.interval_hit == null
                ? null
                : Boolean(reaction.interval_hit),
            resolutionNotes: reaction.resolution_notes ?? null,
            resolvedAt: reaction.resolved_at ?? null,
          };
        })(),
        };
      }),
      briefings: briefingRows.map((briefing) => ({
        id: briefing.id,
        briefingType: briefing.briefing_type,
        title: briefing.title,
        summary: briefing.summary,
        generatedAt: briefing.generated_at,
        status: briefing.status,
        emailStatus: briefing.email_status ?? "not_scheduled",
        eventCount: Number(briefing.event_count),
        p0Count: Number(briefing.p0_count),
        p1Count: Number(briefing.p1_count),
        items: parseJsonRecordArray(briefing.items_json as string),
        recipient: briefing.recipient ?? null,
        sentAt: briefing.sent_at ?? null,
        providerMessageId: briefing.provider_message_id ?? null,
        lastError: briefing.last_error ?? null,
      })),
      calibration,
      watchlist: watchlist.map((item) => ({
        symbol: item.symbol,
        companyName: item.company_name,
        cik: item.cik,
        tier: Number(item.tier),
        active: Boolean(item.active),
        secForms: parseJsonArray(item.sec_forms as string),
        keywords: parseJsonArray(item.keywords as string),
        lastEventAt: item.last_event_at ?? null,
        updatedAt: item.updated_at,
      })),
      runs: runs.map((run) => ({
        id: run.id,
        triggerType: run.trigger_type,
        dryRun: Boolean(run.dry_run),
        startedAt: run.started_at,
        finishedAt: run.finished_at ?? null,
        status: run.status,
        sourcesTotal: Number(run.sources_total),
        sourcesSucceeded: Number(run.sources_succeeded),
        sourcesFailed: Number(run.sources_failed),
        eventsSeen: Number(run.events_seen),
        eventsNew: Number(run.events_new),
        alertsQueued: Number(run.alerts_queued),
        alertsSent: Number(run.alerts_sent),
        durationMs: run.duration_ms == null ? null : Number(run.duration_ms),
        error: run.error ?? null,
      })),
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        tier: Number(source.tier),
        required: Boolean(source.required),
        enabled: Boolean(source.enabled),
        status: source.status,
        cursor: source.cursor ?? null,
        lastCheckedAt: source.last_checked_at ?? null,
        lastSuccessAt: source.last_success_at ?? null,
        lastFailureAt: source.last_failure_at ?? null,
        lastLatencyMs:
          source.last_latency_ms == null
            ? null
            : Number(source.last_latency_ms),
        itemsSeen: Number(source.items_seen),
        itemsNew: Number(source.items_new),
        lastError: source.last_error ?? null,
      })),
      alerts: outbox.map((item) => ({
        id: item.id,
        eventId: item.event_id,
        ticker: item.ticker,
        priority: item.priority,
        channel: item.channel,
        recipient: item.recipient,
        subject: item.subject,
        status: item.status,
        attempts: Number(item.attempts),
        nextAttemptAt: item.next_attempt_at ?? null,
        providerMessageId: item.provider_message_id ?? null,
        lastError: item.last_error ?? null,
        createdAt: item.created_at,
        sentAt: item.sent_at ?? null,
      })),
      outbox: outbox.map((item) => ({
        id: item.id,
        eventId: item.event_id,
        status: item.status,
        attempts: Number(item.attempts),
        nextAttemptAt: item.next_attempt_at ?? null,
        lastError: item.last_error ?? null,
      })),
    },
    200,
    cors,
  );
}

async function healthResponse(env: Env): Promise<Response> {
  const checkedAt = nowIso();
  try {
    await queryFirst<{ ok: number }>(env.DB, "SELECT 1 AS ok");
    const lastRun = await queryFirst<{
      status: string;
      finished_at: string | null;
    }>(
      env.DB,
      `SELECT status, finished_at FROM runs ORDER BY started_at DESC LIMIT 1`,
    );
    const unhealthy = await queryFirst<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count
       FROM sources
       WHERE required = 1 AND enabled = 1 AND status <> 'healthy'`,
    );
    const unresolvedData = await queryFirst<{ count: number }>(
      env.DB,
      `SELECT COUNT(*) AS count
       FROM forecasts
       WHERE status = 'open'
         AND resolution_at <= ?
         AND quality_flag = 'data_unavailable'`,
      checkedAt,
    );
    const stale =
      lastRun?.finished_at != null &&
      !isRecent(lastRun.finished_at, 5 * 60_000);
    const degraded =
      lastRun?.status === "failed" ||
      Number(unhealthy?.count ?? 0) > 0 ||
      Number(unresolvedData?.count ?? 0) > 0;
    return jsonResponse({
      status: stale
        ? "stale"
        : degraded
          ? "degraded"
          : "ok",
      service: "market-signal-monitor",
      checkedAt,
      database: "ok",
      scheduler: "every_minute",
      lastRunAt: lastRun?.finished_at ?? null,
      lastRunStatus: lastRun?.status ?? "not_started",
      unresolvedForecastsWithMissingData: Number(unresolvedData?.count ?? 0),
      unhealthyRequiredSources: Number(unhealthy?.count ?? 0),
    });
  } catch (caught) {
    return jsonResponse(
      {
        status: "error",
        service: "market-signal-monitor",
        checkedAt,
        database: "unavailable",
        error: truncate(
          caught instanceof Error ? caught.message : "D1 health check failed",
          500,
        ),
      },
      503,
    );
  }
}

async function testEmailResponse(
  request: Request,
  env: Env,
): Promise<Response> {
  const configuredSecret = env.CRON_SECRET?.trim();
  if (!configuredSecret) {
    return jsonResponse({ error: "CRON_SECRET is not configured." }, 503);
  }
  if (!constantTimeEqual(requestBearer(request), configuredSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";
  const dryRun = envBoolean(env.DRY_RUN, true);
  const recipient = alertRecipient(env);
  const at = nowIso();
  const subject = "【测试成功】美股监控邮件通道";
  if (dryRun && !force) {
    return jsonResponse({
      ok: true,
      status: "dry_run",
      sent: false,
      recipient,
      subject,
      message:
        "DRY_RUN is enabled. Add force=1 to this protected test-only route to perform one real delivery attempt.",
    });
  }
  if (!emailReady(env)) {
    return jsonResponse(
      {
        ok: false,
        status: "needs_setup",
        sent: false,
        recipient,
        subject,
        error:
          "Configure Gmail webhook or a verified Resend sender.",
      },
      503,
    );
  }
  const item: EmailOutboxItem = {
    id: await sha256Hex(`test-email|${at}|${recipient}|${crypto.randomUUID()}`),
    recipient,
    subject,
    text_body: [
      "美股监控邮件测试",
      "",
      "这封邮件用于确认自动告警通道可以正常送达，不是市场突发提醒。",
      "",
      `生成时间：${formatEtDateTime(at)}`,
      `收件地址：${recipient}`,
    ].join("\n"),
    html_body: [
      '<!doctype html><html><body style="font-family:Arial,sans-serif">',
      "<h2>美股监控邮件测试</h2>",
      "<p>这封邮件用于确认自动告警通道可以正常送达，不是市场突发提醒。</p>",
      `<p>生成时间：${escapeHtml(formatEtDateTime(at))}</p>`,
      "</body></html>",
    ].join(""),
    status: "test",
    attempts: 0,
  };
  try {
    const delivery = await sendOutboxItem(env, item);
    return jsonResponse(
      {
        ok: delivery.sent,
        status: delivery.sent ? "sent" : "failed",
        sent: delivery.sent,
        recipient,
        subject,
        providerMessageId: delivery.providerId ?? null,
        error: delivery.error ?? null,
      },
      delivery.sent ? 200 : 502,
    );
  } catch (caught) {
    return jsonResponse(
      {
        ok: false,
        status: "failed",
        sent: false,
        recipient,
        subject,
        error: truncate(
          caught instanceof Error ? caught.message : "Unknown email failure",
          500,
        ),
      },
      502,
    );
  }
}

async function accessRequestEmailResponse(
  request: Request,
  env: Env,
): Promise<Response> {
  const configuredSecret = env.CRON_SECRET?.trim();
  if (!configuredSecret) {
    return jsonResponse({ error: "CRON_SECRET is not configured." }, 503);
  }
  if (!constantTimeEqual(requestBearer(request), configuredSecret)) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }
  if (!emailReady(env)) {
    return jsonResponse(
      {
        ok: false,
        status: "needs_setup",
        error: "Configure Gmail webhook or a verified Resend sender.",
      },
      503,
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    requestId?: string;
    requesterEmail?: string;
    requesterName?: string;
    approvalUrl?: string;
    ownerEmail?: string;
  } | null;
  const requestId = truncate(String(payload?.requestId ?? "").trim(), 160);
  const requesterEmail = truncate(
    String(payload?.requesterEmail ?? "").trim().toLowerCase(),
    320,
  );
  const requesterName = truncate(
    String(payload?.requesterName ?? "").trim() || "未提供姓名",
    160,
  );
  const approvalUrlValue = String(payload?.approvalUrl ?? "").trim();
  let approvalUrl: URL;
  try {
    approvalUrl = new URL(approvalUrlValue);
  } catch {
    return jsonResponse({ error: "Invalid approval URL." }, 422);
  }
  if (
    !requestId ||
    !requesterEmail.includes("@") ||
    approvalUrl.protocol !== "https:" ||
    !approvalUrl.hostname.endsWith(".chatgpt.site") ||
    approvalUrl.pathname !== "/access/approve"
  ) {
    return jsonResponse({ error: "Invalid access request payload." }, 422);
  }

  const recipient = alertRecipient(env);
  const requestedOwner = String(payload?.ownerEmail ?? "")
    .trim()
    .toLowerCase();
  if (requestedOwner && requestedOwner !== recipient.toLowerCase()) {
    return jsonResponse({ error: "Owner recipient mismatch." }, 422);
  }
  const subject = `【访问申请】${requesterName} 请求查看 Signal Ledger`;
  const text = [
    "Signal Ledger 网站访问申请",
    "",
    `申请人：${requesterName}`,
    `登录邮箱：${requesterEmail}`,
    "",
    "请打开下面的安全审批页面，选择“批准访问”或“拒绝”：",
    approvalUrl.toString(),
    "",
    "在你明确批准前，对方看不到任何研究数据，也不能执行刷新、测试邮件或冻结预测等管理操作。",
  ].join("\n");
  const html = [
    '<!doctype html><html><body style="margin:0;background:#f4f1e8;font-family:Arial,sans-serif;color:#10243b">',
    '<div style="max-width:640px;margin:0 auto;padding:36px 22px">',
    '<div style="background:#fff;border:1px solid #d9d2c3;padding:32px">',
    '<p style="margin:0 0 12px;color:#ef6a4c;font-size:12px;font-weight:700;letter-spacing:2px">SIGNAL LEDGER · 访问申请</p>',
    '<h1 style="font-size:28px;line-height:1.25;margin:0 0 24px">有人请求查看你的美股研究网站</h1>',
    `<p style="font-size:17px;line-height:1.7;margin:0"><strong>申请人：</strong>${escapeHtml(requesterName)}</p>`,
    `<p style="font-size:17px;line-height:1.7;margin:0 0 26px"><strong>登录邮箱：</strong>${escapeHtml(requesterEmail)}</p>`,
    `<a href="${escapeHtml(approvalUrl.toString())}" style="display:inline-block;background:#10243b;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px">打开审批页面</a>`,
    '<p style="font-size:14px;line-height:1.6;color:#66758a;margin:26px 0 0">在你明确批准前，对方看不到任何研究数据。批准后也只有只读权限。</p>',
    "</div></div></body></html>",
  ].join("");
  const item: EmailOutboxItem = {
    id: await sha256Hex(
      `access-request|${requestId}|${approvalUrl.toString()}|${recipient}`,
    ),
    recipient,
    subject,
    text_body: text,
    html_body: html,
    status: "access_request",
    attempts: 0,
  };

  try {
    const delivery = await sendOutboxItem(env, item);
    return jsonResponse(
      {
        ok: delivery.sent,
        status: delivery.sent ? "sent" : "failed",
        sent: delivery.sent,
        recipient,
        providerMessageId: delivery.providerId ?? null,
        error: delivery.error ?? null,
      },
      delivery.sent ? 200 : 502,
    );
  } catch (caught) {
    return jsonResponse(
      {
        ok: false,
        status: "failed",
        sent: false,
        error: truncate(
          caught instanceof Error ? caught.message : "Unknown email failure",
          500,
        ),
      },
      502,
    );
  }
}

async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS" && url.pathname === "/api/dashboard") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return healthResponse(env);
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    // Authorization always precedes cache lookup, including warm-cache hits.
    if (!dashboardAuthValid(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders(request, env));
    }
    try {
      const key = new URL("/__snapshot/dashboard-v1", request.url).href;
      const snapshot = await getDashboardSnapshot(key, async () => {
        const response = await dashboardResponse(request, env);
        if (!response.ok) throw new Error("Dashboard snapshot unavailable");
        return await response.json() as Record<string, unknown>;
      });
      return jsonResponse(snapshotPayload(snapshot), 200, corsHeaders(request, env));
    } catch (caught) {
      return jsonResponse(
        {
          error: "Dashboard query failed",
          detail: truncate(
            caught instanceof Error ? caught.message : "Unknown D1 failure",
            500,
          ),
        },
        500,
        corsHeaders(request, env),
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/api/forecasts") {
    try {
      return await createManualForecast(request, env);
    } catch (caught) {
      return jsonResponse(
        {
          error: "Forecast could not be frozen",
          detail: truncate(
            caught instanceof Error ? caught.message : "Unknown D1 failure",
            500,
          ),
        },
        500,
      );
    }
  }

  if (request.method === "POST" && url.pathname === "/internal/test-email") {
    return testEmailResponse(request, env);
  }

  if (
    request.method === "POST" &&
    url.pathname === "/internal/access-request-email"
  ) {
    return accessRequestEmailResponse(request, env);
  }

  if (request.method === "POST" && url.pathname === "/internal/run") {
    const configuredSecret = env.CRON_SECRET?.trim();
    if (!configuredSecret) {
      return jsonResponse(
        { error: "CRON_SECRET is not configured." },
        503,
      );
    }
    if (!constantTimeEqual(requestBearer(request), configuredSecret)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const dryRunParameter = url.searchParams.get("dry_run");
    const requestedDryRun =
      dryRunParameter == null
        ? undefined
        : envBoolean(dryRunParameter, false);
    try {
      const summary = await runMonitor(env, "manual", requestedDryRun);
      return jsonResponse(summary, summary.status === "failed" ? 500 : 200);
    } catch (caught) {
      return jsonResponse(
        {
          error: "Monitor run could not start",
          detail: truncate(
            caught instanceof Error ? caught.message : "Unknown failure",
            500,
          ),
        },
        500,
      );
    }
  }

  // TEST MODE ONLY. Unreachable in production: the route 404s unless
  // TESTMODE_POSTCLOSE is set, and that variable only ever exists for a
  // `wrangler dev --remote` session. It reads and computes but never writes.
  if (request.method === "GET" && url.pathname === "/internal/testmode/postclose") {
    const testToken = env.TESTMODE_POSTCLOSE?.trim();
    if (!testToken) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!constantTimeEqual(requestBearer(request), testToken)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const sessionDate = url.searchParams.get("session") ?? newYorkDate(nowIso());
    try {
      return jsonResponse(await buildPostCloseTestModel(env, sessionDate));
    } catch (caught) {
      return jsonResponse(
        { ok: false, note: caught instanceof Error ? caught.message : "Unknown failure" },
        500,
      );
    }
  }

  // Server-to-server only. Pages nudges this after queueing an auth email so a
  // waiting user does not sit through a cron interval; the minute cron remains
  // the delivery guarantee if the nudge is lost.
  if (request.method === "POST" && url.pathname === "/internal/service-email/flush") {
    const configured = env.SERVICE_EMAIL_FLUSH_TOKEN?.trim();
    if (!configured) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!constantTimeEqual(requestBearer(request), configured)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    try {
      return jsonResponse(await flushServiceEmailOutbox(env));
    } catch (caught) {
      return jsonResponse({ error: caught instanceof Error ? caught.message : "Unknown failure" }, 500);
    }
  }

  // Sandbox-safe import of the canonical post-close Daily Brief artifact. The
  // billing sandbox has no market schema and no Alpaca credentials, so it cannot
  // run the real research pipeline; this route is how the ONE canonical brief the
  // real pipeline produced gets into the sandbox for fan-out. Gated by the same
  // server-to-server secret as the flush nudge. It validates the artifact and
  // refuses any body that still carries the placeholder markers of a brief
  // rendered from an empty model.
  if (request.method === "POST" && url.pathname === "/internal/daily-brief/artifact") {
    const configured = env.SERVICE_EMAIL_FLUSH_TOKEN?.trim();
    if (!configured) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!constantTimeEqual(requestBearer(request), configured)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = (await request.json().catch(() => null)) as {
      sessionDate?: string;
      subject?: string;
      text?: string;
      html?: string;
    } | null;

    const sessionDate = body?.sessionDate;
    if (!sessionDate || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      return jsonResponse({ error: "sessionDate must be YYYY-MM-DD" }, 400);
    }
    const subject = body?.subject ?? "";
    const text = body?.text ?? "";
    const html = body?.html ?? "";

    const problems = validateCanonicalArtifact({ subject, text, html });
    if (problems.length) {
      return jsonResponse({ error: "Artifact rejected", problems }, 400);
    }

    try {
      const { written } = await upsertDailyBriefArtifact(env.DB, {
        sessionDate,
        subject,
        text,
        html,
        nowIso: nowIso(),
      });
      return jsonResponse({ ok: true, sessionDate, written, subject }, 200);
    } catch (caught) {
      return jsonResponse({ error: caught instanceof Error ? caught.message : "Unknown failure" }, 500);
    }
  }

  // Sandbox-safe manual trigger for the PRO Daily Brief fan-out. Gated by the
  // same server-to-server secret as the flush nudge. It fans out the canonical
  // brief — either the one imported for the session above, or a fully rendered
  // brief passed inline — and never rebuilds research content itself: the
  // sandbox has no market data, so it fails closed when no canonical artifact is
  // available rather than shipping placeholders.
  if (request.method === "POST" && url.pathname === "/internal/daily-brief/fanout") {
    const configured = env.SERVICE_EMAIL_FLUSH_TOKEN?.trim();
    if (!configured) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!constantTimeEqual(requestBearer(request), configured)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = (await request.json().catch(() => null)) as {
      sessionDate?: string;
      subject?: string;
      text?: string;
      html?: string;
    } | null;

    const sessionDate = body?.sessionDate ?? newYorkDate(nowIso());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      return jsonResponse({ error: "sessionDate must be YYYY-MM-DD" }, 400);
    }

    // Reuse, never regenerate. A fully rendered brief may be supplied inline;
    // otherwise the canonical artifact imported for this session is read. When
    // neither exists there is nothing valid to send, so the route fails closed.
    const inline =
      body?.subject && body?.text && body?.html
        ? { sessionDate, subject: body.subject, text: body.text, html: body.html }
        : null;

    let canonical = inline;
    if (!canonical) {
      const stored = await readDailyBriefArtifact(env.DB, sessionDate);
      if (stored) {
        canonical = { sessionDate, subject: stored.subject, text: stored.text, html: stored.html };
      }
    }

    if (!canonical) {
      return jsonResponse(
        {
          error: "No canonical brief available",
          detail:
            `No daily_brief_artifacts row exists for ${sessionDate} and no inline subject/text/html was supplied. ` +
            "Import the canonical brief first via POST /internal/daily-brief/artifact. " +
            "The fan-out will not regenerate research content from an empty model.",
        },
        409,
      );
    }

    // Defense in depth: even an inline or stored artifact must clear the same
    // placeholder gate as the import route, so a low-data body can never ship.
    const problems = validateCanonicalArtifact(canonical);
    if (problems.length) {
      return jsonResponse({ error: "Canonical brief rejected", problems }, 400);
    }

    try {
      const summary = await fanoutDailyBrief(env, canonical);
      const flush = await flushServiceEmailOutbox(env);
      return jsonResponse({ ...summary, flush }, 200);
    } catch (caught) {
      return jsonResponse(
        { ok: false, error: caught instanceof Error ? caught.message : "Unknown failure" },
        500,
      );
    }
  }

  // TEST MODE ONLY. A one-time manual send. Unreachable in production: the
  // route 404s unless TESTMODE_POSTCLOSE is set, which never happens on the
  // deployed worker. It sends exactly once per key and schedules nothing.
  if (request.method === "POST" && url.pathname === "/internal/testmode/send-postclose") {
    const testToken = env.TESTMODE_POSTCLOSE?.trim();
    if (!testToken) {
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (!constantTimeEqual(requestBearer(request), testToken)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    if (url.searchParams.get("confirm") !== "yes") {
      return jsonResponse({ error: "Refusing to send without confirm=yes" }, 400);
    }
    const sendKey = url.searchParams.get("key")?.trim() ?? "";
    const sessionDate = url.searchParams.get("session")?.trim() ?? "";
    // The key is namespaced so a manual resend can never collide with the
    // scheduled postclose:<session> key and block or duplicate it.
    if (!/^manual-postclose:\d{4}-\d{2}-\d{2}:v\d+$/.test(sendKey)) {
      return jsonResponse({ error: "A manual-postclose:<session>:v<n> key is required" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
      return jsonResponse({ error: "A session date is required" }, 400);
    }
    try {
      return jsonResponse(await sendManualPostCloseBrief(env, sessionDate, sendKey));
    } catch (caught) {
      return jsonResponse(
        { sent: false, error: caught instanceof Error ? caught.message : "Unknown failure" },
        500,
      );
    }
  }

  // Inbound Stripe billing webhook. Authenticated by the Stripe-Signature
  // header over the raw body, not by any shared token — Stripe is the only
  // caller. The signature covers the exact bytes, so the body is never
  // re-serialized between receive and verify.
  if (request.method === "POST" && url.pathname === "/webhooks/whop") {
    return handleWhopWebhook(request, env as unknown as Parameters<typeof handleWhopWebhook>[1]);
  }
  if (request.method === "POST" && url.pathname === "/webhooks/stripe") {
    return handleStripeWebhook(request, env);
  }

  return jsonResponse(
    {
      error: "Not found",
      routes: [
        "GET /health",
        "GET /api/dashboard",
        "POST /api/forecasts",
        "POST /internal/test-email",
        "POST /internal/access-request-email",
        "POST /internal/run",
        "POST /webhooks/stripe",
      ],
    },
    404,
  );
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
  ): Promise<void> {
    // The Pages research store owns business evidence. Refresh a bounded slice
    // there every 15 minutes; the existing monitor still owns alerts and email.
    const refreshDue = !envBoolean(env.DRY_RUN, true) &&
      Math.floor(controller.scheduledTime / 60_000) % 15 === 0 &&
      Boolean(env.CRON_SECRET && env.SIGNAL_LEDGER_ORIGIN);
    const businessRefresh = refreshDue
      ? fetch(`${env.SIGNAL_LEDGER_ORIGIN!.replace(/\/+$/, "")}/api/internal/business-refresh`, {
        method: "POST", headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
        signal: AbortSignal.timeout(100_000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Business refresh returned ${response.status}.`);
        return response.json();
      })
      : null;
    const summary = await runMonitor(env, "cron");
    if (businessRefresh) {
      try { console.log(JSON.stringify({ event: "business_refresh_complete", result: await businessRefresh })); }
      catch (error) { console.error("Business refresh failed:", error instanceof Error ? error.message : error); }
    }
    console.log(
      JSON.stringify({
        event: "scheduled_monitor_complete",
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
        ...summary,
      }),
    );
    if (summary.status === "failed") {
      throw new Error(summary.message || "Scheduled monitor run failed.");
    }
  },
};

export default worker;
