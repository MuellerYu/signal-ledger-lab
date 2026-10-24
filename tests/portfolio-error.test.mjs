import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * The portfolio error boundary must never leak a provider's raw response — a 401
 * from Alpaca is a raw nginx page, and a JSON error object can echo request
 * internals. These tests assert that `readableError` collapses every failure to
 * a generic public message while keeping the detail server-side.
 */

const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const libRoot = new URL("../lib/", import.meta.url);

async function load() {
  const code = await readFile(new URL("portfolio-error.ts", libRoot), "utf8");
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(dataUrl(js));
}

const nginx401 = [
  "ALPACA_BARS_401|",
  "<html>",
  "<head><title>401 Authorization Required</title></head>",
  "<body><center><h1>401 Authorization Required</h1></center><hr><center>nginx</center></body>",
  "</html>",
].join("\n");

test("a provider 401 body never reaches the public error string", async () => {
  const { readableError } = await load();
  const result = readableError(new Error(nginx401));
  assert.equal(result.code, "PRICE_PROVIDER_ERROR");
  assert.match(result.error, /temporarily unavailable/i);
  assert.doesNotMatch(result.error, /html|nginx|authorization|401|<|>/i);
});

test("missing credentials are reported honestly without provider content", async () => {
  const { readableError } = await load();
  const result = readableError(new Error("ALPACA_BARS_NOT_CONFIGURED"));
  assert.equal(result.code, "PRICE_PROVIDER_NOT_CONFIGURED");
  assert.doesNotMatch(result.error, /html|nginx|authorization|ALPACA_BARS/i);
});

test("a 5xx body is also sanitised", async () => {
  const { readableError } = await load();
  const result = readableError(new Error("ALPACA_BARS_503|upstream down"));
  assert.equal(result.code, "PRICE_PROVIDER_ERROR");
  assert.doesNotMatch(result.error, /upstream|down|503/i);
});

test("unknown internal errors become a generic public message", async () => {
  const { readableError } = await load();
  const result = readableError(new Error("No adjusted daily history returned for ORCL, AAPL."));
  assert.equal(result.code, "PORTFOLIO_UNAVAILABLE");
  assert.doesNotMatch(result.error, /ORCL|AAPL|adjusted|history/i);
});
