import type { BusinessExtractor } from "./types";

/**
 * SpaceX's Note 3 reports two non-overlapping views of the same revenue:
 * three reportable segments and six product/customer revenue lines. SEC tables
 * are in USD millions; BusinessCandidate values are in USD billions.
 *
 * Source: Space Exploration Technologies Corp., 10-Q filed 2026-08-04,
 * quarter ended 2026-06-30, Note 3 (CIK 0001181412).
 * https://www.sec.gov/Archives/edgar/data/1181412/000162828026052535/spcx-20260630.htm
 */
export const extractSpcxBusinesses: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/\s+/g, " ");
  if (!/Space Exploration Technologies Corp\.?/i.test(text)) return [];
  const start = text.search(/Revenue disaggregated by type and segment is as follows:/i);
  if (start < 0 || !/tables in millions/i.test(text.slice(0, start))) return [];

  // Work inside the Note 3 table so later MD&A mentions cannot be mistaken for
  // reported revenue. Rows are read in filing order, taking the first (latest)
  // period column from each row.
  const table = text.slice(start, start + 6000);
  const labels = [
    "Launch Services",
    "Launch & Development",
    "Space",
    "Consumer",
    "Enterprise & Government",
    "Connectivity",
    "Advertising",
    "AI Solutions & Infrastructure",
    "AI",
    "Total revenues",
  ] as const;
  const rows = new Map<string, { amountM: number; excerpt: string }>();
  let cursor = 0;
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|\\s)${escaped}(?:\\s*\\(\\d+\\))?\\s+\\$?\\s*([\\d,]+)(?=\\s|$)`, "i");
    const match = table.slice(cursor).match(pattern);
    if (!match || match.index === undefined) return [];
    const amountM = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(amountM) || amountM < 0) return [];
    rows.set(label, { amountM, excerpt: match[0].trim() });
    cursor += match.index + match[0].length;
  }

  const value = (label: string) => rows.get(label)!.amountM;
  const same = (actual: number, expected: number) => Math.abs(actual - expected) < 0.5;
  if (!same(value("Launch Services") + value("Launch & Development"), value("Space"))) return [];
  if (!same(value("Consumer") + value("Enterprise & Government"), value("Connectivity"))) return [];
  if (!same(value("Advertising") + value("AI Solutions & Infrastructure"), value("AI"))) return [];
  if (!same(value("Space") + value("Connectivity") + value("AI"), value("Total revenues"))) return [];

  const business = (label: string) => ({
    name: label,
    revenueB: value(label) / 1000,
    sourceExcerpt: rows.get(label)!.excerpt,
  });
  return [
    { kind: "reportable_segment", businesses: [business("Space"), business("Connectivity"), business("AI")] },
    { kind: "revenue_line", businesses: [
      business("Launch Services"),
      business("Launch & Development"),
      business("Consumer"),
      business("Enterprise & Government"),
      business("Advertising"),
      business("AI Solutions & Infrastructure"),
    ] },
  ];
};
