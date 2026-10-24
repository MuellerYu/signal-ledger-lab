/** Candidate rows parsed from a primary SEC filing. The caller verifies that
 * they match same-accession, same-period consolidated revenue before use. */
export type BusinessCandidate = {
  kind: "reportable_segment" | "revenue_line";
  businesses: { name: string; revenueB: number; sourceExcerpt: string; basis?: "reported" | "derived" }[];
};

export type BusinessExtractor = (filingText: string) => BusinessCandidate[];
