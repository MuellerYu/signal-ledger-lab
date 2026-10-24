import type { BusinessExtractor } from "./types";

/**
 * Oklo has one reportable segment, but Note 2 disaggregates its new revenue by
 * nature of service. The note is in USD thousands; this extractor returns USD
 * billions and labels the rows as revenue lines, not operating segments.
 *
 * Checked against the quarter ended 2026-06-30, Form 10-Q, accession
 * 0001628280-26-054571 (CIK 0001849056):
 * https://www.sec.gov/Archives/edgar/data/1849056/000162828026054571/oklo-20260630.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  if (!/\bOklo Inc\.?\b/i.test(text)) return [];

  const heading = /\bDisaggregation of Revenue\s+The following table presents revenue disaggregated by nature of revenue stream for the periods presented:/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    // The financial-statement notes give the unit, while the table itself does
    // not. A missing unit must never be interpreted as thousands by default.
    const prior = text.slice(Math.max(0, match.index! - 8_000), match.index!);
    if (!/Notes to Condensed Consolidated Financial Statement\s*s?[\s\S]{0,300}\(\s*in thousands, except share data or otherwise stated\s*\)/i.test(prior)) continue;

    const following = text.slice(match.index! + match[0].length);
    const boundary = following.search(/\bContract Balances\b/i);
    if (boundary < 0 || boundary > 1_600) continue;
    const table = following.slice(0, boundary);
    const firstRow = table.search(/\bEngineering and consulting services\b/i);
    if (firstRow < 0 || firstRow > 300) continue;
    const header = table.slice(0, firstRow);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    if (years.length < 2 || years[0] <= years[1] ||
      !/(?:Months|Years?) Ended/i.test(header)) continue;

    const names = [
      "Engineering and consulting services",
      "Manufacturing and fabrication services",
      "Other",
      "Total revenue recognized",
    ] as const;
    const rows: { name: string; amountK: number; excerpt: string }[] = [];
    let cursor = firstRow;
    for (const name of names) {
      const pattern = new RegExp(`\\b${name}\\b\\s+\\$?\\s*([\\d,]+)(?=\\s|$)`, "i");
      const found = pattern.exec(table.slice(cursor));
      if (!found || found.index > 250) break;
      const amountK = Number(found[1].replace(/,/g, ""));
      if (!Number.isSafeInteger(amountK) || amountK < 0) break;
      rows.push({ name, amountK, excerpt: found[0].trim() });
      cursor += found.index + found[0].length;
    }
    if (rows.length !== names.length || rows[3].amountK <= 0 ||
      rows[0].amountK + rows[1].amountK + rows[2].amountK !== rows[3].amountK) continue;

    candidates.push({
      kind: "revenue_line",
      businesses: rows.slice(0, 3).map((row) => ({
        name: row.name,
        revenueB: row.amountK / 1_000_000,
        sourceExcerpt: `Notes in USD thousands. ${header.trim()} ${row.excerpt}; ${rows[3].excerpt}`.slice(0, 700),
      })),
    });
  }

  // Repeated or ambiguous tables are not a safe basis for publication.
  return candidates.length === 1 ? candidates : [];
};
