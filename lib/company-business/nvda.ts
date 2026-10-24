import type { BusinessExtractor } from "./types";

/**
 * NVIDIA's reportable segments appear as columns in the segment note. The
 * first Revenue row belongs to the current three-month period in a 10-Q, or
 * the current year in a 10-K. Values in the filing are USD millions.
 *
 * Checked against the 2026 Q2 10-Q and FY2026 10-K (CIK 0001045810):
 * https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/nvda-20260726.htm
 * https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const anchor = /The table below presents details of our reportable segments\./gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(anchor)) {
    const section = text.slice(match.index! + match[0].length, match.index! + match[0].length + 2_000);
    const table = /Compute\s*(?:&|and)\s*Networking\s+Graphics\s+Total\s+\(In millions\)\s+((?:Three Months|Year) Ended\s+.{1,65}?)\s+Revenue\s+\$?\s*([\d,]+)\s+\$?\s*([\d,]+)\s+\$?\s*([\d,]+)/i.exec(section);
    if (!table) continue;
    const period = table[1].trim();
    if (!/\b20\d{2}\b/.test(period)) continue;
    const amounts = table.slice(2, 5).map((value) => Number(value.replaceAll(",", "")));
    if (amounts.some((value) => !Number.isSafeInteger(value) || value <= 0)) continue;
    if (amounts[0] + amounts[1] !== amounts[2]) continue;

    const excerpt = `${table[0].trim()}`;
    candidates.push({
      kind: "reportable_segment",
      businesses: ["Compute & Networking", "Graphics"].map((name, index) => ({
        name,
        revenueB: amounts[index] / 1_000,
        sourceExcerpt: excerpt,
      })),
    });
  }

  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
