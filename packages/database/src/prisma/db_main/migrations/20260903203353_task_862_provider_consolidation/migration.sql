-- TASK-862 — AI Provider consolidation.
--
--   1. `AiProviderConnection` gains the connection-level CEILINGS that used to
--      live on `AiRuntimeProfile` (`maxConcurrent`, `rpmLimit`, `tpmLimit`,
--      `timeoutS`). All nullable = "no opinion".
--   2. `AiRuntimeProfile` is DROPPED (retired: ceilings → the connection row,
--      generation hyper-parameters → the Agent, TASK-863). Its `ResourceType`
--      enum member is left in place (removing a Postgres enum value is a
--      rewrite; the audit rows that reference it stay readable).
--   3. `ProviderReconciliationRun` is DROPPED outright (owner directive
--      2026-09-04: Provider Reconciliation removed completely).
--
-- Authored against a schema diff of dev-2.2 → this branch (no shadow DB was
-- available in the worktree); never applied here — the orchestrator applies it
-- through the normal `db:migrate:deploy` path.

-- AlterTable
ALTER TABLE "core"."AiProviderConnection" ADD COLUMN     "maxConcurrent" INTEGER,
ADD COLUMN     "rpmLimit" INTEGER,
ADD COLUMN     "timeoutS" INTEGER,
ADD COLUMN     "tpmLimit" INTEGER;

-- DropTable
DROP TABLE "core"."AiRuntimeProfile";

-- DropTable
DROP TABLE "core"."ProviderReconciliationRun";

