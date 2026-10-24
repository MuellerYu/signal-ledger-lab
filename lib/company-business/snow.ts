import type { BusinessExtractor } from "./types";

/**
 * Snowflake discloses product and professional services/other revenue as
 * non-overlapping revenue lines, rather than separate reportable segments.
 * The SEC revenue-disaggregation note reports USD thousands; values below are
 * converted to USD billions. The first column is the current quarter in a
 * 10-Q, or the current fiscal year in a 10-K.
 *
 * Source: Snowflake Inc., fiscal Q2 2027 Form 10-Q, Note 3 (CIK 0001640147).
 * https://www.sec.gov/Archives/edgar/data/1640147/000164014726000037/snow-20260731.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const heading = /\bDisaggregation of Revenue\s+Revenue consists of the following\s*\(in thousands\)\s*:/gi;

  for (const match of text.matchAll(heading)) {
    const section = text.slice(match.index! + match[0].length, match.index! + match[0].length + 2_000);
    const productLabel = /\bProduct revenue\b/i.exec(section);
    if (!productLabel || productLabel.index > 400) continue;
    const header = section.slice(0, productLabel.index);
    const quarterly = /\bThree Months Ended\b/i.test(header);
    const annual = /\b(?:Fiscal Year|Years?) Ended\b/i.test(header);
    if (quarterly === annual) continue;

    const years = Array.from(header.matchAll(/\b20\d{2}\b/g), (year) => Number(year[0]));
    if (quarterly && years.length !== 2 && years.length !== 4) continue;
    if (annual && years.length !== 3) continue;
    if (years[0] !== Math.max(...years)) continue;
    if (quarterly && years.length === 4 && (years[0] !== years[2] || years[1] !== years[3])) continue;

    const table = section.slice(productLabel.index);
    const rows = /^Product revenue\s+(.{1,180}?)\s+Professional services and other revenue\s+(.{1,180}?)\s+Total\s+(.{1,180}?)\s+Revenue by geographic area\b/i.exec(table);
    if (!rows) continue;

    const amounts = rows.slice(1, 4).map((row) => {
      const cells = row.replace(/\$/g, " ").trim().split(/\s+/);
      if (cells.length !== years.length || cells.some((cell) => !/^\d{1,3}(?:,\d{3})*$/.test(cell))) return null;
      const values = cells.map((cell) => Number(cell.replace(/,/g, "")));
      return values.every((value) => Number.isSafeInteger(value) && value >= 0) ? values : null;
    });
    const [product, services, total] = amounts;
    if (!product || !services || !total) continue;
    if (total[0] <= 0 || !total.every((value, index) => product[index] + services[index] === value)) continue;

    const context = `Disaggregation of Revenue (USD thousands): ${header.trim()}`;
    const totalExcerpt = `Total ${rows[3].trim()}`;
    return [{
      kind: "revenue_line",
      businesses: [
        {
          name: "Product revenue",
          revenueB: product[0] / 1_000_000,
          sourceExcerpt: `${context} Product revenue ${rows[1].trim()}; ${totalExcerpt}`.slice(0, 700),
        },
        {
          name: "Professional services and other revenue",
          revenueB: services[0] / 1_000_000,
          sourceExcerpt: `${context} Professional services and other revenue ${rows[2].trim()}; ${totalExcerpt}`.slice(0, 700),
        },
      ],
    }];
  }

  return [];
};
