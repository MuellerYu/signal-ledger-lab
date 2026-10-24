const SYMBOLS = new Set(["SOXL", "SPCX", "TSLA", "AMD"]);
import type { OptionChain } from "./options-screen";
export function ibkrNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/g, "");
  const match = /^(-?\d+(?:\.\d+)?)([KM])?%?$/.exec(text);
  if (!match) return null;
  const result = Number(match[1]) * (match[2] === "K" ? 1000 : match[2] === "M" ? 1000000 : 1);
  return Number.isFinite(result) ? result : null;
}
export function normalizeIbkrChain(data: Record<string, unknown>, symbol: string, right: string, now = Date.now()): OptionChain {
  if (data.symbol !== symbol || !SYMBOLS.has(symbol) || !["P", "C"].includes(right) || !Array.isArray(data.contracts) || !Array.isArray(data.snapshots) || data.contracts.length > 48) throw new Error("Invalid chain");
  const snapshots = data.snapshots as Record<string, unknown>[];
  const stock = snapshots.find(r => Number(r.conid) === Number(data.underlyingId));
  const spot = ibkrNumber(stock?.["31"]);
  if (!spot || spot <= 0) throw new Error("Underlying quote is warming up");
  const stamp = ibkrNumber(stock?._updated);
  const valid = stamp !== null && stamp > now - 30 * 86400000 && stamp <= now + 5000;
  const mode = String(stock?.["6509"] || "").charAt(0);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const contracts = data.contracts.map((item: Record<string, unknown>) => {
    if (item.symbol !== symbol || item.right !== right || !(Number(item.strike) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.expiry))) throw new Error("Unverified option");
    const conid = Number(item.conid), expiry = String(item.expiry);
    const dte = Math.round((Date.parse(expiry) - Date.parse(today)) / 86400000);
    if (!Number.isSafeInteger(conid) || conid <= 0 || dte < 7 || dte > 14) throw new Error("Invalid option horizon");
    const raw = snapshots.find(r => Number(r.conid) === conid) || { conid };
    return { ...normalizeIbkrQuote({ symbol, conid, secType: "OPT", currency: "USD", multiplier: 100 }, raw, conid, symbol, now), symbol, right: right as "P" | "C", strike: Number(item.strike), expiry, dte };
  });
  return { symbol, companyName: String(data.companyName || symbol).slice(0, 100), spot, spotUpdatedAt: valid ? new Date(stamp!).toISOString() : null, spotAvailability: mode === "R" ? "Real-time entitlement" : "Delayed, frozen or unverified", spotFresh: mode === "R" && valid && now - stamp! <= 60000, receivedAt: new Date(now).toISOString(), contracts, scope: String(data.scope || "Bounded chain").slice(0, 350) };
}
export function normalizeIbkrQuote(info: Record<string, unknown>, raw: Record<string, unknown>, conid: number, symbol: string, now = Date.now()) {
  if (!SYMBOLS.has(symbol) || (info.symbol ?? info.ticker) !== symbol ||
      (info.instrument_type ?? info.secType) !== "OPT" || info.currency !== "USD" ||
      Number(info.multiplier) !== 100 || Number(info.con_id ?? info.conid) !== conid ||
      Number(raw.conid) !== conid) throw new Error("Contract identity or standard USD multiplier could not be verified.");
  const bid = ibkrNumber(raw["84"]), ask = ibkrNumber(raw["86"]);
  const stamp = ibkrNumber(raw._updated);
  const validStamp = stamp !== null && stamp > 1e12 && stamp <= now + 5000 && stamp > now - 30 * 86400000;
  const codes: Record<string, string> = { R: "Real-time entitlement", D: "Delayed", Z: "Frozen", Y: "Frozen delayed", N: "Not subscribed", i: "Incomplete" };
  const mode = String(raw["6509"] ?? "").charAt(0);
  const fresh = validStamp && now - stamp! <= 60000;
  const availability = `${codes[mode] || "Unknown entitlement"}${!fresh ? " · stale or unverified timestamp" : ""}`;
  return {
    conid, bid: bid !== null && bid >= 0 ? bid : null, ask: ask !== null && ask >= 0 ? ask : null,
    ivPercent: ibkrNumber(raw["7633"]), delta: ibkrNumber(raw["7308"]), volume: ibkrNumber(raw["87"]), openInterest: ibkrNumber(raw["7638"]),
    availability, updatedAt: validStamp ? new Date(stamp!).toISOString() : null,
    description: String(info.local_symbol ?? `${symbol} option ${conid}`).slice(0, 100),
    eligibleQuote: mode === "R" && fresh && bid !== null && ask !== null && bid > 0 && ask >= bid,
  };
}
