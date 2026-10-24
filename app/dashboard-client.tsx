"use client";
import EquityForward from "./equity-forward";
import EquityResearchHome from "./equity-research-home";
import ValuationDesk from "./valuation-desk";
import Link from "next/link";
import dynamic from "next/dynamic";
import PicksPanel from "./picks-panel";
import SiteNav from "./site-nav";
import type { MemberState } from "@/lib/member-session";
import { INITIAL_FORECAST, clamp, type ForecastForm } from "./forecast-form";

// The entry form is only needed once the reader opens it.
const ForecastModal = dynamic(() => import("./forecast-modal"), { ssr: false });
import type { InvestmentSnapshot } from "@/lib/investment-snapshot";

import { finiteNumber, researchNotes, safeSourceUrl, settledPriceOutcome, earningsPhase, forecastRevenueError } from "../lib/earnings-presentation";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type AnyRecord = Record<string, unknown>;

type DashboardData = {
  snapshotAt: string;
  status: string;
  system: AnyRecord;
  metrics: AnyRecord;
  events: AnyRecord[];
  forecasts: AnyRecord[];
  calibration: AnyRecord[];
  watchlist: AnyRecord[];
  runs: AnyRecord[];
  sources: AnyRecord[];
  earningsForecasts: AnyRecord[];
  latestQuotes: AnyRecord[];
  earningsPriceForecasts: AnyRecord[];
  priceForecastScorecard: AnyRecord;
  briefings: AnyRecord[];
  btcResearch: AnyRecord;
  worldNews: AnyRecord[];
};

type Toast = {
  kind: "success" | "error";
  message: string;
};



const EMPTY_DASHBOARD: DashboardData = {
  snapshotAt: "",
  status: "unknown",
  system: {},
  metrics: {},
  events: [],
  forecasts: [],
  calibration: [],
  watchlist: [],
  runs: [],
  sources: [],
  earningsForecasts: [],
  latestQuotes: [],
  earningsPriceForecasts: [],
  priceForecastScorecard: {},
  briefings: [],
  btcResearch: {},
  worldNews: [],
};

const BROWSER_SNAPSHOT_KEY = "signal-ledger:dashboard:v2";
const BROWSER_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;



const STATUS_LABELS: Record<string, string> = {
  healthy: "Healthy",
  operational: "Operational",
  ready: "Ready",
  online: "Online",
  ok: "Normal",
  active: "Active",
  running: "Running",
  live: "Current",
  dry_run: "Test mode",
  manual: "Manual",
  sites_manual: "Manual",
  external_cron: "Scheduled",
  partial: "Partially available",
  fixture: "Demo data",
  needs_setup: "Setup required",
  disabled: "Disabled",
  degraded: "Degraded",
  warning: "Attention needed",
  delayed: "Delayed",
  failed: "Failed",
  error: "Error",
  offline: "Offline",
  open: "Open",
  pending: "Pending",
  resolved: "Resolved",
  correct: "Correct",
  incorrect: "Incorrect",
  success: "Successful",
  completed: "Completed",
  sent: "Sent",
  delivered: "Delivered",
  unavailable: "Unavailable",
  uncertain: "Uncertain",
  skipped: "Skipped",
  unknown: "Status unknown",
};

const EVENT_CATEGORY_LABELS: Record<string, string> = {
  earnings: "Earnings",
  filing: "Regulatory filing",
  sec: "SEC",
  macro: "Macro",
  product: "Product",
  management: "Management",
  guidance: "Guidance",
  analyst: "Analyst research",
  deal: "Transaction",
  crypto: "Digital assets",
  supply_chain: "Supply chain",
  sec_filing: "SEC filing",
  sec_8_k: "SEC 8-K",
  sec_10_q: "SEC 10-Q",
  sec_10_k: "SEC 10-K",
  sec_4: "SEC Form 4",
  company_ir: "Company release",
  market_data: "Market data",
  trade_halt: "Trading halt",
  other: "Other",
};

const DIRECTION_LABELS: Record<string, string> = {
  up: "Bullish",
  bullish: "Bullish",
  down: "Bearish",
  bearish: "Bearish",
  event: "Event occurs",
  yes: "Event occurs",
  no_event: "No event",
  neutral: "Neutral",
  uncertain: "Uncertain",
};

const COMPANY_NAME_LABELS: Record<string, string> = {
  AMD: "AMD",
  AMZN: "Amazon",
  COIN: "Coinbase",
  META: "Meta",
  MSFT: "Microsoft",
  MSTR: "Strategy",
  NVDA: "NVIDIA",
  ORCL: "Oracle",
};

function asRecord(value: unknown): AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : {};
}

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : [];
}

function pickString(record: AnyRecord, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return fallback;
}

function pickNumber(
  record: AnyRecord,
  keys: string[],
  fallback: number | null = null,
) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (
      typeof value === "string" &&
      value.trim() &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
  }
  return fallback;
}

function pickBoolean(record: AnyRecord, keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return null;
}

function normalizePercent(value: number | null) {
  if (value === null) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}



function formatPercent(
  value: number | null,
  options: { signed?: boolean; digits?: number } = {},
) {
  const normalized = normalizePercent(value);
  if (normalized === null) return "—";
  const digits = options.digits ?? (Math.abs(normalized) < 10 ? 1 : 0);
  const sign = options.signed && normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(digits)}%`;
}

function formatPercentPoint(
  value: number | null,
  options: { signed?: boolean; digits?: number } = {},
) {
  if (value === null) return "—";
  const digits = options.digits ?? (Math.abs(value) < 10 ? 1 : 0);
  const sign = options.signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function formatNumber(value: number | null, digits = 0) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatCompactCurrency(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  if (number === null) {
    return typeof value === "string" && value.trim() ? value.trim() : "—";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(number) >= 1_000_000 ? "compact" : "standard",
    minimumFractionDigits: Math.abs(number) < 100 ? 2 : 0,
    maximumFractionDigits: Math.abs(number) < 100 ? 2 : 1,
  }).format(number);
}

function formatStockPrice(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : null;
  if (number === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function formatForecastTargetPrice(value: number | null) {
  if (value === null) return "Pending";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSignedCurrency(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatStockPrice(value)}`;
}

function localizeMetricLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (/revenue|sales|营收|营业收入|销售收入/.test(normalized)) return "Revenue";
  if (/capex|capital expenditure|property and equipment|资本开支|资本支出|资本性支出/.test(normalized)) {
    return "Capital expenditure";
  }
  if (/operating income|operating margin|营业利润|经营利润|营业利润率/.test(normalized)) return "Operating profit";
  if (/gross margin|毛利率/.test(normalized)) return "Gross margin";
  if (/eps|earnings per share|每股收益/.test(normalized)) return "EPS";
  if (/cash flow|free cash flow|现金流|自由现金流/.test(normalized)) return "Cash flow";
  if (/guidance|outlook|指引|业绩展望/.test(normalized)) return "Guidance";
  if (/cloud|azure|rpo|bitcoin|core business|核心业务|云业务|比特币/.test(normalized)) return "Core business";
  return /[\u3400-\u9fff]/.test(value) ? "Key metric" : value || "Key metric";
}

function localizeFinanceText(
  value: string,
  fallback = "English analysis is being prepared.",
) {
  const source = value.replace(/\s+/g, " ").trim();
  if (!source) return fallback;
  return /[\u3400-\u9fff]/.test(source) ? fallback : source;
}

function localizeSourceName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("factset")) {
    return /ap/i.test(value) ? "FactSet (reported by AP)" : "FactSet";
  }
  if (normalized.includes("nasdaq") || normalized.includes("纳斯达克")) return "Nasdaq";
  if (normalized.includes("federal reserve")) return "Federal Reserve";
  if (
    normalized.includes("bureau of economic analysis") ||
    normalized === "bea"
  ) {
    return "U.S. Bureau of Economic Analysis";
  }
  if (normalized.includes("securities and exchange commission")) return "U.S. SEC";
  if (normalized.includes("sec edgar")) return "SEC EDGAR";
  return /[\u3400-\u9fff]/.test(value) ? "Primary source" : value;
}

function eventEnglishOverride(headline: string, ticker = "MARKET") {
  if (/FOMC|Federal Reserve issues.*statement/i.test(headline)) {
    return {
      title: "Federal Reserve issues the FOMC policy statement",
      result:
        "The target range was held at 3.50%–3.75%. The vote was 9–3, with three dissenters preferring a 25-basis-point increase.",
      why:
        "The rate hold masks a distinctly hawkish split. That raises the discount-rate hurdle for long-duration, high-multiple equities.",
    };
  }
  if (/GDP|gross domestic product/i.test(headline)) {
    return {
      title: "U.S. second-quarter 2026 GDP: advance estimate",
      result: "Real GDP grew at a 1.5% annualized rate, down from 2.1% in the prior quarter.",
      why:
        "Slower growth is a headwind for cyclicals and smaller companies. Lower inflation could partly offset the earnings risk through lower rates.",
    };
  }
  if (/personal income|personal consumption|PCE/i.test(headline)) {
    return {
      title: "U.S. personal income and consumer spending",
      result: "Personal income rose 0.2%, disposable income rose 0.2%, and consumer spending increased 0.3%.",
      why:
        "Spending outpaced income, signaling resilient demand but a thinner savings cushion. Spending growth is not the same measure as PCE inflation.",
    };
  }
  const formMatch = headline.match(/\b(10-K|10-Q|8-K|6-K|Form 4)\b/i);
  if (formMatch) {
    const form = formMatch[1].toUpperCase();
    const result =
      form === "10-K"
        ? "The company filed its audited annual report. Focus on revenue, margins, cash flow, capital intensity, and changes in disclosed risks."
        : form === "10-Q"
          ? "The company filed its quarterly report. Focus on revenue, margins, cash flow, capital intensity, and management's outlook."
          : form === "8-K" || form === "6-K"
            ? "The company filed a material-event report. If it contains results, use the financial highlights and company exhibits—not the form label—as the evidence."
            : "An insider ownership change was disclosed. Verify the person, direction, size, and whether the trade was prearranged.";
    return {
      title: `${ticker} files ${form}`,
      result,
      why: "",
    };
  }
  return null;
}

function formatPlainValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return "—";
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: string, compact = false) {
  const date = parseDate(value);
  if (!date) return value || "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(compact ? {} : { year: "numeric" }),
  }).format(date);
}

function formatCalendarDate(value: string) {
  const date = parseDate(value);
  if (!date) return value || "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function getExpectedWindow(forecast: AnyRecord) {
  const raw = forecast.expectedWindow ?? forecast.expected_window;
  const nested = asRecord(raw);
  const legacy = typeof raw === "string" ? raw.trim() : "";
  return {
    start:
      pickString(nested, ["start"]) ||
      pickString(forecast, [
        "expectedWindowStart",
        "expected_window_start",
      ]) ||
      legacy,
    end:
      pickString(nested, ["end"]) ||
      pickString(forecast, ["expectedWindowEnd", "expected_window_end"]) ||
      legacy,
  };
}

function formatRelative(value: string) {
  const date = parseDate(value);
  if (!date) return value || "—";
  const delta = date.getTime() - Date.now();
  const minutes = Math.round(delta / 60_000);
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 36) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} sec`;
  return `${Math.round(value / 60_000)} min`;
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (
    [
      "healthy",
      "operational",
      "ready",
      "online",
      "ok",
      "active",
      "live",
      "success",
      "completed",
    ].includes(normalized)
  ) {
    return "positive";
  }
  if (
    ["failed", "error", "offline", "disabled", "critical", "incorrect"].includes(
      normalized,
    )
  ) {
    return "negative";
  }
  if (
    [
      "degraded",
      "warning",
      "delayed",
      "partial",
      "fixture",
      "manual",
      "needs_setup",
    ].includes(normalized)
  ) {
    return "warning";
  }
  return "neutral";
}

function statusLabel(status: string) {
  const normalized = status.toLowerCase().replaceAll(" ", "_");
  return STATUS_LABELS[normalized] ?? status ?? "Status unknown";
}

function getEventPriority(event: AnyRecord) {
  const raw = pickString(event, ["priority", "severity", "level"], "P2")
    .toUpperCase()
    .replace("CRITICAL", "P0")
    .replace("HIGH", "P1")
    .replace("MEDIUM", "P2")
    .replace("LOW", "P3");
  return ["P0", "P1", "P2", "P3"].includes(raw) ? raw : "P2";
}

function normalizeDashboard(payload: unknown): DashboardData {
  const root = asRecord(payload);
  const data = asRecord(root.data ?? root.dashboard ?? root);
  return {
    snapshotAt: pickString(data, [
      "snapshotAt",
      "snapshot_at",
      "updatedAt",
      "updated_at",
    ]),
    status: pickString(data, ["status", "health"], "unknown"),
    system: asRecord(data.system),
    metrics: asRecord(data.metrics),
    events: asArray(data.events),
    forecasts: asArray(data.forecasts),
    calibration: Array.isArray(data.calibration)
      ? asArray(data.calibration)
      : asArray(asRecord(data.calibration).buckets),
    watchlist: asArray(data.watchlist),
    runs: asArray(data.runs),
    sources: asArray(data.sources),
    earningsForecasts: asArray(
      data.earningsForecasts ?? data.earnings_forecasts,
    ),
    latestQuotes: asArray(data.latestQuotes ?? data.latest_quotes),
    earningsPriceForecasts: asArray(
      data.earningsPriceForecasts ?? data.earnings_price_forecasts,
    ),
    priceForecastScorecard: asRecord(
      data.priceForecastScorecard ?? data.price_forecast_scorecard,
    ),
    briefings: asArray(data.briefings),
    btcResearch: asRecord(data.btcResearch ?? data.btc_research),
    worldNews: asArray(data.worldNews ?? data.world_news),
  };
}

function saveBrowserSnapshot(dashboard: DashboardData) {
  if (!dashboard.snapshotAt) return;
  try {
    window.localStorage.setItem(BROWSER_SNAPSHOT_KEY, JSON.stringify(dashboard));
  } catch {
    // Storage may be disabled or full. The edge snapshot remains the primary cache.
  }
}

function restoreBrowserSnapshot(): DashboardData | null {
  try {
    const raw = window.localStorage.getItem(BROWSER_SNAPSHOT_KEY);
    if (!raw) return null;
    const dashboard = normalizeDashboard(JSON.parse(raw));
    const savedAt = parseDate(dashboard.snapshotAt)?.getTime() ?? 0;
    const ageMs = Date.now() - savedAt;
    if (!savedAt || ageMs < -5 * 60_000 || ageMs > BROWSER_SNAPSHOT_MAX_AGE_MS) {
      window.localStorage.removeItem(BROWSER_SNAPSHOT_KEY);
      return null;
    }
    return {
      ...dashboard,
      status: "partial",
      system: {
        ...dashboard.system,
        snapshotCache: {
          ...asRecord(asRecord(dashboard.system).snapshotCache),
          status: "stale",
          storedAt: dashboard.snapshotAt,
          message: "Showing the most recent snapshot saved by this browser while live data reconnects.",
        },
      },
    };
  } catch {
    return null;
  }
}

function readableDashboardError(caught: unknown) {
  const message = caught instanceof Error ? caught.message : "";
  if (
    (caught instanceof DOMException && caught.name === "AbortError") ||
    /signal is aborted|operation was aborted|aborterror|timed? ?out/i.test(message)
  ) {
    return "The live feed took too long to respond. Retrying automatically.";
  }
  if (/daily database read limit|row read limit|exceeded.*D1/i.test(message)) {
    return "The daily data allowance is exhausted. Cloudflare resets it at 00:00 UTC; automatic retries remain active.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The live feed could not be reached. Retrying automatically.";
  }
  return message || "The live feed is temporarily unavailable. Retrying automatically.";
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function extractError(payload: unknown, fallback: string) {
  const record = asRecord(payload);
  return pickString(record, ["error", "message", "detail"], fallback);
}

function SectionHeader({
  eyebrow,
  title,
  description,
  trailing,
}: {
  eyebrow: string;
  title: string;
  description: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p className="section-description">{description}</p>
      </div>
      {trailing ? <div className="section-trailing">{trailing}</div> : null}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-mark" aria-hidden="true">
        ·
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

/**
 * Homepage hierarchy block. One of three explicit levels (core tools,
 * intelligence, trust) so the page never reads as a flat feed. Membership is
 * now a light single line on the landing hero, not a fourth block. LEVEL 1 is
 * the hero + valuation + picks at the top and needs no marker; the rest are
 * labelled with this component.
 */
function HomeLevel({
  mark,
  title,
  description,
  actions,
}: {
  mark: string;
  title: string;
  description: string;
  actions?: Array<{ href?: string; label: string; onClick?: () => void; primary?: boolean }>;
}) {
  return (
    <section className="home-level" aria-label={title}>
      <div className="home-level-body">
        <span className="home-level-mark">{mark}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {actions && actions.length ? (
        <div className="home-level-actions">
          {actions.map((action) =>
            action.onClick ? (
              <button
                key={action.label}
                className={`button${action.primary ? " button-dark" : ""}`}
                type="button"
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ) : (
              <Link
                key={action.label}
                className={`button${action.primary ? " button-dark" : ""}`}
                href={action.href ?? "#"}
              >
                {action.label}
              </Link>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

function LoadingDashboard() {
  return (
    <div className="loading-dashboard" role="status" aria-live="polite">
      <span className="sr-only">Loading market intelligence</span>
      <div className="loading-hero">
        <span className="skeleton skeleton-kicker" />
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-copy" />
      </div>
      <div className="loading-metrics">
        {[0, 1, 2, 3].map((item) => (
          <span className="skeleton skeleton-card" key={item} />
        ))}
      </div>
      <div className="loading-panels">
        <span className="skeleton skeleton-panel" />
        <span className="skeleton skeleton-panel skeleton-panel-small" />
      </div>
    </div>
  );
}

function SystemStrip({
  dashboard,
  refreshing,
  testingEmail,
  canManage,
  member,
  onRefresh,
  onTestEmail,
}: {
  dashboard: DashboardData;
  refreshing: boolean;
  testingEmail: boolean;
  canManage: boolean;
  member: MemberState;
  onRefresh: () => void;
  onTestEmail: () => void;
}) {
  const pipeline =
    pickString(dashboard.system, [
      "monitoring",
      "pipelineStatus",
      "pipeline_status",
      "collector",
      "ingestion",
    ]) || dashboard.status;
  const marketData = pickString(
    dashboard.system,
    [
      "dataMode",
      "marketDataStatus",
      "market_data_status",
      "marketData",
      "market_data",
    ],
    "unknown",
  );
  const email = pickString(
    dashboard.system,
    ["email", "emailStatus", "email_status", "alerts"],
    "unknown",
  );
  const emailEnabled = pickBoolean(dashboard.system, [
    "emailEnabled",
    "email_enabled",
    "alertsEnabled",
  ]);
  const emailStatus =
    emailEnabled === false ? "offline" : emailEnabled === true ? "online" : email;
  const snapshot =
    dashboard.snapshotAt ||
    pickString(dashboard.system, ["lastRunAt", "last_run_at"]);

  // Every visitor gets the shared navigation. The operator strip below is an
  // additional admin-only status bar, never a replacement for the nav — that
  // would leave the signed-in operator with no way off the homepage.
  if (!canManage) return <SiteNav current="/" member={member} />;

  return (
    <>
    <SiteNav current="/" member={member} />
    <div className="system-strip">
      <div className="shell system-strip-inner">
        <div className="brand-lockup" aria-label="Operator status">
          <span className="private-label">OPERATOR</span>
        </div>
        <div className="system-statuses" aria-label="System status">
          <span className={`system-chip ${statusTone(pipeline)}`}>
            <i aria-hidden="true" />
            Ingestion {statusLabel(pipeline)}
          </span>
          <span className={`system-chip ${statusTone(marketData)}`}>
            <i aria-hidden="true" />
            Market data {statusLabel(marketData)}
          </span>
          <span className={`system-chip ${statusTone(emailStatus)}`}>
            <i aria-hidden="true" />
            Alerts {statusLabel(emailStatus)}
          </span>
          <span className="snapshot-label">
            {snapshot ? `As of ${formatDateTime(snapshot, true)} ET` : "Awaiting first snapshot"}
          </span>
        </div>
        <div className="system-actions">
            <button
              className="button button-quiet"
              type="button"
              onClick={onTestEmail}
              disabled={testingEmail}
            >
              <span aria-hidden="true">↗</span>
              {testingEmail ? "Sending" : "Test alert"}
            </button>
            <button
              className="button button-dark"
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
            >
              <span className={refreshing ? "spin" : ""} aria-hidden="true">
                ↻
              </span>
              {refreshing ? "Refreshing" : "Refresh now"}
            </button>
          </div>
      </div>
    </div>
    </>
  );
}

function InlineCompanyQuote({
  ticker,
  latestQuotes,
}: {
  ticker: string;
  latestQuotes: AnyRecord[];
}) {
  if (!ticker || ticker === "MARKET" || ticker === "—") return null;
  const quote = findLatestQuote(ticker, latestQuotes);
  const price = pickNumber(quote, ["price"]);
  if (price === null) return null;
  const changePct = pickNumber(quote, [
    "percentageChange",
    "percentage_change",
  ]);
  const tone =
    (changePct ?? 0) > 0
      ? "positive"
      : (changePct ?? 0) < 0
        ? "negative"
        : "neutral";
  return (
    <span className="contextual-quote">
      <span className={`inline-company-quote ${tone}`}>
        {formatStockPrice(price)}
        <small>{formatPercentPoint(changePct, { signed: true, digits: 2 })}</small>
      </span>
      <small className="contextual-quote-time">Quote · {pickString(quote, ["asOfAt", "as_of_at", "quoteAsOfAt", "quotedAt", "timestamp"])
        ? formatDateTime(pickString(quote, ["asOfAt", "as_of_at", "quoteAsOfAt", "quotedAt", "timestamp"]), true) + " ET"
        : "Timestamp unavailable"}</small>
    </span>
  );
}

function EventRadar({
  events,
  latestQuotes,
}: {
  events: AnyRecord[];
  latestQuotes: AnyRecord[];
}) {
  const [filter, setFilter] = useState("all");
  const sorted = useMemo(
    () =>
      events
        .filter((event) => {
          const eventType = pickString(event, [
            "eventType",
            "event_type",
            "category",
            "type",
          ]).toLowerCase();
          const research = asRecord(
            event.contentResearch ?? event.content_research,
          );
          const headline = pickString(event, ["headline", "title"]);
          if (
            /sec.*form_?4/.test(eventType) ||
            /\bform\s*4\b/i.test(headline)
          ) {
            return false;
          }
          return !(eventType.startsWith("sec_") && Object.keys(research).length);
        })
        .sort((a, b) => {
        const priorityGap =
          Number(getEventPriority(a).slice(1)) -
          Number(getEventPriority(b).slice(1));
        if (priorityGap) return priorityGap;
        const aDate = parseDate(
          pickString(a, ["publishedAt", "published_at", "occurredAt", "createdAt"]),
        );
        const bDate = parseDate(
          pickString(b, ["publishedAt", "published_at", "occurredAt", "createdAt"]),
        );
        return (bDate?.getTime() ?? 0) - (aDate?.getTime() ?? 0);
      }),
    [events],
  );
  const filtered =
    filter === "all"
      ? sorted.filter((event) =>
          ["P0", "P1"].includes(getEventPriority(event)),
        )
      : sorted.filter((event) => getEventPriority(event) === filter);
  const displayed = filtered.slice(0, 8);

  return (
    <section className="panel event-panel">
      <SectionHeader
        eyebrow="LIVE EVENT RADAR"
        title="Material Event Radar"
        description="New facts that can change fundamentals, expectations, or near-term price discovery—ranked first."
        trailing={
          <div className="segmented-control" aria-label="Filter events by priority">
            {[
              ["all", "All"],
              ["P0", "P0"],
              ["P1", "P1"],
              ["P2", "P2"],
            ].map(([value, label]) => (
              <button
                className={filter === value ? "active" : ""}
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      {displayed.length ? (
        <div className="event-list">
          {displayed.map((event, index) => {
            const id = pickString(event, ["id"], `${index}`);
            const priority = getEventPriority(event);
            const ticker = pickString(
              event,
              ["ticker", "symbol"],
              priority === "P0" ? "MARKET" : "—",
            ).toUpperCase();
            const headline = pickString(event, [
              "headline",
              "title",
              "event",
              "summary",
            ]);
            const summary = pickString(event, [
              "summary",
              "description",
              "whyItMatters",
              "why_it_matters",
            ]);
            const analysis = asRecord(event.analysis);
            const whatHappened = pickString(
              analysis,
              ["whatHappened", "what_happened"],
              summary || headline,
            );
            const whyItMatters = pickString(analysis, [
              "whyItMatters",
              "why_it_matters",
            ]);
            const impactPath = asStringArray(
              analysis.impactPath ?? analysis.impact_path,
            );
            const impact = asRecord(analysis.impact);
            const stance = pickString(
              impact,
              ["stance"],
              pickString(event, ["direction"], "uncertain"),
            ).toLowerCase();
            const verificationPoints = asArray(
              analysis.verificationPoints ?? analysis.verification_points,
            );
            const nextCheck = verificationPoints.length
              ? pickString(verificationPoints[0], ["text"])
              : "";
            const category = pickString(
              event,
              ["eventType", "event_type", "category", "type"],
              "other",
            );
            const source = pickString(
              event,
              ["sourceName", "source_name", "source", "publisher"],
              "Primary source",
            );
            const sourceTier = pickNumber(event, [
              "sourceTier",
              "source_tier",
            ]);
            const url = pickString(event, ["url", "sourceUrl", "source_url"]);
            const time = pickString(event, [
              "publishedAt",
              "published_at",
              "occurredAt",
              "createdAt",
            ]);
            const confidence = normalizePercent(
              pickNumber(event, [
                "confidence",
                "noveltyScore",
                "novelty_score",
                "novelty",
              ]),
            );
            const categoryLabel =
              EVENT_CATEGORY_LABELS[category.toLowerCase()] ?? "Material event";
            const englishOverride = eventEnglishOverride(headline, ticker);
            const localizedHeadline =
              englishOverride?.title ||
              localizeFinanceText(
                headline,
                `${ticker === "MARKET" ? "Market" : ticker}: new ${categoryLabel.toLowerCase()} update`,
              );
            const localizedWhatHappened =
              englishOverride?.result ||
              localizeFinanceText(
                whatHappened,
                "The primary release is indexed and key figures are being extracted. Long unprocessed filings are never shown as analysis.",
              );
            const localizedWhyItMatters =
              englishOverride?.why ||
              localizeFinanceText(
                whyItMatters,
                "Compare the reported figure with consensus and the prior reading to determine whether the earnings path or valuation has changed.",
              );
            const localizedImpactPath = impactPath.map((step) =>
              localizeFinanceText(step, "New fact → estimate revision → asset repricing"),
            );
            const localizedNextCheck = localizeFinanceText(
              nextCheck,
              "Verify the actual release, consensus, prior reading, and subsequent revisions.",
            );

            const content = (
              <>
                <div className="event-rail">
                  <span className={`priority-badge ${priority.toLowerCase()}`}>
                    {priority}
                  </span>
                  <span className="ticker-pill">{ticker}</span>
                  <InlineCompanyQuote
                    ticker={ticker}
                    latestQuotes={latestQuotes}
                  />
                </div>
                <div className="event-copy">
                  <div className="event-meta">
                    <span>{categoryLabel}</span>
                    <span>
                      {localizeSourceName(source)}
                      {sourceTier !== null ? ` · Source tier ${sourceTier}` : ""}
                    </span>
                    <span>
                      {time
                        ? `${formatDateTime(time, true)} ET · ${formatRelative(time)}`
                        : "Time unverified"}
                    </span>
                  </div>
                  <h3>{localizedHeadline || "Untitled event"}</h3>
                  <div className="event-analysis-grid">
                    <div>
                      <span>What happened</span>
                      <p>{localizedWhatHappened}</p>
                    </div>
                    <div>
                      <span>Investment view</span>
                      <p>{localizedWhyItMatters}</p>
                    </div>
                    {localizedImpactPath.length ? (
                      <div className="event-impact-path">
                        <span>Transmission path</span>
                        <p>{localizedImpactPath.join(" → ")}</p>
                      </div>
                    ) : null}
                    {nextCheck ? (
                      <div className="event-next-check">
                        <span>What to verify next</span>
                        <p>{localizedNextCheck}</p>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="event-score">
                    <span>Initial read</span>
                  <strong>{DIRECTION_LABELS[stance] ?? "Pending"}</strong>
                  <small>
                    {confidence === null
                      ? "Ruleset v1"
                      : `Classification ${Math.round(confidence)}`}
                  </small>
                </div>
              </>
            );

            return url ? (
              <a
                className="event-row"
                href={url}
                target="_blank"
                rel="noreferrer"
                key={id}
                aria-label={`${ticker}: ${localizedHeadline}; open source`}
              >
                {content}
              </a>
            ) : (
              <article className="event-row" key={id}>
                {content}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title={events.length ? "No events match this filter" : "Awaiting the first event"}
          description={
            events.length
              ? "Choose another priority to review indexed events."
              : "New events will appear here after source discovery, deduplication, and materiality ranking."
          }
        />
      )}
    </section>
  );
}

function explainBriefingItem(
  item: AnyRecord,
  event: AnyRecord | undefined,
) {
  const sourceItem = event ?? item;
  const ticker = pickString(sourceItem, ["ticker", "symbol"], "MARKET").toUpperCase();
  const headline = pickString(sourceItem, ["headline", "title", "summary"]);
  const summary = pickString(sourceItem, ["summary", "description"]);
  const research = asRecord(
    sourceItem.contentResearch ?? sourceItem.content_research,
  );
  const researchPoints = asArray(
    research.keyPoints ?? research.key_points ?? research.keyMetrics,
  )
    .map((point) => {
      const rawText = pickString(point, ["text", "value", "summary"]);
      return {
        label: /remaining in accounts payable/i.test(rawText)
          ? "CapEx-related payables"
          : localizeMetricLabel(pickString(point, ["label"], "Key metric")),
        text: localizeFinanceText(
          rawText,
          "The figure is indexed and its financial context is being verified.",
        ),
      };
    })
    .filter((point) => point.text);
  const analysis = asRecord(sourceItem.analysis);
  const englishOverride = eventEnglishOverride(headline, ticker);
  const fallbackPoint = pickString(
    analysis,
    ["whatHappened", "what_happened"],
    summary || headline || "The underlying release is awaiting verification.",
  );
  const isSecFiling = /SEC|10-[KQ]|8-K|FORM 4/i.test(
    `${pickString(sourceItem, ["sourceName", "source_name"])} ${headline}`,
  );
  const researchTitle = pickString(research, ["headline"]);
  const genericDocumentTitle =
    /^(document|washington,?\s*d\.?c\.?|united states securities|form\s+\d)/i.test(
      researchTitle,
    );
  const pointText = (labelPattern: RegExp) =>
    researchPoints.find((point) => labelPattern.test(point.label))?.text ?? "";
  const revenue = pointText(/revenue|sales/i);
  const capexPayable = pointText(/capex-related payables/i);
  const capex = pointText(/capex|capital expenditure/i);
  const operating = pointText(/operating profit|operating margin/i);
  const eps = pointText(/eps|earnings per share/i);
  const core = pointText(/core business|cloud|azure|rpo|bitcoin/i);
  const guidance = pointText(/guidance|outlook/i);
  const shorten = (value: string, limit = 120) =>
    value.length > limit ? `${value.slice(0, limit).trim()}…` : value;
  let researchTakeaway = "";
  if (/bitcoin/i.test(core) || ticker === "MSTR") {
    researchTakeaway =
      "The core variables remain Bitcoin price, funding cost, and the pace of accumulation. A single holdings update is not enough to determine the post-earnings direction.";
  } else if (capexPayable && (revenue || core)) {
    researchTakeaway = `${shorten(
      revenue || core,
    )}; meanwhile, ${shorten(
      capexPayable,
    )}. This is committed property and equipment not yet paid, not current-period cash CapEx. Verify purchases of property and equipment in the cash-flow statement.`;
  } else if (capex && (revenue || core)) {
    researchTakeaway = `${shorten(revenue || core)}; meanwhile, ${shorten(capex)}. Demand remains supportive, but investment intensity may pressure free cash flow and valuation. Compare guidance with consensus.`;
  } else if (revenue && operating) {
    researchTakeaway = `${shorten(revenue)}; ${shorten(operating)}. Concurrent revenue and profit improvement is constructive. The next test is whether core growth and guidance clear expectations already embedded in the price.`;
  } else if (revenue && eps) {
    researchTakeaway = `${shorten(revenue)}; ${shorten(eps)}. Direction depends on the gap versus consensus and whether management raises forward guidance.`;
  } else if (guidance || core) {
    researchTakeaway = `${shorten(guidance || core)}. Judge it against consensus and pre-earnings positioning, not in isolation.`;
  } else if (researchPoints.length) {
    researchTakeaway = `${shorten(researchPoints[0].text)}. Next, verify whether it changes revenue, margins, cash flow, or guidance.`;
  }
  return {
    title:
      genericDocumentTitle
        ? `${ticker} filing: financial and operating highlights`
        : englishOverride?.title ||
          localizeFinanceText(
            researchTitle || headline,
            `${ticker} filing: financial and operating highlights`,
          ),
    keyPoints:
      researchPoints.length > 0
        ? researchPoints.slice(0, 5)
        : englishOverride?.result
          ? [{ label: "Result", text: englishOverride.result }]
        : [
            {
              label: isSecFiling ? "Processing status" : "What happened",
              text: isSecFiling
                ? "The source filing is indexed and key figures are being extracted. A form label will never be presented as analysis."
                : localizeFinanceText(
                    fallbackPoint,
                    "The event is indexed and the source facts are being verified.",
                  ),
            },
          ],
    why:
      englishOverride?.why ||
      (isSecFiling ? researchTakeaway : "") ||
      localizeFinanceText(
        pickString(analysis, ["whyItMatters", "why_it_matters"]),
        "",
      ) ||
      "Next, verify whether it changes revenue, margins, CapEx, guidance, or the gap versus market expectations.",
    sourceUrl:
      pickString(research, ["documentUrl", "document_url"]) ||
      pickString(sourceItem, ["url", "sourceUrl", "source_url"]),
  };
}

function ResearchOperatingBar({ dashboard }: { dashboard: DashboardData }) {
  const researchModel = asRecord(dashboard.system.researchModel);
  const xStatus = pickString(researchModel, ["xStatus"], "not_configured");
  return (
    <section className="research-operating-bar" aria-label="Automation and research process">
      <div>
        <span>Monitoring</span>
        <strong>Cloud scan every minute</strong>
        <small>Shared snapshot refreshes every minute · pauses in background</small>
      </div>
      <div>
        <span>Alerts</span>
        <strong>P0/P1 sent in the same cycle</strong>
        <small>Scheduled briefs at 07:45 / 16:20 ET</small>
      </div>
      <div>
        <span>Research stack</span>
        <strong>SEC + market + revisions + news</strong>
        <small>{xStatus === "available" ? "X connected" : "Official X access unavailable"}</small>
      </div>
      <div>
        <span>Research edge</span>
        <strong>Forecast first, settle later</strong>
        <small>Every miss remains in the audit trail</small>
      </div>
    </section>
  );
}

function findMatchingPriceForecast(
  forecast: AnyRecord,
  priceForecasts: AnyRecord[],
) {
  const ticker = pickString(forecast, ["ticker", "symbol"]).toUpperCase();
  const period = pickString(forecast, ["fiscalPeriod", "fiscal_period"]);
  const forecastId = pickString(forecast, ["id"]);
  return (
    priceForecasts.find((candidate) => {
      const candidateTicker = pickString(candidate, [
        "ticker",
        "symbol",
      ]).toUpperCase();
      const candidatePeriod = pickString(candidate, [
        "fiscalPeriod",
        "fiscal_period",
      ]);
      const financialId = pickString(candidate, [
        "financialForecastId",
        "financial_forecast_id",
      ]);
      return (
        candidateTicker === ticker &&
        ((!period && !candidatePeriod) ||
          candidatePeriod === period ||
          financialId === forecastId)
      );
    }) ?? {}
  );
}

function findLatestQuote(ticker: string, latestQuotes: AnyRecord[]) {
  return (
    latestQuotes.find(
      (quote) =>
        pickString(quote, ["ticker", "symbol"]).toUpperCase() ===
        ticker.toUpperCase(),
    ) ?? {}
  );
}

function unionEarningsForecastInputs(
  earningsForecasts: AnyRecord[],
  earningsPriceForecasts: AnyRecord[],
) {
  const merged = new Map<string, AnyRecord>();
  const recordKey = (record: AnyRecord) => {
    const ticker = pickString(record, ["ticker", "symbol"], "—").toUpperCase();
    const period = pickString(record, [
      "fiscalPeriod",
      "fiscal_period",
    ]);
    return `${ticker}|${period}`;
  };
  earningsForecasts.forEach((forecast) => {
    merged.set(recordKey(forecast), forecast);
  });
  earningsPriceForecasts.forEach((forecast) => {
    const key = recordKey(forecast);
    if (!merged.has(key)) merged.set(key, forecast);
  });
  return [...merged.values()];
}

function priceForecastView(
  forecast: AnyRecord,
  priceForecasts: AnyRecord[],
  latestQuotes: AnyRecord[],
) {
  const ticker = pickString(forecast, ["ticker", "symbol"]).toUpperCase();
  const reaction = asRecord(
    forecast.marketReaction ?? forecast.market_reaction,
  );
  const nestedPrice = asRecord(
    forecast.priceForecast ??
      forecast.price_forecast ??
      reaction.priceForecast ??
      reaction.price_forecast,
  );
  const priceRecord = {
    ...nestedPrice,
    ...findMatchingPriceForecast(forecast, priceForecasts),
  };
  const quote = findLatestQuote(ticker, latestQuotes);
  const quoteSource = asRecord(quote.source);
  const referencePrice =
    pickNumber(priceRecord, [
      "referencePrice",
      "reference_price",
      "anchorPrice",
      "anchor_price",
      "currentPrice",
      "current_price",
    ]) ??
    pickNumber(reaction, ["referencePrice", "reference_price"]);
  const latestPrice =
    pickNumber(quote, [
      "price",
      "latestPrice",
      "latest_price",
      "lastPrice",
      "last_price",
      "close",
    ]) ??
    pickNumber(priceRecord, ["latestPrice", "latest_price"]) ??
    referencePrice;
  const predictedChangePct = pickNumber(priceRecord, [
    "predictedChangePct",
    "predicted_change_pct",
    "expectedChangePct",
    "expected_change_pct",
  ]);
  const predictedPostPrice =
    pickNumber(priceRecord, [
      "predictedPostPrice",
      "predicted_post_price",
      "predictedPostEarningsPrice",
      "predicted_post_earnings_price",
      "targetPrice",
      "target_price",
    ]) ??
    (referencePrice !== null && predictedChangePct !== null
      ? referencePrice * (1 + predictedChangePct / 100)
      : null);
  const latestChangePct =
    latestPrice !== null && predictedPostPrice !== null && latestPrice !== 0
      ? ((predictedPostPrice - latestPrice) / latestPrice) * 100
      : predictedChangePct;
  const priceBasis = referencePrice ?? latestPrice;
  const derivedStance =
    predictedPostPrice === null || priceBasis === null
      ? "uncertain"
      : predictedPostPrice > priceBasis
        ? "up"
        : predictedPostPrice < priceBasis
          ? "down"
          : "neutral";
  const stance = pickString(
    priceRecord,
    ["forecastStance", "forecast_stance", "stance"],
    pickString(
      reaction,
      ["predictedDirection", "predicted_direction"],
      derivedStance,
    ),
  ).toLowerCase();
  const recordDrivers = asStringArray(
    priceRecord.keyDrivers ?? priceRecord.key_drivers,
  );
  return {
    record: priceRecord,
    referencePrice,
    referencePriceAt: pickString(priceRecord, [
      "referencePriceAt",
      "reference_price_at",
      "informationCutoffAt",
      "information_cutoff_at",
    ]),
    latestPrice,
    latestPriceAt:
      pickString(quote, [
        "asOfAt",
        "as_of_at",
        "quoteAsOfAt",
        "quote_as_of_at",
        "timestamp",
        "quotedAt",
        "quoted_at",
      ]) ||
      pickString(priceRecord, ["latestPriceAt", "latest_price_at"]),
    latestPriceProvider:
      pickString(quoteSource, ["provider"]) ||
      pickString(quote, ["provider"], "Nasdaq"),
    latestPriceDelayMinutes: pickNumber(quoteSource, [
      "delayMinutes",
      "delay_minutes",
    ]),
    predictedPostPrice,
    predictedChangePct,
    latestChangePct,
    stance,
    thesis: pickString(priceRecord, ["thesis", "rationale"]),
    keyDrivers: recordDrivers,
    status: pickString(priceRecord, ["status"], "open").toLowerCase(),
    actualPostPrice: pickNumber(priceRecord, [
      "actualPostPrice",
      "actual_post_price",
      "actualPrice",
      "actual_price",
    ]),
    actualPriceAt: pickString(priceRecord, [
      "actualPriceAt",
      "actual_price_at",
      "resolvedAt",
      "resolved_at",
    ]),
    errorAmount: pickNumber(priceRecord, ["errorAmount", "error_amount"]),
    errorPct: pickNumber(priceRecord, ["errorPct", "error_pct"]),
    absoluteErrorPct: pickNumber(priceRecord, [
      "absoluteErrorPct",
      "absolute_error_pct",
    ]),
    directionHit: pickBoolean(priceRecord, [
      "directionHit",
      "direction_hit",
    ]),
  };
}

function quoteMarketStatusLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || /unknown|unavailable/.test(normalized)) return "Status pending";
  if (/open|market open/.test(normalized)) return "Market open";
  if (/pre/.test(normalized)) return "Pre-market";
  if (/after|post/.test(normalized)) return "After hours";
  if (/close/.test(normalized)) return "Market closed";
  if (/halt/.test(normalized)) return "Trading halted";
  return value ? localizeFinanceText(value, "Status pending") : "Status pending";
}

function quoteFreshnessLabel({
  isRealtime,
  marketStatus,
  quoteAt,
  delayMinutes,
}: {
  isRealtime: boolean;
  marketStatus: string;
  quoteAt: string;
  delayMinutes: number | null;
}) {
  const normalizedStatus = marketStatus.trim().toLowerCase();
  if (/close/.test(normalizedStatus)) {
    return { label: "Closed", tone: "closed", detail: "Latest valid quote" };
  }
  const quoteTime = parseDate(quoteAt)?.getTime() ?? null;
  const ageMinutes =
    quoteTime === null ? null : Math.max(0, (Date.now() - quoteTime) / 60_000);
  const isTrading = /open|market open/.test(normalizedStatus);
  if (isRealtime && isTrading && ageMinutes !== null && ageMinutes <= 2) {
    return { label: "Live", tone: "live", detail: "Near real time" };
  }
  if (delayMinutes !== null && delayMinutes > 0) {
    return {
      label: `${Math.round(delayMinutes)} min delayed`,
      tone: "delayed",
      detail: quoteMarketStatusLabel(marketStatus),
    };
  }
  if (isTrading && ageMinutes !== null && ageMinutes > 2) {
    return {
      label: "Stale quote",
      tone: "stale",
      detail: `${Math.round(ageMinutes)} min ago`,
    };
  }
  return {
    label: isRealtime ? "Latest quote" : "Delayed",
    tone: isRealtime ? "closed" : "delayed",
    detail: quoteMarketStatusLabel(marketStatus),
  };
}

function releaseTimingLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (/after|post|盘后/.test(normalized)) return "After market close";
  if (/before|pre|盘前/.test(normalized)) return "Before market open";
  if (/during|盘中/.test(normalized)) return "During market hours";
  return value && !/[\u3400-\u9fff]/.test(value) ? value : "Release timing pending";
}

function earningsReleaseHasPassed(eventDate: string, timing: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (eventDate < today) return true;
  if (eventDate > today) return false;
  const minutes =
    Number(parts.hour ?? 0) * 60 + Number(parts.minute ?? 0);
  const normalizedTiming = timing.toLowerCase();
  if (/before|pre|盘前/.test(normalizedTiming)) return minutes >= 8 * 60;
  if (/during|盘中/.test(normalizedTiming)) return minutes >= 12 * 60;
  return minutes >= 16 * 60;
}

function formatModelVariance(model: unknown, actual: unknown) {
  const modelValue =
    typeof model === "number" && Number.isFinite(model)
      ? model
      : typeof model === "string" &&
          model.trim() &&
          Number.isFinite(Number(model))
        ? Number(model)
        : null;
  const actualValue =
    typeof actual === "number" && Number.isFinite(actual)
      ? actual
      : typeof actual === "string" &&
          actual.trim() &&
          Number.isFinite(Number(actual))
        ? Number(actual)
        : null;
  if (
    modelValue === null ||
    actualValue === null ||
    actualValue === 0
  ) {
    return "";
  }
  const variance = ((modelValue - actualValue) / Math.abs(actualValue)) * 100;
  if (Math.abs(variance) < 0.05) return "In line with the actual result";
  return `Model ${variance > 0 ? "overestimated" : "underestimated"} by ${Math.abs(variance).toFixed(
    1,
  )}%`;
}

function formatQuoteVolume(value: number | null) {
  if (value === null) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value);
}


function compactMetricPoint(label: string, text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (label === "CapEx-related payables") {
    const values = [...clean.matchAll(/\$?([\d.]+)\s*billion/gi)].map(
      (match) => match[1],
    );
    if (values.length >= 2) {
      return `$${values[0]}B (prior year: $${values[1]}B)`;
    }
  }
  const financialFormat = clean;
  const firstSentence =
    financialFormat.split(/[.;]/)[0]?.trim() || financialFormat;
  return firstSentence.length > 92
    ? `${firstSentence.slice(0, 92).trim()}…`
    : firstSentence;
}

function briefingConclusion(
  explanation: ReturnType<typeof explainBriefingItem>,
  ticker: string,
) {
  const labels = explanation.keyPoints.map((point) => point.label).join(" ");
  if (ticker === "MSTR" || /bitcoin/i.test(labels)) {
    return "The core variables remain Bitcoin price, funding cost, and the pace of accumulation. A single holdings disclosure is not enough to change the earnings view.";
  }
  if (/capex-related payables/i.test(labels)) {
    return "Cloud demand is strong, but property-and-equipment payables rose materially. Verify cash CapEx and free cash flow; the combined read is neutral.";
  }
  if (/revenue/i.test(labels) && /operating profit|margin/i.test(labels)) {
    return "Revenue and profit improved together, a constructive fundamental signal. The next test is whether core growth and guidance exceed priced-in expectations.";
  }
  const clean = explanation.why.replace(/\s+/g, " ").trim();
  if (!clean) return "No investment conclusion yet; key figures and consensus still require verification.";
  const firstSentence = clean.split(".")[0]?.trim() || clean;
  return `${firstSentence.slice(0, 150)}${firstSentence.length > 150 ? "…" : "."}`;
}

function DailyBriefing({
  briefings,
  events,
  latestQuotes,
  snapshotAt,
}: {
  briefings: AnyRecord[];
  events: AnyRecord[];
  latestQuotes: AnyRecord[];
  snapshotAt: string;
}) {
  const sortedBriefings = [...briefings].sort(
    (a, b) =>
      (parseDate(pickString(b, ["generatedAt", "generated_at"]))?.getTime() ??
        0) -
      (parseDate(pickString(a, ["generatedAt", "generated_at"]))?.getTime() ??
        0),
  );
  const briefing = sortedBriefings[0];
  const generatedAt =
    pickString(briefing ?? {}, ["generatedAt", "generated_at", "publishedAt"]) ||
    snapshotAt;
  const briefingItems = asArray(briefing?.items).filter(
    (item) =>
      pickString(item, ["kind"]).toLowerCase() !== "earningsforecast",
  );
  const briefAnchor = parseDate(snapshotAt)?.getTime() ?? Date.now();
  const items = (briefingItems.length ? briefingItems : events).filter(item => {
    const related = events.find(event => pickString(item, ["id"]) && pickString(event, ["id"]) === pickString(item, ["id"])) ?? item;
    const published = parseDate(pickString(related, ["publishedAt", "published_at"]))?.getTime();
    return published !== undefined && published <= briefAnchor && briefAnchor - published <= 24 * 60 * 60_000;
  }).slice(0, 6);

  return (
    <section className="panel daily-briefing-panel">
      <SectionHeader
        eyebrow="TODAY'S BRIEF"
        title="Key Events in Today's Brief"
        description="The events selected into today's post-close brief, with the key figures captured from each source."
        trailing={
          <div className="briefing-header-status">
            <span className="run-status">LATEST SAVED BRIEF</span>
            <small>
              {generatedAt ? `As of ${formatDateTime(generatedAt, true)} ET` : "Pending"}
            </small>
          </div>
        }
      />
      {items.length ? (
        <div className="data-table-scroll" role="region" aria-label="Today's key events table">
          <table className="market-data-table briefing-table">
            <thead>
              <tr>
                <th scope="col">Priority / Security</th>
                <th scope="col">Event</th>
                <th scope="col">Key figures</th>
                <th scope="col">Source / Time</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => {
                const itemId = pickString(item, ["id"]);
                const ticker = pickString(
                  item,
                  ["ticker", "symbol"],
                  "MARKET",
                ).toUpperCase();
                const headline = pickString(item, [
                  "headline",
                  "title",
                  "summary",
                ]);
                const matchedEvent = events.find(
                  (event) =>
                    (itemId && pickString(event, ["id"]) === itemId) ||
                    (pickString(event, ["ticker", "symbol"]).toUpperCase() ===
                      ticker &&
                      pickString(event, ["headline", "title"]) === headline),
                );
                const sourceItem = matchedEvent ?? item;
                const explanation = explainBriefingItem(item, matchedEvent);
                const priority = getEventPriority(sourceItem);
                const source = pickString(
                  sourceItem,
                  ["sourceName", "source_name", "source"],
                  "Source pending",
                );
                const publishedAt = pickString(sourceItem, [
                  "publishedAt",
                  "published_at",
                ]);
                const url = explanation.sourceUrl;
                return (
                  <tr key={itemId || `${ticker}-${index}`}>
                    <th scope="row">
                      <span className={`priority-badge ${priority.toLowerCase()}`}>
                        {priority}
                      </span>
                      <strong>{ticker}</strong>
                      <InlineCompanyQuote
                        ticker={ticker}
                        latestQuotes={latestQuotes}
                      />
                    </th>
                    <td className="briefing-event-title">{explanation.title}</td>
                    <td>
                      <ul className="table-metric-list">
                        {explanation.keyPoints.slice(0, 3).map((point) => (
                          <li key={`${point.label}-${point.text}`}>
                            <strong>{point.label}</strong>
                            <span>{compactMetricPoint(point.label, point.text)}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="table-source">
                      <strong>{localizeSourceName(source)}</strong>
                      <small>
                        {publishedAt ? formatRelative(publishedAt) : "Time unverified"}
                      </small>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          Primary source ↗
                        </a>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No material events in today's brief"
          description="The live market feed keeps updating on its own. This panel reflects only the events selected into today's post-close brief."
        />
      )}
    </section>
  );
}

export function EarningsForecastPanel({
  earningsForecasts, earningsPriceForecasts, latestQuotes, valuationContext = [],
}: {
  earningsForecasts: AnyRecord[];
  earningsPriceForecasts: AnyRecord[];
  latestQuotes: AnyRecord[];
  valuationContext?: InvestmentSnapshot[];
}) {
  const valuationByTicker = new Map(valuationContext.map((snapshot) => [snapshot.ticker.toUpperCase(), snapshot]));
  const records = unionEarningsForecastInputs(earningsForecasts, earningsPriceForecasts)
    .map((forecast, index) => {
      const event = asRecord(forecast.earningsEvent ?? forecast.earnings_event);
      const actual = asRecord(event.actual);
      const consensus = asRecord(forecast.analystConsensus ?? forecast.analyst_consensus);
      const price = priceForecastView(forecast, earningsPriceForecasts, latestQuotes);
      const date = pickString(event, ["date"]) || pickString(price.record, ["earningsDate", "earnings_date"]);
      const timing = pickString(event, ["timing"], pickString(price.record, ["releaseTiming", "release_timing"]));
      const revenue = finiteNumber(forecast.actualRevenue ?? forecast.actual_revenue ?? actual.revenue);
      const eps = finiteNumber(forecast.actualEps ?? forecast.actual_eps ?? actual.eps);
      const phase = earningsPhase(revenue !== null || eps !== null,
        pickString(event, ["status"]) === "reported", earningsReleaseHasPassed(date, timing));
      return { forecast, event, actual, consensus, price, date, timing, revenue, eps, phase,
        id: pickString(forecast, ["id"], String(index)),
        ticker: pickString(forecast, ["ticker", "symbol"], "—").toUpperCase() };
    });
  const timestamp = (date: string) => parseDate(date)?.getTime() ?? 0;
  const upcoming = records.filter(r => r.phase === "upcoming").sort((a, b) => timestamp(a.date) - timestamp(b.date));
  const reports = records.filter(r => r.phase !== "upcoming").sort((a, b) => timestamp(b.date) - timestamp(a.date));
  const primary = [...upcoming.slice(0, 4), ...reports.slice(0, upcoming.length ? 2 : 4)];
  const primaryIds = new Set(primary);
  const archive = records.filter(r => !primaryIds.has(r)).sort((a, b) => timestamp(b.date) - timestamp(a.date));

  const card = (entry: typeof records[number]) => {
    const { forecast, actual, consensus, price, date, timing, revenue, eps, phase, id, ticker } = entry;
    const modelRevenue = finiteNumber(forecast.revenueEstimate ?? forecast.revenue_estimate);
    const modelEps = finiteNumber(forecast.epsEstimate ?? forecast.eps_estimate);
    const consensusRevenue = finiteNumber(consensus.revenue ?? consensus.revenue_consensus ?? actual.revenueConsensus ?? actual.revenue_consensus);
    const consensusEps = finiteNumber(consensus.eps ?? consensus.eps_consensus ?? actual.epsConsensus ?? actual.eps_consensus);
    // Pre-earnings valuation context comes from the shared cached snapshot, so
    // this card can never disagree with the valuation page.
    const valuation = valuationByTicker.get(ticker) ?? null;
    const valuationGap = valuation?.upsidePct ?? null;
    const outcome = settledPriceOutcome(price.referencePrice, price.predictedPostPrice, price.actualPostPrice);
    const revenueError = forecastRevenueError(modelRevenue, revenue);
    const postmortem = asRecord(actual.postmortem);
    const reaction = asRecord(forecast.marketReaction ?? forecast.market_reaction);
    const highlights = researchNotes(asStringArray(actual.highlights)).slice(0, 3);
    const drivers = researchNotes([
      ...price.keyDrivers, ...asStringArray(reaction.keyDrivers ?? reaction.key_drivers),
    ]).slice(0, 3);
    const review = researchNotes([
      postmortem.summary, ...asStringArray(postmortem.rootCauses ?? postmortem.root_causes),
    ]).slice(0, 2);
    const sourceUrl = safeSourceUrl(
      forecast.actualSourceUrl ?? forecast.actual_source_url ?? actual.sourceUrl ?? actual.source_url ??
      entry.event.sourceUrl ?? entry.event.source_url ?? asRecord(forecast.modelSource ?? forecast.model_source).url
    );
    const consensusUrl = safeSourceUrl(consensus.sourceUrl ?? consensus.source_url ?? consensus.url);
    const consensusProvider = localizeSourceName(pickString(consensus, ["provider"], "Not supplied"));
    const basisNote = researchNotes([actual.comparabilityNote ?? actual.comparability_note])[0];
    const cutoff = pickString(price.record, ["informationCutoffAt", "information_cutoff_at", "frozenAt", "frozen_at"],
      pickString(forecast, ["informationCutoffAt", "information_cutoff_at", "createdAt", "created_at"]));
    const targetDate = pickString(price.record, ["targetDate", "target_date", "targetSessionDate", "target_session_date"]);
    const reported = phase === "reported";
    const tone = outcome.directionHit === false ? "missed" : outcome.directionHit === true ? "matched" : "unsettled";
    const headline = outcome.directionHit !== null
      ? outcome.directionHit ? "Direction matched. Here is the price error." : "Direction missed. Here is the gap."
      : reported ? "The reported numbers" : phase === "missing-results" ? "Results have not reached this feed"
      : price.predictedPostPrice !== null ? "The pre-earnings call" : "Earnings ahead";
    const figures = [
      { name: "Revenue", model: modelRevenue, consensus: consensusRevenue, actual: revenue, format: formatCompactCurrency },
      { name: "EPS", model: modelEps, consensus: consensusEps, actual: eps, format: formatStockPrice },
    ];
    const evidence = asRecord(asRecord(price.record.source).evidence);
    const reactionEvidence = asRecord(evidence.reactionForecast);
    const history = asRecord(evidence.historicalEarningsAmplitude);
    const historyRows = asArray(history.observations);
    const signalInputs = asRecord(asRecord(reaction.featureSnapshot ?? reaction.feature_snapshot).inputs);
    const fundamentalInputs = asRecord(signalInputs.fundamentals);
    const marketInputs = asRecord(signalInputs.market);
    const revisionInputs = asRecord(signalInputs.revisions);
    const newsInputs = asRecord(signalInputs.news);
    const modelBasisComparable = /SEC|XBRL/i.test(
      pickString(forecast, ["forecastMethod", "forecast_method", "sourceQuality", "source_quality"]),
    );
    const accountingBasis = modelBasisComparable
      ? "Model and reported EPS use SEC/XBRL history. Third-party consensus remains provider-basis and is not graded against GAAP unless its basis is verified."
      : "Reported, model and consensus EPS may use different accounting bases. No consensus beat/miss score is assigned without a verified match.";
    const targetFormula =
      price.referencePrice !== null && price.predictedPostPrice !== null && outcome.forecastMove !== null
        ? `${formatStockPrice(price.referencePrice)} × (1 ${outcome.forecastMove >= 0 ? "+" : "−"} ${Math.abs(outcome.forecastMove).toFixed(1)}%) = ${formatStockPrice(price.predictedPostPrice)}`
        : null;
    return (
      <article id={ticker === "AMD" ? "amd-case-study" : undefined} className={"research-card " + tone} key={id + ticker}>
        <header className="research-card-header">
          <div>
            <p className="research-company"><strong>{COMPANY_NAME_LABELS[ticker] ?? ticker}</strong><span>{ticker}</span></p>
            <InlineCompanyQuote ticker={ticker} latestQuotes={latestQuotes} />
          </div>
          <div className="research-card-period">
            <span className={"research-phase " + phase}>{reported ? "REPORTED" : phase === "missing-results" ? "RESULTS MISSING" : "UPCOMING"}</span>
            <strong>{date ? formatCalendarDate(date) : "Date not confirmed"}</strong>
            <small>{pickString(forecast, ["fiscalPeriod", "fiscal_period"])}{timing && !/[\u3400-\u9fff]/.test(timing) ? " · " + timing : ""}</small>
          </div>
        </header>
        <div className="research-card-body">
          <div className="research-verdict">
            <span className="research-eyebrow">{outcome.directionHit !== null ? "FORECAST REVIEW" : reported ? "EARNINGS RESULTS" : "RESEARCH STATUS"}</span>
            <h3>{headline}</h3>
            {outcome.directionHit !== null ? (
              <p>Forecast <strong>{formatPercentPoint(outcome.forecastMove, { signed: true, digits: 1 })}</strong>; observed <strong>{formatPercentPoint(outcome.actualMove, { signed: true, digits: 1 })}</strong> from the same frozen reference price.</p>
            ) : reported ? (
              <p>{revenue !== null ? "Revenue " + formatCompactCurrency(revenue) + ". " : ""}{eps !== null ? "Reported EPS " + formatStockPrice(eps) + "." : ""}</p>
            ) : phase === "missing-results" ? (
              <p>The scheduled release window has passed. Reported figures are missing from the current data feed; this is not a new forecast.</p>
            ) : <p>{price.predictedPostPrice !== null ? "Target " + formatStockPrice(price.predictedPostPrice) + " for the recorded post-earnings session." : "No price forecast was recorded. Financial estimates are shown below."}</p>}
          </div>
          <div className="research-estimates" aria-label={ticker + " earnings comparison"}>
            <div className="research-estimates-row research-estimates-head">
              <span className="research-estimates-name">Estimate</span>
              <span>Model</span>
              <span>Consensus</span>
              <span>Reported</span>
            </div>
            {figures.map(row => (
              <div className="research-estimates-row" key={row.name}>
                <span className="research-estimates-name">{row.name}</span>
                <strong>{row.model !== null ? row.format(row.model) : "—"}</strong>
                <strong>{row.consensus !== null ? row.format(row.consensus) : "—"}</strong>
                <strong className="research-actual">{row.actual !== null ? row.format(row.actual) : "—"}</strong>
              </div>
            ))}
          </div>
          {valuation && (
            <section className="research-valuation-context" aria-label={ticker + " pre-earnings valuation context"}>
              <div className="research-valuation-head">
                <span>Pre-earnings valuation</span>
                {valuation.releaseGate === "model_check_required" || valuation.fairValue === null ? (
                  <span className="research-valuation-flag">
                    {valuation.releaseGate === "model_check_required" ? "MODEL REVIEW" : "VALUATION WITHHELD"}
                  </span>
                ) : null}
                <Link href={"/fair-value?ticker=" + encodeURIComponent(ticker)}>Open valuation →</Link>
              </div>
              <div className="research-valuation-grid">
                <div><span>Price</span><strong>{formatStockPrice(valuation.quote.price)}</strong></div>
                <div><span>Fair value</span><strong>{valuation.fairValue === null ? "Withheld" : formatStockPrice(valuation.fairValue)}</strong></div>
                <div><span>Gap</span><strong className={valuationGap === null ? "" : valuationGap >= 0 ? "gain" : "loss"}>{valuationGap === null ? "—" : formatPercentPoint(valuationGap, { signed: true, digits: 1 })}</strong></div>
                <div><span>View</span><strong>{valuation.rating}</strong></div>
                <div><span>Confidence</span><strong>{Math.round(valuation.confidence * 100) + "%"}</strong></div>
                <div><span>Updated</span><strong>{valuation.valuationUpdatedAt ? formatDateTime(valuation.valuationUpdatedAt, true) : "—"}</strong></div>
              </div>
            </section>
          )}
          <details className="research-details">
            <summary>Details</summary>
            <div className="research-details-body">
              {valuation && (
                <p className="research-valuation-note">
                  Fair value is produced by the shared deterministic engine ({valuation.valuationFamilyLabel}) and is not derived from the earnings estimate above. Model figures and consensus remain separate.
                </p>
              )}
              {(revenueError !== null || (eps !== null && modelEps !== null)) && (
                <div className="research-numeric-review">
                  {revenueError !== null && <p><strong>Revenue model error</strong><span>{Math.abs(revenueError).toFixed(1)}% {revenueError > 0 ? "above" : revenueError < 0 ? "below" : "from"} the reported result.</span></p>}
                  {eps !== null && modelEps !== null && <p><strong>EPS comparison</strong><span>{eps < 0 && modelEps >= 0 ? "A reported loss versus a projected profit." : eps >= 0 && modelEps < 0 ? "A reported profit versus a projected loss." : "Model " + formatStockPrice(modelEps) + "; reported " + formatStockPrice(eps) + "."}</span></p>}
                </div>
              )}
              {price.predictedPostPrice !== null && (
                <section className={"research-price-comparison " + tone} aria-label={ticker + " frozen price forecast"}>
                  <div><span>Pre-release target</span><strong>{formatStockPrice(price.predictedPostPrice)}</strong><small>{outcome.forecastMove !== null ? formatPercentPoint(outcome.forecastMove, { signed: true }) + " from reference" : "Frozen forecast"}</small></div>
                  <div><span>Target-session close</span><strong>{price.actualPostPrice !== null ? formatStockPrice(price.actualPostPrice) : "—"}</strong><small>{price.actualPriceAt ? formatDateTime(price.actualPriceAt, true) + " ET" : reported ? "Not recorded" : "After release"}</small></div>
                  <div><span>Target error</span><strong>{outcome.errorPct !== null ? formatPercentPoint(outcome.errorPct, { signed: true, digits: 1 }) : "—"}</strong><small>{outcome.errorPct !== null ? "(Target − close) / close" : "Requires target-session close"}</small></div>
                </section>
              )}
              {reported && price.predictedPostPrice === null && <p className="research-data-note">No pre-release price target was recorded. Excluded from the price backtest.</p>}
              {highlights.length > 0 && <div className="research-specifics"><h4>What changed</h4><ul>{highlights.map(note => <li key={note}>{note}</li>)}</ul></div>}
              {review.length > 0 ? <div className="research-specifics"><h4>What the forecast missed</h4><ul>{review.map(note => <li key={note}>{note}</li>)}</ul></div>
                : !reported && drivers.length > 0 ? <div className="research-specifics"><h4>Evidence behind the call</h4><ul>{drivers.map(note => <li key={note}>{note}</li>)}</ul></div> : null}
              <details className="research-audit">
                <summary>Sources &amp; forecast record</summary>
                <dl>
                  <div><dt>Model frozen</dt><dd>{cutoff ? formatDateTime(cutoff, true) + " ET" : "Timestamp not supplied"}</dd></div>
                  {price.referencePrice !== null && <div><dt>Price reference</dt><dd>{formatStockPrice(price.referencePrice)}{price.referencePriceAt ? " · " + formatDateTime(price.referencePriceAt, true) + " ET" : ""}</dd></div>}
                  {targetDate && <div><dt>Target session</dt><dd>{formatCalendarDate(targetDate)}</dd></div>}
                  <div><dt>Consensus source</dt><dd>{consensusProvider}{consensusUrl && <a href={consensusUrl} target="_blank" rel="noreferrer"> · Source ↗</a>}</dd></div>
                  <div><dt>EPS basis</dt><dd>{basisNote ?? accountingBasis}</dd></div>
                </dl>
                {reported && drivers.length > 0 && <><h4>Original pre-release evidence</h4><ul>{drivers.map(note => <li key={note}>{note}</li>)}</ul></>}
                <p>Live quotes above are for reference only. Price performance uses the recorded target-session close, not today's quote. Frozen estimates are never rewritten after release. A dash means the value is not available.</p>
              </details>
              <details className="research-audit model-method">
                <summary>Open the model: inputs → call → target</summary>
                <div className="model-method-grid">
                  <section>
                    <span>1 · Financial estimate</span>
                    <p>Revenue: comparable prior-year quarter × the median of the latest comparable year-over-year growth rates.</p>
                    <p>EPS: comparable prior-year GAAP EPS plus the median of recent year-over-year GAAP EPS changes.</p>
                    <strong>{modelRevenue !== null ? `Revenue ${formatCompactCurrency(modelRevenue)}` : "Revenue not estimated"} · {modelEps !== null ? `GAAP EPS ${formatStockPrice(modelEps)}` : "EPS not estimated"}</strong>
                  </section>
                  <section>
                    <span>2 · Direction</span>
                    <p>The call uses only information available before the cutoff: SEC fundamentals, price versus SPY, estimate revisions and company/news evidence. Missing inputs are shown rather than imputed.</p>
                    <ul>
                      <li>Comparable revenue trend: {formatPercentPoint(normalizePercent(pickNumber(fundamentalInputs, ["revenueGrowth"])), { signed: true, digits: 1 })}</li>
                      <li>20-day excess return vs. SPY: {formatPercentPoint(normalizePercent(pickNumber(marketInputs, ["relativeReturn20d"])), { signed: true, digits: 1 })}</li>
                      <li>EPS revisions: {formatNumber(pickNumber(revisionInputs, ["up"]))} up / {formatNumber(pickNumber(revisionInputs, ["down"]))} down</li>
                      <li>Relevant news observations: {formatNumber(pickNumber(newsInputs, ["total"]))}</li>
                    </ul>
                  </section>
                  <section>
                    <span>3 · Magnitude</span>
                    {historyRows.length ? <p>The direction signal is mapped between the stock's own median and 75th-percentile absolute earnings moves, then rounded to 0.5 percentage points.</p> : <p>No price target is produced when fewer than three comparable earnings moves are available or the direction signal is below the minimum threshold.</p>}
                    {historyRows.length ? <strong>{formatNumber(pickNumber(history, ["sampleCount"]))} events · median {formatPercentPoint(pickNumber(history, ["medianAbsMovePct"]), { digits: 1 })} · 75th percentile {formatPercentPoint(pickNumber(history, ["p75AbsMovePct"]), { digits: 1 })}</strong> : null}
                  </section>
                  <section>
                    <span>4 · Price target &amp; audit</span>
                    <p>{targetFormula ?? "No defensible pre-release price target was frozen."}</p>
                    <strong>{reported ? (outcome.directionHit === false ? "The failed call remains in the scorecard." : outcome.directionHit === true ? "The settled call remains in the scorecard." : "Settlement is incomplete.") : "This record remains open until the defined target session settles."}</strong>
                    {reactionEvidence.id ? <small>Direction record and price record are stored separately and linked for audit.</small> : null}
                  </section>
                </div>
                {historyRows.length ? <div className="model-history"><span>Comparable earnings reactions</span><div>{historyRows.map((row, index) => <p key={index}><strong>{pickString(row, ["reportedSession"])}</strong><span>{formatPercentPoint(pickNumber(row, ["movePct"]), { signed: true, digits: 1 })}</span></p>)}</div></div> : null}
                <p className="method-caveat">This is an empirical event model, not a DCF or proof of alpha. The small sample, changing market regimes and missing options/social evidence limit inference.</p>
              </details>
              {sourceUrl && <p className="research-card-source"><a href={sourceUrl} target="_blank" rel="noreferrer">Read the original release <span aria-hidden="true">↗</span></a></p>}
            </div>
          </details>
        </div>
      </article>
    );
  };

  return (
    <section className="panel earnings-desk">
      <SectionHeader eyebrow="THE EARNINGS DESK" title="The call. The result. The difference."
        description="Company results alongside the estimates recorded before release." />
      {primary.length ? (
        <>
          <div className="research-desk-label">{upcoming.length ? "Upcoming releases & latest reported results" : "Latest reported results in this feed"}</div>
          <div className="research-cards">{primary.map(card)}</div>
          {archive.length > 0 && <details className="research-archive"><summary>More earnings records <span>{archive.length}</span></summary><div className="research-cards">{archive.map(card)}</div></details>}
        </>
      ) : <EmptyState title="No earnings records available" description="This feed has not supplied financial estimates or reported results. No sample forecasts are shown." />}
    </section>
  );
}

function ActualComparisonPanel({
  earningsForecasts,
  earningsPriceForecasts,
  latestQuotes,
  priceForecastScorecard,
}: {
  earningsForecasts: AnyRecord[];
  earningsPriceForecasts: AnyRecord[];
  latestQuotes: AnyRecord[];
  priceForecastScorecard: AnyRecord;
}) {
  const candidates = unionEarningsForecastInputs(
    earningsForecasts,
    earningsPriceForecasts,
  );

  const rows = candidates
    .map((forecast, index) => {
      const ticker = pickString(
        forecast,
        ["ticker", "symbol"],
        "—",
      ).toUpperCase();
      const view = priceForecastView(
        forecast,
        earningsPriceForecasts,
        latestQuotes,
      );
      const period = pickString(
        forecast,
        ["fiscalPeriod", "fiscal_period"],
        pickString(view.record, ["fiscalPeriod", "fiscal_period"], "Earnings"),
      );
      const actualPrice = view.actualPostPrice;
      const predictedPrice = view.predictedPostPrice;
      const referencePrice = view.referencePrice;
      const errorAmount =
        view.errorAmount ??
        (actualPrice !== null && predictedPrice !== null
          ? predictedPrice - actualPrice
          : null);
      const errorPct =
        view.errorPct ??
        (errorAmount !== null && actualPrice !== null && actualPrice !== 0
          ? (errorAmount / actualPrice) * 100
          : null);
      const directionHit = view.directionHit;
      const status =
        actualPrice !== null || view.status === "resolved"
          ? "resolved"
          : predictedPrice !== null
            ? "open"
            : "pending";
      return {
        id:
          pickString(view.record, ["id"]) ||
          pickString(forecast, ["id"], `${ticker}-${period}-${index}`),
        ticker,
        period,
        earningsDate: pickString(view.record, [
          "earningsDate",
          "earnings_date",
        ]),
        referencePrice,
        predictedPrice,
        actualPrice,
        actualPriceAt: view.actualPriceAt,
        errorAmount,
        errorPct,
        absoluteErrorPct:
          view.absoluteErrorPct ??
          (errorPct === null ? null : Math.abs(errorPct)),
        directionHit,
        status,
      };
    })
    .sort((a, b) => {
      if (a.status === "resolved" && b.status !== "resolved") return -1;
      if (a.status !== "resolved" && b.status === "resolved") return 1;
      return (
        (parseDate(a.earningsDate)?.getTime() ?? Infinity) -
        (parseDate(b.earningsDate)?.getTime() ?? Infinity)
      );
    });

  const resolvedRows = rows.filter(
    (row) => row.actualPrice !== null && row.predictedPrice !== null,
  );
  const derivedMae = resolvedRows.length
    ? resolvedRows.reduce(
        (sum, row) => sum + Math.abs(row.errorAmount ?? 0),
        0,
      ) / resolvedRows.length
    : null;
  const derivedMape = resolvedRows.length
    ? resolvedRows.reduce(
        (sum, row) => sum + (row.absoluteErrorPct ?? 0),
        0,
      ) / resolvedRows.length
    : null;
  const scoredDirections = resolvedRows.filter(
    (row) => row.directionHit !== null,
  );
  const derivedHitRate = scoredDirections.length
    ? scoredDirections.filter((row) => row.directionHit).length /
      scoredDirections.length
    : null;
  const mae =
    pickNumber(priceForecastScorecard, [
      "mae",
      "meanAbsoluteErrorAmount",
      "mean_absolute_error_amount",
      "meanAbsoluteError",
      "mean_absolute_error",
    ]) ?? derivedMae;
  const mape =
    pickNumber(priceForecastScorecard, [
      "mape",
      "meanAbsoluteErrorPct",
      "mean_absolute_error_pct",
      "meanAbsolutePercentageError",
      "mean_absolute_percentage_error",
    ]) ?? derivedMape;
  const hitRate =
    pickNumber(priceForecastScorecard, [
      "directionHitRate",
      "direction_hit_rate",
    ]) ?? derivedHitRate;
  const resolvedCount =
    pickNumber(priceForecastScorecard, [
      "resolvedForecasts",
      "resolved_forecasts",
      "resolvedCount",
      "resolved_count",
    ]) ?? resolvedRows.length;

  return (
    <section className="panel comparison-panel price-comparison-panel">
      <SectionHeader
        eyebrow="AUTOMATED BACKTEST"
        title="Forecast Performance Summary"
        description="Detailed outcomes remain on each earnings card. This section updates aggregate error and directional accuracy as results settle."
      />
      <div className="price-scorecard">
        <div>
          <span>Settled forecasts</span>
          <strong>{formatNumber(resolvedCount)}</strong>
        </div>
        <div>
          <span>Mean dollar error (MAE)</span>
          <strong>{formatStockPrice(mae)}</strong>
          <small>Lower is better</small>
        </div>
        <div>
          <span>Mean percentage error (MAPE)</span>
          <strong>{formatPercentPoint(mape, { digits: 1 })}</strong>
          <small>Mean absolute percentage error</small>
        </div>
        <div>
          <span>Directional accuracy</span>
          <strong>{formatPercent(hitRate)}</strong>
          <small>Forecast versus actual direction</small>
        </div>
      </div>
      <p className="scorecard-note">
        {rows.length
          ? `${rows.length} official earnings records tracked; ${resolvedRows.length} had both a frozen pre-release target and the defined target-session close. Failed calls remain included. Records without a target or settlement are excluded, with the reason shown on the company card. Error is target price minus actual price.`
          : "No forecasts are eligible for backtesting yet. The first frozen target will be added automatically."}
      </p>
    </section>
  );
}

function DataCaveats({ dashboard }: { dashboard: DashboardData }) {
  const dataMode = pickString(
    dashboard.system,
    ["dataMode", "data_mode"],
    dashboard.status,
  );
  const monitoring = pickString(
    dashboard.system,
    ["monitoring"],
    "unknown",
  );
  const scheduler = pickString(
    dashboard.system,
    ["scheduler"],
    "unknown",
  );
  const email = pickString(dashboard.system, ["email"], "unknown");
  const healthy =
    pickNumber(dashboard.metrics, ["healthySources", "healthy_sources"]) ??
    dashboard.sources.filter((source) =>
      ["healthy", "ready", "online", "ok"].includes(
        pickString(source, ["status"], "unknown").toLowerCase(),
      ),
    ).length;
  const total =
    pickNumber(dashboard.metrics, ["totalSources", "total_sources"]) ??
    dashboard.sources.length;
  const latency = pickNumber(dashboard.metrics, [
    "p95LatencyMs",
    "p95_latency_ms",
  ]);
  const failingSources = dashboard.sources.filter(
    (source) =>
      !["healthy", "ready", "online", "ok"].includes(
        pickString(source, ["status"], "unknown").toLowerCase(),
      ),
  );
  const latestSourceCheck = dashboard.sources
    .map((source) =>
      pickString(source, ["lastCheckedAt", "last_checked_at"]),
    )
    .filter(Boolean)
    .sort(
      (a, b) =>
        (parseDate(b)?.getTime() ?? 0) - (parseDate(a)?.getTime() ?? 0),
    )[0];
  const freshnessAt = dashboard.snapshotAt || latestSourceCheck;
  const notes: string[] = [];
  const cacheState = asRecord(dashboard.system.snapshotCache);
  if (cacheState.status === "stale") {
    notes.push("Live updates are temporarily unavailable. You are viewing the last saved snapshot, not current prices. Original data timestamps are preserved.");
  }
  if (dataMode === "fixture") {
    notes.push("The site is using demonstration data; values do not represent current market conditions.");
  } else if (dataMode === "partial" || dashboard.status === "partial") {
    notes.push("Only part of the live data stack is available; cross-source conclusions may still be unverified.");
  }
  if (monitoring === "manual" || scheduler === "sites_manual") {
    notes.push("Refreshes currently depend on a manual site trigger; continuous monitoring requires the external scheduler.");
  } else if (monitoring === "offline") {
    notes.push("Monitoring is offline. The site is showing the last saved snapshot.");
  }
  if (email === "needs_setup") {
    notes.push("The email alert channel is not fully configured, although events continue to be recorded on the site.");
  } else if (email === "disabled") {
    notes.push("Email alerts are disabled; no external notification will be sent.");
  }
  if (failingSources.length) {
    notes.push(
      `${failingSources.length} sources are currently unhealthy. Source and error records remain in the audit trail.`,
    );
  }
  if (!notes.length) {
    notes.push("No system-level data gap is currently detected. Verify each item against its primary source.");
  }

  return (
    <section className="panel caveats-panel">
      <div className="caveats-heading">
        <div>
          <p className="eyebrow">SOURCE &amp; FRESHNESS</p>
          <h2>Source Coverage & Freshness</h2>
        </div>
        <p>Distinguish “no new information” from “data not yet received.”</p>
      </div>
      <div className="freshness-grid">
        <div>
          <span>Data mode</span>
          <strong>{statusLabel(dataMode)}</strong>
        </div>
        <div>
          <span>Snapshot age</span>
          <strong>{freshnessAt ? formatRelative(freshnessAt) : "No snapshot"}</strong>
          <small>{freshnessAt ? `${formatDateTime(freshnessAt, true)} ET` : "—"}</small>
        </div>
        <div>
          <span>Healthy sources</span>
          <strong>
            {formatNumber(healthy)} / {formatNumber(total)}
          </strong>
        </div>
        <div>
          <span>P95 source-check latency</span>
          <strong>{latency === null ? "—" : formatDuration(latency)}</strong>
          <small>Latest check per source</small>
        </div>
      </div>
      <ul className="caveat-list">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function WatchlistPanel({
  watchlist,
  latestQuotes,
}: {
  watchlist: AnyRecord[];
  latestQuotes: AnyRecord[];
}) {
  const spyQuote = findLatestQuote("SPY", latestQuotes);
  const spyPrice = pickNumber(spyQuote, ["price"]);
  const spyChange = pickNumber(spyQuote, [
    "percentageChange",
    "percentage_change",
  ]);
  const spyQuoteAt = pickString(spyQuote, [
    "quoteAsOfAt",
    "quote_as_of_at",
    "asOfAt",
    "as_of_at",
  ]);
  const rows = watchlist
    .slice(0, 10)
    .map((item, index) => {
      const ticker = pickString(
        item,
        ["ticker", "symbol"],
        `#${index + 1}`,
      ).toUpperCase();
      const quote = findLatestQuote(ticker, latestQuotes);
      const price = pickNumber(quote, ["price"]);
      const stockChange = pickNumber(quote, [
        "percentageChange",
        "percentage_change",
      ]);
      const relativeChange =
        stockChange !== null && spyChange !== null
          ? stockChange - spyChange
          : null;
      return {
        item,
        ticker,
        company: pickString(item, [
          "company",
          "name",
          "companyName",
          "company_name",
        ]),
        price,
        stockChange,
        relativeChange,
        lastEventAt: pickString(item, [
          "lastEventAt",
          "last_event_at",
          "lastEvent",
        ]),
      };
    })
    .sort(
      (a, b) =>
        (b.relativeChange ?? Number.NEGATIVE_INFINITY) -
        (a.relativeChange ?? Number.NEGATIVE_INFINITY),
    );
  const maxAbsRelative = Math.max(
    1,
    ...rows.map((row) => Math.abs(row.relativeChange ?? 0)),
  );

  return (
    <section className="panel watchlist-panel">
      <SectionHeader
        eyebrow="RELATIVE STRENGTH"
        title="Research Watchlist vs. SPY Today"
        description="Excess return equals the stock's session move minus SPY's move. Positive values outperform; negative values underperform."
        trailing={
          <div className="benchmark-summary">
            <span>SPY benchmark</span>
            <strong>
              {spyPrice === null ? "Quote pending" : formatStockPrice(spyPrice)}
            </strong>
            <small>
              {spyChange === null
                ? "Session move pending"
                : `${formatPercentPoint(spyChange, {
                    signed: true,
                    digits: 2,
                  })} · ${
                    spyQuoteAt
                      ? `${formatDateTime(spyQuoteAt, true)} ET`
                      : "Time pending"
                  }`}
            </small>
          </div>
        }
      />
      {rows.length ? (
        <div className="relative-performance-chart">
          <div className="relative-chart-legend">
            <strong>Today's excess return vs. SPY</strong>
            <span>
              Left = underperforming SPY
              <i aria-hidden="true" />
              Right = outperforming SPY
            </span>
          </div>
          {rows.map((row) => {
            const relative = row.relativeChange;
            const width =
              relative === null
                ? 0
                : (Math.abs(relative) / maxAbsRelative) * 50;
            const left =
              relative === null
                ? 50
                : relative >= 0
                  ? 50
                  : 50 - width;
            const tone =
              relative === null
                ? "neutral"
                : relative > 0
                  ? "positive"
                  : relative < 0
                    ? "negative"
                    : "neutral";
            return (
              <article
                className="relative-chart-row"
                key={row.ticker}
                aria-label={`${row.ticker} versus SPY today: ${
                  relative === null
                    ? "data pending"
                    : `${relative >= 0 ? "outperforming by" : "underperforming by"} ${Math.abs(
                        relative,
                      ).toFixed(2)} percentage points`
                }`}
              >
                <div className="relative-security">
                  <span className="ticker-tile">{row.ticker.slice(0, 5)}</span>
                  <div>
                    <strong>{row.ticker}</strong>
                    <small>{row.company || "Research security"}</small>
                  </div>
                </div>
                <div className="relative-quote">
                  <strong>
                    {row.price === null
                      ? "Quote pending"
                      : formatStockPrice(row.price)}
                  </strong>
                  <small>
                    Stock today{" "}
                    {row.stockChange === null
                      ? "—"
                      : formatPercentPoint(row.stockChange, {
                          signed: true,
                          digits: 2,
                        })}
                  </small>
                </div>
                <div className="relative-bar-cell">
                  <div className="relative-bar-track" aria-hidden="true">
                    <i className="relative-zero-line" />
                    {relative !== null ? (
                      <span
                        className={`relative-bar ${tone}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    ) : null}
                  </div>
                  <small>
                    {row.lastEventAt
                      ? `Latest event ${formatRelative(row.lastEventAt)}`
                      : "Awaiting a material event"}
                  </small>
                </div>
                <div className={`relative-result ${tone}`}>
                  <span>Excess return</span>
                  <strong>
                    {relative === null
                      ? "Pending"
                      : formatPercentPoint(relative, {
                          signed: true,
                          digits: 2,
                        })}
                  </strong>
                  <small>
                    {relative === null
                      ? "SPY or stock quote unavailable"
                      : relative > 0
                        ? "Outperforming SPY"
                        : relative < 0
                          ? "Underperforming SPY"
                          : "In line with SPY"}
                  </small>
                </div>
              </article>
            );
          })}
          <div className="relative-chart-note">
            <strong>How to use this chart</strong>
            <p>
              It removes the market-wide move shared by every stock that day. A large gap versus SPY is a prompt to investigate earnings, guidance, news, or company-specific events—not a trading signal by itself.
            </p>
          </div>
        </div>
      ) : (
        <EmptyState
          title="Watchlist not yet synchronized"
          description="Add ORCL, MSTR, and priority names across the AI and semiconductor value chain."
        />
      )}
    </section>
  );
}

type DashboardView = "equities" | "btc" | "world";

const DASHBOARD_VIEW_LABELS: Array<{
  id: DashboardView;
  label: string;
  eyebrow: string;
}> = [
  { id: "equities", label: "U.S. Equities", eyebrow: "EQUITY RESEARCH" },
  { id: "btc", label: "BTC 30-Day Outlook", eyebrow: "DIGITAL ASSET" },
  { id: "world", label: "Live Market Feed", eyebrow: "LIVE MONITORING" },
];

function ResearchTabs({
  active,
  onChange,
}: {
  active: DashboardView;
  onChange: (view: DashboardView) => void;
}) {
  return (
    <nav className="research-tabs" aria-label="Signal Ledger research pages">
      {DASHBOARD_VIEW_LABELS.map((item) => (
        <button
          className={active === item.id ? "active" : ""}
          key={item.id}
          type="button"
          aria-current={active === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
        >
          <span>{item.eyebrow}</span>
          <strong>{item.label}</strong>
        </button>
      ))}
    </nav>
  );
}

function formatBtcPrice(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[$,%\s,]/g, ""))
        : Number.NaN;
  if (!Number.isFinite(number)) return "—";
  return `$${number.toLocaleString("en-US", {
    maximumFractionDigits: number >= 1_000 ? 0 : 2,
  })}`;
}

function formatBtcVolume(value: unknown) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[$,%\s,]/g, ""))
        : Number.NaN;
  if (!Number.isFinite(number)) return "—";
  return `${number.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })} BTC`;
}

function signedPercent(value: unknown, digits = 1) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.replace(/[$,%\s,]/g, ""))
        : Number.NaN;
  if (!Number.isFinite(number)) return "—";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function BtcForecastChart({
  candles,
  path,
  forecast,
}: {
  candles: AnyRecord[];
  path: AnyRecord[];
  forecast: AnyRecord;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const forecastDate = pickString(forecast, ["forecastDate", "forecast_date"]);
  const targetDate = pickString(forecast, ["targetDate", "target_date"]);
  const historicalStart = forecastDate
    ? new Date(`${forecastDate}T00:00:00.000Z`)
    : null;
  historicalStart?.setUTCDate(historicalStart.getUTCDate() - 30);
  const history = candles
    .filter((row) => {
      const day = pickString(row, ["day"]);
      return (
        day &&
        (!historicalStart || day >= historicalStart.toISOString().slice(0, 10)) &&
        (!forecastDate || day <= forecastDate)
      );
    })
    .map((row) => ({
      day: pickString(row, ["day"]),
      value: pickNumber(row, ["close"]),
    }))
    .filter(
      (row): row is { day: string; value: number } => row.value !== null,
    );
  const forecastSeries = path
    .map((row) => ({
      day: pickString(row, ["targetDate", "target_date"]),
      value: pickNumber(row, ["predictedPrice", "predicted_price"]),
      actual: pickNumber(row, ["actualClose", "actual_close"]),
      deviationPct: pickNumber(row, [
        "pathDeviationPct",
        "path_deviation_pct",
      ]),
    }))
    .filter(
      (row): row is {
        day: string;
        value: number;
        actual: number | null;
        deviationPct: number | null;
      } =>
        Boolean(row.day) && row.value !== null,
    );
  const actualForward = forecastSeries
    .filter(
      (row): row is {
        day: string;
        value: number;
        actual: number;
        deviationPct: number | null;
      } =>
        row.actual !== null,
    )
    .map((row) => ({ day: row.day, value: row.actual }));
  const actualMap = new Map(
    [...history, ...actualForward].map((row) => [row.day, row.value]),
  );
  const actualSeries = Array.from(actualMap, ([day, value]) => ({
    day,
    value,
  })).sort((a, b) => a.day.localeCompare(b.day));
  const days = Array.from(
    new Set([
      ...actualSeries.map((row) => row.day),
      ...forecastSeries.map((row) => row.day),
    ]),
  ).sort();
  const values = [
    ...actualSeries.map((row) => row.value),
    ...forecastSeries.map((row) => row.value),
  ];
  if (days.length < 2 || values.length < 2) {
    return (
      <EmptyState
        title="Awaiting the first forecast path"
        description="The chart will appear after the cloud service imports Coinbase daily data and freezes the first 30-day outlook."
      />
    );
  }
  const width = Math.max(1_080, days.length * 34);
  const height = 390;
  const padding = { top: 26, right: 42, bottom: 54, left: 78 };
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const low = minimum - range * 0.12;
  const high = maximum + range * 0.12;
  const x = (day: string) =>
    padding.left +
    (days.indexOf(day) / Math.max(1, days.length - 1)) *
      (width - padding.left - padding.right);
  const y = (value: number) =>
    padding.top +
    ((high - value) / (high - low)) *
      (height - padding.top - padding.bottom);
  const points = (rows: Array<{ day: string; value: number }>) =>
    rows.map((row) => `${x(row.day)},${y(row.value)}`).join(" ");
  const tickValues = Array.from({ length: 5 }, (_, index) =>
    low + ((high - low) * index) / 4,
  ).reverse();
  const dateTicks = [days[0], forecastDate, targetDate || days.at(-1)]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, list) => list.indexOf(value) === index);
  const latestComparison = forecastSeries
    .filter(
      (row): row is {
        day: string;
        value: number;
        actual: number;
        deviationPct: number | null;
      } => row.actual !== null,
    )
    .at(-1);
  const latestDeviationPct = latestComparison
    ? (latestComparison.actual - latestComparison.value) /
      latestComparison.value *
      100
    : null;
  const nudgeChart = (direction: -1 | 1) => {
    scrollRef.current?.scrollBy({
      left: direction * Math.max(420, scrollRef.current.clientWidth * 0.7),
      behavior: "smooth",
    });
  };

  return (
    <div className="btc-chart-wrap">
      <div className="btc-chart-toolbar">
        <div className="chart-legend" aria-label="Chart legend">
          <span className="actual"><i />Actual daily close</span>
          <span className="forecast"><i />Frozen path</span>
          <span className="deviation"><i />Latest deviation</span>
        </div>
        <div className="btc-chart-pan" aria-label="Pan chart horizontally">
          <button type="button" onClick={() => nudgeChart(-1)}>
            ← Earlier
          </button>
          <button type="button" onClick={() => nudgeChart(1)}>
            Later →
          </button>
        </div>
      </div>
      <div
        className="btc-chart-scroll"
        ref={scrollRef}
        role="region"
        tabIndex={0}
        aria-label="Scrollable Bitcoin actual-price and frozen-forecast chart"
      >
        <svg
          className="btc-line-chart"
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: `${width}px`, minWidth: `${width}px` }}
          role="img"
          aria-label="Bitcoin actual price, frozen 30-day path, and daily deviation"
        >
          {tickValues.map((value) => (
            <g key={value}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y(value)}
                y2={y(value)}
                className="chart-grid-line"
              />
              <text x={padding.left - 14} y={y(value) + 5} textAnchor="end">
                {formatBtcPrice(value)}
              </text>
            </g>
          ))}
          {forecastDate ? (
            <g>
              <line
                x1={x(forecastDate)}
                x2={x(forecastDate)}
                y1={padding.top}
                y2={height - padding.bottom}
                className="forecast-freeze-line"
              />
              <text
                x={x(forecastDate) + 8}
                y={padding.top + 14}
                className="forecast-freeze-label"
              >
                Forecast frozen
              </text>
            </g>
          ) : null}
          <polyline
            className="actual-price-line"
            points={points(actualSeries)}
            fill="none"
          />
          <polyline
            className="forecast-price-line"
            points={points(forecastSeries)}
            fill="none"
          />
          {latestComparison ? (
            <g className="latest-deviation-marker">
              <line
                x1={x(latestComparison.day)}
                x2={x(latestComparison.day)}
                y1={y(latestComparison.value)}
                y2={y(latestComparison.actual)}
              />
              <circle
                className="deviation-forecast-dot"
                cx={x(latestComparison.day)}
                cy={y(latestComparison.value)}
                r="5"
              />
              <circle
                className="deviation-actual-dot"
                cx={x(latestComparison.day)}
                cy={y(latestComparison.actual)}
                r="6"
              />
              <text
                x={x(latestComparison.day) + (x(latestComparison.day) > width - 210 ? -10 : 10)}
                y={Math.min(
                  y(latestComparison.value),
                  y(latestComparison.actual),
                ) - 12}
                textAnchor={
                  x(latestComparison.day) > width - 210 ? "end" : "start"
                }
              >
                Actual vs. path {signedPercent(latestDeviationPct, 2)}
              </text>
            </g>
          ) : null}
          {actualSeries.slice(-1).map((row) => (
            <circle
              className="actual-last-dot"
              cx={x(row.day)}
              cy={y(row.value)}
              r="6"
              key={row.day}
            />
          ))}
          {forecastSeries.slice(-1).map((row) => (
            <circle
              className="forecast-last-dot"
              cx={x(row.day)}
              cy={y(row.value)}
              r="6"
              key={row.day}
            />
          ))}
          {dateTicks.map((day) => (
            <text
              className="chart-date-label"
              x={x(day)}
              y={height - 18}
              textAnchor={
                day === days[0]
                  ? "start"
                  : day === days.at(-1)
                    ? "end"
                    : "middle"
              }
              key={day}
            >
              {day.slice(5)}
            </text>
          ))}
        </svg>
      </div>
      <p className="btc-scroll-hint">
        Use the buttons, trackpad, or bottom scrollbar to move across time. The navy line in the forecast window is the actual close, compared daily with the fixed orange path.
      </p>
      <p className="chart-note">
        Path deviation = (actual close − frozen path value) ÷ frozen path value. Positive means actual price is above the path; negative means below. The 30-day path never changes during the cycle.
      </p>
    </div>
  );
}

function BtcVolumeChart({ candles }: { candles: AnyRecord[] }) {
  const rows = candles.slice(-30);
  const volumes = rows
    .map((row) => pickNumber(row, ["volumeBtc", "volume_btc"]))
    .filter((value): value is number => value !== null);
  const max = Math.max(1, ...volumes);
  if (!rows.length) return null;
  return (
    <div className="btc-volume-chart" aria-label="Bitcoin volume over the last 30 days">
      {rows.map((row) => {
        const volume = pickNumber(row, ["volumeBtc", "volume_btc"]) ?? 0;
        const day = pickString(row, ["day"]);
        return (
          <div
            className="btc-volume-bar"
            key={day}
            title={`${day} · ${formatBtcVolume(volume)}`}
          >
            <i style={{ height: `${Math.max(4, (volume / max) * 100)}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function btcForecastNarrative(forecast: AnyRecord, volume: AnyRecord) {
  const stance = pickString(forecast, ["stance"], "neutral").toLowerCase();
  const baseline = pickNumber(forecast, ["baselinePrice", "baseline_price"]);
  const target = pickNumber(forecast, ["targetPrice", "target_price"]);
  const expectedReturn = pickNumber(forecast, [
    "predictedReturnPct",
    "predicted_return_pct",
  ]);
  const low = pickNumber(forecast, ["researchLow", "research_low"]);
  const high = pickNumber(forecast, ["researchHigh", "research_high"]);
  const features = asRecord(forecast.features);
  const momentum7 = pickNumber(features, ["momentum7Pct", "momentum_7_pct"]);
  const momentum30 = pickNumber(features, ["momentum30Pct", "momentum_30_pct"]);
  const rsi14 = pickNumber(features, ["rsi14"]);
  const realizedVol = pickNumber(features, [
    "realizedVol30AnnualizedPct",
    "realized_vol_30_annualized_pct",
  ]);
  const volumeRatio = pickNumber(volume, ["ratio7dTo30d", "ratio_7d_to_30d"]);
  const direction = stance === "bullish" ? "rise" : stance === "bearish" ? "fall" : "remain range-bound";
  const thesis = `The frozen 30-day model expects Bitcoin to ${direction}${
    target !== null ? ` toward ${formatBtcPrice(target)}` : ""
  }${expectedReturn !== null ? ` (${signedPercent(expectedReturn)})` : ""}${
    baseline !== null ? ` from a ${formatBtcPrice(baseline)} reference price` : ""
  }. This path remains fixed for the full cycle; only actual daily closes and forecast error are appended.`;
  const invalidation = stance === "bullish"
    ? `The bullish call fails if the daily close breaks below ${formatBtcPrice(low)} while seven-day momentum turns negative.`
    : stance === "bearish"
      ? `The bearish call fails if the daily close breaks above ${formatBtcPrice(high)} while seven-day momentum turns positive.`
      : `The range-bound call fails if the daily close breaks above ${formatBtcPrice(high)} or below ${formatBtcPrice(low)}.`;
  const drivers = [
    `Momentum: seven-day ${signedPercent(momentum7)}; 30-day ${signedPercent(momentum30)}.`,
    `Volume confirmation: seven-day average volume is ${volumeRatio === null ? "unavailable" : `${volumeRatio.toFixed(2)}×`} the 30-day average.`,
    `Positioning: RSI(14) is ${rsi14 === null ? "unavailable" : rsi14.toFixed(1)}.`,
    `Risk: 30-day annualized realized volatility is ${formatPercentPoint(realizedVol, { digits: 1 })}.`,
  ];
  return { thesis, invalidation, drivers };
}

function BtcProLock({ detail }: { detail: string }) {
  return (
    <div className="btc-pro-lock">
      <span className="tier-chip tier-chip-pro">PRO</span>
      <p>{detail}</p>
      <Link href="/pricing" className="pro-lock-hint"><b>See pricing →</b></Link>
    </div>
  );
}

function BtcResearchPanel({ research, tier }: { research: AnyRecord; tier: "FREE" | "PRO" }) {
  const isPro = tier === "PRO";
  const latest = asRecord(research.latest);
  const forecasts = asArray(research.forecasts);
  const forecast = forecasts[0] ?? {};
  const candles = asArray(research.candles);
  const path = asArray(research.latestPath ?? research.latest_path);
  const comparisons = path.filter(
    (point) => pickNumber(point, ["actualClose", "actual_close"]) !== null,
  );
  const latestComparison = comparisons.at(-1) ?? {};
  const backtests = asArray(research.backtests);
  const scorecard = asRecord(research.scorecard);
  const volume = asRecord(research.volume);
  const features = asRecord(forecast.features);
  const narrative = btcForecastNarrative(forecast, volume);
  const drivers = narrative.drivers;
  const stance = pickString(forecast, ["stance"], "neutral");
  const change24h = pickNumber(latest, ["change24hPct", "change_24h_pct"]);
  const volumeRatio = pickNumber(volume, ["ratio7dTo30d", "ratio_7d_to_30d"]);
  const latestPathDeviation = pickNumber(latestComparison, [
    "pathDeviationPct",
    "path_deviation_pct",
  ]);
  const forecastDate = pickString(forecast, ["forecastDate", "forecast_date"]);

  return (
    <div className="btc-page">
      <section className="panel btc-hero-panel">
        <SectionHeader
          eyebrow="BTC 30-DAY OUTLOOK"
          title="Bitcoin: 30-Day Research Outlook"
          description="One forecast is frozen per 30-day cycle. Direction, target, and path remain unchanged; each UTC close only adds actual price and deviation. The outlook is free to read. Signal Ledger PRO covers equity valuation, options analytics and holdings detail."
          trailing={
            <div className="header-chips">
              <span className="tier-chip tier-chip-free">FREE · 30-DAY OUTLOOK</span>
              <span className="live-indicator">
                <i />
                Coinbase · every 5 minutes
              </span>
            </div>
          }
        />
        {pickNumber(latest, ["price"]) === null ? (
          <EmptyState
            title="Awaiting the first Coinbase sync"
            description="The next monitoring cycle will populate price, volume, and the first 30-day forecast automatically."
          />
        ) : (
          <>
            <div className="btc-kpi-grid">
              <div>
                <span>BTC-USD latest price</span>
                <strong>{formatBtcPrice(latest.price)}</strong>
                <small className={statusTone(change24h && change24h < 0 ? "failed" : "healthy")}>
                  24 hours {signedPercent(change24h)}
                </small>
              </div>
              <div>
                <span>Frozen 30-day target</span>
                <strong>{formatBtcPrice(forecast.targetPrice)}</strong>
                <small>
                  Target date {pickString(forecast, ["targetDate"])}
                </small>
              </div>
              <div>
                <span>Model call</span>
                <strong className={`stance-${stance}`}>
                  {stance === "bullish"
                    ? "Bullish"
                    : stance === "bearish"
                      ? "Bearish"
                      : "Range-bound"}
                  {" "}
                  {signedPercent(forecast.predictedReturnPct)}
                </strong>
                <small>
                  Frozen {formatDateTime(pickString(forecast, ["frozenAt"]), true)}
                </small>
              </div>
              <div>
                <span>24-hour volume</span>
                <strong>{formatBtcVolume(latest.volume24hBtc)}</strong>
                <small>
                  7-day / 30-day average {volumeRatio === null ? "—" : `${volumeRatio.toFixed(2)}×`}
                </small>
              </div>
            </div>

            <div className="btc-thesis-grid">
              <div className="btc-thesis-call">
                <span>30-day thesis</span>
                <h3>{narrative.thesis}</h3>
                <div className="btc-target-band">
                  <span>
                    Research risk range
                    <strong>
                      {formatBtcPrice(forecast.researchLow)} —{" "}
                      {formatBtcPrice(forecast.researchHigh)}
                    </strong>
                  </span>
                  <span>
                    Invalidation condition
                    <strong>{narrative.invalidation}</strong>
                  </span>
                </div>
              </div>
              <div className="btc-feature-ledger">
                <span>Model input snapshot</span>
                {isPro ? (
                  <dl>
                    <div>
                      <dt>7-day momentum</dt>
                      <dd>{signedPercent(features.momentum7Pct)}</dd>
                    </div>
                    <div>
                      <dt>30-day momentum</dt>
                      <dd>{signedPercent(features.momentum30Pct)}</dd>
                    </div>
                    <div>
                      <dt>RSI(14)</dt>
                      <dd>{formatNumber(pickNumber(features, ["rsi14"]), 1)}</dd>
                    </div>
                    <div>
                      <dt>30-day realized volatility</dt>
                      <dd>{formatPercentPoint(pickNumber(features, ["realizedVol30AnnualizedPct"]))}</dd>
                    </div>
                  </dl>
                ) : (
                  <BtcProLock detail="The model's momentum, RSI and realized-volatility inputs are part of Signal Ledger PRO." />
                )}
              </div>
            </div>

            <div className="btc-chart-card">
              <div className="chart-card-heading">
                <div>
                  <span>FORECAST VS ACTUAL</span>
                  <h3>Actual Price vs. the Single Frozen Path</h3>
                </div>
                <p>
                  Frozen {forecastDate || "—"} · {comparisons.length}/30 days observed
                </p>
              </div>
              <div className="btc-vintage-metrics">
                <div>
                  <span>Frozen reference price</span>
                  <strong>{formatBtcPrice(forecast.baselinePrice)}</strong>
                  <small>{forecastDate || "Awaiting freeze"}</small>
                </div>
                <div>
                  <span>Frozen 30-day target</span>
                  <strong>{formatBtcPrice(forecast.targetPrice)}</strong>
                  <small>Target date {pickString(forecast, ["targetDate"])}</small>
                </div>
                <div>
                  <span>Latest actual close</span>
                  <strong>{formatBtcPrice(latestComparison.actualClose)}</strong>
                  <small>
                    {pickString(
                      latestComparison,
                      ["targetDate", "target_date"],
                      "Awaiting UTC close",
                    )}
                  </small>
                </div>
                <div className="btc-deviation-kpi">
                  <span>Current path deviation</span>
                  <strong>{signedPercent(latestPathDeviation, 2)}</strong>
                  <small>
                    {latestPathDeviation === null
                      ? "Awaiting UTC close"
                      : latestPathDeviation >= 0
                        ? "Actual price above path"
                        : "Actual price below path"}
                  </small>
                </div>
              </div>
              <BtcForecastChart
                candles={candles}
                path={path}
                forecast={forecast}
              />
            </div>

            <div className="btc-detail-grid">
              <article className="btc-analysis-card">
                <span>Why the model made this call</span>
                {isPro ? (
                  <ol>
                    {drivers.length ? (
                      drivers.map((driver) => <li key={driver}>{driver}</li>)
                    ) : (
                      <li>Awaiting the first model input snapshot.</li>
                    )}
                  </ol>
                ) : (
                  <BtcProLock detail="The model's reasoning — the four drivers behind the frozen call — is part of Signal Ledger PRO." />
                )}
              </article>
              <article className="btc-analysis-card">
                <span>Volume regime · last 30 days</span>
                <BtcVolumeChart candles={candles} />
                <p>
                  7-day average {formatBtcVolume(volume.average7dBtc)}; 30-day average{" "}
                  {formatBtcVolume(volume.average30dBtc)}. Volume confirms trend strength; it does not determine direction on its own.
                </p>
              </article>
            </div>
          </>
        )}
      </section>

      <section className="panel btc-backtest-panel">
        <SectionHeader
          eyebrow="DAILY BACKTEST"
          title="Path Tracking & 30-Day Evaluation"
          description="Daily rows measure how one frozen path is evolving; they are correlated observations, not independent forecasts. Forecast performance is judged only when a full 30-day cycle closes."
          trailing={
            <span className="score-chip">
              {formatNumber(pickNumber(scorecard, ["dailyComparisons"]))} daily comparisons
            </span>
          }
        />
        <div className="btc-score-grid">
          <div>
            <span>Frozen 30-day cycles</span>
            <strong>{formatNumber(pickNumber(scorecard, ["forecastsFrozen"]))}</strong>
          </div>
          <div>
            <span>Daily path deviation · MAE</span>
            <strong>{formatPercentPoint(pickNumber(scorecard, ["meanAbsolutePathDeviationPct", "meanAbsoluteErrorPct"]))}</strong>
            <small>Diagnostic only</small>
          </div>
          <div>
            <span>Completed-cycle direction</span>
            <strong>{formatNumber(pickNumber(scorecard, ["settledDirectionHits"]))} / {formatNumber(pickNumber(scorecard, ["settled30dForecasts"]))}</strong>
            <small>Not a statistically valid hit rate yet</small>
          </div>
          <div>
            <span>30-day target error</span>
            <strong>{formatPercentPoint(pickNumber(scorecard, ["meanAbsoluteTargetErrorPct"]))}</strong>
            <small>No-change baseline {formatPercentPoint(pickNumber(scorecard, ["noChangeMeanAbsoluteErrorPct"]))}</small>
          </div>
        </div>
        {isPro ? (
          backtests.length ? (
            <div className="data-table-scroll" role="region" aria-label="Bitcoin daily backtest table">
              <table className="market-data-table btc-backtest-table">
                <thead>
                  <tr>
                    <th>Forecast date</th>
                    <th>Comparison date</th>
                    <th>Frozen path value</th>
                    <th>Actual close</th>
                    <th>Path error</th>
                    <th>Path direction</th>
                  </tr>
                </thead>
                <tbody>
                  {backtests.slice(0, 30).map((row, index) => (
                    <tr key={`${pickString(row, ["forecastId"])}-${index}`}>
                      <td>{pickString(row, ["forecastDate"])}</td>
                      <td>{pickString(row, ["targetDate"])}</td>
                      <td>{formatBtcPrice(row.predictedPathPrice)}</td>
                      <td>{formatBtcPrice(row.actualClose)}</td>
                      <td>{signedPercent(row.errorPct, 2)}</td>
                      <td>
                        <span
                          className={`result-badge ${
                            pickBoolean(row, ["directionHit"]) ? "hit" : "miss"
                          }`}
                        >
                          {pickBoolean(row, ["directionHit"]) ? "Aligned" : "Diverged"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="Backtesting begins after the first daily close"
              description="After a forecast is frozen, the system appends actual closes from the next UTC day onward. A full score is available after 30 days."
            />
          )
        ) : (
          <BtcProLock detail="The full per-day path-evaluation table is part of Signal Ledger PRO." />
        )}
      </section>
    </div>
  );
}

const NEWS_REGION_LABELS: Record<string, string> = {
  ALL: "All Markets",
  US: "United States",
  JP: "Japan",
  KR: "South Korea",
  CN: "China",
  GLOBAL: "Global",
};

function worldNewsEnglishTitle(item: AnyRecord): string {
  const original = pickString(item, ["headline"]);
  if (original && !/[\u3400-\u9fff]/.test(original)) return original;
  const generated = pickString(item, ["titleZh", "title_zh"]);
  if (generated && !/[\u3400-\u9fff]/.test(generated)) return generated;
  return "English briefing in progress";
}

function worldNewsCategory(item: AnyRecord) {
  const raw = pickString(item, ["category"]).toLowerCase();
  const headline = worldNewsEnglishTitle(item).toLowerCase();
  const text = `${raw} ${headline}`;
  if (/earnings|guidance|profit|revenue/.test(text)) return "Earnings & Guidance";
  if (/central bank|federal reserve|rate|inflation|gdp|macro|monetary/.test(text)) return "Macro & Monetary Policy";
  if (/war|military|sanction|tariff|trade|geopolit/.test(text)) return "Geopolitics & Trade";
  if (/oil|gas|energy|commodity/.test(text)) return "Energy & Commodities";
  if (/chip|semiconductor|ai|technology/.test(text)) return "Technology & Supply Chain";
  if (/regulat|policy|politic/.test(text)) return "Policy & Regulation";
  return "Markets & Industry";
}

function worldNewsEnglishBrief(item: AnyRecord) {
  const headline = worldNewsEnglishTitle(item);
  const note = (keys: string[]) => researchNotes(keys.map(key => item[key]))[0] ?? "";
  return {
    headline, category: worldNewsCategory(item),
    factSummary: note(["factSummary", "fact_summary", "factSummaryZh", "fact_summary_zh", "summary"]),
    commentary: note(["commentary", "commentaryZh", "commentary_zh"]),
    impactPath: note(["impactPath", "impact_path", "impactPathZh", "impact_path_zh"]),
    verification: note(["verification", "verificationZh", "verification_zh"]),
  };
}

function WorldNewsPanel({
  news,
  snapshotAt,
  sources,
}: {
  news: AnyRecord[];
  snapshotAt: string;
  sources: AnyRecord[];
}) {
  const [region, setRegion] = useState("ALL");
  const newsSource = sources.find(
    (source) => pickString(source, ["id"]) === "news:gdelt-world",
  );
  const lastCheckedAt = newsSource
    ? pickString(newsSource, ["lastCheckedAt", "last_checked_at"])
    : "";
  const lastSuccessAt = newsSource
    ? pickString(newsSource, ["lastSuccessAt", "last_success_at"])
    : "";
  const sourceStatus = newsSource
    ? pickString(newsSource, ["status"], "unknown")
    : "unknown";
  const snapshotTimeMs = parseDate(snapshotAt)?.getTime() ?? 0;
  const sourceCheckAgeMs = lastCheckedAt && snapshotTimeMs > 0
    ? Math.max(
        0,
        snapshotTimeMs - (parseDate(lastCheckedAt)?.getTime() ?? 0),
      )
    : Number.POSITIVE_INFINITY;
  const sourceIsCurrent =
    ["healthy", "ready", "online", "ok"].includes(
      sourceStatus.toLowerCase(),
    ) && sourceCheckAgeMs <= 15 * 60 * 1_000;
  const freshnessAnchor =
    parseDate(snapshotAt)?.getTime() ??
    news.reduce(
      (latest, item) =>
        Math.max(
          latest,
          parseDate(pickString(item, ["publishedAt"]))?.getTime() ?? 0,
        ),
      0,
    );
  const visible = news
    .filter((item) => {
      const publishedAt =
        parseDate(pickString(item, ["publishedAt"]))?.getTime() ?? 0;
      const ageMs = freshnessAnchor - publishedAt;
      return (
        ageMs >= -5 * 60 * 1_000 &&
        ageMs <= 24 * 60 * 60 * 1_000 &&
        (region === "ALL" || pickString(item, ["region"]) === region)
      );
    })
    .sort(
      (left, right) =>
        (parseDate(pickString(right, ["publishedAt"]))?.getTime() ?? 0) -
          (parseDate(pickString(left, ["publishedAt"]))?.getTime() ?? 0) ||
        (pickNumber(right, ["importanceScore"]) ?? 0) -
          (pickNumber(left, ["importanceScore"]) ?? 0),
    );
  const latestQualifiedAt = pickString(visible[0] ?? {}, ["publishedAt"]);
  return (
    <div className="world-news-page">
      <section className="panel world-news-panel">
        <SectionHeader
          eyebrow="LIVE MARKET MONITORING"
          title="Live Market Feed"
          description="Continuously updating market and geopolitical events across five markets — raw source reporting, separate from the post-close Daily Brief."
          trailing={
            <div className="news-freshness">
              <span className={`news-source-health ${sourceIsCurrent ? "healthy" : "delayed"}`}>
                <i />{sourceIsCurrent ? "BACKGROUND FEED ACTIVE" : "FEED CHECK DELAYED"}
              </span>
              <strong>
                Last feed check: {lastCheckedAt ? formatRelative(lastCheckedAt) : "Unavailable"}
              </strong>
              <small>
                {lastCheckedAt
                  ? `${formatDateTime(lastCheckedAt, true)} · Last successful ${formatRelative(lastSuccessAt)}`
                  : "No feed run recorded yet"}
              </small>
              <strong>
                Latest qualified story: {latestQualifiedAt ? formatRelative(latestQualifiedAt) : "None in the last 24 hours"}
              </strong>
              <small>Visible-page refresh: 1 minute · Feed scan: approximately 10 minutes</small>
            </div>
          }
        />
        <div className="news-region-tabs" role="tablist" aria-label="Filter by market">
          {Object.entries(NEWS_REGION_LABELS).map(([key, label]) => (
            <button
              type="button"
              role="tab"
              aria-selected={region === key}
              className={region === key ? "active" : ""}
              onClick={() => setRegion(key)}
              key={key}
            >
              {label}
            </button>
          ))}
        </div>

        {visible.length ? (
          <div className="world-news-list">
            {visible.slice(0, 40).map((item) => {
              const brief = worldNewsEnglishBrief(item);
              const importance =
                pickNumber(item, ["importanceScore", "importance_score"]) ?? 0;
              const evidenceStatus = pickString(
                item,
                ["evidenceStatus", "evidence_status"],
                "Reported",
              );
              return (
                <article className="world-news-card" key={pickString(item, ["id"])}>
                  <div className="world-news-card-body">
                    <div className="world-news-meta">
                      <span>{NEWS_REGION_LABELS[pickString(item, ["region"])]}</span>
                      <span>{brief.category}</span>
                      <span className="news-evidence-status">{localizeFinanceText(evidenceStatus, "Reported")}</span>
                      <time>{formatRelative(pickString(item, ["publishedAt"]))}</time>
                    </div>
                    <h3>{brief.headline}</h3>
                    <div className="news-script-grid">
                      {brief.factSummary && brief.factSummary !== brief.headline && <div className="news-brief-main">
                        <span>WHAT HAPPENED</span>
                        <p>{brief.factSummary}</p>
                      </div>}
                      {brief.commentary && <div>
                        <span>WHY IT MATTERS</span>
                        <p>{brief.commentary}</p>
                      </div>}
                      {brief.impactPath && <div>
                        <span>WHO IS AFFECTED</span>
                        <p>{brief.impactPath}</p>
                      </div>}
                      {brief.verification && <div className="news-followup">
                        <span>WHAT TO WATCH NEXT</span>
                        <p>{brief.verification}</p>
                      </div>}
                    </div>
                    <div className="world-news-source">
                      <span>{pickString(item, ["sourceName"])}</span>
                      <a
                        href={pickString(item, ["sourceUrl"])}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original report ↗
                      </a>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No qualifying material event in the last 24 hours"
            description="No matching story is available in the current snapshot. See the feed-check timestamp above for source status."
          />
        )}
      </section>
    </div>
  );
}



/** One canonical snapshot per ticker, keyed case-insensitively. */
function mergeSnapshotsByTicker(current: InvestmentSnapshot[], incoming: InvestmentSnapshot[]) {
  const byTicker = new Map(current.map((snapshot) => [snapshot.ticker.toUpperCase(), snapshot]));
  incoming.forEach((snapshot) => {
    if (snapshot?.ticker) byTicker.set(snapshot.ticker.toUpperCase(), snapshot);
  });
  return [...byTicker.values()];
}

export default function DashboardClient({
  canManage = false,
  initialSnapshots = [],
  initialView = "equities",
  member,
}: {
  canManage?: boolean;
  initialSnapshots?: InvestmentSnapshot[];
  initialView?: DashboardView;
  member: MemberState;
}) {
  const [dashboard, setDashboard] = useState<DashboardData>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const [submittingForecast, setSubmittingForecast] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [activeView, setActiveView] = useState<DashboardView>(initialView);

  // Deep links from the nav (/?view=btc, /?view=world) arrive as a prop resolved
  // by the server page. A same-page navigation changes that prop without
  // remounting this client component, so re-sync the active tab whenever it does.
  useEffect(() => {
    setActiveView(initialView);
  }, [initialView]);
  const [valuationSnapshots, setValuationSnapshots] = useState<InvestmentSnapshot[]>(initialSnapshots);
  const [valuationMostViewed, setValuationMostViewed] = useState<string[]>([]);
  const [valuationLoading, setValuationLoading] = useState(initialSnapshots.length === 0);
  const [valuationError, setValuationError] = useState("");
  const dashboardRequest = useRef<AbortController | null>(null);
  const dashboardFailures = useRef(0);
  const nextDashboardRead = useRef(0);
  const requestedValuations = useRef(new Set<string>());

  const showToast = useCallback((nextToast: Toast) => {
    setToast(nextToast);
    window.setTimeout(() => {
      setToast((current) =>
        current?.message === nextToast.message ? null : current,
      );
    }, 4500);
  }, []);

  const loadDashboard = useCallback(async (showFullLoader = false) => {
    if (dashboardRequest.current || Date.now() < nextDashboardRead.current) return;
    const controller = new AbortController();
    dashboardRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    if (showFullLoader) setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/dashboard", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(extractError(payload, `Unable to load dashboard (${response.status})`));
      }
      const normalized = normalizeDashboard(payload);
      if (!normalized.snapshotAt) throw new Error("The live feed returned an incomplete snapshot.");
      setDashboard(normalized);
      saveBrowserSnapshot(normalized);
      dashboardFailures.current = 0;
      nextDashboardRead.current = Date.now() + 60_000;
    } catch (caught) {
      dashboardFailures.current += 1;
      nextDashboardRead.current = Date.now() + Math.min(300_000, 60_000 * 2 ** (dashboardFailures.current - 1));
      setError(readableDashboardError(caught));
    } finally {
      window.clearTimeout(timeout);
      dashboardRequest.current = null;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const saved = restoreBrowserSnapshot();
    if (saved) {
      setDashboard((current) => current.snapshotAt ? current : saved);
      setLoading(false);
    }
    const poll = async () => {
      if (document.visibilityState === "visible") await loadDashboard(false);
      if (!cancelled && document.visibilityState === "visible") {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void poll(), Math.max(60_000, nextDashboardRead.current - Date.now()));
      }
    };
    const resume = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    };
    timer = window.setTimeout(() => void poll(), 0);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      dashboardRequest.current?.abort();
    };
 }, [loadDashboard]);

  // The homepage shelf reads the canonical cached snapshot used by the
  // valuation page. It is a plain GET: no AI call, no duplicate fair value.
  const loadValuations = useCallback(async () => {
    try {
      const response = await fetch("/api/valuation/snapshot?scope=home", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(extractError(payload, `Valuation snapshots unavailable (${response.status})`));
      const body = asRecord(payload);
      const snapshots = Array.isArray(body.snapshots) ? body.snapshots as InvestmentSnapshot[] : [];
      // Merged, not replaced: the earnings desk adds tickers that this scope
      // does not cover, and a later load must not drop them.
      setValuationSnapshots((current) => mergeSnapshotsByTicker(current, snapshots));
      const sections = asRecord(body.sections);
      setValuationMostViewed(Array.isArray(sections.mostViewed) ? sections.mostViewed.filter((value): value is string => typeof value === "string") : []);
    } catch (caught) {
      setValuationError(caught instanceof Error ? caught.message : "Valuation snapshots unavailable.");
    } finally {
      setValuationLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadValuations(), 0);
    return () => window.clearTimeout(timer);
  }, [loadValuations]);

  // The shelf above only covers a fixed seed, so an earnings card for any other
  // ticker would silently render without its valuation block. Ask for the
  // earnings tickers explicitly and merge them into the same snapshot list.
  const earningsTickers = useMemo(() => {
    const tickers = new Set<string>();
    for (const record of [...dashboard.earningsForecasts, ...dashboard.earningsPriceForecasts]) {
      const ticker = pickString(record, ["ticker", "symbol"]).toUpperCase();
      if (ticker) tickers.add(ticker);
    }
    return [...tickers].sort();
  }, [dashboard.earningsForecasts, dashboard.earningsPriceForecasts]);

  // Deliberately keyed on a primitive and read through a ref: depending on
  // `valuationSnapshots` meant the shelf finishing first ran this effect's
  // cleanup, discarded the in-flight earnings snapshots, and left the tickers
  // marked as requested so they were never fetched again.
  const earningsTickerKey = earningsTickers.join(",");
  const latestSnapshots = useRef(valuationSnapshots);
  latestSnapshots.current = valuationSnapshots;

  useEffect(() => {
    // Wait for the shelf load to land first, otherwise a ticker the shelf does
    // cover would be requested twice on a cold client render.
    if (valuationLoading || !earningsTickerKey) return;
    const covered = new Set(latestSnapshots.current.map((snapshot) => snapshot.ticker.toUpperCase()));
    const missing = earningsTickerKey.split(",").filter(
      (ticker) => !covered.has(ticker) && !requestedValuations.current.has(ticker),
    );
    if (!missing.length) return;
    missing.forEach((ticker) => requestedValuations.current.add(ticker));
    void (async () => {
      try {
        const response = await fetch(
          `/api/valuation/snapshot?tickers=${encodeURIComponent(missing.join(","))}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        );
        if (!response.ok) throw new Error(`Valuations unavailable (${response.status})`);
        const body = asRecord(await readJsonResponse(response));
        const extra = Array.isArray(body.snapshots) ? (body.snapshots as InvestmentSnapshot[]) : [];
        // The merge is functional and never cancelled, so a slower shelf load
        // can no longer discard these results.
        setValuationSnapshots((current) => mergeSnapshotsByTicker(current, extra));
      } catch {
        // Unmark on failure so a later poll retries. A ticker the engine cannot
        // value simply never lands, and its card renders without the block.
        missing.forEach((ticker) => requestedValuations.current.delete(ticker));
      }
    })();
  }, [earningsTickerKey, valuationLoading]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(extractError(payload, `Refresh failed (${response.status})`));
      }
      showToast({ kind: "success", message: "Refresh started. New data will appear as each source completes." });
      await loadDashboard(false);
    } catch (caught) {
      showToast({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Unable to start a refresh",
      });
    } finally {
      setRefreshing(false);
    }
  };

  const handleTestEmail = async () => {
    setTestingEmail(true);
    try {
      const response = await fetch("/api/alerts/test", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(extractError(payload, `Test alert failed (${response.status})`));
      }
      showToast({
        kind: "success",
        message: "Test alert sent to the configured owner address.",
      });
    } catch (caught) {
      showToast({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Test alert failed",
      });
    } finally {
      setTestingEmail(false);
    }
  };

  const handleCreateForecast = async (form: ForecastForm) => {
    setSubmittingForecast(true);
    try {
      const probabilityTotal =
        form.probabilityUp + form.probabilityBase + form.probabilityDown;
      if (probabilityTotal !== 100) {
        throw new Error("Upside, base, and downside probabilities must total 100%");
      }
      const returnLow = Number(form.returnLow);
      const returnHigh = Number(form.returnHigh);
      if (!Number.isFinite(returnLow) || !Number.isFinite(returnHigh)) {
        throw new Error("Enter a valid return range");
      }
      if (returnLow >= returnHigh) {
        throw new Error("The return floor must be below the return ceiling");
      }
      const response = await fetch("/api/forecasts", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ticker: form.ticker,
          targetDefinition: form.targetDefinition,
          horizon: form.horizon,
          probabilityUp: form.probabilityUp / 100,
          probabilityBase: form.probabilityBase / 100,
          probabilityDown: form.probabilityDown / 100,
          returnLow: returnLow / 100,
          returnHigh: returnHigh / 100,
          benchmark: form.benchmark,
          rationale: form.rationale,
        }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(extractError(payload, `Save failed (${response.status})`));
      }
      setForecastOpen(false);
      showToast({ kind: "success", message: "Forecast frozen and added to the ledger." });
      await loadDashboard(false);
    } catch (caught) {
      showToast({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Unable to save the forecast",
      });
    } finally {
      setSubmittingForecast(false);
    }
  };

  return (
    <main>
      <SystemStrip
        dashboard={dashboard}
        refreshing={refreshing}
        testingEmail={testingEmail}
        canManage={canManage}
        member={member}
        onRefresh={() => void handleRefresh()}
        onTestEmail={() => void handleTestEmail()}
      />

      <div className="shell dashboard-shell">
        {/* The valuation hero and its cached cards render on first paint, before
            the slower research feed resolves, so valuation is never below a loader. */}
        {activeView === "equities" ? (
          <ValuationDesk
            snapshots={valuationSnapshots}
            loading={valuationLoading}
            error={valuationError}
            mostViewedTickers={valuationMostViewed}
            earningsForecasts={dashboard.earningsForecasts}
            earningsPriceForecasts={dashboard.earningsPriceForecasts}
            tier={member.tier}
            onOpenValuation={(ticker) => {
              window.location.href = `/fair-value?ticker=${encodeURIComponent(ticker)}`;
            }}
          />
        ) : null}
        {activeView === "equities" ? <PicksPanel /> : null}
        {loading ? (
          <LoadingDashboard />
        ) : error && dashboard.snapshotAt === "" ? (
          <section className="load-error" role="alert">
            <span className="error-code">RESEARCH FEED</span>
            <h2>The market feed could not load.</h2>
            <p>Your plan has not changed. Try again, or continue with stock summaries and the free research walkthroughs.</p>
            <p><Link href="/examples">Read a free walkthrough →</Link></p>
            <button
              className="button button-dark"
              type="button"
              onClick={() => {
                nextDashboardRead.current = 0;
                void loadDashboard(true);
              }}
            >
              Check connection
            </button>
          </section>
        ) : (
          <>
            {error || asRecord(dashboard.system.snapshotCache).status === "stale" ? (
              <div className="inline-warning" role="status">
                Live updates are temporarily unavailable. Showing the last saved snapshot, not current prices.
                {error ? ` ${error}` : " The original news and price timestamps have been preserved."}
              </div>
            ) : null}

            <HomeLevel
              mark="LEVEL 2 · MARKET INTELLIGENCE"
              title="Daily Brief and the Live Market Feed"
              description="The post-close Daily Brief explains what moved and why; the Live Market Feed tracks breaking market events as they land. Format previews are free to read."
              actions={[
                { href: "/daily-brief", label: "Daily Brief", primary: true },
                { label: "Live Market Feed", onClick: () => setActiveView("world") },
              ]}
            />

            <ResearchTabs active={activeView} onChange={setActiveView} />

            {activeView === "equities" ? (
              <>
                <EquityResearchHome
                  latestQuotes={dashboard.latestQuotes}
                  earningsPriceForecasts={dashboard.earningsPriceForecasts}
                />
                <details className="research-secondary"><summary>Forward company research notes</summary><EquityForward /></details>
                <EarningsForecastPanel
                  earningsForecasts={dashboard.earningsForecasts}
                  earningsPriceForecasts={dashboard.earningsPriceForecasts}
                  latestQuotes={dashboard.latestQuotes}
                  valuationContext={valuationSnapshots}
                />
                <details className="research-secondary"><summary>Full forecast scorecard &amp; comparison table</summary><ActualComparisonPanel
                  earningsForecasts={dashboard.earningsForecasts}
                  earningsPriceForecasts={dashboard.earningsPriceForecasts}
                  latestQuotes={dashboard.latestQuotes}
                  priceForecastScorecard={dashboard.priceForecastScorecard}
                /></details>

                <DailyBriefing
                  briefings={dashboard.briefings}
                  events={dashboard.events}
                  latestQuotes={dashboard.latestQuotes}
                  snapshotAt={dashboard.snapshotAt}
                />

                <details className="research-secondary"><summary>All events &amp; source details</summary><EventRadar
                  events={dashboard.events}
                  latestQuotes={dashboard.latestQuotes}
                /></details>

                <WatchlistPanel
                  watchlist={dashboard.watchlist}
                  latestQuotes={dashboard.latestQuotes}
                />

                <details className="research-secondary"><summary>Data sources &amp; system status</summary>
                  <ResearchOperatingBar dashboard={dashboard} />
                  <DataCaveats dashboard={dashboard} />
                </details>
              </>
            ) : activeView === "btc" ? (
              <BtcResearchPanel research={dashboard.btcResearch} tier={member.tier} />
            ) : (
              <WorldNewsPanel
                news={dashboard.worldNews}
                snapshotAt={dashboard.snapshotAt}
                sources={dashboard.sources}
              />
            )}

            <HomeLevel
              mark="LEVEL 3 · TRUST & PERFORMANCE"
              title="Track record and research record"
              description="Frozen earnings forecasts and model portfolios are graded against reported results and never rewritten after the fact. The evidence sits next to the ledger that produced it."
              actions={[{ href: "/track-record", label: "Open the track record →", primary: true }]}
            />
          </>
        )}

        <footer className="site-footer">
          <div>
            <span className="brand-mark brand-mark-small" aria-hidden="true">
              SL
            </span>
            <div>
              <strong>Signal Ledger</strong>
              <small>Independent equity research · Valuation · Forecast accountability</small>
            </div>
          </div>
          <p>
            Signal Ledger publishes fundamental research, valuation work and preserved forecast records. It is not investment advice and never places trades.
          </p>
          <span>PUBLIC RESEARCH EDITION</span>
        </footer>
      </div>

      {canManage && forecastOpen ? (
        <ForecastModal
          open
          submitting={submittingForecast}
          onClose={() => setForecastOpen(false)}
          onSubmit={handleCreateForecast}
        />
      ) : null}

      {toast ? (
        <div
          className={`toast ${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span aria-hidden="true">{toast.kind === "success" ? "✓" : "!"}</span>
          <p>{toast.message}</p>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}
