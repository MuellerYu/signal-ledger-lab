// TEST MODE ONLY. Reads monitor-worker/.dev.vars into a plain object.
// These credentials stay on this machine; nothing here is sent anywhere except
// Alpaca, and nothing is written back to Cloudflare.
import { readFile } from "node:fs/promises";

export async function loadDevVars(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Missing ${path}. Create it with ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. ` +
        "It is gitignored and never leaves this machine.",
    );
  }

  const vars = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}
