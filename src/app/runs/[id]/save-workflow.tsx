"use client";

import { useState } from "react";
import { saveRunAsWorkflow } from "@/server/actions";

/**
 * Capture a completed run as a workflow (§3.5).
 *
 * The template starts as the run's actual task. Turning a literal into
 * `{{order_id}}` is the whole act of parameterising, so the field is editable
 * and the hint says so — there is no separate "add a variable" ceremony.
 */
export function SaveAsWorkflow({
  runId,
  task,
  suggestedName,
}: {
  runId: string;
  task: string;
  suggestedName: string;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-line-strong px-2 py-1 text-xs transition-colors hover:bg-surface-sunken"
      >
        Save as workflow
      </button>
    );
  }

  return (
    <form
      action={saveRunAsWorkflow.bind(null, runId)}
      className="w-full space-y-3 border-t border-line pt-3"
    >
      <label className="block">
        <span className="mb-1 block text-xs text-ink-muted">Name</span>
        <input
          name="name"
          required
          defaultValue={suggestedName}
          className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs text-ink-muted">Task template</span>
        <textarea
          name="template"
          required
          rows={3}
          defaultValue={task}
          className="machine w-full rounded border border-line px-2 py-1.5 text-xs outline-none focus:border-accent"
        />
        <span className="mt-1 block text-xs text-ink-faint">
          Replace the parts that should vary with{" "}
          <span className="machine">{"{{name}}"}</span> — each one becomes an
          input on the workflow and a field in its API payload.
        </span>
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded bg-accent px-3 py-1 text-xs text-accent-ink"
        >
          Save workflow
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-line-strong px-3 py-1 text-xs"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
