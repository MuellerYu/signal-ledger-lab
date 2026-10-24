export type ChainContract = {
  conid: number; symbol: string; right: "P" | "C"; strike: number; expiry: string; dte: number;
  bid: number | null; ask: number | null; ivPercent: number | null; delta: number | null;
  volume: number | null; openInterest: number | null; updatedAt: string | null;
  availability: string; eligibleQuote: boolean;
};
export type OptionChain = {
  symbol: string; companyName: string; spot: number; spotUpdatedAt: string | null;
  spotAvailability: string; spotFresh: boolean; receivedAt: string;
  contracts: ChainContract[]; scope: string;
};
export type ScreenInputs = { minReturnPct: number; cash: number; shares: number; quantity: number; feesPerContract: number; maxSpreadPct: number };

export type StrategyCandidate = {
  symbol: string;
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  midpoint: number;
  delta: number;
  iv: number | null;
  volume: number | null;
  openInterest: number;
  spreadPct: number;
  netPremium: number;
  cashCollateral: number;
  breakeven: number;
  returnOnCashPct: number;
  annualizedYieldPct: number;
  fairValueDistancePct: number | null;
  upsideToStrikePct: number | null;
  returnIfCalledPct: number | null;
  assignmentRiskProxyPct: number;
  /** Strike distance from spot, signed so puts sit below and calls above. */
  distanceFromSpotPct: number;
  collateralRequired: number;
  sharesRequired: number;
  riskLabel: "LOW" | "MODERATE" | "HIGH";
  valuationSupportScore: number;
  liquidityScore: number;
  /** Deterministic multiplicative components behind `score` (spec: premium × quality factors). */
  components: {
    premiumReturn: number;
    liquidity: number;
    spread: number;
    delta: number;
    valuationSupport: number;
    ivAttractiveness?: number;
    upsideRetained?: number;
    strikeVsFairValue?: number;
  };
  valuationSupportLabel: "HIGH" | "MODERATE" | "LOW" | "NOT ESTABLISHED";
  liquidityLabel: "GOOD" | "FAIR" | "POOR";
  recommendation: "ATTRACTIVE" | "ACCEPTABLE" | "MARGINAL";
  score: number;
  rationale: string[];
};

export type StrategyPickLabel =
  | "BEST RISK-ADJUSTED"
  | "BEST INCOME"
  | "MOST CONSERVATIVE"
  | "BEST BALANCED"
  | "MOST UPSIDE PRESERVED";
export type StrategyPick = { label: StrategyPickLabel; candidate: StrategyCandidate };

export type StrategyScreenSettings = {
  cash: number;
  shares: number;
  contracts: number;
  feesPerContract: number;
  minReturnPct: number;
  minDte: number;
  maxDte: number;
  minAbsDelta: number;
  maxAbsDelta: number;
  maxSpreadPct: number;
  minOpenInterest: number;
  fairValue?: number | null;
  buyZone?: number | null;
  strongBuyZone?: number | null;
  averageCost?: number | null;
  desiredMinimumExitPrice?: number | null;
};

type PublicContract = {
  symbol: string; expiration: string; dte: number; strike: number; type: "call" | "put";
  bid: number | null; ask: number | null; midpoint: number | null; spreadPct: number | null;
  iv: number | null; delta: number | null; volume: number | null; openInterest: number | null;
};

function rankStrategy(contracts: PublicContract[], spot: number, side: "put" | "call", settings: StrategyScreenSettings) {
  if (!Number.isFinite(spot) || spot <= 0) return [];
  const quantity = Math.max(1, Math.floor(settings.contracts));
  return contracts.flatMap((contract): StrategyCandidate[] => {
    if (contract.type !== side || contract.bid === null || contract.bid <= 0 || contract.ask === null || contract.ask < contract.bid || contract.midpoint === null || contract.midpoint <= 0 || contract.spreadPct === null || contract.delta === null || contract.openInterest === null) return [];
    const absDelta = Math.abs(contract.delta);
    const outOfMoney = side === "put" ? contract.strike < spot : contract.strike > spot;
    if (!outOfMoney || contract.dte < settings.minDte || contract.dte > settings.maxDte || absDelta < settings.minAbsDelta || absDelta > settings.maxAbsDelta || contract.spreadPct > settings.maxSpreadPct || contract.openInterest < settings.minOpenInterest) return [];
    const grossPremium = contract.bid * 100 * quantity;
    const netPremium = grossPremium - settings.feesPerContract * quantity;
    const cashCollateral = (side === "put" ? contract.strike : spot) * 100 * quantity;
    if (netPremium <= 0 || (side === "put" ? settings.cash < contract.strike * 100 * quantity : settings.shares < 100 * quantity)) return [];
    const returnOnCashPct = netPremium / cashCollateral * 100;
    if (returnOnCashPct < settings.minReturnPct) return [];
    const breakeven = side === "put" ? contract.strike - netPremium / (100 * quantity) : spot - netPremium / (100 * quantity);
    const annualizedYieldPct = returnOnCashPct * 365 / Math.max(1, contract.dte);
    const fairValue = settings.fairValue ?? null;
    const desiredExit = settings.desiredMinimumExitPrice && settings.desiredMinimumExitPrice > 0 ? settings.desiredMinimumExitPrice : null;
    const supportReference = side === "put" ? settings.buyZone ?? fairValue : Math.max(fairValue ?? 0, desiredExit ?? 0) || null;
    const valuationSupportScore = supportReference && supportReference > 0
      ? Math.max(0, Math.min(1, side === "put" ? supportReference / breakeven : contract.strike / supportReference))
      : 0.5;
    const liquidityScore = Math.max(0, Math.min(1,
      0.55 * Math.min(1, contract.openInterest / 1000)
      + 0.2 * Math.min(1, (contract.volume ?? 0) / 500)
      + 0.25 * Math.max(0, 1 - contract.spreadPct / Math.max(1, settings.maxSpreadPct)),
    ));
    const deltaScore = Math.max(0, Math.min(1, 1 - Math.abs(absDelta - 0.25) / 0.2));
    // Premium return is expressed as a 0–1 quality factor so the total score
    // stays a transparent product of independent quality dimensions.
    const premiumReturn = Math.max(0, Math.min(1, returnOnCashPct / Math.max(settings.minReturnPct * 3, 1)));
    const spreadScore = Math.max(0, Math.min(1, 1 - contract.spreadPct / Math.max(1, settings.maxSpreadPct)));
    const ivScore = contract.iv === null ? 0.4 : Math.max(0, Math.min(1, contract.iv / 0.75));
    const upsideRetained = side === "call" && contract.strike > 0 && spot > 0
      ? Math.max(0, Math.min(1, (contract.strike - spot) / Math.max(0.05, spot)))
      : 1;
    const strikeVsFairValue = side === "call" && fairValue && fairValue > 0
      ? Math.max(0, Math.min(1, contract.strike / fairValue))
      : 1;
    const score = side === "put"
      ? 100 * premiumReturn * liquidityScore * spreadScore * deltaScore * valuationSupportScore * ivScore
      : 100 * premiumReturn * liquidityScore * spreadScore * upsideRetained * strikeVsFairValue * deltaScore;
    const components = side === "put"
      ? { premiumReturn, liquidity: liquidityScore, spread: spreadScore, delta: deltaScore, valuationSupport: valuationSupportScore, ivAttractiveness: ivScore }
      : { premiumReturn, liquidity: liquidityScore, spread: spreadScore, delta: deltaScore, valuationSupport: valuationSupportScore, upsideRetained, strikeVsFairValue };
    const valuationSupportLabel = side === "put"
      ? !supportReference || !(supportReference > 0) ? "NOT ESTABLISHED" as const
        : breakeven <= supportReference * 1.01 ? "HIGH" as const
          : breakeven <= supportReference * 1.08 ? "MODERATE" as const
            : "LOW" as const
      : !supportReference || !(supportReference > 0) ? "NOT ESTABLISHED" as const
        : contract.strike >= supportReference * 0.99 ? "HIGH" as const
          : contract.strike >= supportReference * 0.92 ? "MODERATE" as const
            : "LOW" as const;
    const liquidityLabel = liquidityScore >= 0.66 ? "GOOD" as const : liquidityScore >= 0.4 ? "FAIR" as const : "POOR" as const;
    const recommendation = valuationSupportLabel === "LOW" || liquidityLabel === "POOR" || deltaScore < 0.35
      ? "MARGINAL" as const
      : valuationSupportLabel === "HIGH" && liquidityLabel === "GOOD" && deltaScore >= 0.6
        ? "ATTRACTIVE" as const
        : "ACCEPTABLE" as const;
    const fairValueDistancePct = fairValue && fairValue > 0 ? ((side === "put" ? breakeven : contract.strike) / fairValue - 1) * 100 : null;
    const upsideToStrikePct = side === "call" ? (contract.strike / spot - 1) * 100 : null;
    const coveredCost = settings.averageCost && settings.averageCost > 0 ? settings.averageCost : spot;
    const returnIfCalledPct = side === "call" ? ((contract.strike - coveredCost) * 100 * quantity + netPremium) / (coveredCost * 100 * quantity) * 100 : null;
    const assignmentRiskProxyPct = absDelta * 100;
    const distanceFromSpotPct = (contract.strike / spot - 1) * 100;
    const collateralRequired = side === "put" ? contract.strike * 100 * quantity : 0;
    const sharesRequired = side === "call" ? 100 * quantity : 0;
    const riskLabel = assignmentRiskProxyPct <= 20 && distanceFromSpotPct <= 8
      ? "LOW" as const
      : assignmentRiskProxyPct <= 30 && distanceFromSpotPct <= 15
        ? "MODERATE" as const
        : "HIGH" as const;
    const rationale = [
      `${returnOnCashPct.toFixed(2)}% net premium return for this trade; not annualized`,
      `${contract.dte} DTE · |delta| ${absDelta.toFixed(2)} · ${contract.spreadPct.toFixed(1)}% spread`,
      supportReference ? `${side === "put" ? "Strike" : "Call strike"} compared with Signal Ledger valuation reference $${supportReference.toFixed(2)}` : "No valuation reference supplied; valuation support is neutral",
    ];
    return [{ symbol: contract.symbol, expiration: contract.expiration, dte: contract.dte, strike: contract.strike, bid: contract.bid, ask: contract.ask, midpoint: contract.midpoint, delta: contract.delta, iv: contract.iv, volume: contract.volume, openInterest: contract.openInterest, spreadPct: contract.spreadPct, netPremium, cashCollateral, breakeven, returnOnCashPct, annualizedYieldPct, fairValueDistancePct, upsideToStrikePct, returnIfCalledPct, assignmentRiskProxyPct, distanceFromSpotPct, collateralRequired, sharesRequired, riskLabel, valuationSupportScore, liquidityScore, components, valuationSupportLabel, liquidityLabel, recommendation, score, rationale }];
  }).sort((left, right) => right.score - left.score || right.returnOnCashPct - left.returnOnCashPct).slice(0, 5);
}

export function rankCashSecuredPuts(contracts: PublicContract[], spot: number, settings: StrategyScreenSettings) {
  return rankStrategy(contracts, spot, "put", settings);
}

export function rankCoveredCalls(contracts: PublicContract[], spot: number, settings: StrategyScreenSettings) {
  return rankStrategy(contracts, spot, "call", settings);
}

/**
 * The three labels are computed deterministically from the ranked candidates.
 * The engine never forces a recommendation: an empty ranking stays empty.
 */
export function buildOptionsPicks(ranked: StrategyCandidate[]): StrategyPick[] {
  if (!ranked.length) return [];
  const byScore = [...ranked].sort((left, right) => right.score - left.score)[0];
  const byIncome = [...ranked].sort((left, right) => right.returnOnCashPct - left.returnOnCashPct || right.score - left.score)[0];
  // Covered calls protect upside rather than premium: the third label asks which
  // strike keeps the most upside above the current spot while still paying.
  const isCoveredCall = ranked[0].delta > 0;
  const byProtection = [...ranked].sort((left, right) => isCoveredCall
    ? (right.upsideToStrikePct ?? 0) - (left.upsideToStrikePct ?? 0)
      || right.score - left.score
    : Math.abs(left.delta) - Math.abs(right.delta)
      || left.assignmentRiskProxyPct - right.assignmentRiskProxyPct
      || right.liquidityScore - left.liquidityScore
      || right.score - left.score)[0];
  const picks: StrategyPick[] = [
    { label: isCoveredCall ? "BEST BALANCED" : "BEST RISK-ADJUSTED", candidate: byScore },
    { label: "BEST INCOME", candidate: byIncome },
    { label: isCoveredCall ? "MOST UPSIDE PRESERVED" : "MOST CONSERVATIVE", candidate: byProtection },
  ];
  const seen = new Set<string>();
  return picks.filter((pick) => {
    if (seen.has(pick.candidate.symbol)) return false;
    seen.add(pick.candidate.symbol);
    return true;
  });
}

export type ChainRowInput = {
  strike: number;
  type: "call" | "put";
  bid: number | null;
  spreadPct: number | null;
  volume?: number | null;
  openInterest?: number | null;
};

/** A contract is dead when there is no bid or the quoted spread is unusable. */
export function isDeadContract(contract: ChainRowInput | undefined) {
  if (!contract) return true;
  if (contract.bid === null || contract.bid <= 0) return true;
  return contract.spreadPct !== null && contract.spreadPct > 40;
}

/**
 * Default chain view: a symmetric window of useful strikes around spot with
 * dead contracts removed. `showAllStrikes` returns the untouched chain.
 */
export function selectDisplayStrikes<T extends ChainRowInput>(contracts: T[], spot: number | null, showAllStrikes = false, halfWindow = 10) {
  const strikes = [...new Set(contracts.map((contract) => contract.strike))].sort((left, right) => left - right);
  const grouped = strikes.map((strike) => ({
    strike,
    call: contracts.find((contract) => contract.type === "call" && contract.strike === strike),
    put: contracts.find((contract) => contract.type === "put" && contract.strike === strike),
  }));
  if (showAllStrikes) return { rows: grouped, hidden: 0, windowed: false };
  if (!Number.isFinite(spot) || spot === null || spot <= 0) {
    const rows = grouped.slice(0, halfWindow * 2 + 1);
    return { rows, hidden: grouped.length - rows.length, windowed: false };
  }
  let nearest = 0;
  for (let index = 1; index < grouped.length; index += 1) {
    if (Math.abs(grouped[index].strike - spot) < Math.abs(grouped[nearest].strike - spot)) nearest = index;
  }
  const windowed = grouped
    .slice(Math.max(0, nearest - halfWindow), nearest + halfWindow + 1)
    .filter((row) => !isDeadContract(row.call) || !isDeadContract(row.put));
  return { rows: windowed, hidden: grouped.length - windowed.length, windowed: true };
}
export function screenOption(contract: ChainContract, chain: OptionChain, settings: ScreenInputs, now = Date.now()) {
  const { quantity, feesPerContract, cash, shares, minReturnPct, maxSpreadPct } = settings;
  if (!(chain.spot > 0) || !Number.isFinite(chain.spot) || !(contract.strike > 0) || !Number.isFinite(contract.strike) || contract.symbol !== chain.symbol || !["P", "C"].includes(contract.right)) throw new Error("Invalid underlying or contract definition.");
  if (![quantity, feesPerContract, cash, shares, minReturnPct, maxSpreadPct].every(Number.isFinite) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || feesPerContract < 0 || cash < 0 || shares < 0 || minReturnPct < 0 || maxSpreadPct < 0) throw new Error("Check contracts, capital, fees and filter values.");
  const premium = contract.bid === null ? null : contract.bid * 100 * quantity;
  const fees = feesPerContract * quantity;
  const netCredit = premium === null ? null : premium - fees;
  const capital = (contract.right === "P" ? contract.strike : chain.spot) * 100 * quantity;
  const returnPct = netCredit === null ? null : netCredit / capital * 100;
  const breakeven = netCredit === null ? null : (contract.right === "P" ? contract.strike : chain.spot) - netCredit / (100 * quantity);
  const spreadPct = contract.bid !== null && contract.ask !== null && contract.ask + contract.bid > 0 ? (contract.ask - contract.bid) / ((contract.ask + contract.bid) / 2) * 100 : null;
  const blockers: string[] = [];
  const quoteMs = Date.parse(contract.updatedAt || "");
  if (!contract.eligibleQuote || !Number.isFinite(quoteMs) || now - quoteMs > 60000 || quoteMs > now + 5000) blockers.push("No fresh, real-time two-sided quote");
  const spotMs = Date.parse(chain.spotUpdatedAt || "");
  if (!chain.spotFresh || !Number.isFinite(spotMs) || now - spotMs > 60000 || spotMs > now + 5000) blockers.push("Underlying quote is stale/unverified");
  if (contract.dte < 7 || contract.dte > 14) blockers.push("Outside 7–14 calendar DTE");
  const otm = contract.right === "P" ? contract.strike < chain.spot : contract.strike > chain.spot;
  if (!otm) blockers.push("Not out of the money; premium may include intrinsic value");
  if (spreadPct === null || spreadPct < 0 || spreadPct > maxSpreadPct) blockers.push("Wide or missing bid/ask spread");
  if (contract.volume === null || contract.volume < 50) blockers.push("Daily volume below 50 or missing");
  if (contract.openInterest === null || contract.openInterest < 100) blockers.push("Open interest below 100 or missing");
  if (contract.delta === null || Math.abs(contract.delta) > .3) blockers.push("Absolute delta above 0.30 or missing");
  if (contract.ivPercent === null || contract.ivPercent <= 0) blockers.push("Contract IV unavailable");
  if (contract.right === "P" ? cash < capital : shares < 100 * quantity) blockers.push(contract.right === "P" ? "Insufficient reserved cash" : "Insufficient unencumbered shares");
  if (returnPct === null || returnPct < minReturnPct) blockers.push(`Below ${minReturnPct}% net per-trade premium yield`);
  const warnings = ["Event/ex-dividend calendar not verified", "Historical comparable IV not available; IV rank cannot be established"];
  if (chain.symbol === "SOXL") warnings.push("Daily 3× leveraged ETF: path-dependent downside");
  if (chain.symbol === "SPCX") warnings.push("SPCX history begins with the June 2026 Nasdaq listing; pre-2026 quotes belong to an unrelated ETF and are excluded");
  const stress = [-.1, -.2, -.4].map(move => {
    const spot = chain.spot * (1 + move);
    const intrinsic = contract.right === "P" ? Math.max(0, contract.strike - spot) : Math.max(0, spot - contract.strike);
    const optionPnl = netCredit === null ? null : netCredit - intrinsic * 100 * quantity;
    return { move, spot, pnl: optionPnl === null ? null : optionPnl + (contract.right === "C" ? (spot - chain.spot) * 100 * quantity : 0) };
  });
  return { contract, capital, premium, netCredit, returnPct, breakeven, spreadPct, blockers, warnings, stress, passesScreen: blockers.length === 0, tradeReady: false };
}

/**
 * Deterministic screening presets. One universal DTE/delta rule does not fit
 * every mandate, so each preset fixes the DTE window, delta band, liquidity,
 * spread, return and open-interest floors. No AI is involved in screening.
 */
export const OPTIONS_PRESETS = {
  conservative: { label: "Conservative", minDte: 21, maxDte: 45, minAbsDelta: 0.1, maxAbsDelta: 0.2, minOpenInterest: 500, maxSpreadPct: 8, minReturnPct: 0.8 },
  balanced: { label: "Balanced", minDte: 14, maxDte: 30, minAbsDelta: 0.15, maxAbsDelta: 0.3, minOpenInterest: 250, maxSpreadPct: 12, minReturnPct: 1 },
  aggressive: { label: "Aggressive", minDte: 7, maxDte: 21, minAbsDelta: 0.25, maxAbsDelta: 0.45, minOpenInterest: 100, maxSpreadPct: 20, minReturnPct: 1.5 },
} as const;
export type OptionsPresetId = keyof typeof OPTIONS_PRESETS;

export function applyOptionsPreset(current: StrategyScreenSettings, preset: OptionsPresetId): StrategyScreenSettings {
  const chosen = OPTIONS_PRESETS[preset];
  return {
    ...current,
    minDte: chosen.minDte,
    maxDte: chosen.maxDte,
    minAbsDelta: chosen.minAbsDelta,
    maxAbsDelta: chosen.maxAbsDelta,
    minOpenInterest: chosen.minOpenInterest,
    maxSpreadPct: chosen.maxSpreadPct,
    minReturnPct: chosen.minReturnPct,
  };
}

/** Stable hash of the active screening filters, used in the AI review cache key. */
export function optionsFilterHash(settings: StrategyScreenSettings) {
  const source = JSON.stringify([settings.minDte, settings.maxDte, settings.minAbsDelta, settings.maxAbsDelta, settings.minOpenInterest, settings.maxSpreadPct, settings.minReturnPct, settings.contracts, settings.cash, settings.shares]);
  let value = 2166136261;
  for (let index = 0; index < source.length; index += 1) value = Math.imul(value ^ source.charCodeAt(index), 16777619);
  return (value >>> 0).toString(16);
}
