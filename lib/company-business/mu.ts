import type { BusinessExtractor } from "./types";

/**
 * Micron's four market-based business units are reportable segments. "All Other"
 * is disclosed in the same segment revenue table but is not a reportable segment.
 * Amounts in Micron's financial-statement tables are USD millions.
 */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  if (!/\b(?:all tabular (?:dollar )?amounts|consolidated statements of operations)[^]{0,120}?\b(?:in )?millions\b/i.test(text)) {
    return [];
  }

  const heading = /\b(?:Note\s+\d+\.\s*)?Segment and Other Information\b/gi;
  const columns = /\bCMBU\s+CDBU\s+MCBU\s+AEBU\s+All Other\s+Unallocated\s+Total\b/i;
  const labels = [
    "Cloud Memory Business Unit",
    "Core Data Center Business Unit",
    "Mobile and Client Business Unit",
    "Automotive and Embedded Business Unit",
    "All Other",
  ];

  for (const section of text.matchAll(heading)) {
    const sectionText = text.slice(section.index!, section.index! + 9_000);
    // The 10-Q and 10-K notes describe these four units explicitly as reportable
    // segments. This also avoids mistaking a different business-unit table for it.
    if (!/four business units[^.]{0,160}reportable segments/i.test(sectionText)) continue;
    const header = columns.exec(sectionText);
    if (!header) continue;

    const afterHeader = sectionText.slice(header.index + header[0].length);
    const row = /^\s*Revenue\s+(.{1,220}?)\s+Cost of goods sold\b/i.exec(afterHeader);
    if (!row) continue;

    const cells = row[1].replace(/\$/g, " ").replace(/&#8212;|&#8211;|&#x2014;|&#x2013;/gi, "—").trim().split(/\s+/);
    if (cells.length !== 7 || cells.some((cell) => !/^(?:\d{1,3}(?:,\d{3})*|\d+|[—–-])$/.test(cell))) continue;
    const amounts = cells.map((cell) => /^[—–-]$/.test(cell) ? 0 : Number(cell.replace(/,/g, "")));
    const [cloud, core, mobile, automotive, other, unallocated, total] = amounts;
    if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) continue;
    if (unallocated !== 0 || total <= 0 || cloud + core + mobile + automotive + other !== total) continue;

    const excerpt = `${header[0]} Revenue ${row[1].trim()}`;
    const reportable = [cloud, core, mobile, automotive].map((amount, index) => ({
      name: labels[index], revenueB: amount / 1_000, sourceExcerpt: excerpt,
    }));
    const reconciled = [
      ...reportable,
      { name: labels[4], revenueB: other / 1_000, sourceExcerpt: excerpt },
    ];

    return [
      { kind: "revenue_line", businesses: reconciled },
      { kind: "reportable_segment", businesses: reportable },
    ];
  }

  return [];
};
