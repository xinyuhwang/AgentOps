import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  buildInputSpec,
  extractVariables,
  parseInputSpec,
  validateAndRender,
} from "./template";

describe("template variables", () => {
  test("placeholders become variables in first-appearance order", () => {
    assert.deepEqual(
      extractVariables("Refund {{order_id}} for {{customer}}"),
      ["order_id", "customer"],
    );
  });

  test("a repeated variable is one input", () => {
    assert.deepEqual(
      extractVariables("{{id}} then {{id}} again"),
      ["id"],
    );
  });

  test("inner whitespace is tolerated", () => {
    assert.deepEqual(extractVariables("order {{  order_id  }}"), ["order_id"]);
  });

  test("a template with no placeholders has no inputs", () => {
    assert.deepEqual(extractVariables("Run the nightly report"), []);
  });

  test("malformed placeholders are left as literal text", () => {
    // Single braces and names starting with a digit are not variables; treating
    // them as such would invent inputs nobody asked for.
    assert.deepEqual(extractVariables("{order_id} and {{1bad}} and {{}}"), []);
  });

  test("the schema mirrors the variables", () => {
    const spec = buildInputSpec("Check {{order_id}}");
    assert.deepEqual(spec.schema.required, ["order_id"]);
    assert.deepEqual(spec.schema.properties, { order_id: { type: "string" } });
    assert.equal(spec.schema.additionalProperties, false);
  });
});

describe("validate and render", () => {
  const spec = buildInputSpec("Refund {{order_id}} for {{customer}}");

  test("valid input renders the task", () => {
    const result = validateAndRender(spec, {
      order_id: "1182",
      customer: "Ada",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.task, "Refund 1182 for Ada");
  });

  test("a repeated variable is substituted everywhere", () => {
    const repeated = buildInputSpec("{{id}}/{{id}}");
    const result = validateAndRender(repeated, { id: "7" });
    assert.equal(result.ok && result.task, "7/7");
  });

  test("a missing input is reported by name", () => {
    const result = validateAndRender(spec, { order_id: "1182" });
    assert.equal(result.ok, false);
    assert.deepEqual(result.ok === false && result.errors, [
      'Missing required input "customer".',
    ]);
  });

  test("an empty string is not a valid input", () => {
    const result = validateAndRender(spec, { order_id: "  ", customer: "Ada" });
    assert.equal(result.ok, false);
    assert.match(
      result.ok === false ? result.errors[0] : "",
      /must not be empty/,
    );
  });

  test("a non-string input is rejected rather than coerced", () => {
    const result = validateAndRender(spec, { order_id: 1182, customer: "Ada" });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.errors[0] : "", /must be a string/);
  });

  test("unknown keys are rejected rather than ignored", () => {
    // Silently dropping a misspelled field would let a caller believe they had
    // parameterised something they had not.
    const result = validateAndRender(spec, {
      order_id: "1",
      customer: "Ada",
      oder_id: "1",
    });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.errors[0] : "", /Unknown input/);
  });

  test("a non-object body is rejected", () => {
    for (const bad of [null, "string", 42, ["a"]]) {
      const result = validateAndRender(spec, bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} should be invalid`);
    }
  });

  test("a value containing a placeholder is inserted literally", () => {
    // Single-pass substitution: an input cannot smuggle in another variable.
    const result = validateAndRender(spec, {
      order_id: "{{customer}}",
      customer: "Ada",
    });
    assert.equal(result.ok && result.task, "Refund {{customer}} for Ada");
  });

  test("a template with no variables accepts an empty object", () => {
    const fixed = buildInputSpec("Run the nightly report");
    const result = validateAndRender(fixed, {});
    assert.equal(result.ok && result.task, "Run the nightly report");
  });

  test("all problems are reported at once, not one at a time", () => {
    const result = validateAndRender(spec, { extra: "x" });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.errors.length, 3);
  });
});

describe("stored spec round-trip", () => {
  test("a stored spec rebuilds from its template", () => {
    const original = buildInputSpec("Check {{order_id}}");
    const restored = parseInputSpec(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(restored, original);
  });

  test("variables are regenerated rather than trusted", () => {
    // If a stored row's variables ever disagreed with its template, the
    // template wins — it is what actually gets rendered.
    const restored = parseInputSpec({
      template: "Check {{order_id}}",
      variables: ["stale", "wrong"],
    });
    assert.deepEqual(restored.variables, ["order_id"]);
  });

  test("a missing or malformed spec degrades to an empty template", () => {
    assert.deepEqual(parseInputSpec(null).variables, []);
    assert.deepEqual(parseInputSpec({ nonsense: true }).template, "");
  });
});
