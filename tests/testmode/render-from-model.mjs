// TEST MODE ONLY. Renders the worker's /internal/testmode/postclose payload
// through the shipped ten-section email. The mapping and the renderer both come
// from lib/postclose-email.ts, so this cannot drift from what gets sent.
//
//   node --import ./register.mjs render-from-model.mjs /tmp/testmode.json

import { readFile, writeFile } from "node:fs/promises";
import { renderPostCloseEmail, toPostCloseEmailBrief } from "../../lib/postclose-email.ts";

const inputPath = process.argv[2] ?? "/tmp/testmode.json";
const raw = JSON.parse(await readFile(inputPath, "utf8"));
if (!raw.ok) {
  console.error("Route did not return a model:", JSON.stringify(raw, null, 2).slice(0, 800));
  process.exit(1);
}

const brief = toPostCloseEmailBrief(raw);
const { text, html } = renderPostCloseEmail(brief, { testMode: true });

const outDir = new URL("./out/", import.meta.url);
await writeFile(new URL(`${brief.sessionDate}.txt`, outDir), text);
await writeFile(new URL(`${brief.sessionDate}.html`, outDir), html);
console.log(text);
console.log(`\n[testmode] wrote out/${brief.sessionDate}.txt and .html`);
