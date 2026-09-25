-- TASK-1006 — drop the pre-agent ASR pipeline data layer (owner decision OD-2, 2026-09-25:
-- "remove both, drop tables", applied after a cluster DB backup).
--
-- Every reader and writer was removed first (gateway/applications, apps/stt, SDKs, console):
-- STT selection is an ASR Agent resolved to a ResolvedAsrSpec (TASK-861), BYO credentials live on
-- AiProviderConnection. The ResourceType enum members AsrPipeline / AsrPipelineVersion /
-- TenantSttConfig are deliberately KEPT as tombstones for historical AuditLog rows.

-- DropForeignKey
ALTER TABLE "core"."AsrPipelineVersion" DROP CONSTRAINT "AsrPipelineVersion_asrPipelineId_fkey";

-- DropForeignKey
ALTER TABLE "core"."TranscriptionJob" DROP CONSTRAINT "TranscriptionJob_pipelineId_fkey";

-- DropIndex
DROP INDEX "core"."TranscriptionJob_pipelineId_idx";

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" DROP COLUMN "maxAsrPipelines";

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" DROP COLUMN "maxAsrPipelines";

-- AlterTable
ALTER TABLE "core"."TranscriptionJob" DROP COLUMN "pipelineId";

-- DropTable
DROP TABLE "core"."AsrPipeline";

-- DropTable
DROP TABLE "core"."AsrPipelineVersion";

-- DropTable
DROP TABLE "core"."TenantSttConfig";

