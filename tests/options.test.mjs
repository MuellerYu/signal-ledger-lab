import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createBridgeHandler } from "../scripts/ibkr-readonly-bridge.mjs";
async function load(path) {
  const code = await readFile(new URL(path, import.meta.url), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));
}
const { americanOption, optionSellerPnl, sellerRisk, optionDateMs, addOptionDays } = await load("../lib/options-math.ts");
const { ibkrNumber, normalizeIbkrQuote } = await load("../lib/ibkr-quote.ts");
const base = { spot: 100, strike: 100, years: 1, iv: .2, rate: .05, dividendYield: 0, right: "call" };

test("American no-dividend call agrees with independently published European benchmark", () => {
  // BSM benchmark S=K=100, T=1, sigma=.2, r=.05 => 10.450583572185565.
  assert.ok(Math.abs(americanOption(base, 1000) - 10.450583572185565) < .005);
});
test("American put includes early-exercise premium and respects intrinsic bounds", () => {
  const value = americanOption({ ...base, right: "put" }, 1000);
  assert.ok(value > 5.573526022256971); // Corresponding European put.
  assert.ok(Math.abs(value - 6.0896) < .01);
  assert.ok(americanOption({ ...base, spot: 30, right: "put" }) >= 70);
});
test("expiry, zero spot and zero volatility remain finite and correct", () => {
  assert.equal(americanOption({ ...base, spot: 80, right: "put", years: 0 }), 20);
  assert.equal(americanOption({ ...base, spot: 120, years: 0 }), 20);
  assert.equal(americanOption({ ...base, spot: 0, right: "put" }), 100);
  assert.ok(Math.abs(americanOption({ ...base, iv: 0 }) - (100 - 100 * Math.exp(-.05))) < 1e-8);
  assert.equal(americanOption({ ...base, spot: 50, iv: 0, right: "put" }), 50);
});
test("volatility stress, stock direction and 7/14-day time value behave correctly", () => {
  const p = (spot, iv, years = 14 / 365) => americanOption({ ...base, spot, iv, years, right: "put" });
  assert.ok(p(100, .8) > p(100, .4));
  assert.ok(p(80, .6) > p(100, .6));
  assert.ok(p(100, .6) > p(100, .6, 7 / 365));
  assert.ok(Number.isFinite(p(100, .000001)));
});
test("rejects invalid inputs instead of coercing them to market values", () => {
  for (const patch of [{ spot: NaN }, { spot: -1 }, { strike: 0 }, { years: -1 }, { years: 3 }, { iv: -1 }, { iv: 6 }, { rate: Infinity }]) assert.throws(() => americanOption({ ...base, ...patch }));
});
test("cash-secured put and covered-call maximum risk and actual expiry P/L reconcile", () => {
  const put = sellerRisk("put", 95, 2, 2, 0, 4);
  assert.equal(put.cashReserve, 19000); assert.equal(put.maxProfit, 396); assert.equal(put.maxLoss, 18604); assert.equal(put.breakeven, 93.02);
  assert.equal(optionSellerPnl(2, 95, 2, 4), -put.maxLoss);
  const call = sellerRisk("call", 105, 2, 1, 100, 2);
  assert.equal(call.requiredShares, 100); assert.equal(call.maxProfit, 698); assert.equal(call.maxLoss, 9802);
  const totalAt120 = (120 - 100) * 100 + optionSellerPnl(2, 15, 1, 2);
  assert.equal(totalAt120, call.maxProfit);
});
test("New York close is DST-aware and rejects invalid date rollovers", () => {
  assert.equal(new Date(optionDateMs("2026-09-07")).toISOString(), "2026-09-07T20:00:00.000Z");
  assert.equal(new Date(optionDateMs("2026-12-07")).toISOString(), "2026-12-07T21:00:00.000Z");
  assert.ok(Number.isNaN(optionDateMs("2026-02-30")));
  assert.equal(addOptionDays("2026-12-30", 7), "2027-01-06");
});
test("IBKR missing values do not turn into zero and formatted volume is supported", () => {
  for (const v of [null, undefined, "", "—", "C123.45", "N/A"]) assert.equal(ibkrNumber(v), null);
  assert.equal(ibkrNumber("1.2K"), 1200); assert.equal(ibkrNumber("60.3%"), 60.3); assert.equal(ibkrNumber("0"), 0);
});
const info = { symbol: "TSLA", instrument_type: "OPT", multiplier: "100", currency: "USD", con_id: 1234, local_symbol: "TSLA option" };
const now = Date.parse("2026-09-07T15:00:00Z");
const raw = { conid: 1234, "84": "2.10", "86": "2.20", "6509": "RpB", _updated: now, "7633": "60%" };
test("broker quotes retain entitlement/time flags and reject wrong contracts", () => {
  assert.equal(normalizeIbkrQuote(info, raw, 1234, "TSLA", now).eligibleQuote, true);
  for (const patch of [{ "6509": "DpB" }, { "6509": "Z" }, { _updated: now - 120000 }, { _updated: null }, { "86": "1" }]) assert.equal(normalizeIbkrQuote(info, { ...raw, ...patch }, 1234, "TSLA", now).eligibleQuote, false);
  for (const patch of [{ multiplier: 10 }, { symbol: "SPX" }, { instrument_type: "STK" }, { currency: "EUR" }]) assert.throws(() => normalizeIbkrQuote({ ...info, ...patch }, raw, 1234, "TSLA", now));
});
const token = "a".repeat(40);
async function invoke(handler, path, method = "GET", auth = `Bearer ${token}`) {
  let status, body;
  await handler({ url: path, method, headers: { authorization: auth } }, { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } });
  return { status, body };
}
test("bridge denies unauthenticated, order and arbitrary proxy requests before gateway access", async () => {
  let calls = 0; const gateway = async () => { calls++; };
  const handler = createBridgeHandler(token, gateway);
  assert.equal((await invoke(handler, "/status", "GET", "wrong")).status, 401);
  assert.equal((await invoke(handler, "/iserver/account/123/orders", "POST")).status, 404);
  assert.equal((await invoke(handler, "/quote?conid=1&symbol=SPX")).status, 400);
  assert.equal(calls, 0);
});
test("bridge bootstraps snapshots without exposing account data and enforces pacing", async () => {
  const paths = [];
  const gateway = async path => { paths.push(path); if (path.endsWith("auth/status")) return { authenticated: true };
    if (path.endsWith("/info")) return info; if (path.endsWith("/accounts")) return { accounts: ["PRIVATE_ACCOUNT"] };
    if (path.includes("snapshot")) return [{ ...raw, account: "PRIVATE_ACCOUNT", "75": 12345 }]; return []; };
  const handler = createBridgeHandler(token, gateway);
  const response = await invoke(handler, "/quote?conid=1234&symbol=TSLA");
  assert.equal(response.status, 200); assert.equal(response.body.snapshot["84"], "2.10");
  assert.ok(!JSON.stringify(response.body).includes("PRIVATE_ACCOUNT"));
  assert.ok(paths.indexOf("/iserver/accounts") < paths.findIndex(x => x.includes("snapshot")));
  assert.equal((await invoke(handler, "/status")).status, 200);
  assert.equal((await invoke(handler, "/quote?conid=1234&symbol=TSLA")).status, 429);
});
const { screenOption } = await load("../lib/options-screen.ts");
const { normalizeIbkrChain } = await load("../lib/ibkr-quote.ts");
const { createChainReader, validOptionContract } = await import("../scripts/ibkr-chain.mjs");
const c = { conid: 1234, symbol: "TSLA", right: "P", strike: 95, expiry: "2026-09-18", dte: 11, bid: 10, ask: 10.2, ivPercent: 180, delta: -.25, volume: 300, openInterest: 500, eligibleQuote: true, updatedAt: new Date(now).toISOString(), availability: "Real-time entitlement" };
const chain = { symbol: "TSLA", companyName: "Tesla", spot: 100, spotFresh: true, spotUpdatedAt: c.updatedAt, receivedAt: c.updatedAt, contracts: [c] };
const settings = { minReturnPct: 10, cash: 9500, shares: 100, quantity: 1, feesPerContract: 1.3, maxSpreadPct: 10 };
test("screen uses full cash collateral and fees, not annualized or net capital", () => {
  const r = screenOption(c, chain, settings, now);
  assert.equal(r.capital, 9500); assert.equal(r.netCredit, 998.7);
  assert.ok(Math.abs(r.returnPct - 998.7 / 9500 * 100) < 1e-10);
  assert.equal(r.passesScreen, true); assert.equal(r.tradeReady, false);
  assert.equal(r.stress[1].pnl, -501.29999999999995);
  assert.ok(r.warnings.some(s => s.includes("calendar")));
});
test("screen excludes stale, ITM, missing IV, poor coverage and insufficient net yield", () => {
  for (const patch of [{ eligibleQuote: false }, { updatedAt: new Date(now - 61000).toISOString() }, { strike: 105 }, { ivPercent: null }, { volume: null }, { delta: -.5 }, { bid: 1 }]) assert.equal(screenOption({ ...c, ...patch }, chain, settings, now).passesScreen, false);
  assert.equal(screenOption(c, chain, { ...settings, cash: 9499 }, now).passesScreen, false);
  assert.equal(screenOption(c, { ...chain, spotFresh: false }, settings, now).passesScreen, false);
  assert.throws(() => screenOption(c, chain, { ...settings, quantity: 1.5 }, now));
  assert.throws(() => screenOption(c, { ...chain, spot: 0 }, settings, now));
});
test("covered call stress includes stock loss and rejects insufficient shares", () => {
  const call = { ...c, right: "C", strike: 105, delta: .25 };
  const r = screenOption(call, chain, { ...settings, minReturnPct: 5 }, now);
  assert.equal(r.capital, 10000); assert.equal(r.stress[1].pnl, -1001.3);
  assert.equal(screenOption(call, chain, { ...settings, shares: 99 }, now).passesScreen, false);
});
const native = { conid: 1234, symbol: "TSLA", secType: "OPT", right: "P", strike: 95, currency: "USD", multiplier: "100", tradingClass: "TSLA", maturityDate: "20260918" };
test("chain accepts only standard same-symbol actual 7–14 DTE expirations", () => {
  assert.equal(validOptionContract(native, "TSLA", "P", "2026-09-07").dte, 11);
  for (const patch of [{ tradingClass: "TSLA1" }, { maturityDate: "20260911" }, { multiplier: 10 }, { right: "C" }, { symbol: "SPX" }]) assert.equal(validOptionContract({ ...native, ...patch }, "TSLA", "P", "2026-09-07"), null);
});
test("chain discovery selects contracts and reuses metadata without copying account payloads", async () => {
  const paths = [];
  const gateway = async (path, method, body) => {
    paths.push(path);
    if (path.endsWith("secdef/search")) return [{ conid: 1, symbol: "TSLA", companyName: "Tesla", sections: [{ secType: "STK" }, { secType: "OPT", months: "SEP26" }] }];
    if (path === "/iserver/contract/1/info") return { symbol: "TSLA", currency: "USD", instrument_type: "STK", company_name: "Tesla" };
    if (path.endsWith("accounts")) return { accounts: ["PRIVATE"] };
    if (path.includes("strikes?")) { assert.match(path, /sectype=OPT/); return { put: [95, 105], call: [105] }; }
    if (path.includes("secdef/info?")) return [native, { ...native, conid: 777, multiplier: 10 }];
    if (path.includes("snapshot?")) return new URL(path, "https://local.invalid").searchParams.get("conids").split(",").map(id => id === "1" ? { conid: 1, "31": "100", "6509": "R", _updated: now } : { ...raw, "7633": 60, "7308": -.25 });
    if (path.endsWith("unsubscribe")) return { success: true };
    throw new Error(path);
  };
  const reader = createChainReader(gateway), result = await reader("TSLA", "P", now);
  assert.equal(result.contracts.length, 1); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  const normalized = normalizeIbkrChain(result, "TSLA", "P", now);
  assert.equal(normalized.spot, 100); assert.equal(normalized.contracts[0].eligibleQuote, true);
  await reader("TSLA", "P", now + 15000);
  assert.equal(paths.filter(p => p.endsWith("secdef/search")).length, 1);
  assert.throws(() => normalizeIbkrChain({ ...result, symbol: "SPX" }, "TSLA", "P", now));
});
test("owner API has no local-host auth bypass or public caching; calculator is independent of D1", async () => {
  const route = await readFile(new URL("../app/api/options/ibkr/route.ts", import.meta.url), "utf8");
  assert.match(route, /isAuthorizedMutation\(request\)/);
  assert.doesNotMatch(route, /getChatGPTUser|isSiteOwnerEmail/);
  assert.match(route, /private, no-store/); assert.doesNotMatch(route, /isLocalHost|localhost|\.DB/);
  const client = await readFile(new URL("../app/options/workstation.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(client, /localStorage|IBKR_BRIDGE_TOKEN|\/api\/dashboard/);
});
