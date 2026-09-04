-- TASK-861 — TranscriptionJob re-keyed to the ASR Agent version: `agentVersionId` + `resolvedSpec`
-- snapshot added, `pipelineId` (FK → AsrPipeline, deprecated) made nullable. Authored against a
-- git-archive base schema with `prisma migrate diff`; additive, no data step.

-- DropForeignKey
ALTER TABLE "core"."TranscriptionJob" DROP CONSTRAINT "TranscriptionJob_pipelineId_fkey";

-- AlterTable
ALTER TABLE "core"."TranscriptionJob" ADD COLUMN     "agentVersionId" TEXT,
ADD COLUMN     "resolvedSpec" JSONB,
ALTER COLUMN "pipelineId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "TranscriptionJob_agentVersionId_idx" ON "core"."TranscriptionJob"("agentVersionId");

-- AddForeignKey
ALTER TABLE "core"."TranscriptionJob" ADD CONSTRAINT "TranscriptionJob_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "core"."AsrPipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;

