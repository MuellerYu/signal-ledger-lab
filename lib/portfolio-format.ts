/** Pure formatting helpers shared by server pages and client charts. */

export const signedPct = (value: number, digits = 1) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value * 100).toFixed(digits)}%`;

export const formatNav = (value: number) => value.toFixed(1);

export const tone = (value: number) => (value > 0 ? "gain" : value < 0 ? "loss" : "");

export type DatedPoint = { date: string };

export function filterByRange<T extends DatedPoint>(points: T[], range: string): T[] {
  if (range === "SI" || !points.length) return points;
  const asOf = points.at(-1)!.date;
  if (range === "YTD") return points.filter((point) => point.date > `${Number(asOf.slice(0, 4)) - 1}-12-31`);
  const months = range === "1M" ? 1 : range === "3M" ? 3 : range === "6M" ? 6 : 0;
  if (!months) return points;
  const cutoff = new Date(`${asOf}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const from = cutoff.toISOString().slice(0, 10);
  return points.filter((point) => point.date >= from);
}
