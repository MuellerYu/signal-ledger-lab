import type { BusinessExtractor } from "./types";

/**
 * Palantir discloses Government and Commercial as its reportable segments.
 * Read only the first (current-period) revenue column of the segment note,
 * where values are in USD thousands. Contribution and geographic revenue
 * tables contain overlapping figures and must never be summed with these rows.
 *
 * Checked against Q2 2026 10-Q (CIK 0001321655, accession 0001321655-26-000041):
 * https://www.sec.gov/Archives/edgar/data/1321655/000132165526000041/pltr-20260630.htm
 * and FY2025 10-K (accession 0001321655-26-000011):
 * https://www.sec.gov/Archives/edgar/data/1321655/000132165526000011/pltr-20251231.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const heading = /Financial information for each reportable segment(?:, including disaggregation of revenue,)? was as follows \(in thousands, except percentages\):/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index! + match[0].length, match.index! + match[0].length + 3_500);
    const government = /\bGovernment revenue\s*\$?\s*([\d,]+)\b/i.exec(table);
    if (!government || government.index > 500) continue;
    const header = table.slice(0, government.index);
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    const quarterly = /\bThree Months Ended\b/i.test(header) &&
      (years.length === 2 && years[0] > years[1] ||
        years.length === 4 && /\b(?:Six|Nine) Months Ended\b/i.test(header) &&
          years[0] > years[1] && years[0] === years[2] && years[1] === years[3]);
    const annual = /\bYears? Ended\b/i.test(header) &&
      years.length === 3 && years[0] > years[1] && years[1] > years[2];
    if (!quarterly && !annual || !/\bContribution:\s*$/i.test(header)) continue;

    const afterGovernment = table.slice(government.index + government[0].length, government.index + government[0].length + 1_100);
    const commercial = /\bCommercial revenue\s*\$?\s*([\d,]+)\b/i.exec(afterGovernment);
    if (!commercial || !/\bExpenses attributable to government segment\b/i.test(afterGovernment.slice(0, commercial.index)) ||
      !/\bGovernment contribution\b/i.test(afterGovernment.slice(0, commercial.index))) continue;
    const afterCommercial = afterGovernment.slice(commercial.index + commercial[0].length);
    if (!/\bExpenses attributable to commercial segment\b/i.test(afterCommercial) ||
      !/\bCommercial contribution\b/i.test(afterCommercial)) continue;

    const amounts = [government[1], commercial[1]].map((value) => Number(value.replaceAll(",", "")));
    if (amounts.some((value) => !Number.isSafeInteger(value) || value <= 0)) continue;
    const context = `${match[0]} ${header.trim()}`;
    candidates.push({
      kind: "reportable_segment",
      businesses: [
        { name: "Government", revenueB: amounts[0] / 1_000_000,
          sourceExcerpt: `${context} ${government[0]}`.slice(0, 700) },
        { name: "Commercial", revenueB: amounts[1] / 1_000_000,
          sourceExcerpt: `${context} ${commercial[0]}`.slice(0, 700) },
      ],
    });
  }

  // Conflicting duplicate segment tables require a human review.
  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
