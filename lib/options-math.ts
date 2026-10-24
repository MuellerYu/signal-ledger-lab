/** Research estimates, not executable quotes. All monetary inputs are USD/share. */
export type OptionRight = "call" | "put";
export type OptionInputs = {
  spot: number; strike: number; years: number; iv: number;
  rate: number; dividendYield: number; right: OptionRight;
};
export const OPTION_MULTIPLIER = 100;
export function intrinsic(spot: number, strike: number, right: OptionRight) {
  return Math.max(0, right === "call" ? spot - strike : strike - spot);
}

/** Recombining American binomial tree with early exercise at each node.
 * CRR when its transition probability is valid; JR for near-zero-volatility cases.
 * Continuous dividend yield only; discrete dividends/borrow/skew are not modelled.
 */
export function americanOption(input: OptionInputs, steps = 300): number {
  const { spot: s, strike: k, years: t, iv: v, rate: r, dividendYield: q, right } = input;
  if (![s, k, t, v, r, q].every(Number.isFinite) || s < 0 || k <= 0 ||
      t < 0 || t > 2 || v < 0 || v > 5 || r < 0 || r > .3 || q < 0 || q > .5 ||
      !["call", "put"].includes(right) || !Number.isInteger(steps) || steps < 20 || steps > 1500) {
    throw new Error("Check prices, dates, IV (0–500%), rate (0–30%) and yield (0–50%).");
  }
  if (t === 0 || s === 0) return intrinsic(s, k, right);
  const dt = t / steps;
  if (v === 0) {
    let value = intrinsic(s, k, right);
    for (let i = 1; i <= steps; i++) {
      const time = i * dt;
      value = Math.max(value, Math.exp(-r * time) * intrinsic(s * Math.exp((r - q) * time), k, right));
    }
    return value;
  }
  let up = Math.exp(v * Math.sqrt(dt));
  let down = 1 / up;
  let p = (Math.exp((r - q) * dt) - down) / (up - down);
  if (p < 0 || p > 1) {
    up = Math.exp((r - q - v * v / 2) * dt + v * Math.sqrt(dt));
    down = Math.exp((r - q - v * v / 2) * dt - v * Math.sqrt(dt));
    p = .5;
  }
  const discount = Math.exp(-r * dt);
  const values = new Float64Array(steps + 1);
  const ratio = up / down;
  let node = s * down ** steps;
  for (let j = 0; j <= steps; j++, node *= ratio) values[j] = intrinsic(node, k, right);
  for (let i = steps - 1; i >= 0; i--) {
    node = s * down ** i;
    for (let j = 0; j <= i; j++, node *= ratio) {
      values[j] = Math.max(intrinsic(node, k, right), discount * (p * values[j + 1] + (1 - p) * values[j]));
    }
  }
  return values[0];
}

export function optionSellerPnl(credit: number, buyback: number, quantity: number, totalFees: number) {
  return (credit - buyback) * OPTION_MULTIPLIER * quantity - totalFees;
}
export function sellerRisk(right: OptionRight, strike: number, credit: number, quantity: number, stockCost: number, fees: number) {
  const units = OPTION_MULTIPLIER * quantity;
  return {
    requiredShares: right === "call" ? units : 0,
    cashReserve: right === "put" ? strike * units : 0,
    breakeven: (right === "put" ? strike : stockCost) - credit + fees / units,
    maxLoss: Math.max(0, ((right === "put" ? strike : stockCost) - credit) * units + fees),
    maxProfit: (right === "put" ? credit : strike - stockCost + credit) * units - fees,
  };
}

/** All calculator date-only inputs denote 16:00 New York, including DST. */
export function optionDateMs(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return NaN;
  const guess = midnight + 21 * 3600000;
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(guess));
  return guess + (16 - hour) * 3600000;
}
export function addOptionDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
