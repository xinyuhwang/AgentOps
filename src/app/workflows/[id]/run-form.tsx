"use client";

import { useActionState } from "react";
import { runWorkflowFromForm } from "@/server/actions";

/**
 * "Run again", with a form matching the input schema (§3.5). One field per
 * template variable — which is only a meaningful form because the task is a
 * template rather than a fixed string.
 */
export function RunForm({
  workflowId,
  variables,
}: {
  workflowId: string;
  variables: string[];
}) {
  const [state, action, pending] = useActionState(
    runWorkflowFromForm.bind(null, workflowId),
    null,
  );

  return (
    <form action={action} className="space-y-3">
      {variables.length === 0 ? (
        <p className="text-xs text-ink-muted">
          This workflow takes no inputs — its task is fixed.
        </p>
      ) : (
        variables.map((name) => (
          <label key={name} className="block">
            <span className="machine mb-1 block text-xs text-ink-muted">
              {name}
            </span>
            <input
              name={name}
              required
              className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
        ))
      )}

      {state?.errors?.length ? (
        <ul className="space-y-1 text-xs text-status-bad">
          {state.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-accent px-4 py-1.5 text-sm text-accent-ink disabled:opacity-50"
      >
        {pending ? "Starting…" : "Run"}
      </button>
    </form>
  );
}
