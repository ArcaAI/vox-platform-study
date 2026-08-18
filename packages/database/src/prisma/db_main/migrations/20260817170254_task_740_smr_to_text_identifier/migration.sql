-- TASK-740 — eliminate the `smr` identifier from the DB-persisted plane.
--
-- Owner directive 2026-08-17 (owner-decisions-2026-08-17.md §3b decision 3):
-- "`smr` was renamed to `text`. Do NOT use `smr` anymore!" — which reverses the
-- frozen-identifier position TASK-707 took on exactly these two surfaces.
--
-- Both statements below are RENAMES, never DROP+ADD: the columns and the task
-- keys carry admin-managed configuration (a tenant's chosen provider/model),
-- and re-creating them would silently reset every tenant to the platform
-- default. There is no production data yet (owner decision D-A), but a
-- data-preserving rename is the correct shape regardless and keeps the local
-- dev/test databases usable without a reseed.
--
-- Deliberately NOT rewritten here: `HarnessPolicyChange.beforeJson`/`afterJson`.
-- Those are WORM audit snapshots of what a policy looked like at the time it was
-- edited; rewriting a historical record so it uses today's field names would
-- falsify the audit trail. They keep their `smrProvider`/`smrModel` keys.

-- 1. HarnessPolicy — the text-generation selection columns.
ALTER TABLE "core"."HarnessPolicy" RENAME COLUMN "smrProvider" TO "textProvider";
ALTER TABLE "core"."HarnessPolicy" RENAME COLUMN "smrModel" TO "textModel";

-- 2. AiTaskDefault — the DB-persisted task keys.
--    Covers all five registered keys in one statement: `smr.live`,
--    `smr.finalize`, `smr.test` and the two opt-in `.fallback` variants
--    (`smr.live.fallback`, `smr.finalize.fallback`), since only the `smr.`
--    prefix is replaced. UNIQUE(tenantId, taskKey) cannot collide: no `text.*`
--    task key existed before this migration.
UPDATE "core"."AiTaskDefault"
SET "taskKey" = 'text.' || substring("taskKey" FROM 5)
WHERE "taskKey" LIKE 'smr.%';
