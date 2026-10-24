/** Explicitly started by the owner; never installed as an unattended service.
 * Native gateway credentials stay in IBKR's gateway. No order routes exist here.
 */
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createChainReader } from "./ibkr-chain.mjs";

const symbols = new Set(["SOXL", "SPCX", "TSLA", "AMD"]);
const fields = "84,86,87,6509,7308,7633,7638";
export function createBridgeHandler(token, gateway) {
  if (typeof token !== "string" || token.length < 32) throw new Error("A bridge token of at least 32 characters is required.");
  let busy = false, lastRead = 0;
  const readChain = createChainReader(gateway);
  return async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const got = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return send(401, { error: "Unauthorized" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method !== "GET" || !["/status", "/quote", "/chain"].includes(url.pathname)) return send(404, { error: "Read-only route not found" });
    const conid = url.searchParams.get("conid"), symbol = url.searchParams.get("symbol");
    if (url.pathname === "/quote" && (!/^[1-9]\d{0,11}$/.test(conid || "") || !symbols.has(symbol))) return send(400, { error: "Invalid contract" });
    if (url.pathname === "/chain" && (!symbols.has(symbol) || !["P", "C"].includes(url.searchParams.get("right")))) return send(400, { error: "Invalid chain" });
    if (busy || (url.pathname !== "/status" && Date.now() - lastRead < 9000)) return send(429, { error: "Please wait before retrying" });
    busy = true; if (url.pathname !== "/status") lastRead = Date.now();
    try {
      const status = await gateway("/iserver/auth/status", "POST");
      if (!status.authenticated || status.competing) readChain.reset();
      if (url.pathname === "/status") return send(200, { authenticated: status.authenticated === true && !status.competing });
      if (!status.authenticated || status.competing) return send(503, { error: "Gateway reauthentication required" });
      if (url.pathname === "/chain") {
        const chain = await readChain(symbol, url.searchParams.get("right"));
        chain.snapshots = chain.snapshots.map(row => Object.fromEntries(["conid", "_updated", "31", ...fields.split(",")].filter(k => row[k] !== undefined).map(k => [k, row[k]])));
        return send(200, chain);
      }
      const info = await gateway(`/iserver/contract/${conid}/info`);
      if ((info.symbol ?? info.ticker) !== symbol || (info.instrument_type ?? info.secType) !== "OPT" || info.currency !== "USD" || Number(info.multiplier) !== 100) return send(400, { error: "Standard USD option identity not verified" });
      // IBKR requires these read-only bootstrap calls before derivative snapshots.
      // Account data is discarded; never returned or logged by this bridge.
      await gateway("/iserver/accounts");
      await gateway("/iserver/secdef/search", "POST", { symbol, secType: "STK" });
      const snapshots = await gateway(`/iserver/marketdata/snapshot?conids=${conid}&fields=${fields}`);
      const snapshot = Array.isArray(snapshots) ? snapshots.find(row => String(row.conid) === conid) : null;
      // Return only market-data fields and the minimum public contract definition.
      const cleanInfo = Object.fromEntries(["symbol", "ticker", "instrument_type", "secType", "currency", "multiplier", "con_id", "conid", "local_symbol"].filter(k => info[k] !== undefined).map(k => [k, info[k]]));
      const cleanSnapshot = snapshot ? Object.fromEntries(["conid", "_updated", ...fields.split(",")].filter(k => snapshot[k] !== undefined).map(k => [k, snapshot[k]])) : null;
      return send(200, { info: cleanInfo, snapshot: cleanSnapshot });
    } catch { send(502, { error: "Gateway unavailable" }); }
    finally { busy = false; }
  };
}

export function startBridge() {
  const token = process.env.IBKR_BRIDGE_TOKEN;
  // Trust the explicitly provided gateway certificate, never disable TLS verification.
  const ca = process.env.IBKR_GATEWAY_CA_FILE ? readFileSync(process.env.IBKR_GATEWAY_CA_FILE) : undefined;
  const port = Number(process.env.IBKR_GATEWAY_PORT || 5001);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local gateway port");
  let lastGatewayRequest = 0;
  const gateway = async (path, method = "GET", body) => {
    const delay = Math.max(0, 250 - (Date.now() - lastGatewayRequest));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastGatewayRequest = Date.now();
    return new Promise((resolve, reject) => {
    const req = httpsRequest(new URL(`/v1/api${path}`, `https://localhost:${port}`), { method, ca, timeout: 10000, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) } }, response => {
      let data = "";
      response.on("data", chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(new Error("Oversize response")); });
      response.on("end", () => { try { if (response.statusCode !== 200) throw new Error("Gateway rejected request"); resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    req.on("timeout", () => req.destroy(new Error("Gateway timeout"))); req.on("error", reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  };
  const server = createServer(createBridgeHandler(token, gateway));
  server.listen(8789, "127.0.0.1", () => console.log("Read-only IBKR bridge listening on 127.0.0.1:8789. No order or account endpoints are exposed."));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startBridge();
