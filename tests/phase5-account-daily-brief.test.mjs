import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { applyMigration, createD1, MIGRATION_PATH } from "./helpers/sqlite-d1.mjs";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/**
 * The account page's Daily Brief toggle.
 *
 * On the Stripe sandbox Preview the switch rendered OFF and clicking it did
 * nothing. It was `disabled`, because /account only minted a
 * (uid, sig) preference signature when `EMAIL_PREFERENCE_SECRET` was present in
 * the deployment environment — and that secret exists in the Pages *production*
 * environment but was never installed for *preview*. The account route then
 * required the same missing secret, so it would have answered 403 even if the
 * switch had fired. A signed-in member's switch must not depend on a secret
 * that only the emailed, unauthenticated preference links need.
 *
 * These tests pin the fix at all three levels: the rendered switch, the
 * authentication contract of the route, and the database write itself.
 */

/* ==================================================== the rendered switch */

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const toModule = (source, fileName) =>
  "data:text/javascript;base64," +
  Buffer.from(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName,
    }).outputText.replace(
      /from ["'](react(?:\/jsx-runtime)?)["']/g,
      (_, name) => `from "${pathToFileURL(require.resolve(name)).href}"`,
    ),
  ).toString("base64");

// next/link is the only non-React import on this component; a plain anchor is
// enough to render it.
const linkStub = dataUrl(`
  import { createElement } from "${pathToFileURL(require.resolve("react")).href}";
  export default function Link({ href, children, ...rest }) {
    return createElement("a", { href, ...rest }, children);
  }
`);

const panelSource = (await readFile(new URL("app/account/account-panel.tsx", root), "utf8")).replace(
  'from "next/link"',
  `from "${linkStub}"`,
);
const checkoutStub = dataUrl("export default function ProCheckout() { return null; }");
const renderedPanelSource = panelSource.replace('from "../pro-checkout"', `from "${checkoutStub}"`);
const AccountPanel = (await import(toModule(renderedPanelSource, "account-panel.tsx"))).default;

const PROPS = {
  email: "owner@example.com",
  tier: "PRO",
  dailyBriefEnabled: false,
  accessUntil: "2026-10-19T22:00:00.000Z",
  cancelAtPeriodEnd: false,
  cancelAt: null,
};

const render = (overrides = {}) => renderToStaticMarkup(React.createElement(AccountPanel, { ...PROPS, ...overrides }));
const switchTag = (html) => html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";

test("1. the switch renders enabled for a signed-in member — never dead UI", () => {
  const html = render();
  const tag = switchTag(html);

  assert.notEqual(tag, "", "the switch is present");
  assert.doesNotMatch(tag, /disabled/, "the switch is clickable without any extra credential");
  assert.match(tag, /aria-checked="false"/, "it reflects the stored preference, which is off");
  assert.match(html, /Daily Brief is off/);
});

test("2. the switch reflects an enabled preference", () => {
  const html = render({ dailyBriefEnabled: true });
  assert.match(switchTag(html), /aria-checked="true"/);
  assert.match(html, /Daily Brief is on/);
  assert.doesNotMatch(switchTag(html), /disabled/);
});

test("3. the saved dates render identically in every time zone", () => {
  // The reported page also failed hydration (React #418). `toLocaleDateString`
  // with a default locale and zone resolves to the server's ICU default on
  // Cloudflare but to the visitor's own settings in the browser, so an instant
  // near midnight formatted as two different days. Pinning both sides makes the
  // server render and the client render identical.
  const original = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const utc = render();
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14, the far side of the date line
    const east = render();
    process.env.TZ = "America/Los_Angeles";
    const west = render();

    assert.equal(east, utc, "a UTC+14 browser hydrates the same markup");
    assert.equal(west, utc, "a UTC-7 browser hydrates the same markup");
    assert.match(utc, /Access through October 19, 2026/, "the pinned locale and UTC zone are what render");
  } finally {
    process.env.TZ = original;
  }
});

test("4. a scheduled cancellation still renders its own date, stably", () => {
  const html = render({ cancelAt: "2026-11-01T09:00:00.000Z" });
  assert.match(html, /Cancels on November 1, 2026/);
});

/* ==================================================== the route's contract */

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("5. the account toggle authenticates by session, not by the email-link secret", async () => {
  const route = stripComments(await readFile("app/api/account/preferences/route.ts", "utf8"));

  assert.match(route, /getCurrentUser/, "it uses the same session credential as /api/billing/portal");
  assert.match(route, /getMembershipD1/, "it still reaches the database through the membership binding");
  assert.doesNotMatch(
    route,
    /EMAIL_PREFERENCE_SECRET/,
    "a secret that only emailed preference links need must not gate a signed-in member's switch",
  );
  assert.doesNotMatch(route, /verifyPreferenceRequest/, "no signature check on an already-authenticated request");
});

test("6. /account no longer mints a preference signature for the toggle", async () => {
  const page = stripComments(await readFile("app/account/page.tsx", "utf8"));

  assert.doesNotMatch(page, /signPreference/, "nothing to mint when the session is the credential");
  assert.doesNotMatch(page, /EMAIL_PREFERENCE_SECRET/, "and no secret to be missing");
});

test("7. the panel holds no signature gate and formats dates deterministically", async () => {
  const panel = stripComments(await readFile("app/account/account-panel.tsx", "utf8"));

  assert.doesNotMatch(panel, /prefSignature/, "no prop left that can silently disable the switch");
  assert.doesNotMatch(panel, /disabled=\{saving \|\|/, "the switch is disabled only while a save is in flight");
  assert.doesNotMatch(panel, /toLocaleDateString\(\s*undefined/, "an unpinned locale is a hydration mismatch");
  assert.match(panel, /toLocaleDateString\("en-US"/, "the locale is pinned");
  assert.match(panel, /timeZone: "UTC"/, "and so is the zone");
});

/* ==================================================== the route's behaviour */

const entitlementUrl = await loadModule("entitlement.ts");
const tokensUrl = await loadModule("auth-tokens.ts");
const preferencesUrl = await loadModule("email-preferences.ts", {
  "./entitlement": entitlementUrl,
  "./auth-tokens": tokensUrl,
});
const sessionCookieUrl = await loadModule("session-cookie.ts");

const userStub = dataUrl(`
  let current = null;
  export function setCurrentUser(user) { current = user; }
  export async function getCurrentUser() { return current; }
`);
const databaseStub = dataUrl(`
  let current = null;
  export function setMembershipD1(database) { current = database; }
  export function getMembershipD1() { return current; }
`);

const routeSource = (await readFile(new URL("app/api/account/preferences/route.ts", root), "utf8"))
  .replace('from "@/lib/access"', `from "${userStub}"`)
  .replace('from "@/lib/email-preferences"', `from "${preferencesUrl}"`)
  .replace('from "@/lib/membership-db"', `from "${databaseStub}"`)
  .replace('from "@/lib/session-cookie"', `from "${sessionCookieUrl}"`);

const route = await import(toModule(routeSource, "preferences-route.ts"));
const users = await import(userStub);
const databases = await import(databaseStub);

const USER = { id: "user_1", email: "owner@example.com", emailVerified: true };

const post = (body, { user = USER, d1 } = {}) => {
  users.setCurrentUser(user);
  databases.setMembershipD1(d1 ?? null);
  return route.POST(
    new Request("https://your-project.pages.dev/api/account/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
};

async function freshDb() {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(
    `INSERT INTO users (id, email, email_verified, created_at, updated_at)
     VALUES ('user_1','owner@example.com',1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`,
  );
  return d1;
}

test("8. a signed-in member can switch the Daily Brief on and back off", async () => {
  const d1 = await freshDb();

  const on = await post({ daily_brief: "on" }, { d1 });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { dailyBriefEnabled: true, marketingEnabled: false });
  assert.equal(d1.raw.prepare("SELECT daily_brief_enabled AS v FROM email_preferences WHERE user_id='user_1'").get().v, 1);

  const off = await post({ daily_brief: "off" }, { d1 });
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { dailyBriefEnabled: false, marketingEnabled: false });
  assert.equal(d1.raw.prepare("SELECT daily_brief_enabled AS v FROM email_preferences WHERE user_id='user_1'").get().v, 0);
});

test("9. the toggle changes nothing but the preference row", async () => {
  const d1 = await freshDb();
  const snapshot = () =>
    d1.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .filter(({ name }) => name !== "email_preferences")
      .map(({ name }) => [name, d1.raw.prepare(`SELECT * FROM "${name}"`).all()]);
  const before = JSON.stringify(snapshot());

  assert.equal((await post({ daily_brief: "on" }, { d1 })).status, 200);

  // Requirement: turning the brief off never touches entitlement. Leaving every
  // other table byte-identical is what makes that true by construction.
  assert.equal(JSON.stringify(snapshot()), before, "no table but email_preferences was written");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n, 0, "billing is untouched");
});

test("10. an unauthenticated POST is refused and writes nothing", async () => {
  const d1 = await freshDb();

  const anonymous = await post({ daily_brief: "on" }, { user: null, d1 });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "sign_in_required" });
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM email_preferences").get().n, 0, "no row was created");

  // The membership binding being absent fails closed the same way.
  users.setCurrentUser(USER);
  databases.setMembershipD1(null);
  const unbound = await route.POST(
    new Request("https://example.com/api/account/preferences", {
      method: "POST",
      body: JSON.stringify({ daily_brief: "on" }),
    }),
  );
  assert.equal(unbound.status, 401);
});

test("11. a malformed body is rejected rather than read as an unsubscribe", async () => {
  const d1 = await freshDb();
  assert.equal((await post({ daily_brief: "on" }, { d1 })).status, 200);

  for (const body of ["{}", '{"daily_brief":"yes"}', "not json at all"]) {
    const response = await post(body, { d1 });
    assert.equal(response.status, 400, `${body} is not a valid instruction`);
  }
  assert.equal(
    d1.raw.prepare("SELECT daily_brief_enabled AS v FROM email_preferences WHERE user_id='user_1'").get().v,
    1,
    "the stored preference survived every malformed request",
  );
});

test("12. toggling the brief preserves the marketing preference beside it", async () => {
  const d1 = await freshDb();
  const preferences = await import(preferencesUrl);
  await preferences.applyPreferenceChange(
    d1,
    "user_1",
    { dailyBriefEnabled: false, marketingEnabled: true },
    "2026-09-01T00:00:00.000Z",
  );

  const response = await post({ daily_brief: "on" }, { d1 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { dailyBriefEnabled: true, marketingEnabled: true });
});
