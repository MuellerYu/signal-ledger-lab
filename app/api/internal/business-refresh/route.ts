import { getBindings } from "@/lib/runtime";
import { LAUNCH_TICKERS } from "@/lib/launch-universe";
import { isLaunchTicker } from "@/lib/launch-universe";
import { isLocalOwnerPreviewRequest } from "@/lib/local-owner-preview";
import { latestPeriodicAccession, loadSecEvidence } from "@/lib/valuation-data";
import { getInvestmentSnapshot } from "@/lib/investment-snapshot";
import { ensureOwnerForecastTables, loadCompanyBusinessEvidence, ownerForecastDb, saveCompanyBusinessEvidence } from "@/lib/owner-forecast-store";

export const dynamic = "force-dynamic";

/** The monitor Worker calls this every 15 minutes. Four issuers per run covers
 * the launch queue in 75 minutes without making public page views fetch SEC. */
export async function POST(request: Request) {
  const secret = getBindings().CRON_SECRET?.trim();
  const localPreview = isLocalOwnerPreviewRequest(request) && request.headers.get("origin") === new URL(request.url).origin;
  if (!localPreview && (!secret || request.headers.get("authorization") !== `Bearer ${secret}`))
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  const db = ownerForecastDb();
  if (!db) return Response.json({ error: "Research database unavailable." }, { status: 503 });
  await ensureOwnerForecastTables(db);
  const slot = Math.floor(Date.now() / 900_000);
  const start = (slot % 5) * 4;
  const requested = new URL(request.url).searchParams.get("ticker")?.toUpperCase();
  const tickers = localPreview && requested && isLaunchTicker(requested) ? [requested] : LAUNCH_TICKERS.slice(start, start + 4);
  const results: { ticker: string; status: string; accessionNumber?: string }[] = [];
  for (const ticker of tickers) {
    try {
      const previous = await loadCompanyBusinessEvidence(ticker);
      if (!localPreview && previous && Date.now() - previous.fetchedAt < 12 * 60 * 60 * 1_000) {
        const accession = await latestPeriodicAccession(previous.cik);
        if (accession && accession === previous.evidence.accessionNumber) {
          results.push({ ticker, status: "current", accessionNumber: accession });
          continue;
        }
      }
      const next = await loadSecEvidence(ticker);
      await saveCompanyBusinessEvidence(db, ticker, next.cik, next.entityName ?? ticker, next.reportedBusinesses);
      results.push({ ticker, status: next.reportedBusinesses.status,
        accessionNumber: next.reportedBusinesses.accessionNumber ?? undefined });
      if (localPreview) await getInvestmentSnapshot(ticker).catch(() => null);
    } catch (error) {
      console.error("[business-refresh]", ticker, error instanceof Error ? error.message : "unknown error");
      results.push({ ticker, status: "fetch_failed" });
    }
  }
  return Response.json({ results }, { headers: { "Cache-Control": "private, no-store" } });
}
