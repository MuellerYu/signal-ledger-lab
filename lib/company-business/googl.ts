import type { BusinessExtractor } from "./types";

/**
 * Alphabet's segment note reports Google Services, Google Cloud, and Other Bets
 * in USD millions. Search, YouTube, subscriptions, and devices are already
 * included in Google Services, so they cannot be added as separate businesses.
 *
 * Verified against the 2026 Q2 10-Q, Note 15 (CIK 0001652044):
 * https://www.sec.gov/Archives/edgar/data/1652044/000165204426000071/goog-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ")
    // SEC iXBRL often separates a parenthesized loss into three text nodes.
    .replace(/\(\s+([\d,]+)\s+\)/g, "($1)").trim();
  const intro = /The following table presents revenue, profitability, and expense information about our segments \(in millions\):/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const heading of text.matchAll(intro)) {
    const table = text.slice(heading.index!, heading.index! + 3_500);
    const revenueHeading = /\bRevenues\s*:/i.exec(table);
    const incomeHeading = /\bOperating income \(loss\)\s*:/i.exec(table);
    if (!revenueHeading || !incomeHeading || incomeHeading.index <= revenueHeading.index) continue;

    const header = table.slice(0, revenueHeading.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((match) => Number(match[0]));
    const quarterly = /\bThree Months Ended\b/i.test(header) &&
      (years.length === 2 || years.length === 4) &&
      years[1] > years[0] &&
      (years.length === 2 || (years[2] === years[0] && years[3] === years[1]));
    const annual = /\bYear Ended\b/i.test(header) &&
      years.length === 3 && years[0] < years[1] && years[1] < years[2];
    if (!quarterly && !annual) continue;
    const currentColumn = quarterly ? 1 : 2;

    const revenueRows = table.slice(revenueHeading.index + revenueHeading[0].length, incomeHeading.index);
    const labels = ["Google Services", "Google Cloud", "Other Bets", "Hedging gains (losses)", "Total revenues"];
    const rows: { label: string; values: number[]; excerpt: string }[] = [];
    let cursor = 0;
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const at = revenueRows.indexOf(label, cursor);
      const next = index + 1 < labels.length ? revenueRows.indexOf(labels[index + 1], at + label.length) : revenueRows.length;
      if (at < 0 || next < 0 || at - cursor > 120 || next - at > 350) break;
      const excerpt = revenueRows.slice(at, next).trim();
      const cells = excerpt.slice(label.length).replace(/\$/g, " ").trim().split(/\s+/);
      if (cells.length !== years.length || cells.some((cell) => !/^(?:\d{1,3}(?:,\d{3})*|\d+|\([\d,]+\))$/.test(cell))) break;
      const values = cells.map((cell) => cell.startsWith("(")
        ? -Number(cell.slice(1, -1).replace(/,/g, ""))
        : Number(cell.replace(/,/g, "")));
      if (values.some((value) => !Number.isSafeInteger(value))) break;
      rows.push({ label, values, excerpt });
      cursor = next;
    }
    if (rows.length !== labels.length) continue;
    if (rows.slice(0, 3).some((row) => row.values.some((value) => value < 0))) continue;
    if (rows[4].values.some((value, column) => value <= 0 ||
      rows.slice(0, 4).reduce((sum, row) => sum + row.values[column], 0) !== value)) continue;

    const context = `${heading[0]} ${header.trim()} Revenues:`;
    const business = (row: typeof rows[number]) => ({
      name: row.label,
      revenueB: row.values[currentColumn] / 1_000,
      sourceExcerpt: `${context} ${row.excerpt}; ${rows[4].excerpt}`.slice(0, 700),
    });
    const segments = rows.slice(0, 3).map(business);
    // Keep the disclosed reconciliation even when it is a loss. The current
    // caller only accepts non-negative rows, so it can use the segment-only
    // candidate below for those periods.
    candidates.push({ kind: "revenue_line", businesses: [...segments, business(rows[3])] });
    candidates.push({ kind: "reportable_segment", businesses: segments });
  }

  // A repeated table with conflicting values needs manual review.
  const fingerprints = new Set(candidates.filter((candidate) => candidate.kind === "reportable_segment")
    .map((candidate) => JSON.stringify(candidate.businesses.map((row) => row.revenueB))));
  return fingerprints.size > 1 ? [] : candidates.slice(0, 2);
};
