import type { BusinessExtractor } from "./types";

const number = (value: string) => Number(value.replaceAll(",", ""));

/** Intel's Foundry segment mostly sells to Intel Products. Only its disclosed
 * external revenue can be combined with CCPG/CCG and DCAI without double count. */
export const extractBusinessCandidates: BusinessExtractor = (filingText) => {
  const text = filingText.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  const tableIntro = /Net revenue, cost of sales and operating expenses and operating income \(loss\) for each (?:annual )?period presented were as follows:|Net revenue, cost of sales and operating expenses and operating income \(loss\) for each period were as follows:/gi;

  for (const intro of text.matchAll(tableIntro)) {
    const table = text.slice(intro.index!, intro.index! + 3_000);
    const period = /\b(Three Months Ended|Year Ended)\s*\(In Millions\)\s*([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\b/i.exec(table);
    if (!period) continue;

    const header = /\b(CCPG|CCG)\s+DCAI\s+Total Intel Products\s+Intel Foundry\s+All Other\s+Corporate Unallocated\s+Intersegment Eliminations\s+Total Consolidated\b/i.exec(table.slice(period.index + period[0].length));
    if (!header) continue;
    const afterHeader = table.slice(period.index + period[0].length + header.index + header[0].length);
    const row = /^\s*Revenue\s+(.{1,220}?)\s+Cost of sales and operating expenses\b/i.exec(afterHeader);
    if (!row) continue;

    // SEC inline XBRL leaves numeric HTML entities and spaces inside negative
    // parentheses after the caller strips tags (for example "&#8212;" and "( 5,477 )").
    const normalizedRow = row[1]
      .replace(/&#(?:8212|x2014);/gi, "—")
      .replace(/&#(?:8211|x2013);/gi, "–")
      .replace(/\(\s*([\d,]+)\s*\)/g, "($1)");
    const cells = normalizedRow.replace(/\$/g, " ").trim().split(/\s+/);
    if (cells.length !== 8 || cells.some((cell) => !/^(?:\d{1,3}(?:,\d{3})*|\d+|[—–-]|\([\d,]+\))$/.test(cell))) continue;
    const [client, dcai, products, foundry, other, corporate, eliminations, consolidated] = cells.map((cell) =>
      /^\([\d,]+\)$/.test(cell) ? -number(cell.slice(1, -1)) : /^[—–-]$/.test(cell) ? 0 : number(cell),
    );
    if (![client, dcai, products, foundry, other, consolidated].every((value) => Number.isSafeInteger(value) && value > 0)) continue;
    if (client + dcai !== products || corporate !== 0 || eliminations >= 0 || products + foundry + other + eliminations !== consolidated) continue;

    const year = period[4];
    const day = period[3];
    const foundryDisclosure = /Intel Foundry also includes certain third-party foundry and assembly and test revenues from external customers that totaled\s*\$?\s*([\d,]+)\s+million\s+in\s+(?:the\s+three months ended\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})|([12]\d{3}))/gi;
    let externalFoundry: number | null = null;
    let foundryExcerpt = "";
    for (const disclosure of text.matchAll(foundryDisclosure)) {
      const samePeriod = period[1].toLowerCase().startsWith("year")
        ? disclosure[5] === year
        : disclosure[4] === year && disclosure[3] === day && disclosure[2]?.slice(0, 3).toLowerCase() === period[2].toLowerCase();
      if (!samePeriod) continue;
      externalFoundry = number(disclosure[1]);
      foundryExcerpt = disclosure[0];
      break;
    }
    if (externalFoundry === null || !Number.isSafeInteger(externalFoundry) || externalFoundry <= 0 || externalFoundry > foundry) continue;

    // The All Other segment can also contain intersegment sales. Its external
    // amount is the remaining consolidated revenue, not its gross segment row.
    const externalOther = consolidated - products - externalFoundry;
    const internalFoundry = foundry - externalFoundry;
    const internalOther = other - externalOther;
    if (externalOther <= 0 || internalOther < 0 || internalFoundry + internalOther !== -eliminations) continue;

    const tableExcerpt = `${period[0]} ${header[0]} Revenue ${normalizedRow.trim()}`.slice(0, 650);
    const business = (name: string, revenueM: number, sourceExcerpt: string) => ({ name, revenueB: revenueM / 1_000, sourceExcerpt });
    return [{
      kind: "revenue_line",
      businesses: [
        business(header[1].toUpperCase() === "CCPG" ? "Client Computing and Physical AI Group" : "Client Computing Group", client, tableExcerpt),
        business("Data Center and AI", dcai, tableExcerpt),
        business("Intel Foundry (external customers)", externalFoundry, foundryExcerpt),
        {
          ...business(
            "All Other (external customers, derived)",
            externalOther,
            `Derived (USD millions): ${consolidated.toLocaleString("en-US")} consolidated - ${products.toLocaleString("en-US")} Intel Products - ${externalFoundry.toLocaleString("en-US")} Intel Foundry external = ${externalOther.toLocaleString("en-US")} All Other external. ${tableExcerpt} ${foundryExcerpt}`.slice(0, 900),
          ),
          basis: "derived" as const,
        },
      ],
    }];
  }

  return [];
};
