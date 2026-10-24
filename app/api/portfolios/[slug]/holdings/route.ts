import { isKnownPortfolio } from "@/lib/pick-ny";
import { getPortfolioHoldings } from "@/lib/pick-ny-store";
import { requirePro, upgradeRequired } from "@/lib/access";
import { noStoreJson, unavailable, unknownPortfolio } from "../../shared";

export const dynamic = "force-dynamic";

/** Latest session's positions: initial vs current weight, price, return, contribution. PRO-only. */
export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  if (!(await requirePro())) return upgradeRequired();

  const { slug } = await context.params;
  const key = slug.toLowerCase();
  if (!isKnownPortfolio(key)) return unknownPortfolio(key);

  const result = await getPortfolioHoldings(key);
  if (!result.ok) return unavailable(result);
  return noStoreJson({ schema: "signal-ledger.portfolio.v1", slug: key, holdings: result.value });
}
