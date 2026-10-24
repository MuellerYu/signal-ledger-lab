import type { BusinessExtractor } from "./types";

const HISTORICAL_SEGMENTS = [
  "Productivity and Business Processes",
  "Intelligent Cloud",
  "More Personal Computing",
] as const;

// Microsoft announced a two-segment presentation beginning in FY27. Parse it
// only when the actual periodic filing contains a complete, reconciled table.
const FY27_SEGMENTS = ["Agents and Infra", "Devices and Consumer"] as const;

const amount = (raw: string) => Number(raw.replaceAll(",", ""));

/** The first numeric column of Microsoft's segment note is the latest period;
 *  the filing prints these tables in USD millions. The caller separately ties
 *  the result to same-accession SEC consolidated revenue facts. */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ");
  const heading = /Segment revenue, cost of revenue, operating expenses, and operating income were as follows during the periods presented:/gi;
  const candidates: ReturnType<BusinessExtractor> = [];

  for (const match of text.matchAll(heading)) {
    const table = text.slice(match.index!, match.index! + 8_000);
    const firstSegment = Math.min(
      ...[...HISTORICAL_SEGMENTS, ...FY27_SEGMENTS]
        .map((name) => table.indexOf(name))
        .filter((index) => index >= 0),
    );
    if (!Number.isFinite(firstSegment) || firstSegment > 600) continue;
    const header = table.slice(0, firstSegment);
    if (!/\(In millions\)/i.test(header) || !/\b(?:Three Months Ended|Year Ended)\b/i.test(header)) continue;

    const labels = table.indexOf(FY27_SEGMENTS[0]) === firstSegment ? FY27_SEGMENTS : HISTORICAL_SEGMENTS;
    const rows: { name: string; revenueM: number; excerpt: string; end: number }[] = [];
    let cursor = firstSegment;
    for (const name of labels) {
      const row = new RegExp(`\\b${name}\\s+Revenue\\s+\\$?\\s*([\\d,]+)\\b`, "i").exec(table.slice(cursor));
      if (!row || row.index > 650) break;
      const revenueM = amount(row[1]);
      if (!Number.isSafeInteger(revenueM) || revenueM <= 0) break;
      const end = cursor + row.index + row[0].length;
      rows.push({ name, revenueM, excerpt: `${header.slice(0, 250)} ${row[0]}`.trim(), end });
      cursor = end;
    }
    if (rows.length !== labels.length) continue;

    // The next block must be the consolidated Total row, for the same first
    // column. This also rejects partial or mixed period tables.
    const total = /\bTotal\s+Revenue\s+\$?\s*([\d,]+)\b/i.exec(table.slice(cursor, cursor + 900));
    if (!total) continue;
    const totalM = amount(total[1]);
    if (!Number.isSafeInteger(totalM) || totalM <= 0 || rows.reduce((sum, row) => sum + row.revenueM, 0) !== totalM) continue;

    candidates.push({
      kind: "reportable_segment",
      businesses: rows.map((row) => ({
        name: row.name,
        revenueB: row.revenueM / 1_000,
        sourceExcerpt: `${row.excerpt} … ${total[0]}`.slice(0, 700),
      })),
    });
  }

  // Duplicate copies of the same table are harmless. Conflicting tables in
  // one filing require review rather than an arbitrary first match.
  if (candidates.some((candidate) => JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB])) !==
    JSON.stringify(candidates[0].businesses.map(({ name, revenueB }) => [name, revenueB])))) return [];
  return candidates.slice(0, 1);
};
