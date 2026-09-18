/**
 * Version diffing (§3.6, §6 Phase 2).
 *
 * Pure functions with no database access, so the comparison logic is testable
 * on its own and the page stays a renderer.
 */

export type LineChange = {
  kind: "same" | "added" | "removed";
  text: string;
};

/**
 * A line-level diff via longest common subsequence.
 *
 * Hand-rolled rather than pulled from a package: system instructions are a
 * handful of lines, and the LCS table is small enough that the dependency
 * would cost more than the code. If instructions ever grow to the point where
 * an O(n*m) table matters, swap this one function out.
 */
export function diffLines(before: string, after: string): LineChange[] {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: LineChange[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      out.push({ kind: "added", text: b[j] });
      j++;
    }
  }

  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });

  return out;
}

export function hasChanges(changes: LineChange[]): boolean {
  return changes.some((c) => c.kind !== "same");
}

export type FieldChange = {
  label: string;
  before: string;
  after: string;
  changed: boolean;
};

export type VersionConfig = {
  model: string;
  maxSteps: number;
  timeoutMs: number;
  maxRetries: number;
  requireApprovalForSideEffecting: boolean;
  toolKeys: string[];
};

/**
 * Scalar config differences, in the order the Overview form presents them —
 * so a diff reads like the form the change was made in.
 */
export function diffFields(
  before: VersionConfig,
  after: VersionConfig,
): FieldChange[] {
  const field = (label: string, x: string, y: string): FieldChange => ({
    label,
    before: x,
    after: y,
    changed: x !== y,
  });

  // Tool sets are compared as sets: reordering the checkbox list is not a change.
  const tools = (c: VersionConfig) =>
    c.toolKeys.length > 0 ? [...c.toolKeys].sort().join(", ") : "none";

  return [
    field("Model", before.model, after.model),
    field("Max steps", String(before.maxSteps), String(after.maxSteps)),
    field("Timeout", `${before.timeoutMs}ms`, `${after.timeoutMs}ms`),
    field("Retries", String(before.maxRetries), String(after.maxRetries)),
    field(
      "Approval for side-effecting",
      before.requireApprovalForSideEffecting ? "required" : "not required",
      after.requireApprovalForSideEffecting ? "required" : "not required",
    ),
    field("Tools", tools(before), tools(after)),
  ];
}
