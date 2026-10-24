import { isLaunchTicker } from "./launch-universe";
import type { ReportedBusinessEvidence } from "./valuation-data";

export type ForecastBusiness = {
  id: string;
  parentId: string | null;
  name: string;
  basis: "reported" | "derived" | "owner_split";
  baseRevenueB: number;
  driver: "growth" | "quantity_price";
  annualGrowth: number | null;
  quantityYearOne: number | null;
  unitPriceUsdYearOne: number | null;
  quantityGrowth: number | null;
  unitPriceGrowth: number | null;
  netMargin: number | null;
  pe: number | null;
  note: string;
};

export type OwnerForecastTree = {
  schemaVersion: 1;
  ticker: string;
  issuerName: string;
  source: { cik: string; accessionNumber: string; url: string; periodEnd: string; periodForm: "10-Q" | "10-K";
    consolidatedRevenueB: number; businessKind: "reportable_segment" | "revenue_line" };
  horizonYears: number;
  annualizationFactor: number;
  discountRate: number | null;
  dilutedSharesB: number | null;
  netCashB: number | null;
  businesses: ForecastBusiness[];
};

export type ForecastResult = {
  ready: boolean;
  issues: string[];
  rows: { id: string; name: string; revenueByYearB: number[]; earningsByYearB: number[]; terminalEquityB: number; presentValueB: number }[];
  presentValueB: number | null;
  perShareUsd: number | null;
  /** This is a terminal P/E scenario, not a full DCF or a decision-grade fair value. */
  method: "terminal_pe_scenario";
};

const within = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function sourceMatchesCik(url: unknown, cik: string) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/Archives\/edgar\/data\/(\d+)\//);
    return parsed.origin === "https://www.sec.gov" && Boolean(match) && Number(match![1]) === Number(cik);
  } catch { return false; }
}

export function seedOwnerForecastTree(ticker: string, issuerName: string, cik: string, evidence: ReportedBusinessEvidence, dilutedSharesB: number | null): OwnerForecastTree | null {
  if (!isLaunchTicker(ticker) || evidence.status !== "verified" || !evidence.sourceUrl || !evidence.accessionNumber ||
    !evidence.periodEnd || !evidence.periodForm || !evidence.kind || evidence.consolidatedRevenueB === null || !evidence.businesses.length) return null;
  return {
    schemaVersion: 1, ticker, issuerName,
    source: { cik, accessionNumber: evidence.accessionNumber, url: evidence.sourceUrl, periodEnd: evidence.periodEnd,
      periodForm: evidence.periodForm,
      consolidatedRevenueB: evidence.consolidatedRevenueB, businessKind: evidence.kind },
    horizonYears: 3, annualizationFactor: evidence.periodForm === "10-Q" ? 4 : 1,
    discountRate: null, dilutedSharesB: within(dilutedSharesB, 0.000001, 1000) ? dilutedSharesB : null,
    netCashB: null,
    businesses: evidence.businesses.map((row, index) => ({
      id: `business-${index + 1}`, parentId: null, name: row.name, basis: row.basis === "derived" ? "derived" : "reported", baseRevenueB: row.revenueB,
      driver: "growth", annualGrowth: null, quantityYearOne: null, unitPriceUsdYearOne: null,
      quantityGrowth: null, unitPriceGrowth: null, netMargin: null, pe: null, note: "",
    })),
  };
}

/** A forecast may split an SEC row into owner nodes, but may not rewrite the
 * reported parent revenue or relabel it as a different SEC business. */
export function matchesReportedBusinessAnchor(tree: OwnerForecastTree, cik: string, evidence: ReportedBusinessEvidence): boolean {
  if (evidence.status !== "verified" || tree.source.cik !== cik ||
    tree.source.accessionNumber !== evidence.accessionNumber || tree.source.url !== evidence.sourceUrl ||
    tree.source.periodEnd !== evidence.periodEnd || tree.source.periodForm !== evidence.periodForm ||
    tree.source.businessKind !== evidence.kind ||
    tree.source.consolidatedRevenueB !== evidence.consolidatedRevenueB) return false;
  const roots = tree.businesses.filter((node) => node.parentId === null);
  if (roots.length !== evidence.businesses.length) return false;
  return evidence.businesses.every((row) => roots.some((node) => node.name === row.name &&
    node.basis === (row.basis === "derived" ? "derived" : "reported") &&
    Math.abs(node.baseRevenueB - row.revenueB) < 0.0000001));
}

export function computeOwnerForecastTree(tree: OwnerForecastTree): ForecastResult {
  const issues: string[] = [];
  const fail = (): ForecastResult => ({ ready: false, issues: [...new Set(issues)], rows: [], presentValueB: null,
    perShareUsd: null, method: "terminal_pe_scenario" });
  if (tree?.schemaVersion !== 1 || !isLaunchTicker(tree.ticker) || !/^\d{10}$/.test(tree.source?.cik ?? "") ||
    !sourceMatchesCik(tree.source?.url, tree.source?.cik ?? "") ||
    !/^\d{10}-\d{2}-\d{6}$/.test(tree.source?.accessionNumber ?? "") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(tree.source?.periodEnd ?? "") ||
    !["10-Q", "10-K"].includes(tree.source?.periodForm ?? "") ||
    !within(tree.source.consolidatedRevenueB, 0.000001, 100_000)) issues.push("Verified SEC source metadata is required.");
  if (!Number.isInteger(tree?.horizonYears) || tree.horizonYears < 1 || tree.horizonYears > 5) issues.push("Forecast horizon must be 1–5 years.");
  if (!within(tree?.annualizationFactor, 0.1, 8)) issues.push("Set a quarterly-to-annual revenue factor from 0.1× to 8×.");
  if (!within(tree?.discountRate, 0, 0.5)) issues.push("Set a discount rate from 0% to 50%.");
  if (!within(tree?.dilutedSharesB, 0.000001, 1000)) issues.push("Set diluted shares in billions.");
  if (!within(tree?.netCashB, -100_000, 100_000)) issues.push("Set the current net cash or debt in billions, including zero if appropriate.");
  if (!Array.isArray(tree?.businesses) || !tree.businesses.length || tree.businesses.length > 40) issues.push("The tree needs 1–40 businesses.");
  if (issues.length) return fail();

  const nodes = new Map<string, ForecastBusiness>();
  for (const node of tree.businesses) {
    if (!node || typeof node !== "object" || typeof node.id !== "string" || typeof node.name !== "string") {
      issues.push("Business nodes must have a valid id and name."); continue;
    }
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(node.id) || nodes.has(node.id) || !node.name?.trim() || node.name.length > 120 ||
      !within(node.baseRevenueB, 0, 100_000) || !["reported", "derived", "owner_split"].includes(node.basis) ||
      !["growth", "quantity_price"].includes(node.driver)) issues.push(`Invalid business node: ${node?.name ?? "unnamed"}.`);
    nodes.set(node.id, node);
  }
  if (issues.length) return fail();
  for (const node of tree.businesses) {
    if (node.parentId && (!nodes.has(node.parentId) || node.parentId === node.id)) issues.push(`Invalid parent for ${node.name}.`);
    let cursor = node.parentId;
    const seen = new Set([node.id]);
    while (cursor) {
      if (seen.has(cursor)) { issues.push(`Business tree contains a cycle at ${node.name}.`); break; }
      seen.add(cursor);
      cursor = nodes.get(cursor)?.parentId ?? null;
    }
  }
  if (issues.length) return fail();
  const leaves = tree.businesses.filter((node) => !tree.businesses.some((child) => child.parentId === node.id));
  for (const parent of tree.businesses.filter((node) => tree.businesses.some((child) => child.parentId === node.id))) {
    const childSum = tree.businesses.filter((child) => child.parentId === parent.id).reduce((sum, child) => sum + child.baseRevenueB, 0);
    if (Math.abs(childSum - parent.baseRevenueB) > Math.max(0.001, parent.baseRevenueB * 0.01))
      issues.push(`${parent.name} children do not reconcile to its disclosed revenue.`);
  }
  const leafSum = leaves.reduce((sum, node) => sum + node.baseRevenueB, 0);
  if (Math.abs(leafSum - tree.source.consolidatedRevenueB) > Math.max(0.001, tree.source.consolidatedRevenueB * 0.01))
    issues.push("Leaf business revenue does not reconcile to SEC consolidated revenue.");

  const rows: ForecastResult["rows"] = [];
  for (const node of leaves) {
    if (!within(node.netMargin, 0, 1)) issues.push(`${node.name}: set a net earnings margin from 0% to 100%.`);
    if (!within(node.pe, 0.01, 1_000)) issues.push(`${node.name}: set a positive P/E multiple.`);
    if (node.driver === "growth" && !within(node.annualGrowth, -0.99, 5)) issues.push(`${node.name}: set annual revenue growth.`);
    if (node.driver === "quantity_price" && (!within(node.quantityYearOne, 0, 1e12) ||
      !within(node.unitPriceUsdYearOne, 0, 1e12) || !within(node.quantityGrowth, -0.99, 5) ||
      !within(node.unitPriceGrowth, -0.99, 5))) issues.push(`${node.name}: set annual quantity, unit price and their growth rates.`);
    if (issues.length) continue;
    const revenueByYearB = Array.from({ length: tree.horizonYears }, (_, year) => node.driver === "growth"
      ? node.baseRevenueB * tree.annualizationFactor * (1 + node.annualGrowth!) ** (year + 1)
      : node.quantityYearOne! * (1 + node.quantityGrowth!) ** year *
        node.unitPriceUsdYearOne! * (1 + node.unitPriceGrowth!) ** year / 1e9);
    const earningsByYearB = revenueByYearB.map((revenue) => revenue * node.netMargin!);
    const terminalEquityB = earningsByYearB.at(-1)! * node.pe!;
    const presentValueB = terminalEquityB / (1 + tree.discountRate!) ** tree.horizonYears;
    if (![...revenueByYearB, terminalEquityB, presentValueB].every(Number.isFinite)) {
      issues.push(`${node.name}: the forecast exceeds finite numeric bounds.`); continue;
    }
    rows.push({ id: node.id, name: node.name, revenueByYearB, earningsByYearB, terminalEquityB, presentValueB });
  }
  if (issues.length || rows.length !== leaves.length) return fail();
  const presentValueB = rows.reduce((sum, row) => sum + row.presentValueB, 0) + tree.netCashB!;
  return { ready: true, issues: [], rows, presentValueB, perShareUsd: presentValueB / tree.dilutedSharesB!,
    method: "terminal_pe_scenario" };
}
