import type { BusinessExtractor } from "./types";

const HEADING = /the following table presents summary results for each of our three businesses:/gi;
const BUSINESSES = ["Cloud and software", "Hardware", "Services"] as const;

/** Oracle's Note 9 segment table is in USD millions. Read its first (current
 * period) column and require the printed segment total to equal the three rows.
 * The caller also reconciles this total to the same SEC accession's companyfacts.
 * Cloud applications and infrastructure are components of cloud and software,
 * so they must not be added as separate operating segments. */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ");
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const heading of text.matchAll(HEADING)) {
    const table = text.slice(heading.index!, heading.index! + 5_000);
    const firstBusiness = table.search(/\bCloud and software:\s+Revenues\b/i);
    if (firstBusiness < 0 || firstBusiness > 600) continue;
    const header = table.slice(0, firstBusiness);
    if (!/\b(?:in millions|dollars in millions)\b/i.test(header) ||
        !/\b(?:Three Months Ended|Years? Ended)\b/i.test(header)) continue;

    const rows: { name: string; amountM: number; excerpt: string }[] = [];
    let cursor = firstBusiness;
    for (const name of BUSINESSES) {
      const pattern = new RegExp(`\\b${name}:\\s+Revenues\\s*\\$?\\s*([\\d,]+)\\b`, "i");
      const match = pattern.exec(table.slice(cursor, cursor + 1_400));
      if (!match) break;
      const amountM = Number(match[1].replaceAll(",", ""));
      if (!Number.isSafeInteger(amountM) || amountM <= 0) break;
      rows.push({ name, amountM, excerpt: match[0] });
      cursor += match.index + match[0].length;
    }
    if (rows.length !== BUSINESSES.length) continue;

    const total = /\bTotals?:\s+Revenues\s*\$?\s*([\d,]+)\b/i.exec(table.slice(cursor, cursor + 1_000));
    if (!total) continue;
    const totalM = Number(total[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(totalM) || rows.reduce((sum, row) => sum + row.amountM, 0) !== totalM) continue;

    candidates.push({
      kind: "reportable_segment",
      businesses: rows.map(({ name, amountM, excerpt }) => ({
        name,
        revenueB: amountM / 1_000,
        sourceExcerpt: `${header.slice(0, 250)} ${excerpt} … ${total[0]}`.trim().slice(0, 700),
      })),
    });
  }

  // A future filing with inconsistent duplicate tables requires review.
  if (candidates.some((candidate) => JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB])) !==
    JSON.stringify(candidates[0].businesses.map(({ name, revenueB }) => [name, revenueB])))) return [];
  return candidates.slice(0, 1);
};
