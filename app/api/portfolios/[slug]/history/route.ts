import { isKnownPortfolio } from "@/lib/pick-ny";
import { getPortfolioHistory } from "@/lib/pick-ny-store";
import { noStoreJson, unavailable, unknownPortfolio } from "../../shared";

export const dynamic = "force-dynamic";

const RANGES = new Set(["1M", "3M", "6M", "YTD", "SI"]);

/** Chart series only: date, NAV, benchmark NAV, drawdown. */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const key = slug.toLowerCase();
  if (!isKnownPortfolio(key)) return unknownPortfolio(key);

  const requested = (new URL(request.url).searchParams.get("range") ?? "SI").toUpperCase();
  const range = RANGES.has(requested) ? requested : "SI";

  const result = await getPortfolioHistory(key, range);
  if (!result.ok) return unavailable(result);
  return noStoreJson({ schema: "signal-ledger.portfolio.v1", slug: key, range, points: result.value });
}
