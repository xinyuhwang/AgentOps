import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { diffFields, diffLines, hasChanges } from "./diff";

describe("line diff", () => {
  const kinds = (before: string, after: string) =>
    diffLines(before, after).map((c) => `${c.kind[0]}:${c.text}`);

  test("identical text has no changes", () => {
    const changes = diffLines("a\nb\nc", "a\nb\nc");
    assert.equal(hasChanges(changes), false);
    assert.ok(changes.every((c) => c.kind === "same"));
  });

  test("an inserted line is added, the rest unchanged", () => {
    assert.deepEqual(kinds("a\nc", "a\nb\nc"), ["s:a", "a:b", "s:c"]);
  });

  test("a deleted line is removed", () => {
    assert.deepEqual(kinds("a\nb\nc", "a\nc"), ["s:a", "r:b", "s:c"]);
  });

  test("a modified line reads as a removal plus an addition", () => {
    assert.deepEqual(kinds("a\nb", "a\nB"), ["s:a", "r:b", "a:B"]);
  });

  test("empty before means everything is added", () => {
    assert.deepEqual(kinds("", "a\nb"), ["a:a", "a:b"]);
  });

  test("empty after means everything is removed", () => {
    assert.deepEqual(kinds("a\nb", ""), ["r:a", "r:b"]);
  });

  test("both empty is no change at all", () => {
    assert.deepEqual(diffLines("", ""), []);
  });

  test("common lines are preserved rather than rewritten wholesale", () => {
    // A naive diff would mark every line changed; LCS keeps the shared prefix
    // and suffix, which is the whole point of doing this properly.
    const changes = diffLines(
      "intro\nmiddle\nend",
      "intro\nreplaced\nend",
    );
    assert.equal(changes.filter((c) => c.kind === "same").length, 2);
  });
});

describe("field diff", () => {
  const base = {
    model: "claude-opus-5",
    maxSteps: 8,
    timeoutMs: 15_000,
    maxRetries: 2,
    requireApprovalForSideEffecting: true,
    toolKeys: ["calculator", "web_search"],
  };

  test("identical config reports no changes", () => {
    assert.ok(diffFields(base, { ...base }).every((f) => !f.changed));
  });

  test("a changed model is flagged with both values", () => {
    const [model] = diffFields(base, { ...base, model: "claude-sonnet-5" });
    assert.equal(model.changed, true);
    assert.equal(model.before, "claude-opus-5");
    assert.equal(model.after, "claude-sonnet-5");
  });

  test("reordering tools is not a change", () => {
    // The checkbox list has no meaningful order; treating it as one would
    // produce phantom diffs on every save.
    const reordered = { ...base, toolKeys: ["web_search", "calculator"] };
    const tools = diffFields(base, reordered).find((f) => f.label === "Tools")!;
    assert.equal(tools.changed, false);
  });

  test("adding a tool is a change", () => {
    const added = { ...base, toolKeys: [...base.toolKeys, "send_email"] };
    const tools = diffFields(base, added).find((f) => f.label === "Tools")!;
    assert.equal(tools.changed, true);
    assert.match(tools.after, /send_email/);
  });

  test("an empty tool set reads as none rather than blank", () => {
    const tools = diffFields(base, { ...base, toolKeys: [] }).find(
      (f) => f.label === "Tools",
    )!;
    assert.equal(tools.after, "none");
  });

  test("the approval toggle renders as words, not booleans", () => {
    const approval = diffFields(base, {
      ...base,
      requireApprovalForSideEffecting: false,
    }).find((f) => f.label === "Approval for side-effecting")!;

    assert.equal(approval.before, "required");
    assert.equal(approval.after, "not required");
  });
});
