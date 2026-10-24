import type { BusinessExtractor } from "./types";

/**
 * Amazon's reportable segments are North America, International, and AWS.
 * Advertising and subscription services are also disclosed as product/service
 * revenue lines, but are already included in these segments. The segment note
 * reports USD millions; BusinessCandidate values are USD billions.
 *
 * Source: Amazon.com, Inc., 2026 Q2 Form 10-Q, Note 8 (CIK 0001018724).
 * https://www.sec.gov/Archives/edgar/data/1018724/000101872426000026/amzn-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  // The shared filingText normalizer leaves numeric HTML entities intact;
  // Amazon's heading uses &#8212; for its em dash in the SEC HTML.
  const notes = /\bNote\s+\d+\s*(?:[—–-]|&#(?:8211|8212|x2013|x2014);|&(?:ndash|mdash);)\s*Segment Information\b/gi;

  for (const note of text.matchAll(notes)) {
    const section = text.slice(note.index, note.index + 12_000);
    if (!/organized our operations into three segments:\s*North America,\s*International,\s*and AWS\b/i.test(section.slice(0, 2_000))) continue;

    const lead = /Information on reportable segments and reconciliation to consolidated net income is as follows\s*\(in millions\)\s*:/i.exec(section);
    if (!lead) continue;
    const table = section.slice(lead.index + lead[0].length, lead.index + lead[0].length + 4_000);
    const firstRow = /\bNorth America\s+Net sales\b/i.exec(table);
    if (!firstRow) continue;
    const header = table.slice(0, firstRow.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((match) => Number(match[0]));
    const isQuarterly = /\bThree Months Ended\b/i.test(header) && (years.length === 2 || years.length === 4);
    const isAnnual = /\bYear Ended\b/i.test(header) && years.length === 3;
    if (!isQuarterly && !isAnnual) continue;
    const latestIndex = isQuarterly ? 1 : years.length - 1;
    if (years[latestIndex] !== Math.max(...years)) continue;

    const labels = ["North America", "International", "AWS", "Consolidated"] as const;
    const rows: { name: string; amountM: number; excerpt: string }[] = [];
    let cursor = firstRow.index;
    for (const name of labels) {
      const pattern = new RegExp(`\\b${name}\\s+Net sales\\s+(.{1,220}?)\\s+Operating expenses\\b`, "i");
      const match = pattern.exec(table.slice(cursor));
      if (!match || match.index > 700) break;
      const cells = match[1].replace(/\$/g, " ").trim().split(/\s+/);
      if (cells.length !== years.length || cells.some((cell) => !/^\d{1,3}(?:,\d{3})*$/.test(cell))) break;
      const amounts = cells.map((cell) => Number(cell.replace(/,/g, "")));
      if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) break;
      rows.push({ name, amountM: amounts[latestIndex], excerpt: `${name} Net sales ${match[1].trim()}` });
      cursor += match.index + match[0].length;
    }
    if (rows.length !== labels.length) continue;
    if (rows[0].amountM + rows[1].amountM + rows[2].amountM !== rows[3].amountM) continue;

    const context = `Segment Information (in millions): ${header.trim()}`;
    return [{
      kind: "reportable_segment",
      businesses: rows.slice(0, 3).map((row) => ({
        name: row.name,
        revenueB: row.amountM / 1_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${rows[3].excerpt}`.slice(0, 700),
      })),
    }];
  }

  return [];
};
