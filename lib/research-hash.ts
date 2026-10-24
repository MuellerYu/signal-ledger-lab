// Stable, deterministic canonical hashing for the research cache layers.
//
// `evidenceVersion` and `assumptionVersion` must not include timestamps, generated
// ids, object insertion order or revision timestamps — only the durable, normalized
// content. `canonicalize` is the single shared normalizer: object keys sorted,
// `undefined` dropped from objects (as JSON does), `-0` normalized to `0`, non-finite
// numbers collapsed to null, arrays order-preserved. Both hashers feed the same FNV-1a.
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value)) return "null";
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  if (type === "object") {
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner === undefined) continue;
      entries.push([key, inner]);
    }
    entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return "{" + entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalize(inner)}`).join(",") + "}";
  }
  return JSON.stringify(value);
}

/** FNV-1a 32-bit, shared by every research hash so identities stay comparable. */
export function fnv1a(input: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Canonical hash of any value, e.g. an evidence corpus or a ResearchPlan. */
export function hashCanonical(value: unknown): string {
  return fnv1a(canonicalize(value));
}
