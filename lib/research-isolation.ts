/** Shared request, response and stored-plan contract. Unknown check provenance
 * is deliberately not equivalent to operating evidence. */
export type CheckProvenance = "operating" | "market" | "mixed";

export const RESEARCH_ISOLATION_VERSION = "p0-r11-draft-sparse-v1";

/** Normalize compound fields, while keeping word boundaries for `rating` so
 * operatingIncome/operatingMargin cannot be mistaken for investment ratings. */
export function isMarketField(key: string, unitPrice = false): boolean {
  const words = key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const compact = words.join("");
  if (compact === "price") return !unitPrice;
  return /fairvalue|currentprice|marketprice|referenceprice|targetprice|pricetarget|stockprice|shareprice|lastprice|analysttarget|consensus|sanityrange|legacyprior|expectedreturn|upside|downside/.test(compact)
    || words.some((word) => ["fv", "quote", "quotes", "rating"].includes(word))
    || /^(?:preliminary|estimated|current|market|analyst|consensus|model)?(?:fv|quote|rating)(?:usd|low|high|now|12m|pct|label|enum|value|price)?$/.test(compact);
}

function walk(value: unknown, path: string, unitPrice: boolean, rejected: string[], text: (s: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`, false, rejected, text));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).flatMap(([key, child]) => {
      const childPath = `${path}.${key}`;
      if (isMarketField(key, unitPrice)) { rejected.push(childPath); return []; }
      // A declared economic driver is the only context in which bare `price`
      // means an operating unit price, rather than ambiguous market metadata.
      const priceParam = key === "params" && ["volume_x_price", "capacity_x_utilization_x_price"].includes(String(object.formula));
      return [[key, walk(child, childPath, priceParam, rejected, text)]];
    }));
  }
  return typeof value === "string" ? text(value) : value;
}

export function marketFieldPaths(value: unknown): string[] {
  const rejected: string[] = [];
  walk(value, "$", false, rejected, (s) => s);
  return rejected;
}

export function projectResearchFields(value: unknown, text: (s: string) => string): unknown {
  return walk(value, "$", false, [], text);
}
