/**
 * Task templates (§3.5).
 *
 * A workflow is a saved run whose task has been turned into a template —
 * `Check refund status for order {{order_id}}` — so that the "input schema"
 * the design doc promises is a real thing rather than a formality, and the
 * copyable API endpoint takes meaningful arguments.
 *
 * Pure functions: no database, no framework. The API route and the re-run form
 * both validate through here, so the endpoint and the UI cannot disagree about
 * what a valid input is.
 */

/** `{{ name }}` with optional inner whitespace. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export type JsonSchema = {
  type: "object";
  properties: Record<string, { type: "string" }>;
  required: string[];
  additionalProperties: false;
};

export type WorkflowInputSpec = {
  template: string;
  variables: string[];
  schema: JsonSchema;
};

/** Variable names in first-appearance order, deduplicated. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    // A variable used twice is still one input.
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

export function buildInputSpec(template: string): WorkflowInputSpec {
  const variables = extractVariables(template);
  return {
    template,
    variables,
    schema: {
      type: "object",
      properties: Object.fromEntries(
        variables.map((v) => [v, { type: "string" as const }]),
      ),
      required: [...variables],
      additionalProperties: false,
    },
  };
}

export type ValidationResult =
  | { ok: true; task: string }
  | { ok: false; errors: string[] };

/**
 * Validates a set of values and renders the task in one step, so a caller
 * cannot accidentally render without validating.
 *
 * Strict about unknown keys: silently ignoring a misspelled field would let an
 * API caller believe they had parameterised something they hadn't.
 */
export function validateAndRender(
  spec: WorkflowInputSpec,
  values: unknown,
): ValidationResult {
  const errors: string[] = [];

  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, errors: ["Input must be a JSON object."] };
  }

  const provided = values as Record<string, unknown>;

  for (const name of spec.variables) {
    const value = provided[name];
    if (value === undefined || value === null) {
      errors.push(`Missing required input "${name}".`);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`Input "${name}" must be a string.`);
      continue;
    }
    if (value.trim() === "") {
      errors.push(`Input "${name}" must not be empty.`);
    }
  }

  for (const key of Object.keys(provided)) {
    if (!spec.variables.includes(key)) {
      errors.push(`Unknown input "${key}".`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, task: render(spec.template, provided as Record<string, string>) };
}

/**
 * Substitution is single-pass: a value that itself contains `{{...}}` is
 * inserted literally rather than being expanded, so an input cannot smuggle in
 * another variable reference.
 */
function render(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => values[name]);
}

/** Reads a spec back off a stored workflow row, tolerating older shapes. */
export function parseInputSpec(stored: unknown): WorkflowInputSpec {
  const record = (stored ?? {}) as Partial<WorkflowInputSpec>;
  if (typeof record.template === "string") {
    // Rebuild rather than trust the stored variables: the template is the
    // source of truth, and regenerating keeps the two from drifting.
    return buildInputSpec(record.template);
  }
  return buildInputSpec("");
}
