import { canonicalJson, newId, sha256Hex } from "./crypto";

type JsonRecord = Record<string, unknown>;

type NormalizedForecastInput = {
  securityId: string;
  ticker: string;
  eventId: string | null;
  forecastType: "pre_event" | "post_event_impact";
  targetDefinition: string;
  hypothesis: string | null;
  direction: "up" | "neutral" | "down";
  probabilityUp: number;
  probabilityBase: number;
  probabilityDown: number;
  horizon: string;
  resolutionAtMs: number | null;
  resolutionCriteria: string | null;
  benchmark: string;
  returnLow: number | null;
  returnHigh: number | null;
  rationale: string | null;
  evidence: unknown[];
  invalidationCondition: string | null;
  modelVersion: string;
  slotCode: string;
  eligibility: string;
};

export class ForecastValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForecastValidationError";
  }
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringValue(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function optionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

function probabilityValue(value: unknown) {
  const parsed = optionalNumber(value);
  if (parsed === null) return null;
  return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
}

function normalizeProbabilities(record: JsonRecord) {
  const distribution = asRecord(
    record.probabilities ??
      record.probabilityDistribution ??
      record.probability_distribution,
  );
  let up =
    probabilityValue(
      record.probabilityUp ?? record.probability_up ?? distribution.up,
    ) ?? null;
  let base =
    probabilityValue(
      record.probabilityBase ??
        record.probability_base ??
        distribution.base ??
        distribution.flat ??
        distribution.neutral,
    ) ?? null;
  let down =
    probabilityValue(
      record.probabilityDown ?? record.probability_down ?? distribution.down,
    ) ?? null;

  if (up === null && base === null && down === null) {
    const binaryProbability = probabilityValue(
      record.probability ??
        record.forecastProbability ??
        record.forecast_probability,
    );
    if (binaryProbability === null) {
      throw new ForecastValidationError(
        "A probability distribution is required.",
      );
    }
    const direction = stringValue(record, ["direction", "stance"]).toLowerCase();
    if (["down", "bearish", "no", "no_event"].includes(direction)) {
      up = 1 - binaryProbability;
      base = 0;
      down = binaryProbability;
    } else if (["neutral", "base", "flat"].includes(direction)) {
      up = (1 - binaryProbability) / 2;
      base = binaryProbability;
      down = (1 - binaryProbability) / 2;
    } else {
      up = binaryProbability;
      base = 0;
      down = 1 - binaryProbability;
    }
  }

  if (up === null || base === null || down === null) {
    throw new ForecastValidationError(
      "probabilityUp, probabilityBase, and probabilityDown must all be supplied.",
    );
  }
  if ([up, base, down].some((value) => value < 0 || value > 1)) {
    throw new ForecastValidationError(
      "Each probability must be between 0 and 1 (or 0 and 100 percent).",
    );
  }
  const total = up + base + down;
  if (Math.abs(total - 1) > 0.000001) {
    throw new ForecastValidationError(
      `Probabilities must sum to 1; received ${total.toFixed(6)}.`,
    );
  }

  return {
    up: Number(up.toFixed(8)),
    base: Number(base.toFixed(8)),
    down: Number(down.toFixed(8)),
  };
}

function deriveDirection(
  record: JsonRecord,
  probabilities: { up: number; base: number; down: number },
) {
  const explicit = stringValue(record, ["direction", "stance"]).toLowerCase();
  if (["up", "bullish", "yes", "event"].includes(explicit)) return "up";
  if (["down", "bearish", "no", "no_event"].includes(explicit)) return "down";
  if (["neutral", "base", "flat"].includes(explicit)) return "neutral";
  if (probabilities.up > probabilities.down) return "up";
  if (probabilities.down > probabilities.up) return "down";
  return "neutral";
}

function deriveSlot(
  forecastType: "pre_event" | "post_event_impact",
  resolutionAtMs: number | null,
  cutoffAtMs: number,
) {
  if (forecastType === "post_event_impact") {
    return { slotCode: "AFTER_VERIFIED", eligibility: "official" };
  }
  if (!resolutionAtMs) {
    return { slotCode: "MANUAL", eligibility: "conditional" };
  }
  const leadMs = resolutionAtMs - cutoffAtMs;
  if (leadMs <= 0) {
    throw new ForecastValidationError(
      "The resolution time must be later than the server freeze time.",
    );
  }
  if (leadMs < 60 * 60_000) {
    return { slotCode: "LATE", eligibility: "shadow_late" };
  }
  if (leadMs <= 24 * 60 * 60_000) {
    return { slotCode: "T-60M", eligibility: "official" };
  }
  if (leadMs <= 7 * 24 * 60 * 60_000) {
    return { slotCode: "T-24H", eligibility: "official" };
  }
  return { slotCode: "T-7D", eligibility: "official" };
}

function horizonDurationMs(value: string) {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(m|min|h|hr|d|day|w|wk)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  if (unit === "m" || unit === "min") return amount * 60_000;
  if (unit === "h" || unit === "hr") return amount * 60 * 60_000;
  if (unit === "w" || unit === "wk") return amount * 7 * 24 * 60 * 60_000;
  return amount * 24 * 60 * 60_000;
}

async function normalizeForecastInput(
  d1: D1Database,
  payload: unknown,
  cutoffAtMs: number,
): Promise<NormalizedForecastInput> {
  const record = asRecord(payload);
  const ticker = stringValue(record, ["ticker", "symbol"]).toUpperCase();
  if (!ticker || ticker.length > 16) {
    throw new ForecastValidationError("A valid watchlist ticker is required.");
  }
  const security = await d1
    .prepare(
      `SELECT id, ticker, benchmark FROM securities
       WHERE ticker = ? AND enabled = 1 LIMIT 1`,
    )
    .bind(ticker)
    .first<{ id: string; ticker: string; benchmark: string }>();
  if (!security) {
    throw new ForecastValidationError(
      `${ticker} is not in the enabled watchlist.`,
    );
  }

  const targetDefinition = stringValue(record, [
    "targetDefinition",
    "target_definition",
    "question",
    "hypothesis",
    "title",
  ]);
  if (!targetDefinition || targetDefinition.length > 500) {
    throw new ForecastValidationError(
      "A falsifiable target definition of 1–500 characters is required.",
    );
  }
  const forecastTypeRaw = stringValue(record, [
    "forecastType",
    "forecast_type",
  ]);
  const forecastType =
    forecastTypeRaw === "post_event_impact"
      ? "post_event_impact"
      : "pre_event";
  const probabilities = normalizeProbabilities(record);
  const horizonInput = stringValue(record, [
    "horizon",
    "horizonCode",
    "horizon_code",
  ]);
  const resolutionAtRaw = stringValue(record, [
    "resolutionAt",
    "resolution_at",
    "horizonEnd",
    "horizon_end",
  ]);
  const parsedResolutionAt = resolutionAtRaw
    ? Date.parse(resolutionAtRaw)
    : Number.NaN;
  if (resolutionAtRaw && !Number.isFinite(parsedResolutionAt)) {
    throw new ForecastValidationError("resolutionAt must be a valid timestamp.");
  }
  const derivedHorizonMs = horizonDurationMs(horizonInput);
  const resolutionAtMs = Number.isFinite(parsedResolutionAt)
    ? parsedResolutionAt
    : derivedHorizonMs
      ? cutoffAtMs + derivedHorizonMs
      : null;
  const horizon =
    horizonInput ||
    (resolutionAtMs ? new Date(resolutionAtMs).toISOString() : "manual");
  const { slotCode, eligibility } = deriveSlot(
    forecastType,
    resolutionAtMs,
    cutoffAtMs,
  );
  const evidenceValue =
    record.evidence ?? record.evidenceIds ?? record.evidence_ids ?? [];
  const evidence = Array.isArray(evidenceValue)
    ? evidenceValue.slice(0, 50)
    : typeof evidenceValue === "string" && evidenceValue.trim()
      ? [evidenceValue.trim()]
      : [];
  const returnLow = optionalNumber(record.returnLow ?? record.return_low);
  const returnHigh = optionalNumber(record.returnHigh ?? record.return_high);
  if (returnLow !== null && returnHigh !== null && returnLow > returnHigh) {
    throw new ForecastValidationError(
      "returnLow cannot be greater than returnHigh.",
    );
  }

  return {
    securityId: security.id,
    ticker: security.ticker,
    eventId: stringValue(record, ["eventId", "event_id"]) || null,
    forecastType,
    targetDefinition,
    hypothesis:
      stringValue(record, ["hypothesis"]) || targetDefinition || null,
    direction: deriveDirection(record, probabilities),
    probabilityUp: probabilities.up,
    probabilityBase: probabilities.base,
    probabilityDown: probabilities.down,
    horizon,
    resolutionAtMs,
    resolutionCriteria:
      stringValue(record, ["resolutionCriteria", "resolution_criteria"]) ||
      (derivedHorizonMs
        ? "Resolve using the first completed regular-session observation at or after the frozen horizon; record source and benchmark with the actual."
        : null),
    benchmark:
      stringValue(record, ["benchmark", "benchmarkTicker"]) ||
      security.benchmark,
    returnLow,
    returnHigh,
    rationale: stringValue(record, ["rationale"]) || null,
    evidence,
    invalidationCondition:
      stringValue(record, [
        "invalidationCondition",
        "invalidation_condition",
      ]) || null,
    modelVersion:
      stringValue(record, ["modelVersion", "model_version"]) || "manual-v1",
    slotCode,
    eligibility,
  };
}

function isLedgerRace(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("forecasts_ledger_seq_unique") ||
    message.includes("UNIQUE constraint failed: forecasts.ledger_seq")
  );
}

export async function freezeForecast(d1: D1Database, payload: unknown) {
  const cutoffAtMs = Date.now();
  const input = await normalizeForecastInput(d1, payload, cutoffAtMs);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await d1
      .prepare(
        `SELECT ledger_seq, chain_hash FROM forecasts
         ORDER BY ledger_seq DESC LIMIT 1`,
      )
      .first<{ ledger_seq: number; chain_hash: string }>();
    const ledgerSeq = (previous?.ledger_seq ?? 0) + 1;
    const prevChainHash = previous?.chain_hash ?? "0".repeat(64);
    const id = newId("fcst");
    const frozenAtMs = Date.now();
    const payloadSnapshot = {
      id,
      ledgerSeq,
      ...input,
      probabilities: {
        up: input.probabilityUp,
        base: input.probabilityBase,
        down: input.probabilityDown,
      },
      createdAtMs: frozenAtMs,
      frozenAtMs,
      informationCutoffAtMs: cutoffAtMs,
      prevChainHash,
    };
    const payloadHash = await sha256Hex(canonicalJson(payloadSnapshot));
    const chainHash = await sha256Hex(
      `${prevChainHash}:${ledgerSeq}:${payloadHash}`,
    );

    try {
      await d1
        .prepare(
          `INSERT INTO forecasts (
            id, ledger_seq, security_id, ticker, event_id, forecast_type,
            target_definition, hypothesis, direction, probability_up,
            probability_base, probability_down, probabilities_json, horizon,
            resolution_at_ms, resolution_criteria, benchmark, return_low,
            return_high, rationale, evidence_json, invalidation_condition,
            model_version, slot_code, eligibility, status, created_at_ms,
            frozen_at_ms, information_cutoff_at_ms, prev_chain_hash,
            payload_hash, chain_hash
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?
          )`,
        )
        .bind(
          id,
          ledgerSeq,
          input.securityId,
          input.ticker,
          input.eventId,
          input.forecastType,
          input.targetDefinition,
          input.hypothesis,
          input.direction,
          input.probabilityUp,
          input.probabilityBase,
          input.probabilityDown,
          JSON.stringify({
            up: input.probabilityUp,
            base: input.probabilityBase,
            down: input.probabilityDown,
          }),
          input.horizon,
          input.resolutionAtMs,
          input.resolutionCriteria,
          input.benchmark,
          input.returnLow,
          input.returnHigh,
          input.rationale,
          JSON.stringify(input.evidence),
          input.invalidationCondition,
          input.modelVersion,
          input.slotCode,
          input.eligibility,
          frozenAtMs,
          frozenAtMs,
          cutoffAtMs,
          prevChainHash,
          payloadHash,
          chainHash,
        )
        .run();
      return {
        id,
        ledgerSeq,
        ticker: input.ticker,
        targetDefinition: input.targetDefinition,
        hypothesis: input.hypothesis,
        direction: input.direction,
        probabilityUp: input.probabilityUp,
        probabilityBase: input.probabilityBase,
        probabilityDown: input.probabilityDown,
        horizon: input.horizon,
        resolutionAt: input.resolutionAtMs
          ? new Date(input.resolutionAtMs).toISOString()
          : null,
        resolutionCriteria: input.resolutionCriteria,
        benchmark: input.benchmark,
        returnLow: input.returnLow,
        returnHigh: input.returnHigh,
        rationale: input.rationale,
        status: "open",
        eligibility: input.eligibility,
        slotCode: input.slotCode,
        createdAt: new Date(frozenAtMs).toISOString(),
        frozenAt: new Date(frozenAtMs).toISOString(),
        informationCutoffAt: new Date(cutoffAtMs).toISOString(),
        payloadHash,
        prevChainHash,
        chainHash,
      };
    } catch (error) {
      if (attempt < 2 && isLedgerRace(error)) continue;
      throw error;
    }
  }

  throw new Error("Unable to reserve an immutable ledger sequence.");
}
