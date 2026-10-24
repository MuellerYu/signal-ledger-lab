import type { BusinessExtractor } from "./types";

const amount = (value: string) => Number(value.replaceAll(",", ""));

/** Broadcom's MD&A presents the current quarter/year in the first amount
 * column of its Net Revenue by Segment table (USD millions). */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const candidates: ReturnType<BusinessExtractor> = [];
  const headings = filingText.matchAll(/\bNet Revenue by Segment\b/gi);

  for (const heading of headings) {
    const table = filingText.slice(heading.index, heading.index + 2_000);
    const semiconductor = /\bSemiconductor solutions\s+\$?\s*([\d,]+)\b/i.exec(table);
    const software = /\bInfrastructure software\s+\$?\s*([\d,]+)\b/i.exec(table);
    const total = /\bTotal net revenue\s+\$?\s*([\d,]+)\b/i.exec(table);
    if (!semiconductor || !software || !total) continue;

    const header = table.slice(0, semiconductor.index);
    if (!/\b(?:in millions|dollars in millions)\b/i.test(header)) continue;
    if (!(semiconductor.index < software.index && software.index < total.index)) continue;
    if (software.index - semiconductor.index > 650 || total.index - software.index > 650) continue;

    const semiconductorM = amount(semiconductor[1]);
    const softwareM = amount(software[1]);
    const totalM = amount(total[1]);
    if (![semiconductorM, softwareM, totalM].every((value) => Number.isSafeInteger(value) && value > 0)) continue;
    if (semiconductorM + softwareM !== totalM) continue;

    const context = header.slice(Math.max(0, header.length - 280));
    candidates.push({
      kind: "reportable_segment",
      businesses: [
        {
          name: "Semiconductor solutions",
          revenueB: semiconductorM / 1_000,
          sourceExcerpt: `${context} ${table.slice(semiconductor.index, software.index).trim()}`.slice(0, 700),
        },
        {
          name: "Infrastructure software",
          revenueB: softwareM / 1_000,
          sourceExcerpt: `${context} ${table.slice(software.index, total.index).trim()} ${total[0]}`.slice(0, 700),
        },
      ],
    });
  }

  return candidates;
};
