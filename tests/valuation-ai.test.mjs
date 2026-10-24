import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("AI orchestration is exception-only while deterministic code retains valuation control", async () => {
  const source = await readFile(new URL("../lib/valuation-ai.ts", import.meta.url), "utf8");
  assert.match(source, /https:\/\/api\.openai\.com\/v1\/responses/);
  assert.match(source, /gpt-5\.6-sol/);
  assert.match(source, /gpt-5\.6-luna/);
  assert.match(source, /type: "json_schema"/);
  // Structured output is still declared explicitly, but strict mode is off: the
  // research schemas carry free-form maps (DriverParams, ToolRequest.args) plus
  // optional fields that OpenAI strict mode cannot express. The price firewall and
  // patch/revision whitelists are the enforcement boundary, not output strictness.
  assert.match(source, /strict: false/);
  assert.match(source, /issuerProfileNeedsPlanner/);
  assert.match(source, /claimAiCall/);
  assert.match(source, /runValuationProfile\(workingProfile, options\)/);
  assert.match(source, /aiUsed: false/);
  assert.match(source, /Never invent a fact, estimate, source, market price, fair value, target price or rating/);
  assert.doesNotMatch(source, /fairValue:\s*\{\s*type:/);
});

test("strict:false research payloads are runtime-validated before the compiler/reviewer", async () => {
  const source = await readFile(new URL("../lib/valuation-ai.ts", import.meta.url), "utf8");
  // Runtime validation is imported and wired in — the enforcement boundary is an
  // explicit post-JSON.parse gate, never output-mode strictness.
  assert.match(source, /from "\.\/research-validate"/);
  assert.match(source, /validateResearchPayload<ResearchDraft>\("draft"/);
  assert.match(source, /validateResearchPayload<ResearchPlan>\("plan"/);
  assert.match(source, /validateResearchPayload<\{ revisions: ResearchRevision\[\] \}>\("revision"/);
  // A schema-invalid payload is surfaced (RESEARCH_SCHEMA_INVALID) rather than
  // silently absorbed into the deterministic fallback.
  assert.match(source, /ResearchSchemaInvalidError/);
  assert.match(source, /schemaError/);
});

test("AI access stays server-side and defaults off until Cloudflare secrets are configured", async () => {
  const [runtime, envExample, client] = await Promise.all([
    readFile(new URL("../lib/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/fair-value/workstation.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /OPENAI_API_KEY\?: string/);
  assert.match(envExample, /AI_VALUATION_ENABLED=false/);
  assert.match(envExample, /OPENAI_REVIEW_MODEL=gpt-5\.6-sol/);
  assert.doesNotMatch(client, /OPENAI_API_KEY/);
});
