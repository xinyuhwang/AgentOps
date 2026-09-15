import { notFound } from "next/navigation";
import { getAgent } from "@/server/queries";
import { saveAgentConfig, startRun } from "@/server/actions";
import { SELECTABLE_MODELS } from "@/core/llm/pricing";

export const dynamic = "force-dynamic";

/**
 * §3.2 — a single form, top to bottom, one column. No sidebar of metrics next
 * to it: config is config, results live in Runs.
 */
export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getAgent(id);
  if (!data) notFound();

  const { agent, production, allTools, attachedToolIds } = data;
  const hasSideEffectingAttached = allTools.some(
    (t) => attachedToolIds.has(t.id) && t.sideEffecting,
  );
  // A draft has never been saved, so there is no production version to run.
  const isDraft = agent.productionVersionId === null;

  const saveConfig = saveAgentConfig.bind(null, id);
  const run = startRun.bind(null, id);

  return (
    <div className="max-w-xl space-y-8">
      <form action={saveConfig} className="space-y-5">
        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">Model</span>
          <select
            name="model"
            defaultValue={production?.model ?? "claude-opus-5"}
            className="machine w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {SELECTABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-ink-muted">
            System instructions
          </span>
          <textarea
            name="systemInstructions"
            rows={6}
            defaultValue={production?.systemInstructions ?? ""}
            className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
        </label>

        <fieldset>
          <legend className="mb-2 text-xs text-ink-muted">Tools</legend>
          <div className="space-y-1.5">
            {allTools.map((tool) => (
              <label key={tool.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="tools"
                  value={tool.id}
                  defaultChecked={attachedToolIds.has(tool.id)}
                />
                <span>{tool.displayName}</span>
                <span className="machine text-xs text-ink-faint">
                  {tool.key}@{tool.version}
                </span>
                {/* Marked because these are the tools approval and replay
                    treat specially (§3.2). */}
                {tool.sideEffecting ? (
                  <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                    side-effecting
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Progressive disclosure (§5): most users never touch these. */}
        <details className="rounded border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm">Execution</summary>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">Max steps</span>
              <input
                type="number"
                name="maxSteps"
                defaultValue={production?.maxSteps ?? 12}
                className="machine w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">
                Timeout (ms)
              </span>
              <input
                type="number"
                name="timeoutMs"
                defaultValue={production?.timeoutMs ?? 30_000}
                className="machine w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-ink-muted">Retries</span>
              <input
                type="number"
                name="maxRetries"
                defaultValue={production?.maxRetries ?? 2}
                className="machine w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
            </label>
          </div>
        </details>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="requireApproval"
            defaultChecked={production?.requireApprovalForSideEffecting ?? true}
            disabled={!hasSideEffectingAttached}
            className="mt-0.5"
          />
          <span>
            Require approval before side-effecting tools
            <span className="mt-0.5 block text-xs text-ink-muted">
              {hasSideEffectingAttached
                ? "Scope comes from each tool's definition, not a global notion of “external”."
                : "No side-effecting tool is attached, so this has nothing to gate."}
            </span>
          </span>
        </label>

        <button
          type="submit"
          className={
            isDraft
              ? "rounded bg-accent px-4 py-1.5 text-sm text-accent-ink"
              : "rounded border border-line-strong px-3 py-1.5 text-sm transition-colors hover:bg-surface-sunken"
          }
        >
          {isDraft ? "Save and promote to production" : "Save"}
        </button>
        <p className="text-xs text-ink-faint">
          {isDraft
            ? "This agent is a draft and cannot run yet. Saving promotes it to production."
            : "Once a run has used a version, saving cuts a new one rather than editing it, so every past run still points at the exact config that produced it."}
        </p>
      </form>

      <form
        action={run}
        className="flex items-end gap-3 border-t border-line pt-6"
      >
        <label className="flex-1">
          <span className="mb-1 block text-xs text-ink-muted">Task</span>
          <input
            name="task"
            required
            disabled={isDraft}
            placeholder={
              isDraft
                ? "Save the configuration above first"
                : "Check refund status for order 1182"
            }
            className="w-full rounded border border-line px-2 py-1.5 text-sm outline-none focus:border-accent disabled:bg-surface-sunken disabled:text-ink-faint"
          />
        </label>
        {/* The one primary action on this screen once the agent is real (§5).
            While it is a draft, Save carries that role instead. */}
        <button
          type="submit"
          disabled={isDraft}
          className="rounded bg-accent px-4 py-1.5 text-sm text-accent-ink disabled:opacity-40"
        >
          Run
        </button>
      </form>
    </div>
  );
}
