import type { BusinessExtractor } from "./types";

/**
 * Tesla's income statement discloses three complete, non-overlapping revenue
 * lines. Automotive includes sales, regulatory credits, and leasing; energy
 * and services are separate. These are revenue lines, not the two reportable
 * segments (which combine automotive and services).
 *
 * Checked against 2026 Q2 Form 10-Q, accession 0001628280-26-049270:
 * https://www.sec.gov/Archives/edgar/data/1318605/000162828026049270/tsla-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const candidates: ReturnType<BusinessExtractor> = [];
  const labels = ["Total automotive revenues", "Energy generation and storage", "Services and other"] as const;

  for (const heading of text.matchAll(/\bConsolidated Statements of Operations\s+\(in millions, except per share data\)/gi)) {
    const table = text.slice(heading.index!, heading.index! + 2_500);
    const start = /\bRevenues\s+Automotive sales\b/i.exec(table);
    if (!start || start.index > 800) continue;
    const header = table.slice(0, start.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((match) => Number(match[0]));
    const validQuarter = /\bThree Months Ended\b/i.test(header) && years.length >= 2 && years[0] > years[1];
    const validYear = /\bYear Ended\b/i.test(header) && years.length >= 2 && years[0] > years[1];
    if (!validQuarter && !validYear) continue;

    const body = table.slice(start.index);
    const rows: { name: string; amountM: number; excerpt: string }[] = [];
    let cursor = 0;
    for (const label of labels) {
      const row = new RegExp(`\\b${label}\\s+\\$?\\s*([0-9]{1,3}(?:,[0-9]{3})*)\\b`, "i").exec(body.slice(cursor));
      if (!row || row.index > 400) break;
      const amountM = Number(row[1].replaceAll(",", ""));
      if (!Number.isSafeInteger(amountM) || amountM <= 0) break;
      rows.push({ name: label, amountM, excerpt: row[0] });
      cursor += row.index + row[0].length;
    }
    if (rows.length !== labels.length) continue;
    const total = /\bTotal revenues\s+\$?\s*([0-9]{1,3}(?:,[0-9]{3})*)\b/i.exec(body.slice(cursor, cursor + 150));
    if (!total) continue;
    const totalM = Number(total[1].replaceAll(",", ""));
    if (rows.reduce((sum, row) => sum + row.amountM, 0) !== totalM) continue;

    const context = `${heading[0]} ${header.trim()}`.slice(0, 300);
    candidates.push({
      kind: "revenue_line",
      businesses: rows.map((row) => ({
        name: row.name === "Total automotive revenues" ? "Automotive" : row.name,
        revenueB: row.amountM / 1_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${total[0]}`.slice(0, 700),
      })),
    });
  }

  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
