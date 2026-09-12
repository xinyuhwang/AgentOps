import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";

async function main() {
  await migrate(db, { migrationsFolder: "./drizzle" });

  /**
   * Circular FK: agents.production_version_id -> agent_versions.id, while
   * agent_versions.agent_id -> agents.id. Drizzle's schema DSL cannot express
   * the cycle, so the constraint is added here, after both tables exist.
   */
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agents_production_version_fk'
      ) THEN
        ALTER TABLE agents
          ADD CONSTRAINT agents_production_version_fk
          FOREIGN KEY (production_version_id)
          REFERENCES agent_versions(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `;

  /** Same story for the two self/cross references on runs. */
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'runs_replayed_from_fk'
      ) THEN
        ALTER TABLE runs
          ADD CONSTRAINT runs_replayed_from_fk
          FOREIGN KEY (replayed_from_run_id)
          REFERENCES runs(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'workflows_source_run_fk'
      ) THEN
        ALTER TABLE workflows
          ADD CONSTRAINT workflows_source_run_fk
          FOREIGN KEY (source_run_id)
          REFERENCES runs(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `;

  console.log("migrations applied");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
