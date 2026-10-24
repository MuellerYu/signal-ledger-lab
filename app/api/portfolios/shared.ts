import { PORTFOLIO_SCHEMA, getPortfolioSummary, type PortfolioResult } from "@/lib/pick-ny-store";
import { isKnownPortfolio } from "@/lib/pick-ny";

export const dynamic = "force-dynamic";

export function noStoreJson(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export function unknownPortfolio(slug: string) {
  return noStoreJson({ schema: PORTFOLIO_SCHEMA, status: "unknown_portfolio", slug, error: `No published portfolio has the slug "${slug}".` }, 404);
}

export function unavailable(result: Extract<PortfolioResult<unknown>, { ok: false }>, status = 503) {
  return noStoreJson({ schema: PORTFOLIO_SCHEMA, status: "unavailable", code: result.code, error: result.error }, status);
}

/** The summary endpoint backs both the picks page and the homepage module. */
export async function summaryFor(slug: string) {
  if (!isKnownPortfolio(slug)) return { response: unknownPortfolio(slug) };
  const result = await getPortfolioSummary(slug);
  if (!result.ok) return { response: unavailable(result) };
  return { response: noStoreJson({ ...result.value, generatedAt: new Date().toISOString() }) };
}
