import { Empty, PageHeader } from "../_components/ui";

/**
 * Workflows are captured from successful runs, not built on a canvas (§3.5).
 * The nav item is here from Phase 1 so the three-item IA is real; the capture
 * flow itself is Phase 2.
 */
export default function WorkflowsPage() {
  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="A workflow is a saved run: its step sequence, the agent version it pinned, and an input schema."
      />
      <Empty>
        Nothing saved yet. Workflows are captured from a successful run rather
        than constructed from scratch — that capture step arrives in Phase 2.
      </Empty>
    </>
  );
}
