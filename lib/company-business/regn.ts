import type { BusinessExtractor } from "./types";

/**
 * Regeneron reports one operating segment. Its MD&A revenue table, however,
 * disaggregates recognized revenue into non-overlapping product, collaboration,
 * and other revenue lines. Sanofi's Dupixent/Kevzara sales and Bayer's ex-U.S.
 * EYLEA sales are partner sales, not Regeneron revenue, and are excluded.
 *
 * Checked against the 2026 Q2 Form 10-Q, accession 0000872589-26-000025:
 * https://www.sec.gov/Archives/edgar/data/872589/000087258926000025/regn-20260630.htm
 * The same table structure appears in the FY2025 Form 10-K, accession
 * 0000872589-26-000008. All amounts are read from the filing, not stored here.
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const candidates: ReturnType<BusinessExtractor> = [];
  const heading = /\bRevenues\s+(?:(?:Three|Six|Nine) Months Ended|Year Ended)/gi;

  for (const match of text.matchAll(heading)) {
    const window = text.slice(match.index!, match.index! + 5_000);
    const productHeading = /\bNet product sales:\s*/i.exec(window);
    if (!productHeading || productHeading.index > 450) continue;
    const header = window.slice(0, productHeading.index);
    if (!/\bIn millions\b/i.test(header)) continue;
    const years = [...header.matchAll(/\b20\d{2}\b/g)].map((year) => Number(year[0]));
    const quarterly = /\bThree Months Ended\b/i.test(header) &&
      ((years.length === 2 && years[0] > years[1]) ||
        (years.length === 4 && /\b(?:Six|Nine) Months Ended\b/i.test(header) &&
          years[0] > years[1] && years[0] === years[2] && years[1] === years[3]));
    const annual = /\bYear Ended\b/i.test(header) &&
      years.length >= 3 && years[0] > years[1] && years[1] > years[2] &&
      (years.length === 3 || /\$\s*Change/i.test(header));
    if (!quarterly && !annual) continue;

    const body = window.slice(productHeading.index);
    const end = /\bTotal revenues\s+\$?\s*([\d,]+(?:\.\d+)?)/i.exec(body);
    if (!end || end.index > 3_000) continue;
    const table = body.slice(0, end.index + end[0].length);
    const product = /\bTotal net product sales\s+\$?\s*([\d,]+(?:\.\d+)?)/i.exec(table);
    const collaboration = /\bCollaboration revenue:\s*/i.exec(table);
    if (!product || !collaboration || product.index >= collaboration.index) continue;

    const parts = [
      { label: "Total net product sales", name: "Own product sales", search: table.slice(0, collaboration.index) },
      { label: "Sanofi", name: "Sanofi collaboration", search: table.slice(collaboration.index) },
      { label: "Bayer", name: "Bayer collaboration", search: table.slice(collaboration.index) },
      { label: "Other", name: "Other collaboration", search: table.slice(collaboration.index) },
      { label: "Other revenue", name: "Other revenue", search: table.slice(collaboration.index) },
    ];
    const rows: { name: string; amountM: number; excerpt: string; position: number }[] = [];
    for (const part of parts) {
      const row = new RegExp(`\\b${part.label}\\s+\\$?\\s*([\\d,]+(?:\\.\\d+)?)\\b`, "i").exec(part.search);
      if (!row) break;
      const amountM = Number(row[1].replaceAll(",", ""));
      if (!Number.isFinite(amountM) || amountM < 0) break;
      rows.push({ name: part.name, amountM, excerpt: row[0],
        position: (part.label === "Total net product sales" ? 0 : collaboration.index) + row.index });
    }
    if (rows.length !== parts.length || rows.some((row, index) => index > 0 && row.position <= rows[index - 1].position)) continue;
    const totalM = Number(end[1].replaceAll(",", ""));
    if (!Number.isFinite(totalM) || totalM <= 0 ||
      Math.abs(rows.reduce((sum, row) => sum + row.amountM, 0) - totalM) > 0.051) continue;

    const context = header.slice(0, 280);
    candidates.push({
      kind: "revenue_line",
      businesses: rows.map((row) => ({
        name: row.name,
        revenueB: row.amountM / 1_000,
        sourceExcerpt: `${context} ${row.excerpt}; ${end[0]}`.slice(0, 700),
      })),
    });
  }

  const fingerprints = new Set(candidates.map((candidate) =>
    JSON.stringify(candidate.businesses.map(({ name, revenueB }) => [name, revenueB]))));
  return fingerprints.size === 1 ? candidates.slice(0, 1) : [];
};
