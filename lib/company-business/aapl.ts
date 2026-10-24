import type { BusinessExtractor } from "./types";

const CATEGORIES = ["iPhone", "Mac", "iPad", "Wearables, Home and Accessories", "Services"] as const;
const MILLIONS = "(\\d{1,3}(?:,\\d{3})+)";

/**
 * Apple's reportable segments are geographic. This separate, complete product
 * and services view is classified as revenue lines so the two views cannot be
 * added together. The first amount column is the latest quarter/year, in USD
 * millions, in the MD&A "net sales by category" table.
 *
 * Verified against the 2026 Q3 10-Q (accession 0000320193-26-000020):
 * https://www.sec.gov/Archives/edgar/data/320193/000032019326000020/aapl-20260627.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const heading = /The following table shows net sales by category for [^.]{0,250}?\(dollars in millions\):/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index!, match.index! + 2_500);
    const firstRow = /\biPhone\s+\$?\s*\d{1,3}(?:,\d{3})+\b/i.exec(table);
    if (!firstRow || firstRow.index > 650) continue;
    const header = table.slice(0, firstRow.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    // The filing's first amount column must be the most recent presented
    // period. Reject unfamiliar layouts instead of silently using a prior year.
    if (years.length < 2 || years[0] !== Math.max(...years)) continue;
    if (!/\b(?:Three Months Ended|for 20\d{2}, 20\d{2} and 20\d{2})\b/i.test(header)) continue;

    const rows: { name: string; amountM: number; excerpt: string }[] = [];
    let cursor = firstRow.index;
    for (const name of CATEGORIES) {
      const label = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const row = new RegExp(`\\b${label}(?:\\s*\\(\\d+\\))?\\s+\\$?\\s*${MILLIONS}\\b`, "i").exec(table.slice(cursor));
      if (!row || row.index > 250) break;
      const amountM = Number(row[1].replaceAll(",", ""));
      if (!Number.isSafeInteger(amountM) || amountM <= 0) break;
      rows.push({ name, amountM, excerpt: row[0] });
      cursor += row.index + row[0].length;
    }
    if (rows.length !== CATEGORIES.length) continue;

    const total = new RegExp(`\\bTotal net sales\\s+\\$?\\s*${MILLIONS}\\b`, "i").exec(table.slice(cursor, cursor + 250));
    if (!total) continue;
    const totalM = Number(total[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(totalM) || rows.reduce((sum, row) => sum + row.amountM, 0) !== totalM) continue;

    const context = `${match[0]} ${header.slice(match[0].length).trim()}`.slice(0, 310);
    candidates.push({
      kind: "revenue_line",
      businesses: rows.map((row) => ({
        name: row.name,
        revenueB: row.amountM / 1_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${total[0]}`.slice(0, 700),
      })),
    });
  }

  // Multiple copies in a filing are acceptable only if they agree exactly.
  if (candidates.some((candidate) => JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB])) !==
    JSON.stringify(candidates[0].businesses.map(({ name, revenueB }) => [name, revenueB])))) return [];
  return candidates.slice(0, 1);
};
