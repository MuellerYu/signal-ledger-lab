const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const fields = "31,84,86,87,6509,7308,7633,7638";
const number = v => typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.replaceAll(",", "")) ? Number(v.replaceAll(",", "")) : null;
const dateET = now => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
export function validOptionContract(row, symbol, right, today) {
  const expiry = String(row.maturityDate || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const dte = Math.round((Date.parse(expiry) - Date.parse(today)) / 86400000);
  if ((row.symbol ?? row.ticker) !== symbol || row.secType !== "OPT" || row.right !== right || row.currency !== "USD" || Number(row.multiplier) !== 100 || row.tradingClass !== symbol || !Number.isFinite(dte) || dte < 7 || dte > 14 || !(Number(row.strike) > 0) || !Number.isSafeInteger(Number(row.conid))) return null;
  return { conid: Number(row.conid), symbol, right, strike: Number(row.strike), expiry, dte };
}
/** Read-only bounded chain discovery. Injected gateway serializes/paces requests. */
export function createChainReader(gateway) {
  const cache = new Map();
  const active = new Set();
  const readSnapshot = async ids => {
    // Only manage subscriptions requested by this bridge; never unsubscribe all.
    for (const conid of active) if (!ids.includes(conid)) { await gateway("/iserver/marketdata/unsubscribe", "POST", { conid }); active.delete(conid); }
    ids.forEach(id => active.add(id));
    let rows = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await gateway(`/iserver/marketdata/snapshot?conids=${ids.join(",")}&fields=${fields}`);
      rows = Array.isArray(data) ? data : [];
      if (rows.length === ids.length && rows.every(r => r._updated && (r["31"] !== undefined || (r["84"] !== undefined && r["86"] !== undefined)))) break;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800));
    }
    return rows;
  };
  const readChain = async (symbol, right, now = Date.now()) => {
    if (!["SOXL", "SPCX", "TSLA", "AMD"].includes(symbol) || !["P", "C"].includes(right)) throw new Error("Unsupported symbol/right");
    const today = dateET(now), key = `${symbol}:${right}:${today}`;
    let saved = cache.get(key);
    if (!saved || now - saved.at > 10 * 60000) {
      const results = await gateway("/iserver/secdef/search", "POST", { symbol, secType: "STK" });
      const candidates = Array.isArray(results) ? results.filter(r => r.symbol === symbol && (r.secType === "STK" || r.sections?.some(s => s.secType === "STK"))) : [];
      if (!candidates.length || candidates.length > 8) throw new Error("Underlying identity is missing or ambiguous");
      const verified = [];
      for (const underlying of candidates) {
        const info = await gateway(`/iserver/contract/${underlying.conid}/info`);
        if ((info.symbol ?? info.ticker) === symbol && info.currency === "USD" && (info.instrument_type ?? info.secType) === "STK") verified.push({ underlying, info });
      }
      const uniqueStocks = [...new Map(verified.map(v => [Number(v.underlying.conid), v])).values()];
      if (uniqueStocks.length !== 1) throw new Error("US underlying not uniquely verified");
      const { underlying, info } = uniqueStocks[0];
      if (symbol === "SPCX" && !/space.?x|space exploration/i.test(String(info.company_name ?? info.companyName ?? underlying.companyName))) throw new Error("SPCX issuer is not verified as SpaceX");
      const availableMonths = String(underlying.sections?.find(s => s.secType === "OPT")?.months || "").split(";");
      if (!availableMonths[0]) throw new Error("No listed option chain returned by IBKR");
      await gateway("/iserver/accounts"); // Required initialization; discard account data.
      const stockQuotes = await readSnapshot([Number(underlying.conid)]);
      const stock = stockQuotes.find?.(r => Number(r.conid) === Number(underlying.conid));
      const spot = number(stock?.["31"]);
      if (!(spot > 0)) throw new Error("Underlying snapshot warming up; retry after 15 seconds");
      const neededMonths = new Set([7,14].map(days => { const d = new Date(Date.parse(today) + days * 86400000); return months[d.getUTCMonth()] + String(d.getUTCFullYear()).slice(-2); }));
      const contracts = [];
      for (const month of availableMonths.filter(m => neededMonths.has(m))) {
        const query = new URLSearchParams({ conid: String(underlying.conid), sectype: "OPT", month, exchange: "SMART" });
        const strikesResult = await gateway(`/iserver/secdef/strikes?${query}`);
        // OTM only; pick nearest 12 strikes per month to bound subscriptions and discovery cost.
        const strikes = [...new Set(strikesResult[right === "P" ? "put" : "call"] || [])].map(Number).filter(k => Number.isFinite(k) && (right === "P" ? k < spot && k >= spot * .65 : k > spot && k <= spot * 1.35)).sort((a,b) => Math.abs(a-spot)-Math.abs(b-spot)).slice(0,12);
        for (const strike of strikes) {
          const qs = new URLSearchParams(query); qs.set("strike", String(strike)); qs.set("right", right);
          const data = await gateway(`/iserver/secdef/info?${qs}`);
          for (const row of Array.isArray(data) ? data : []) { const contract = validOptionContract(row,symbol,right,today); if (contract) contracts.push(contract); }
        }
      }
      const unique = [...new Map(contracts.map(c => [c.conid,c])).values()].sort((a,b) => a.expiry.localeCompare(b.expiry) || a.strike-b.strike).slice(0,48);
      saved = { at: now, underlyingId: Number(underlying.conid), companyName: String(info.company_name ?? underlying.companyName), contracts: unique };
      cache.set(key, saved);
      for (const [k,v] of cache) if (now - v.at > 10*60000) cache.delete(k);
    }
    const ids = [saved.underlyingId, ...saved.contracts.map(c=>c.conid)];
    const snapshots = await readSnapshot(ids);
    return { symbol, companyName: saved.companyName, underlyingId: saved.underlyingId, contracts: saved.contracts, snapshots, receivedAt: new Date().toISOString(), scope: "Up to 12 nearest out-of-the-money strikes per month, 7–14 calendar DTE, maximum 48 standard USD contracts. This is a bounded screen, not every listed contract." };
  };
  readChain.reset = () => { cache.clear(); active.clear(); };
  return readChain;
}
