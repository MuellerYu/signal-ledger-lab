// Presentation-only calculations. Live quotes must never settle an old forecast.
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const FILLER = /under review|still being verified|being prepared|being rebuilt|not yet connected|awaiting evidence|English source note|new (?:market-related|market) information|only the title|not enough pre-earnings evidence|this evidence is included|first (?:determine|check) whether|check a second independent source/i;
export function researchNotes(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string")
    .map(v => v.trim()).filter(v => v.length > 12 && !/[\u3400-\u9fff]/.test(v) && !FILLER.test(v) && !/^\[Missing\]/i.test(v)))];
}

export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return /^(https?:)$/.test(url.protocol) ? url.href : null; } catch { return null; }
}

export function settledPriceOutcome(reference: unknown, target: unknown, actual: unknown) {
  const baseline = finiteNumber(reference), forecast = finiteNumber(target), close = finiteNumber(actual);
  const forecastMove = baseline !== null && baseline > 0 && forecast !== null ? (forecast / baseline - 1) * 100 : null;
  const actualMove = baseline !== null && baseline > 0 && close !== null && close > 0 ? (close / baseline - 1) * 100 : null;
  const errorPct = forecast !== null && close !== null && close > 0 ? (forecast / close - 1) * 100 : null;
  const direction = (move: number) => move > 0.5 ? 1 : move < -0.5 ? -1 : 0;
  return { forecastMove, actualMove, errorPct,
    directionHit: forecastMove !== null && actualMove !== null ? direction(forecastMove) === direction(actualMove) : null };
}

export function earningsPhase(hasFigures: boolean, confirmedReported: boolean, releaseWindowPassed: boolean) {
  return hasFigures ? "reported" : confirmedReported || releaseWindowPassed ? "missing-results" : "upcoming";
}

export function forecastRevenueError(model: unknown, actual: unknown): number | null {
  const estimate = finiteNumber(model), reported = finiteNumber(actual);
  return estimate !== null && reported !== null && reported > 0 ? (estimate / reported - 1) * 100 : null;
}
