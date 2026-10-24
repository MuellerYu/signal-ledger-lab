import type { BusinessExtractor } from "./types";

/**
 * Meta reports Family of Apps and Reality Labs as its two reportable segments.
 * Its segment note uses USD millions; the output uses USD billions. Advertising
 * and Other revenue belong inside Family of Apps and must not be added to it.
 *
 * Checked against the 2026 Q2 Form 10-Q, Note 12 (CIK 0001326801):
 * https://www.sec.gov/Archives/edgar/data/1326801/000162828026050705/meta-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const heading = /The following table sets forth our segment information of revenue, expenses, and income \(loss\) from operations \(in millions\):/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index! + match[0].length, match.index! + match[0].length + 3_500);
    const firstRow = /\bFamily of Apps:\s+Revenue\b/i.exec(table);
    if (!firstRow || firstRow.index > 500) continue;

    const header = table.slice(0, firstRow.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    const quarterly = /\bThree Months Ended\b/i.test(header) &&
      ((years.length === 2 && years[0] > years[1]) ||
        (years.length === 4 && /\b(?:Six|Nine) Months Ended\b/i.test(header) &&
          years[0] > years[1] && years[0] === years[2] && years[1] === years[3]));
    const annual = /\bYear Ended\b/i.test(header) &&
      years.length === 3 && years[0] > years[1] && years[1] > years[2];
    if (!quarterly && !annual) continue;

    const labels = ["Family of Apps", "Reality Labs", "Total"] as const;
    const rows: { name: string; values: number[]; excerpt: string }[] = [];
    let cursor = firstRow.index;
    for (const name of labels) {
      const start = new RegExp(`\\b${name}:\\s+Revenue\\b`, "i").exec(table.slice(cursor));
      if (!start || start.index > 600) break;
      const rowStart = cursor + start.index;
      const rowEnd = /\bEmployee compensation\b/i.exec(table.slice(rowStart));
      if (!rowEnd || rowEnd.index > 200) break;
      const excerpt = table.slice(rowStart, rowStart + rowEnd.index).trim();
      const cells = excerpt.slice(start[0].length).replace(/\$/g, " ").trim().split(/\s+/);
      if (cells.length !== years.length || cells.some((cell) => !/^\d{1,3}(?:,\d{3})*$/.test(cell))) break;
      const values = cells.map((cell) => Number(cell.replace(/,/g, "")));
      if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) break;
      rows.push({ name, values, excerpt });
      cursor = rowStart + rowEnd.index;
    }
    if (rows.length !== labels.length ||
      rows[2].values.some((total, column) => rows[0].values[column] + rows[1].values[column] !== total)) continue;

    const context = `${match[0]} ${header.trim()}`;
    candidates.push({
      kind: "reportable_segment",
      businesses: rows.slice(0, 2).map((row) => ({
        name: row.name,
        revenueB: row.values[0] / 1_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${rows[2].excerpt}`.slice(0, 700),
      })),
    });
  }

  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
