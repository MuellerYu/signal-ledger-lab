type JsonRecord = Record<string, unknown>;

const PRIVATE_RESPONSE_KEYS = /^(?:alerts?|outbox|runs?|recipient|providerMessageId|lastError|cursor|approvalToken(?:Hash)?|decisionToken|account(?:Id)?|account_id|positions?|orders?|credentials?|secrets?|tokens?|authorization|cookie)$/i;

const PUBLIC_COLLECTIONS = [
  "events",
  "forecasts",
  "calibration",
  "watchlist",
  "earningsForecasts",
  "latestQuotes",
  "earningsPriceForecasts",
  "priceForecastScorecard",
  "briefings",
  "btcResearch",
  "worldNews",
] as const;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function publicUrl(value: string) {
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|auth|signature|credential/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return "";
  }
}

function removePrivateFields(value: unknown, depth = 0): unknown {
  if (depth > 14) return null;
  if (Array.isArray(value)) {
    return value.map((item) => removePrivateFields(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .filter(([key]) => !PRIVATE_RESPONSE_KEYS.test(key))
      .map(([key, item]) => [
        key,
        typeof item === "string" && /url$/i.test(key)
          ? publicUrl(item)
          : removePrivateFields(item, depth + 1),
      ]),
  );
}

/**
 * Bitcoin is a first-class product whose 30-day outlook is FREE to read: the
 * headline call, frozen target, research range and the forecast-vs-actual path
 * stay public. The deeper analytical detail — the model's input snapshot, its
 * "why" drivers and the per-day backtest rows — is PRO. Gating happens here,
 * server-side, so a FREE reader is never sent the PRO JSON at all (nothing is
 * hidden in CSS). PRO is only ever granted by the membership entitlement path.
 */
const BTC_PRO_FORECAST_FIELDS = ["drivers", "features"] as const;

function gateBtcResearch(value: unknown, tier: "FREE" | "PRO"): unknown {
  const btc = asRecord(value);
  if (tier === "PRO") return btc;
  const forecasts = Array.isArray(btc.forecasts)
    ? btc.forecasts.map((forecast) => {
        const row = asRecord(forecast);
        for (const field of BTC_PRO_FORECAST_FIELDS) delete row[field];
        return row;
      })
    : [];
  return { ...btc, forecasts, backtests: [] };
}

export function publicDashboard(value: unknown, tier: "FREE" | "PRO" = "FREE") {
  const dashboard = asRecord(value);
  const system = asRecord(dashboard.system);
  const metrics = asRecord(dashboard.metrics);
  const publicMetrics = [
    "watchlistCount",
    "healthySources",
    "totalSources",
    "openForecasts",
    "resolvedForecasts",
    "brierScore",
    "directionHitRate",
    "p95LatencyMs",
    "latencyBasis",
  ];
  const result: JsonRecord = {
    snapshotAt: dashboard.snapshotAt,
    status: dashboard.status,
    system: removePrivateFields({
      monitoring: system.monitoring,
      email: system.email,
      dataMode: system.dataMode,
      lastRunAt: system.lastRunAt,
      lastRunStatus: system.lastRunStatus,
      scheduler:
        typeof system.scheduler === "string" &&
        system.scheduler.toLowerCase().includes("manual")
          ? "manual"
          : "scheduled",
      researchModel: system.researchModel,
      snapshotCache: system.snapshotCache,
    }),
    metrics: Object.fromEntries(
      publicMetrics
        .filter((key) => metrics[key] !== undefined)
        .map((key) => [key, metrics[key]]),
    ),
    sources: Array.isArray(dashboard.sources)
      ? dashboard.sources.map((source) => {
          const item = asRecord(source);
          return removePrivateFields({
            id: item.id,
            name: item.name,
            kind: item.kind,
            tier: item.tier,
            required: item.required,
            enabled: item.enabled,
            status: item.status,
            lastCheckedAt: item.lastCheckedAt,
            lastSuccessAt: item.lastSuccessAt,
          });
        })
      : [],
  };
  for (const key of PUBLIC_COLLECTIONS) {
    const collection = removePrivateFields(dashboard[key]);
    result[key] = key === "btcResearch" ? gateBtcResearch(collection, tier) : collection;
  }
  return result;
}
