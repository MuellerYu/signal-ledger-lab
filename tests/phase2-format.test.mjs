import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadModule } from "./helpers/transpile.mjs";

const formatUrl = await loadModule("format.ts");
const pickNyUrl = await loadModule("pick-ny.ts");
const briefUrl = await loadModule("daily-brief.ts", { "./pick-ny": pickNyUrl, "./format": formatUrl });
const emailUrl = await loadModule("postclose-email.ts", { "./daily-brief": briefUrl });

const format = await import(formatUrl);
const { buildValuationWatch, VALUATION_BASELINE_NOTE } = await import(briefUrl);
const { renderPostCloseEmail, toPostCloseEmailBrief } = await import(emailUrl);

/** The real value that prompted this work. */
const REAL_FAIR_VALUE = 214.1991099076723;

/* ==================================================== precision */

test("26. a fair value renders at two decimals", () => {
  assert.equal(format.money(REAL_FAIR_VALUE), "$214.20");
  assert.equal(format.money(451.4865632471788), "$451.49");
  assert.equal(format.money(18.02930620085562), "$18.03");
  assert.equal(format.money(1234.5), "$1,234.50");
  assert.equal(format.money(-1.006), "-$1.01");
  assert.equal(format.money(0), "$0.00");
  assert.equal(format.money(null), "—", "an absent value is not a zero");
});

test("26b. the other display units use their agreed precision", () => {
  assert.equal(format.pct(2.720882428513738), "+2.72%");
  assert.equal(format.pct(-6.683681607911939), "-6.68%");
  assert.equal(format.pts(1.6230), "+1.62 pts");
  assert.equal(format.pts(-0.60023), "-0.60 pts");
  assert.equal(format.weight(0.189), "18.9%");
  assert.equal(format.percent(80.00001, 0), "80%");
});

test("27. full precision survives formatting", () => {
  const move = {
    ticker: "ORCL",
    priceChangePct: -1.9756939832647258,
    classification: "NO COMPARABLE PRIOR SNAPSHOT",
    fairValuePrior: null,
    fairValueCurrent: REAL_FAIR_VALUE,
    fairValueChangePct: null,
    modelInputChanged: false,
    thesisChanged: false,
    inputChanges: [],
  };

  const watch = buildValuationWatch([move]);
  assert.equal(watch.rows[0].fairValue, "$214.20", "the displayed value is rounded");
  assert.equal(move.fairValueCurrent, REAL_FAIR_VALUE, "the underlying value is untouched by rendering");
  assert.equal(watch.rows[0].priceMove, "-1.98%");
});

test("no arithmetic path rounds: contributions still reconcile exactly", async () => {
  const { portfolioDay } = await import(briefUrl);
  const prior = new Map([["SOXL", 100], ["AMD", 200], ["ORCL", 150], ["MSTR", 120], ["TSLA", 250], ["ASTS", 60]]);
  const today = new Map([["SOXL", 104.8], ["AMD", 206.2], ["ORCL", 148.5], ["MSTR", 121.2], ["TSLA", 247.0], ["ASTS", 60.6]]);
  const day = portfolioDay(prior, today, { previousClose: 500, close: 501.5 });
  const total = day.holdings.reduce((sum, holding) => sum + holding.contributionPoints, 0);
  assert.ok(Math.abs(total - day.returnPct) < 1e-12, "internal precision is preserved end to end");
});

/* ==================================================== the baseline section */

const baselineMove = (ticker, priceChangePct, fairValue) => ({
  ticker,
  priceChangePct,
  classification: "NO COMPARABLE PRIOR SNAPSHOT",
  fairValuePrior: null,
  fairValueCurrent: fairValue,
  fairValueChangePct: null,
  modelInputChanged: false,
  thesisChanged: false,
  inputChanges: [],
});

test("28. the baseline explanation is emitted once, not per ticker", () => {
  const moves = [
    baselineMove("ORCL", -1.9756939832647258, REAL_FAIR_VALUE),
    baselineMove("MSTR", 16.369272644790577, 165.5581284114294),
    baselineMove("TSLA", -0.4699196765204028, 205.2582674860821),
    baselineMove("AMD", 2.720882428513738, 451.4865632471788),
    baselineMove("ASTS", -6.683681607911939, 18.02930620085562),
  ];

  const watch = buildValuationWatch(moves);
  assert.equal(watch.baselineNote, VALUATION_BASELINE_NOTE);
  assert.equal(watch.rows.length, 5, "one compact row per instrument");
  assert.equal(watch.detail.length, 0, "a baseline row carries no narrative");
  assert.equal(watch.rows[0].status, "Baseline");
  assert.equal(watch.rows[0].fairValue, "$214.20");

  const brief = toPostCloseEmailBrief({
    sessionDate: "2026-09-18",
    regime: "AI / SEMI-LED",
    indexReturns: { SPY: 0.11 },
    mainMove: null,
    anomalies: [],
    causality: null,
    catalyst: null,
    portfolio: null,
    valuationMovements: moves,
  });
  const { text, sections } = renderPostCloseEmail(brief);

  const occurrences = text.split(VALUATION_BASELINE_NOTE).length - 1;
  assert.equal(occurrences, 1, `the explanation must appear exactly once, saw ${occurrences}`);

  const section = sections.find((entry) => entry.title === "SIGNAL LEDGER VALUATION WATCH");
  assert.deepEqual(section.table.head, ["Ticker", "Price Move", "Fair Value", "Status"]);
  assert.equal(section.table.rows.length, 5);
  assert.ok(!text.includes("214.1991099076723"), "the raw float never reaches a reader");
  assert.ok(!text.includes("+0.00%"), "no fake flat change is printed");
});

test("28b. a non-baseline change keeps its narrative and its prior value", () => {
  const moves = [{
    ticker: "AMD",
    priceChangePct: 2.720882428513738,
    classification: "VALUATION INPUT CHANGED",
    fairValuePrior: 400.123456789,
    fairValueCurrent: 451.4865632471788,
    fairValueChangePct: 12.8504,
    modelInputChanged: true,
    thesisChanged: false,
    inputChanges: ["modelWeights.DCF: 0.5 → 0.6"],
  }];

  const watch = buildValuationWatch(moves);
  assert.equal(watch.baselineNote, null, "no baseline explanation when every row has a prior");
  assert.equal(watch.rows[0].status, "Valuation input changed");
  assert.equal(watch.rows[0].fairValue, "$451.49");
  assert.match(watch.detail[0], /\$400\.12 → \$451\.49/, "prior and current are both shown, at two decimals");
  assert.match(watch.detail[0], /\+12\.85%/);
  assert.ok(!watch.detail[0].includes("451.4865632471788"), "no raw float in the narrative");
});

test("a price-only move never reads as a valuation change", () => {
  const watch = buildValuationWatch([{
    ticker: "MSTR",
    priceChangePct: 16.369272644790577,
    classification: "PRICE MOVED ONLY",
    fairValuePrior: 165.5581284114294,
    fairValueCurrent: 165.5581284114294,
    fairValueChangePct: 0,
    modelInputChanged: false,
    thesisChanged: false,
    inputChanges: [],
  }]);
  assert.equal(watch.rows[0].status, "Price moved only");
  assert.match(watch.detail[0], /核心估值输入和公允价值没有改变/);
});

/* ==================================================== secrets */

const FORBIDDEN_IN_CLIENT = [
  "PADDLE_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
  "AUTH_LINK_DERIVATION_SECRET",
  "AUTH_SESSION_SECRET",
  "AUTH_RATE_LIMIT_SECRET",
  "EMAIL_PREFERENCE_SECRET",
  "RESEND_API_KEY",
  "SERVICE_EMAIL_FLUSH_TOKEN",
];

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("29. no payment or auth secret is reachable from the client", async () => {
  const files = await sourceFiles("app");

  for (const path of files) {
    const source = await readFile(path, "utf8");
    const isClient = /^\s*["']use client["']/m.test(source);

    for (const secret of FORBIDDEN_IN_CLIENT) {
      if (!source.includes(secret)) continue;
      assert.ok(
        !isClient,
        `${path} is a client component that references ${secret}; secrets must stay server-side`,
      );
      // Even server-side, a secret must not be published under a NEXT_PUBLIC name.
      assert.ok(
        !source.includes(`NEXT_PUBLIC_${secret}`),
        `${path} exposes ${secret} through a NEXT_PUBLIC variable`,
      );
    }
  }

  // An exact allowlist, so a new mention anywhere else fails the suite:
  //   auth-config.ts  reads the secret from bindings
  //   auth-tokens.ts  names it in a "not configured" error message
  //   runtime.ts      declares it on the bindings type
  const libHits = [];
  for (const path of await sourceFiles("lib")) {
    const source = await readFile(path, "utf8");
    if (source.includes("AUTH_LINK_DERIVATION_SECRET")) libHits.push(path);
  }
  assert.deepEqual(
    libHits.sort(),
    ["lib/auth-config.ts", "lib/auth-tokens.ts", "lib/runtime.ts"],
    "no other module may touch the derivation secret",
  );
});

test("the browser never receives a secret through the auth routes", async () => {
  for (const path of ["app/api/auth/request-link/route.ts", "app/auth/verify/route.ts", "app/api/auth/consume/route.ts"]) {
    const source = await readFile(path, "utf8");
    assert.ok(!/NEXT_PUBLIC/.test(source), `${path} must not publish anything public`);
    assert.match(source, /from "@\/lib\/auth-config"|from "@\/lib\/auth-flow"|from "@\/lib\/session-cookie"/, `${path} is server-side only`);
  }
});
