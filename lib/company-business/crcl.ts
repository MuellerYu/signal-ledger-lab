import type { BusinessExtractor } from "./types";

/**
 * Circle discloses one business segment. Note 11 instead provides four
 * non-overlapping product/service revenue lines; "Other revenue" is a heading
 * and "Total other revenue" is a subtotal, neither is an additional line.
 * Reserve income is included in Circle's reported top line even though it is
 * not revenue from customer contracts under ASC 606.
 *
 * Checked against 2026 Q2 Form 10-Q, Note 11, accession 0001876042-26-000248:
 * https://www.sec.gov/Archives/edgar/data/1876042/000187604226000248/crcl-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const heading = /The following table summarizes the disaggregation of revenue by major product and service\s*\(in thousands\)\s*:/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index! + match[0].length, match.index! + match[0].length + 3_200);
    const first = /\bReserve income\s+\$?\s*\d{1,3}(?:,\d{3})*\b/i.exec(table);
    if (!first || first.index > 650) continue;
    const header = table.slice(0, first.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    const quarterly = /\bThree months ended\b/i.test(header) &&
      (years.length === 2 || years.length === 4);
    const annual = /\bYears? ended\b/i.test(header) && years.length === 3;
    if ((!quarterly && !annual) || years[0] !== Math.max(...years)) continue;

    const labels = ["Reserve income", "Subscription and services", "Transaction revenue", "Other", "Total other revenue", "Total revenue and reserve income"] as const;
    const rows: { name: string; values: number[]; excerpt: string }[] = [];
    let cursor = first.index;
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index];
      const marker = index === 3 ? /\bOther\b(?!\s+revenue)/i
        : index === 5 ? /\bTotal revenue and reserve income(?: from continuing operations)?\b/i
        : new RegExp(`\\b${label}\\b`, "i");
      const start = marker.exec(table.slice(cursor));
      if (!start || start.index > 150) break;
      const rowStart = cursor + start.index;
      const nextLabel = labels[index + 1];
      const next = nextLabel
        ? (index === 0
          ? /\bOther revenue\s*:?\s+Subscription and services\b/i
          : new RegExp(`\\b${nextLabel}\\b`, "i")).exec(table.slice(rowStart + start[0].length))
        : /\bReserve income\b/i.exec(table.slice(rowStart + start[0].length));
      if (!next || next.index > 240) break;
      const end = rowStart + start[0].length + next.index;
      const excerpt = table.slice(rowStart, end).trim();
      const raw = excerpt.slice(start[0].length).replace(/\$/g, " ").trim();
      const cells = raw ? raw.split(/\s+/) : [];
      if (cells.length !== years.length || cells.some((cell) => !/^\d{1,3}(?:,\d{3})*$/.test(cell))) break;
      const values = cells.map((cell) => Number(cell.replace(/,/g, "")));
      if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) break;
      rows.push({ name: label, values, excerpt });
      cursor = end;
    }
    if (rows.length !== labels.length) continue;
    if (rows[0].values.some((reserve, column) =>
      rows[1].values[column] + rows[2].values[column] + rows[3].values[column] !== rows[4].values[column] ||
      reserve + rows[4].values[column] !== rows[5].values[column])) continue;

    const context = `${match[0]} ${header.trim()}`.slice(0, 320);
    candidates.push({
      kind: "revenue_line",
      businesses: rows.slice(0, 4).map((row) => ({
        name: row.name,
        revenueB: row.values[0] / 1_000_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${rows[5].excerpt}`.slice(0, 700),
      })),
    });
  }

  // Duplicate tables are acceptable only if they produce the same first-period figures.
  if (candidates.some((candidate) => JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB])) !==
    JSON.stringify(candidates[0].businesses.map(({ name, revenueB }) => [name, revenueB])))) return [];
  return candidates.slice(0, 1);
};
