// Minimal diagnostic: reproduce the research_draft structured-output call and
// print the full OpenAI error body (to find why it returns 400). Never prints
// the API key. Read-only; no production state.
import { readFile } from "node:fs/promises";

const bindings = {};
for (const raw of (await readFile(new URL("../.dev.vars", import.meta.url), "utf8")).split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  bindings[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
}
const apiKey = bindings.OPENAI_API_KEY;
const model = bindings.OPENAI_VALUATION_MODEL || "gpt-5.6-luna";
if (!apiKey) { console.error("no OPENAI_API_KEY"); process.exit(1); }

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["toolRequests"],
  properties: {
    toolRequests: { type: "array", items: { type: "object", additionalProperties: false, required: ["tool", "args"], properties: { tool: { type: "string" }, args: { type: "object" } } } },
  },
};

async function attempt(label, body) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n=== ${label} ===`);
  console.log(`status ${res.status}`);
  console.log(text.slice(0, 2000));
}

const base = { model, instructions: "test", input: "{}", max_output_tokens: 200 };

await attempt("A: json_schema strict + prompt_cache_key + reasoning", {
  ...base,
  reasoning: { effort: "low" },
  text: { format: { type: "json_schema", name: "research_draft", strict: true, schema } },
  prompt_cache_key: "signal-ledger:research_draft:v2",
  store: false,
});

await attempt("B: json_schema strict, NO prompt_cache_key", {
  ...base,
  reasoning: { effort: "low" },
  text: { format: { type: "json_schema", name: "research_draft", strict: true, schema } },
  store: false,
});

await attempt("C: json_schema strict:false, NO prompt_cache_key", {
  ...base,
  reasoning: { effort: "low" },
  text: { format: { type: "json_schema", name: "research_draft", strict: false, schema } },
  store: false,
});

await attempt("D: prompt_cache_key only, NO text.format", {
  ...base,
  reasoning: { effort: "low" },
  prompt_cache_key: "signal-ledger:research_draft:v2",
  store: false,
});

await attempt("E: text.format only, NO prompt_cache_key, NO reasoning", {
  ...base,
  text: { format: { type: "json_schema", name: "research_draft", strict: true, schema } },
  store: false,
});
