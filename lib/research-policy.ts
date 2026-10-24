// ResearchPolicy: the standing rules the planner and reviewer must obey. It is
// deliberately written as machine-readable principles plus a stable version hash,
// so a policy change invalidates every downstream research-plan and valuation
// cache layer without touching the market-state cache identity.
export type PolicyPrinciple = {
  name: string;
  criterion: string;
  appliesTo: "planner" | "reviewer" | "both";
};

export type ResearchPolicy = {
  id: string;
  version: string;
  principles: PolicyPrinciple[];
};

export const DEFAULT_RESEARCH_POLICY: ResearchPolicy = {
  id: "signal-ledger-research-v1",
  version: "2026-09-21.1",
  principles: [
    {
      name: "value_operating_capability",
      criterion: "Value the 3–5 year operating capability of the business from durable operating evidence, not from the current market price.",
      appliesTo: "both",
    },
    {
      name: "separate_current_vs_future",
      criterion: "Separate current operating value from future operating potential; do not credit an unbuilt future as if it were already realized.",
      appliesTo: "planner",
    },
    {
      name: "detect_cycles_and_ramps",
      criterion: "Detect technology cycles, capacity ramps, penetration curves, commercialization transitions and business-model changes, and encode them as explicit forecast stages and growth constraints.",
      appliesTo: "planner",
    },
    {
      name: "loss_making_not_zero",
      criterion: "A loss-making or new business must not be valued at zero for lacking current profit; value its mature economics plus the required investment, financing, dilution and failure probability.",
      appliesTo: "planner",
    },
    {
      name: "optionality_probability_weighted",
      criterion: "Optionality is allowed only as commercial scenarios that are probability-weighted, with capital, financing, dilution and a double-count check; never double-count the same economics.",
      appliesTo: "planner",
    },
    {
      name: "no_permanent_value_inflation",
      criterion: "Do not learn a permanent rule that raises valuation simply because a principal believes a stock should be worth more. Growth, margins and multiples must be anchored to evidence, not to a desired price.",
      appliesTo: "both",
    },
    {
      name: "price_blind",
      criterion: "The planner and reviewer never receive or consider the current market price, any published fair value, or any analyst target. They reason from operating and research evidence only.",
      appliesTo: "both",
    },
    {
      name: "evidence_only_revisions",
      criterion: "The reviewer requests revisions only for evidence and consistency reasons; never because a value looks too low or too conservative.",
      appliesTo: "reviewer",
    },
  ],
};

export function policyVersion(policy: ResearchPolicy = DEFAULT_RESEARCH_POLICY): string {
  return policy.version;
}

/** A stable, deterministic hash of the policy (excludes timestamps). */
export function hashPolicy(policy: ResearchPolicy = DEFAULT_RESEARCH_POLICY): string {
  return fnv1a(JSON.stringify({ id: policy.id, version: policy.version, principles: policy.principles.map((p) => [p.name, p.criterion, p.appliesTo]) }));
}

/** FNV-1a 32-bit, kept local so research modules do not depend on issuer-intelligence. */
function fnv1a(input: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
