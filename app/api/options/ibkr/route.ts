import { getBindings } from "@/lib/runtime";
import { isAuthorizedMutation } from "@/lib/auth";
import { normalizeIbkrQuote, normalizeIbkrChain } from "@/lib/ibkr-quote";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Authorization, oai-authenticated-user-email" };
const reply = (message: string, status: number, extra = {}) => Response.json({ message, ...extra }, { status, headers });
// Shared in-flight request protection per isolate. No D1 reads, secrets or account payloads in browser caches.
let running: Promise<Response> | null = null;
let lastRead = 0;
export async function GET(request: Request) {
  if (!isAuthorizedMutation(request)) return reply("Verified owner authorization is required for brokerage data.", 401);
  const env = getBindings();
  if (!env.IBKR_BRIDGE_URL || !env.IBKR_BRIDGE_TOKEN) return reply("IBKR setup is pending: authorize the gateway and configure the private quote bridge. The calculator works without this connection.", 503);
  const query = new URL(request.url).searchParams;
  const conid = query.get("conid");
  const symbol = query.get("symbol") || "SOXL";
  const chain = query.get("mode") === "chain", right = query.get("right") || "P";
  if (chain && (!["SOXL", "SPCX", "TSLA", "AMD"].includes(symbol) || !["P", "C"].includes(right) || conid)) return reply("Invalid chain selection.", 400);
  if (conid && (!/^[1-9]\d{0,11}$/.test(conid) || !["SOXL", "SPCX", "TSLA", "AMD"].includes(symbol))) return reply("Choose a supported symbol and a valid IBKR option contract ID.", 400);
  if (running || Date.now() - lastRead < 10000) return reply("Please wait 10 seconds between broker requests.", 429);
  lastRead = Date.now();
  running = (async () => {
    try {
      const base = new URL(env.IBKR_BRIDGE_URL!);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid bridge configuration");
      const url = new URL(chain ? "/chain" : conid ? "/quote" : "/status", base.origin);
      if (conid) { url.searchParams.set("conid", conid); url.searchParams.set("symbol", symbol); }
      if (chain) { url.searchParams.set("symbol", symbol); url.searchParams.set("right", right); }
      const response = await fetch(url, { headers: { Authorization: `Bearer ${env.IBKR_BRIDGE_TOKEN}`, Accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(chain ? 55000 : 15000) });
      if (!response.ok) return reply(response.status === 401 ? "IBKR bridge authorization failed. Check server-side credentials." : "IBKR could not supply this contract. Check gateway login, market-data permissions and contract ID.", 502);
      const data = await response.json() as { authenticated?: boolean; info?: Record<string, unknown>; snapshot?: Record<string, unknown> };
      if (chain) return reply("IBKR chain received. Quote timestamps and eligibility are checked independently; a passing screen is not a low-risk recommendation.", 200, { chain: normalizeIbkrChain(data, symbol, right) });
      if (!conid) return reply(data.authenticated === true ? "IBKR gateway is authenticated. Read a specific option to verify quote entitlements." : "IBKR gateway requires login or reauthentication.", data.authenticated === true ? 200 : 503);
      if (!data.info || !data.snapshot) return reply("IBKR quote is still warming up or incomplete. Retry in 10 seconds.", 503);
      const quote = normalizeIbkrQuote(data.info, data.snapshot, Number(conid), symbol);
      return reply(quote.eligibleQuote ? "IBKR snapshot received. This is a quote, not a fill or a trade recommendation." : "Snapshot is delayed, frozen, incomplete or stale. Do not treat it as an executable real-time quote.", 200, { quote });
    } catch { return reply("The private IBKR quote service is unavailable or returned an unverified contract. No substitute prices were used.", 502); }
  })();
  try { return await running; } finally { running = null; }
}
