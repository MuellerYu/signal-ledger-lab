/**
 * Presentation formatting for Signal Ledger.
 *
 * Full precision is retained everywhere else: D1 columns, `snapshot_json`,
 * and every intermediate calculation. This module is the only place a number
 * becomes a string for a human, so the website and the email cannot show the
 * same value two different ways.
 *
 * Nothing here rounds a value that is later used in arithmetic — these
 * functions return display strings and are never fed back into a computation.
 */

/** Shown when a value is genuinely absent. Never a zero. */
const ABSENT = "—";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Groups the integer part so $1234.5 reads as $1,234.50. */
function group(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };

/**
 * A money amount at two decimals: 214.1991099076723 -> "$214.20".
 * The currency symbol is a display choice only and never affects entitlement.
 */
export function money(value: number | null | undefined, currency = "USD"): string {
  if (!isNumber(value)) return ABSENT;
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? "";
  const negative = value < 0;
  const [whole, fraction] = Math.abs(value).toFixed(2).split(".");
  return `${negative ? "-" : ""}${symbol}${group(whole)}.${fraction}`;
}

/** A signed percentage at two decimals: 2.7208 -> "+2.72%". */
export function pct(value: number | null | undefined, digits = 2): string {
  if (!isNumber(value)) return ABSENT;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

/** An unsigned percentage: 0.189 -> "18.9%". */
export function percent(value: number | null | undefined, digits = 1): string {
  if (!isNumber(value)) return ABSENT;
  return `${value.toFixed(digits)}%`;
}

/** A portfolio weight given as a fraction: 0.189 -> "18.9%". */
export function weight(fraction: number | null | undefined, digits = 1): string {
  if (!isNumber(fraction)) return ABSENT;
  return percent(fraction * 100, digits);
}

/** A signed contribution in percentage points: 1.6230 -> "+1.62 pts". */
export function pts(value: number | null | undefined, digits = 2): string {
  if (!isNumber(value)) return ABSENT;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)} pts`;
}

/** A signed plain number at two decimals: 1.6230 -> "+1.62". */
export function signed(value: number | null | undefined, digits = 2): string {
  if (!isNumber(value)) return ABSENT;
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

/** A plain number at the given precision. */
export function number(value: number | null | undefined, digits = 2): string {
  if (!isNumber(value)) return ABSENT;
  return value.toFixed(digits);
}
