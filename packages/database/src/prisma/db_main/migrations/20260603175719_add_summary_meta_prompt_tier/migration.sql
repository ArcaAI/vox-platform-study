-- TASK-331 doc-06 F4: persist the prompt-resolution tier + the prompt id actually
-- used onto SummaryMeta so the summary surface can show which tier
-- (preferred/department/default) produced a given summary. The tier was already
-- computed and forwarded to SMR; it was never persisted. Backward-compatible:
-- both columns are nullable and the index is additive (no DROP/DELETE/TRUNCATE).

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "promptResolvedFrom" TEXT,
ADD COLUMN     "resolvedPromptId" TEXT;

-- CreateIndex
CREATE INDEX "SummaryMeta_promptResolvedFrom_idx" ON "core"."SummaryMeta"("promptResolvedFrom");
