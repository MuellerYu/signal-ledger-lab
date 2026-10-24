import type { BusinessExtractor } from "./types";

/**
 * AMD's current segment presentation has three reportable segments: Data
 * Center, Client and Gaming, and Embedded. Client and Gaming are separately
 * disclosed revenue components of the combined reportable segment, not two
 * additional reportable segments. We return four non-overlapping revenue
 * lines for the business tree and never add the combined subtotal again.
 *
 * Source: latest 10-Q, quarter ended June 27, 2026, accession
 * 0000002488-26-000123 (USD millions):
 * https://www.sec.gov/Archives/edgar/data/2488/000000248826000123/amd-20260627.htm
 * FY2025 10-K has the same row order with two year columns instead of the
 * current 10-Q's four quarter/YTD columns (Q1 10-Q has two columns):
 * https://www.sec.gov/Archives/edgar/data/2488/000000248826000021/amd-20251227.htm
 *
 * Only the first, current-period column is used. The caller reconciles its
 * total against same-accession SEC companyfacts. A changed table layout or
 * ambiguous duplicate produces no candidates for manual review.
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const anchor of text.matchAll(/\bNet revenue:\s+Data Center\b/gi)) {
    const before = text.slice(Math.max(0, anchor.index! - 350), anchor.index!);
    const quarterly = /\bThree Months Ended\b/i.test(before);
    const annual = /\bYear Ended\b/i.test(before);
    if ((!quarterly && !annual) || !/\bIn millions\b/i.test(before)) continue;
    const columns = quarterly && /\b(?:Six|Nine) Months Ended\b/i.test(before) ? 4 : 2;
    const table = text.slice(anchor.index! + "Net revenue:".length, anchor.index! + 1_200);
    const rows = /^\s*Data Center\s+([\d,$\s]+?)\s+Client and Gaming\s+Client\s+([\d,$\s]+?)\s+Gaming\s+([\d,$\s]+?)\s+Total Client and Gaming\s+([\d,$\s]+?)\s+Embedded\s+([\d,$\s]+?)\s+Total net revenue\s+([\d,$\s]+?)(?=\s+[A-Za-z]|$)/i.exec(table);
    if (!rows) continue;

    const amounts = rows.slice(1, 7).map((row) => {
      const cells = row.match(/\d[\d,]*/g) ?? [];
      return cells.length === columns ? cells.map((cell) => Number(cell.replaceAll(",", ""))) : [];
    });
    if (amounts.some((cells) => cells.length !== columns || cells.some((value) => !Number.isSafeInteger(value) || value <= 0))) continue;
    const [dataCenter, client, gaming, clientAndGaming, embedded, consolidated] = amounts.map((cells) => cells[0]);
    if (client + gaming !== clientAndGaming || dataCenter + clientAndGaming + embedded !== consolidated) continue;

    const excerpt = `${before.slice(-220)} Net revenue: ${rows[0]}`.trim().slice(0, 750);
    candidates.push({
      kind: "revenue_line",
      businesses: [
        { name: "Data Center", revenueB: dataCenter / 1_000, sourceExcerpt: excerpt },
        { name: "Client", revenueB: client / 1_000, sourceExcerpt: excerpt },
        { name: "Gaming", revenueB: gaming / 1_000, sourceExcerpt: excerpt },
        { name: "Embedded", revenueB: embedded / 1_000, sourceExcerpt: excerpt },
      ],
    });
  }

  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
