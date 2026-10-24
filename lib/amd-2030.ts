/**
 * AMD 2030 working case for the public research page. The Q2 2026 revenue,
 * cash, debt and diluted-share anchors are reported facts; every 2030 driver,
 * cash margin and valuation rate below is an analyst assumption. This scenario
 * is separate from the site's published valuation snapshot.
 */
export const AMD_2030_AS_OF = "2026-09-24";
export const AMD_Q2_2026_FILING = "https://ir.amd.com/financial-information/sec-filings/content/0000002488-26-000123/amd-20260627.htm";
export const AMD_2025_ANALYST_DAY = "https://ir.amd.com/news-events/press-releases/detail/1266/amd-unveils-strategy-to-lead-the-1-trillion-compute-market-and-accelerate-next-phase-of-growth";

export const AMD_2030_ASSUMPTIONS = {
  acceleratorEquivalentUnitsM: 2,
  acceleratorRevenuePerUnitUsd: 60_000,
  dataCenterOtherRevenueB: 30,
  wacc: 0.105,
  terminalGrowth: 0.035,
  exitEvFcfMultiple: 20,
  end2030SharesB: 1.8,
  annualReturnHurdle: 0.1,
} as const;

const reported = {
  netCashB: 13.111 - 3.226,
  dilutedSharesB: 1.659,
  maximumCustomerWarrantsB: 0.32,
} as const;

const businessCases = [
  { id: "data-center", name: "Data Center", q2RevenueB: 6.718, targetRevenueB: 0, startingFcffMargin: 0.20, terminalFcffMargin: 0.38, driver: "Instinct-equivalent volume × realized revenue + EPYC / networking / other" },
  { id: "client", name: "Client", q2RevenueB: 3.062, targetRevenueB: 20, startingFcffMargin: 0.16, terminalFcffMargin: 0.20, driver: "Ryzen shipment and mix assumptions; absolute CPU units not disclosed" },
  { id: "gaming", name: "Gaming", q2RevenueB: 0.779, targetRevenueB: 4, startingFcffMargin: 0.10, terminalFcffMargin: 0.12, driver: "Semi-custom cycle and Radeon mix assumptions" },
  { id: "embedded", name: "Embedded", q2RevenueB: 0.977, targetRevenueB: 8, startingFcffMargin: 0.20, terminalFcffMargin: 0.25, driver: "Adaptive/embedded design-win conversion assumptions" },
] as const;

export function computeAmd2030Case(currentPrice: number | null) {
  const a = AMD_2030_ASSUMPTIONS;
  const acceleratorRevenueB = a.acceleratorEquivalentUnitsM * a.acceleratorRevenuePerUnitUsd / 1000;
  const rows = businessCases.map((business) => {
    const annualizedQ2RevenueB = business.q2RevenueB * 4;
    const revenue2030B = business.id === "data-center" ? acceleratorRevenueB + a.dataCenterOtherRevenueB : business.targetRevenueB;
    const path = [1, 2, 3, 4].map((year) => {
      const revenueB = annualizedQ2RevenueB * (revenue2030B / annualizedQ2RevenueB) ** (year / 4);
      const fcffMargin = business.startingFcffMargin + (business.terminalFcffMargin - business.startingFcffMargin) * year / 4;
      return { year: 2026 + year, revenueB, fcffB: revenueB * fcffMargin };
    });
    const interimValueB = path.reduce((sum, item, index) => sum + item.fcffB / (1 + a.wacc) ** (index + 1), 0);
    const terminalValueB = path[3].fcffB * (1 + a.terminalGrowth) / (a.wacc - a.terminalGrowth) / (1 + a.wacc) ** 4;
    const presentValueB = interimValueB + terminalValueB;
    return {
      ...business,
      annualizedQ2RevenueB,
      revenue2030B,
      fcff2030B: path[3].fcffB,
      path,
      interimValueB,
      terminalValueB,
      presentValueB,
      perShareUsd: presentValueB / reported.dilutedSharesB,
    };
  });
  const revenue2030B = rows.reduce((sum, row) => sum + row.revenue2030B, 0);
  const fcff2030B = rows.reduce((sum, row) => sum + row.fcff2030B, 0);
  const enterpriseValueNowB = rows.reduce((sum, row) => sum + row.presentValueB, 0);
  const equityValueNowB = enterpriseValueNowB + reported.netCashB;
  const fairValueNowUsd = equityValueNowB / reported.dilutedSharesB;
  const fullWarrantFairValueUsd = equityValueNowB / (reported.dilutedSharesB + reported.maximumCustomerWarrantsB);
  const end2030PriceUsd = (fcff2030B * a.exitEvFcfMultiple + reported.netCashB) / a.end2030SharesB;
  const exitPrices = [15, 20, 25, 30].map((multiple) => ({ multiple, priceUsd: (fcff2030B * multiple + reported.netCashB) / a.end2030SharesB }));
  const yearsTo2030 = 4.25;
  const hurdlePriceUsd = currentPrice === null ? null : currentPrice * (1 + a.annualReturnHurdle) ** yearsTo2030;
  const hurdleMultiple = hurdlePriceUsd === null ? null : (hurdlePriceUsd * a.end2030SharesB - reported.netCashB) / fcff2030B;
  return {
    rows,
    reported,
    acceleratorRevenueB,
    revenue2030B,
    fcff2030B,
    enterpriseValueNowB,
    equityValueNowB,
    fairValueNowUsd,
    fullWarrantFairValueUsd,
    end2030PriceUsd,
    exitPrices,
    hurdlePriceUsd,
    hurdleMultiple,
  };
}
