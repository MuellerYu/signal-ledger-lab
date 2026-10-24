import { publicOptionsProvider } from "@/lib/alpaca-options";
import { getCurrentEntitlement } from "@/lib/access";
import type { NormalizedOptionChain } from "@/lib/options-provider";

export const dynamic = "force-dynamic";

/**
 * FREE receives the basic chain (expiration, strike, bid, ask, volume, open
 * interest). IV and the Greeks are advanced analytics (PRO), so they are
 * stripped server-side — a free client never receives them, rather than having
 * them fetched and hidden. The payload now varies by entitlement, so it is not
 * edge-cacheable.
 */
function freeChain(chain: NormalizedOptionChain): NormalizedOptionChain {
  return {
    ...chain,
    contracts: chain.contracts.map((contract) => ({
      ...contract,
      iv: null,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
    })),
  };
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const ticker = String(query.get("ticker") ?? "").trim().toUpperCase();
  const requestedExpiration = String(query.get("expiration") ?? "").trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(ticker)) return Response.json({ error: "Enter a valid U.S. ticker." }, { status: 400 });
  try {
    const expirations = await publicOptionsProvider.getExpirations(ticker);
    const expiration = requestedExpiration || expirations.find((date) => {
      const dte = Math.ceil((Date.parse(`${date}T20:00:00Z`) - Date.now()) / 86_400_000);
      return dte >= 7 && dte <= 30;
    }) || expirations[0];
    if (!expiration || !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return Response.json({ error: "No listed expiration was returned for this symbol.", expirations }, { status: 404 });
    if (requestedExpiration && !expirations.includes(requestedExpiration)) return Response.json({ error: "The requested expiration is not listed.", expirations }, { status: 400 });
    const chain = await publicOptionsProvider.getChain(ticker, expiration);
    const entitlement = await getCurrentEntitlement();
    const projectedChain = entitlement.tier === "PRO" ? chain : freeChain(chain);
    return Response.json({
      schema: "signal-ledger.options-chain.v1",
      ...projectedChain,
      options_provider: chain.provider,
      options_data_age_ms: chain.cacheAgeMs,
      options_AI_used: false,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OPTIONS_PROVIDER_UNAVAILABLE";
    const configured = message !== "ALPACA_OPTIONS_NOT_CONFIGURED";
    return Response.json({ error: configured ? "Options data is temporarily unavailable." : "Alpaca options credentials are not configured on the server.", code: message }, { status: configured ? 503 : 424, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
}
