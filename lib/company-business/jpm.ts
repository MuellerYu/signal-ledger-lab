import type { BusinessExtractor } from "./types";

/**
 * JPMorganChase reports three bank segments on a managed (fully taxable
 * equivalent) basis. Corporate and the FTE reconciling item must be combined
 * to get a fourth, non-overlapping row that ties to reported GAAP net revenue.
 * Amounts in the filing table are USD millions; candidates use USD billions.
 *
 * 2026 Q2 Form 10-Q, Note 25, CIK 0000019617, accession 0001628280-26-054343:
 * https://www.sec.gov/Archives/edgar/data/19617/000162828026054343/jpm-20260630.htm
 * The same table layout appears in the 2025 10-K, Note 32:
 * https://www.sec.gov/Archives/edgar/data/19617/000162828026008131/jpm-20251231.htm
 */

const AMOUNT = /\(\s*\d[\d,]*\s*\)|-?\d[\d,]*/g;
const SEGMENT_NAMES = [
  "Consumer & Community Banking",
  "Commercial & Investment Bank",
  "Asset & Wealth Management",
] as const;

function revenueRow(block: string, start: number, count: number) {
  const excerpt = /\bTotal net revenue\s+(.{1,300}?)\s+Provision for credit losses\b/i.exec(block.slice(start, start + 2_500));
  if (!excerpt) return null;
  const values = [...excerpt[1].matchAll(AMOUNT)].map(([token]) => {
    const negative = token.startsWith("(") || token.startsWith("-");
    const magnitude = Number(token.replace(/[(),-]/g, ""));
    return negative ? -magnitude : magnitude;
  });
  return values.length === count && values.every(Number.isSafeInteger)
    ? { values, excerpt: `Total net revenue ${excerpt[1].trim()}` }
    : null;
}

export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const anchors = text.matchAll(/\bSegment\s*&\s*Corporate results and reconciliation(?:\s*\([a-z]\))?/gi);

  for (const anchor of anchors) {
    const section = text.slice(anchor.index, anchor.index + 12_000);
    const period = /As of or for the (three months|year) ended\s+(?:[A-Za-z]+\s+\d{1,2},?\s*)?/i.exec(section.slice(0, 700));
    if (!period) continue;
    const annual = period[1].toLowerCase() === "year";
    const columns = annual ? 9 : 6;
    const header = /Consumer\s*&\s*Community Banking\s+Commercial\s*&\s*Investment Bank\s+Asset\s*&\s*Wealth Management\s+((?:(?:19|20)\d{2}\s+){6,9})Noninterest revenue\b/i.exec(section);
    if (!header) continue;
    const years = [...header[1].matchAll(/(?:19|20)\d{2}/g)].map(([year]) => Number(year));
    if (years.length !== columns) continue;
    const span = annual ? 3 : 2;
    if (!years.every((year, index) => year === years[index % span]) ||
      years[0] !== Math.max(...years)) continue;
    const segment = revenueRow(section, header.index + header[0].length, columns);
    if (!segment) continue;

    const corporateHeader = /Corporate\s+Reconciling Items(?:\s*\([a-z]\))?\s+Total\s+((?:(?:19|20)\d{2}\s+){6,9})Noninterest revenue\b/i.exec(section.slice(header.index + header[0].length));
    if (!corporateHeader) continue;
    const corporateYears = [...corporateHeader[1].matchAll(/(?:19|20)\d{2}/g)].map(([year]) => Number(year));
    if (corporateYears.length !== columns || corporateYears.some((year, index) => year !== years[index])) continue;
    const corporateStart = header.index + header[0].length + corporateHeader.index + corporateHeader[0].length;
    const corporate = revenueRow(section, corporateStart, columns);
    if (!corporate) continue;

    const ccb = segment.values[0];
    const cib = segment.values[span];
    const awm = segment.values[span * 2];
    const corporateManaged = corporate.values[0];
    const fteAdjustment = corporate.values[span];
    const gaapTotal = corporate.values[span * 2];
    const corporateGaap = corporateManaged + fteAdjustment;
    if ([ccb, cib, awm, corporateManaged, gaapTotal, corporateGaap].some((value) => value <= 0) ||
      fteAdjustment >= 0 || ccb + cib + awm + corporateGaap !== gaapTotal) continue;

    const context = `${period[0].trim()} (in millions; segment revenues on managed FTE basis). `;
    const segmentExcerpt = `${context}${segment.excerpt}; ${corporate.excerpt}`.slice(0, 700);
    return [{
      kind: "reportable_segment",
      businesses: [
        ...SEGMENT_NAMES.map((name, index) => ({
          name,
          revenueB: [ccb, cib, awm][index] / 1_000,
          sourceExcerpt: segmentExcerpt,
          basis: "reported" as const,
        })),
        {
          name: "Corporate and FTE reconciliation",
          revenueB: corporateGaap / 1_000,
          sourceExcerpt: `${context}${corporate.excerpt}; Corporate ${corporateManaged.toLocaleString("en-US")} + FTE reconciliation (${Math.abs(fteAdjustment).toLocaleString("en-US")}) = ${corporateGaap.toLocaleString("en-US")}; GAAP total ${gaapTotal.toLocaleString("en-US")}.`.slice(0, 700),
          basis: "derived",
        },
      ],
    }];
  }
  return [];
};
