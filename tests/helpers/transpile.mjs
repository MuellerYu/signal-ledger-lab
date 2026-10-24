// Loads lib/*.ts into node:test by transpiling, with dependencies swapped for
// already-transpiled data URLs — the same approach the existing suites use.

import { readFile } from "node:fs/promises";
import ts from "typescript";

export const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

export async function loadModule(name, deps = {}) {
  let code = await readFile(new URL(`../../lib/${name}`, import.meta.url), "utf8");
  for (const [specifier, url] of Object.entries(deps)) {
    code = code.replaceAll(`"${specifier}"`, `"${url}"`);
  }
  return dataUrl(
    ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  );
}
