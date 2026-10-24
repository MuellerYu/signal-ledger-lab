import { getBindings } from "./runtime";
import type { StrategyCandidate } from "./options-screen";

export type OptionsReviewRequest = {
  underlying: string;
  strategy: "cash_secured_put" | "covered_call";
  candidates: StrategyCandidate[];
  valuationContext: {
    currentPrice: number | null;
    fairValue: number | null;
    p10: number | null;
    p90: number | null;
    buyZone: number | null;
    strongBuyZone: number | null;
  };
  riskSettings: {
    cash: number;
    shares: number;
    contracts: number;
    minimumReturnPct: number;
    maximumSpreadPct: number;
    averageCost: number | null;
    desiredMinimumExitPrice: number | null;
  };
  snapshotKey: string;
  /** Cache key parts: the review must never be reused across a different chain,
   * expiration, strategy, filter set or valuation snapshot. */
  expiration: string;
  chainTimestamp: string;
  filterHash: string;
  valuationSnapshotId: string;
};

export type OptionsReview = {
  decision: "SELECT" | "NO_TRADE";
  selectedSymbol: string | null;
  alternativeSymbol: string | null;
  summary: string;
  tradeoffs: string[];
  risks: string[];
  options_AI_used: boolean;
  options_AI_model: string | null;
  options_AI_call_reason: "USER_REQUESTED_TOP_FIVE_REVIEW";
  cached: boolean;
};

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
};

const REVIEW_TTL_MS = 5 * 60 * 1_000;
const cache = new Map<string, { expiresAt: number; value: OptionsReview }>();

function outputText(payload: OpenAiResponse) {
  if (payload.output_text?.trim()) return payload.output_text.trim();
  return payload.output?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
    .trim() ?? "";
}

function cacheKey(input: OptionsReviewRequest) {
  const source = JSON.stringify({
    underlying: input.underlying,
    strategy: input.strategy,
    expiration: input.expiration ?? null,
    chainTimestamp: input.chainTimestamp ?? input.snapshotKey ?? null,
    filterHash: input.filterHash ?? null,
    valuationSnapshotId: input.valuationSnapshotId ?? null,
    candidates: input.candidates.map((item) => [item.symbol, item.bid, item.ask, item.iv, item.delta, item.openInterest]),
    valuationContext: input.valuationContext,
    riskSettings: input.riskSettings,
    snapshotKey: input.snapshotKey,
  });
  let value = 2166136261;
  for (let index = 0; index < source.length; index += 1) value = Math.imul(value ^ source.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16);
}

function finiteOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function reviewTopOptions(input: OptionsReviewRequest): Promise<OptionsReview> {
  const bindings = getBindings();
  const enabled = bindings.AI_VALUATION_ENABLED?.trim().toLowerCase() === "true";
  const apiKey = bindings.OPENAI_API_KEY?.trim();
  if (!enabled || !apiKey) throw new Error("OPTIONS_AI_NOT_CONFIGURED");
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(input.underlying) || !["cash_secured_put", "covered_call"].includes(input.strategy)) throw new Error("INVALID_OPTIONS_REVIEW");
  if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 5) throw new Error("INVALID_OPTIONS_REVIEW");

  const key = cacheKey(input);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };

  const candidates = input.candidates.slice(0, 5).map((item) => ({
    symbol: item.symbol,
    expiration: item.expiration,
    dte: item.dte,
    strike: item.strike,
    bid: item.bid,
    ask: item.ask,
    midpoint: item.midpoint,
    spreadPct: item.spreadPct,
    iv: item.iv,
    delta: item.delta,
    volume: item.volume,
    openInterest: item.openInterest,
    netPremium: item.netPremium,
    cashCollateral: item.cashCollateral,
    breakeven: item.breakeven,
    returnOnCashPct: item.returnOnCashPct,
    annualizedYieldPct: item.annualizedYieldPct,
    fairValueDistancePct: item.fairValueDistancePct,
    upsideToStrikePct: item.upsideToStrikePct,
    returnIfCalledPct: item.returnIfCalledPct,
    assignmentRiskProxyPct: item.assignmentRiskProxyPct,
    deterministicScore: item.score,
  }));
  const model = bindings.OPENAI_REVIEW_MODEL?.trim() || "gpt-5.6-sol";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        reasoning: { effort: "low" },
        instructions: "You are the final risk reviewer for a read-only options research tool. You receive only the ticker, the valuation context and the deterministic top candidates - never the full option chain. Never invent a contract, quote, Greek, forecast or market fact. State a preferred trade (one supplied symbol), an alternative, why it is preferred, the main risk, and return NO_TRADE when nothing supplied is attractive. Favor capital protection, liquidity, valuation support and the user's explicit coverage.",
        input: JSON.stringify({
          underlying: input.underlying,
          strategy: input.strategy,
          candidates,
          valuationContext: {
            currentPrice: finiteOrNull(input.valuationContext.currentPrice),
            fairValue: finiteOrNull(input.valuationContext.fairValue),
            p10: finiteOrNull(input.valuationContext.p10),
            p90: finiteOrNull(input.valuationContext.p90),
            buyZone: finiteOrNull(input.valuationContext.buyZone),
            strongBuyZone: finiteOrNull(input.valuationContext.strongBuyZone),
          },
          riskSettings: input.riskSettings,
        }),
        text: { format: {
          type: "json_schema",
          name: "options_top_five_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["decision", "selectedSymbol", "alternativeSymbol", "summary", "tradeoffs", "risks"],
            properties: {
              decision: { type: "string", enum: ["SELECT", "NO_TRADE"] },
              selectedSymbol: { anyOf: [{ type: "string" }, { type: "null" }] },
              alternativeSymbol: { anyOf: [{ type: "string" }, { type: "null" }] },
              summary: { type: "string" },
              tradeoffs: { type: "array", items: { type: "string" }, maxItems: 4 },
              risks: { type: "array", items: { type: "string" }, maxItems: 4 },
            },
          },
        } },
        max_output_tokens: 700,
        store: false,
        prompt_cache_key: `signal-ledger:options-review:${input.underlying}`,
      }),
    });
    if (!response.ok) throw new Error(`OPTIONS_AI_${response.status}`);
    const text = outputText(await response.json() as OpenAiResponse);
    const parsed = JSON.parse(text) as Omit<OptionsReview, "options_AI_used" | "options_AI_model" | "options_AI_call_reason" | "cached">;
    const allowed = new Set(candidates.map((item) => item.symbol));
    const selectedSymbol = parsed.decision === "SELECT" && parsed.selectedSymbol && allowed.has(parsed.selectedSymbol) ? parsed.selectedSymbol : null;
    const alternativeSymbol = parsed.decision === "SELECT" && parsed.alternativeSymbol
      && parsed.alternativeSymbol !== selectedSymbol && allowed.has(parsed.alternativeSymbol) ? parsed.alternativeSymbol : null;
    const review: OptionsReview = {
      decision: selectedSymbol ? "SELECT" : "NO_TRADE",
      selectedSymbol,
      alternativeSymbol,
      summary: String(parsed.summary ?? "").slice(0, 800),
      tradeoffs: Array.isArray(parsed.tradeoffs) ? parsed.tradeoffs.map(String).slice(0, 4) : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 4) : [],
      options_AI_used: true,
      options_AI_model: model,
      options_AI_call_reason: "USER_REQUESTED_TOP_FIVE_REVIEW",
      cached: false,
    };
    cache.set(key, { expiresAt: Date.now() + REVIEW_TTL_MS, value: review });
    return review;
  } finally {
    clearTimeout(timeout);
  }
}
