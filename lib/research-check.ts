// Deterministic research consistency checks. These run AFTER the valuation so the
// reviewer can request evidence-based revisions, but they are deliberately
// price-blind: no fair value, current price, scenario price output, upside/downside,
// rating or market comparison ever appears here. The reviewer only sees the checks
// that survive `sanitizeChecksForReviewer`.
import type { AutomatedValuationPack } from "./valuation-data";
import type { UniversalValuationOutput } from "./universal-valuation";
import type { ResearchCheck } from "./research-firewall";
import type { ResearchPlan } from "./research-plan";
import type { CompiledResearchProfile } from "./research-compiler";

function refs(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function runResearchChecks(
  pack: AutomatedValuationPack,
  plan: ResearchPlan,
  compiled: CompiledResearchProfile,
  _output: UniversalValuationOutput,
): ResearchCheck[] {
  const checks: ResearchCheck[] = [];
  const evidence = pack.evidenceAssumptions;

  // 1. Every business is valued off a real operating or disclosed value.
  for (const business of plan.businesses) {
    const segment = compiled.segments.find((item) => item.name === business.name);
    const metricValue = segment?.metricValueB ?? 0;
    const optionality = business.stage === "optionality";
    checks.push({
      id: `unit-metric-${business.id}`,
      label: `Operating basis for ${business.name}`,
      status: metricValue > 0 ? "passed" : optionality ? "warning" : "failed",
      detail: metricValue > 0
        ? `${business.name} valued from a ${segment?.metric ?? "revenue"} basis of $${metricValue.toFixed(2)}B.`
        : optionality
          ? `${business.name} is optionality with no realized operating base; value must come from a probability-weighted disclosed NPV, not a revenue multiple.`
          : `${business.name} has no operating base: its metric value is ${metricValue}.`,
      evidenceRefs: refs(business.disclosedData.map((item) => item.evidenceId).filter(Boolean)[0]),
    });
  }

  // 2. Forecast periods are ordered and start at the base year.
  for (const business of plan.businesses) {
    const years = business.forecastYears.map((item) => item.year);
    const ordered = years.every((year, index) => index === 0 || year > years[index - 1]);
    checks.push({
      id: `period-order-${business.id}`,
      label: `Forecast period order for ${business.name}`,
      status: ordered ? "passed" : "failed",
      detail: ordered ? `${business.name} forecast years are strictly increasing.` : `${business.name} forecast years are out of order: ${years.join(", ")}.`,
      evidenceRefs: [],
    });
  }

  // 3. Dilution is non-negative and bounded relative to the base share count.
  const baseSharesB = evidence.dilutedSharesB ?? 0;
  const dilutionSharesB = plan.dilution.reduce((sum, item) => sum + item.sharesB, 0);
  checks.push({
    id: "dilution-basis",
    label: "Dilution share-count basis",
    status: dilutionSharesB < 0 ? "failed" : baseSharesB > 0 && dilutionSharesB > baseSharesB ? "warning" : "passed",
    detail: dilutionSharesB < 0
      ? "Dilution is negative, which is not a valid share-count basis."
      : `${dilutionSharesB.toFixed(2)}B shares of dilution on a ${baseSharesB.toFixed(2)}B base${dilutionSharesB > baseSharesB ? " (dilution exceeds the base; review the share basis)" : ""}.`,
    evidenceRefs: refs(...plan.dilution.map((item) => item.evidenceId)),
  });

  // 4. Financing cost is a rate in [0, 1] and each item carries evidence.
  const invalidFinancing = plan.financing.filter((item) => item.costPct !== undefined && (item.costPct < 0 || item.costPct > 1));
  checks.push({
    id: "financing-cost-basis",
    label: "Financing cost basis",
    status: invalidFinancing.length ? "failed" : "passed",
    detail: invalidFinancing.length
      ? `${invalidFinancing.length} financing item(s) carry a cost outside [0, 1].`
      : "All financing costs are expressed as rates in [0, 1].",
    evidenceRefs: refs(...plan.financing.map((item) => item.evidenceId)),
  });

  // 5. Profit vs cash-flow basis: a profit-multiple segment must not silently use a
  //    levered cash-flow stream as if it were an unlevered profit metric.
  const basisMismatch = plan.businesses.filter((business) =>
    ["ev_ebitda", "forward_pe"].includes(business.valuationMethod)
    && (evidence.cashFlowBasis === "cfo_capex_proxy" || evidence.cashFlowBasis === "fcfe_equity")
    && business.disclosedData.every((item) => !/ebitda|operating income|ebit/i.test(item.label)),
  );
  checks.push({
    id: "profit-vs-cashflow-basis",
    label: "Profit vs cash-flow basis",
    status: basisMismatch.length ? "warning" : "passed",
    detail: basisMismatch.length
      ? `${basisMismatch.map((business) => business.name).join(", ")} value(s) on a profit multiple while only a levered cash-flow basis is evidenced; the basis must be stated, not conflated.`
      : "Profit-multiple segments are anchored to a profit metric, and cash-flow segments to a cash-flow basis.",
    evidenceRefs: [],
  });

  // 6. Segment overlap: a business that overlaps another must not double-count the
  //    same disclosed revenue.
  const overlapping = plan.businesses.filter((business) => business.overlaps.length > 0);
  checks.push({
    id: "segment-overlap",
    label: "Segment overlap / duplication",
    status: overlapping.length ? "failed" : "passed",
    detail: overlapping.length
      ? `${overlapping.map((business) => `${business.name}→[${business.overlaps.join(", ")}]`).join("; ")} declare overlaps; the same economics must not be counted twice.`
      : "No business declares an overlap with another; no disclosed revenue is double-counted.",
    evidenceRefs: [],
  });

  // 7. Aggregation rule does not double-count the terminal value.
  const terminalDoubleCount = plan.aggregationRule === "sotp" && compiled.profile.modelApplicability?.sotp !== 1;
  checks.push({
    id: "terminal-overlap",
    label: "Terminal value double-count",
    status: terminalDoubleCount ? "failed" : "passed",
    detail: terminalDoubleCount
      ? "A company-level DCF terminal value is mixed with a segment SOTP; the terminal value must belong to one segment or the company, not both."
      : "Terminal value is attributed once (segment-level SOTP or a single company model).",
    evidenceRefs: [],
  });

  // 8. Funding gap: committed capital must be coverable by financing plus internal cash.
  const capexTotal = plan.capitalRequirements.reduce((sum, item) => sum + (item.kind === "capex" ? item.amountB : 0), 0);
  const equityFinancingB = plan.financing.reduce((sum, item) => sum + (item.kind === "equity" ? item.amountB : 0), 0);
  const debtFinancingB = plan.financing.reduce((sum, item) => sum + (item.kind === "debt" || item.kind === "hybrid" ? item.amountB : 0), 0);
  const internalCash = Math.max(0, evidence.netCashB ?? 0);
  const gap = capexTotal - (equityFinancingB + debtFinancingB + internalCash);
  checks.push({
    id: "funding-gap",
    label: "Capital funding gap",
    status: gap > 0.01 ? "warning" : "passed",
    detail: gap > 0.01
      ? `Committed capital $${capexTotal.toFixed(2)}B exceeds financing ($${(equityFinancingB + debtFinancingB).toFixed(2)}B) plus internal cash ($${internalCash.toFixed(2)}B) by $${gap.toFixed(2)}B.`
      : `Committed capital $${capexTotal.toFixed(2)}B is covered by financing and internal cash.`,
    evidenceRefs: refs(...plan.capitalRequirements.map((item) => item.evidenceId), ...plan.financing.map((item) => item.evidenceId)),
  });

  // 9. Scenario probabilities: company-level scenarios must not exceed 1 in aggregate.
  const companyScenarios = plan.scenarios.filter((scenario) => scenario.appliesTo === "company");
  const companyProbability = companyScenarios.reduce((sum, scenario) => sum + scenario.probability, 0);
  checks.push({
    id: "scenario-probability-sum",
    label: "Company scenario probability sum",
    status: companyScenarios.length > 0 && Math.abs(companyProbability - 1) > 1e-8 ? "failed" : "passed",
    detail: companyScenarios.length > 0 && Math.abs(companyProbability - 1) > 1e-8
      ? `Company scenarios sum to ${companyProbability.toFixed(3)} ; exhaustive scenarios must sum to 1.`
      : `Company scenarios sum to ${companyProbability.toFixed(3)} (complete distribution when supplied).`,
    evidenceRefs: [],
  });

  // 10. Scenario exclusivity: two company scenarios must not cover the same business.
  const scenarioIds = companyScenarios.map((scenario) => scenario.id);
  const invalidCoverage = companyScenarios.some((scenario) =>
    plan.businesses.some((business) => !scenario.businessIds.includes(business.id)));
  const nonExclusive = new Set(scenarioIds).size !== scenarioIds.length || invalidCoverage;
  checks.push({
    id: "scenario-exclusivity", label: "Company scenario identity and coverage",
    status: nonExclusive ? "failed" : "passed",
    detail: nonExclusive ? "Company scenarios need unique state IDs and complete business coverage." : "Distinct company states may cover the same businesses.", evidenceRefs: [],
  });

  // 11. Probability double-count: a single uncertainty must be owned by a segment OR
  //     a scenario, never both.
  const segmentOwners = new Set(plan.scenarios.filter((scenario) => scenario.appliesTo === "segment").flatMap((scenario) => scenario.businessIds));
  const companyOwners = new Set(companyScenarios.flatMap((scenario) => scenario.businessIds));
  const doubleCounted = [...segmentOwners].filter((id) => companyOwners.has(id));
  checks.push({
    id: "probability-double-count",
    label: "Probability ownership (no double count)",
    status: doubleCounted.length ? "failed" : "passed",
    detail: doubleCounted.length
      ? `Businesses ${doubleCounted.join(", ")} have their success probability owned by BOTH a segment scenario and a company scenario; each uncertainty must be applied exactly once.`
      : "Every uncertainty's probability is owned by exactly one segment or one scenario.",
    evidenceRefs: [],
  });

  // The compiler validates supported contracts before evaluating them. Check the
  // resulting bridge, not the lengths of copied audit arrays; cash-flow consumption
  // is independently covered by hand-calculated sensitivity tests.
  const expectedCash = (evidence.netCashB ?? 0) + plan.financing.reduce((sum, item) => sum + item.amountB, 0);
  const expectedShares = (evidence.dilutedSharesB ?? 0) + dilutionSharesB;
  const bridgeMatches = Math.abs((compiled.profile.baseline.netCashB ?? 0) - expectedCash) < 1e-8
    && Math.abs((compiled.profile.baseline.dilutedSharesB ?? 0) - expectedShares) < 1e-8;
  checks.push({
    id: "compilation-completeness", label: "Compiled capital bridge",
    status: bridgeMatches ? "passed" : "failed",
    detail: bridgeMatches ? "Compiled cash and share balances reconcile to the supported financing/dilution contract; capital is deducted in forecast cash flows, not again in net cash." : "Compiled cash or share balances do not reconcile to the plan.",
    evidenceRefs: [],
  });

  return checks.map((check) => ({ ...check, provenance: "operating" }));
}
