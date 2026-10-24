/** Closed structural contracts shared by AI schemas, runtime gates and sending
 * projections. This implements only the schema vocabulary used by this module
 * and research-plan, not a general-purpose JSON Schema engine. */
export type ResearchSchema = {
  type?: string | readonly string[];
  properties?: Record<string, ResearchSchema>;
  additionalProperties?: boolean;
  required?: readonly string[];
  items?: ResearchSchema;
  anyOf?: readonly ResearchSchema[];
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  pattern?: string;
};

export const DRIVER_PARAMETER_KEYS = {
  reported_segment: ["revenueB"], volume_x_price: ["volume", "price"],
  users_x_arpu: ["users", "arpu"], capacity_x_utilization_x_price: ["capacity", "utilization", "price"],
  revenue_x_margin: ["revenueB"], growth: ["revenueB"], constant: ["value"],
  // No parameter-based implementation exists for these formulas. The compiler
  // keeps its existing disclosed/forecast-metric fallback; no new economics.
  asset_yield_minus_share_plus_fees: [], sum_of_children: [], scenario_weighted: [],
} as const;
export type DriverParameter = (typeof DRIVER_PARAMETER_KEYS)[keyof typeof DRIVER_PARAMETER_KEYS][number];
const NUMERIC_STRING = "^[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?$";
const numericParameter: ResearchSchema = { anyOf: [{ type: "number" }, { type: "string", pattern: NUMERIC_STRING }] };

export function driverParamsSchema(formula: keyof typeof DRIVER_PARAMETER_KEYS): ResearchSchema {
  return { type: "object", additionalProperties: false,
    properties: Object.fromEntries(DRIVER_PARAMETER_KEYS[formula].map((key) => [key, numericParameter])) };
}

const peers: ResearchSchema = { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9.-]*$" } };
export const TOOL_ARGUMENT_SCHEMAS: Record<string, ResearchSchema> = {
  list_filing_documents: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 10 } } },
  get_reported_segments: { type: "object", additionalProperties: false, properties: {} },
  get_peer_financials: { type: "object", additionalProperties: false, properties: { peers, peerTickers: peers, tickers: peers } },
};
export const toolRequestSchema: ResearchSchema = { anyOf: Object.entries(TOOL_ARGUMENT_SCHEMAS).map(([tool, args]) => ({
  type: "object", additionalProperties: false, required: ["tool", "args"], properties: { tool: { type: "string", const: tool }, args },
})) };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function variant(value: unknown, schema: ResearchSchema): ResearchSchema | undefined {
  if (!schema.anyOf) return schema;
  // Discriminated unions (formula/tool) should explain errors at the selected
  // node, without accepting fields from a different formula or tool.
  if (object(value)) return schema.anyOf.find((choice) => Object.entries(choice.properties ?? {})
    .some(([key, field]) => Object.hasOwn(field, "const") && field.const === value[key]));
  return schema.anyOf.find((choice) => schemaErrors(value, choice).length === 0);
}

export function schemaErrors(value: unknown, schema: ResearchSchema, path = "top"): string[] {
  if (schema.anyOf) {
    const selected = variant(value, schema);
    return selected ? schemaErrors(value, selected, path) : [`${path}: no supported schema variant`];
  }
  const errors: string[] = [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (types && !types.some((type) => type === actual || (type === "integer" && typeof value === "number" && Number.isInteger(value)))) return [`${path}: expected ${types.join("|")}`];
  if (Object.hasOwn(schema, "const") && value !== schema.const) errors.push(`${path}: invalid discriminator`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: unsupported enum value`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path}: expected finite number`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: string too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid string format`);
    if (schema.pattern === NUMERIC_STRING && !Number.isFinite(Number(value))) errors.push(`${path}: numeric string must be finite`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items) value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items!, `${path}[${i}]`)));
  }
  if (object(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing required field`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...schemaErrors(child, schema.properties![key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
    }
  }
  return errors;
}

/** Only project declared keys; never coerce a financial value or invent a zero.
 * Actual sends first validate the unprojected plan, so stripping metadata here
 * cannot turn a rejected candidate into an approved plan. */
export function projectSchema(value: unknown, schema: ResearchSchema): unknown {
  if (schema.anyOf) { const selected = variant(value, schema); return selected ? projectSchema(value, selected) : undefined; }
  if (Array.isArray(value) && schema.items) return value.map((item) => projectSchema(item, schema.items!));
  if (object(value) && schema.properties) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => Object.hasOwn(schema.properties!, key))
    .map(([key, child]) => [key, projectSchema(child, schema.properties![key])]));
  return value;
}
