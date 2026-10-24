import type { BusinessExtractor } from "./types";

/**
 * Strategy reports Software and Bitcoin as separate operating segments from
 * 2026 Q2 onward. Bitcoin treasury generated no revenue; all consolidated
 * revenue was Software. Four product/service lines provide a useful, complete
 * split of that revenue. Bitcoin holdings and fair-value changes are not sales.
 *
 * Source: Strategy Inc., 2026 Q2 Form 10-Q, accession 0001050446-26-000044.
 * https://www.sec.gov/Archives/edgar/data/1050446/000105044626000044/mstr-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const heading = /\bCONSOLIDATED STATEMENTS OF OPERATIONS\s*\(in thousands, except per share data\)/gi;
  const labels = [
    "Product licenses",
    "Subscription services",
    "Total product licenses and subscription services",
    "Product support",
    "Other services",
    "Total revenues",
  ] as const;

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index! + match[0].length, match.index! + match[0].length + 3_500);
    const first = /\bRevenues:\s*Product licenses\b/i.exec(table);
    if (!first || first.index > 650) continue;
    const header = table.slice(0, first.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    const quarterly = /\bThree Months Ended\b/i.test(header) && years.length === 4;
    const annual = /\bYears? Ended\b/i.test(header) && years.length === 3;
    if ((!quarterly && !annual) || years[0] !== Math.max(...years)) continue;

    const rows: { name: string; values: number[]; excerpt: string }[] = [];
    let cursor = first.index + "Revenues:".length;
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];
      const start = new RegExp(`\\b${label}\\b`, "i").exec(table.slice(cursor));
      if (!start || start.index > 60) break;
      const rowStart = cursor + start.index;
      const nextLabel = labels[index + 1];
      const next = nextLabel
        ? new RegExp(`\\b${nextLabel}\\b`, "i").exec(table.slice(rowStart + start[0].length))
        : /\bCost of revenues\b/i.exec(table.slice(rowStart + start[0].length));
      if (!next || next.index > 180) break;
      const rowEnd = rowStart + start[0].length + next.index;
      const excerpt = table.slice(rowStart, rowEnd).trim();
      const cells = excerpt.slice(start[0].length).replace(/\$/g, " ").trim().split(/\s+/);
      if (cells.length !== years.length || cells.some((cell) => !/^\d{1,3}(?:,\d{3})*$/.test(cell))) break;
      const values = cells.map((cell) => Number(cell.replace(/,/g, "")));
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) break;
      rows.push({ name: label, values, excerpt });
      cursor = rowEnd;
    }
    if (rows.length !== labels.length) continue;
    if (rows[0].values.some((license, column) =>
      license + rows[1].values[column] !== rows[2].values[column] ||
      rows[2].values[column] + rows[3].values[column] + rows[4].values[column] !== rows[5].values[column])) continue;

    const context = `${match[0]} ${header.trim()}`.slice(0, 300);
    return [{
      kind: "revenue_line",
      businesses: [rows[0], rows[1], rows[3], rows[4]].map((row) => ({
        name: row.name,
        revenueB: row.values[0] / 1_000_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${rows[5].excerpt}`.slice(0, 700),
      })),
    }];
  }

  return [];
};
