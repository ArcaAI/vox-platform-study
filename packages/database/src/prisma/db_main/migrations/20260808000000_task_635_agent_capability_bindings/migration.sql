-- TASK-635 C2 (DR-1 / DR-4) — capability-keyed agent bindings + session-agent lineage.
--
-- PURELY ADDITIVE. Ten nullable columns across two existing tables; no
-- defaults, no backfill, no index changes, no table rewrites. Every existing
-- row reads NULL on every new column, and every resolution path treats NULL as
-- "fall through to exactly what happens today" — so the 36 seeded
-- DepartmentAgent rows (18 SYSTEM golden + 18 Global clones) change behavior by
-- zero bytes and no data migration is required.
--
-- DepartmentAgent (6): four capability-keyed PromptTemplate bindings (loose
--   String refs, deliberately WITHOUT FK relations — the legacy
--   `Department.newPatientPromptId` precedent; integrity is service- and
--   resolver-enforced), plus `toolConfig` (which live-loop tools run) and
--   `llmOverrides` (per-task { live, finalize } model override, OD-3b).
-- SummaryMeta (2): the frozen session-agent lineage written by finalize (C5).
--
-- Roll-forward only. Committed together with the .prisma schema files.

-- AlterTable
ALTER TABLE "core"."DepartmentAgent" ADD COLUMN     "livePromptTemplateId" TEXT,
ADD COLUMN     "llmOverrides" JSONB,
ADD COLUMN     "newPatientTemplateId" TEXT,
ADD COLUMN     "preSummaryTemplateId" TEXT,
ADD COLUMN     "revisitTemplateId" TEXT,
ADD COLUMN     "toolConfig" JSONB;

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "sessionAgentId" TEXT,
ADD COLUMN     "sessionAgentPromptVersion" TEXT;
