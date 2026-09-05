/*
  Warnings:

  - You are about to drop the column `textModel` on the `HarnessPolicy` table. All the data in the column will be lost.
  - You are about to drop the column `textProvider` on the `HarnessPolicy` table. All the data in the column will be lost.
  - You are about to drop the column `featureDnaReports` on the `PlanEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `featureMonitoringAccess` on the `PlanEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `featureVoiceEnrollment` on the `PlanEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `featureDnaReports` on the `TenantEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `featureMonitoringAccess` on the `TenantEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `featureVoiceEnrollment` on the `TenantEntitlement` table. All the data in the column will be lost.
  - You are about to drop the column `asrModel` on the `TenantFrontendConfig` table. All the data in the column will be lost.
  - You are about to drop the column `diarization` on the `TenantFrontendConfig` table. All the data in the column will be lost.
  - You are about to drop the column `noiseCancel` on the `TenantFrontendConfig` table. All the data in the column will be lost.
  - You are about to drop the column `vad` on the `TenantFrontendConfig` table. All the data in the column will be lost.
  - You are about to drop the column `voiceEnrollment` on the `TenantFrontendConfig` table. All the data in the column will be lost.
  - You are about to drop the `AiTaskDefault` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PipelinePolicy` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PipelinePolicyChange` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `modelId` on table `UserVoiceProfile` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "core"."HarnessPolicy" DROP COLUMN "textModel",
DROP COLUMN "textProvider";

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" DROP COLUMN "featureDnaReports",
DROP COLUMN "featureMonitoringAccess",
DROP COLUMN "featureVoiceEnrollment";

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" DROP COLUMN "featureDnaReports",
DROP COLUMN "featureMonitoringAccess",
DROP COLUMN "featureVoiceEnrollment";

-- AlterTable
ALTER TABLE "core"."TenantFrontendConfig" DROP COLUMN "asrModel",
DROP COLUMN "diarization",
DROP COLUMN "noiseCancel",
DROP COLUMN "vad",
DROP COLUMN "voiceEnrollment";

-- TASK-887 — a voice profile lives in the space of the model that embedded it.
-- (1) The column stops declaring one platform-wide width. Prisma cannot diff an `Unsupported`
--     type change, so this statement is hand-authored: pgvector accepts an un-dimensioned `vector`;
--     per-tenant profile sets are small, so brute-force cosine without an ANN index is the trade
--     (an unsized column cannot carry an ivfflat/hnsw index anyway).
ALTER TABLE "core"."UserVoiceProfile" ALTER COLUMN "embedding" TYPE vector;
-- (2) Backfill BEFORE the NOT NULL: every existing row was written by the platform singleton
--     (`pyannote/wespeaker-voxceleb-resnet34-LM`), whose registry row is `wespeaker-voxceleb-resnet34`.
--     `modelId` held the HuggingFace id (or NULL); it now holds the AiModel SLUG.
UPDATE "core"."UserVoiceProfile"
   SET "modelId" = 'wespeaker-voxceleb-resnet34'
 WHERE "modelId" IS NULL OR "modelId" <> 'wespeaker-voxceleb-resnet34';
-- (3) Only then may it be mandatory.
-- AlterTable
ALTER TABLE "core"."UserVoiceProfile" ALTER COLUMN "modelId" SET NOT NULL;

-- DropTable
DROP TABLE "core"."AiTaskDefault";

-- DropTable
DROP TABLE "core"."PipelinePolicy";

-- DropTable
DROP TABLE "core"."PipelinePolicyChange";

-- TASK-879 — purge the GlobalSetting rows the deleted tts engine flags left behind (seeded by the
-- removed `seed/11d-tts-engine-flags.ts` under the SYSTEM tenant, namespace 'registry'; the registry
-- no longer declares the keys, so the rows are unreachable).
DELETE FROM "core"."GlobalSetting"
 WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
   AND "namespace" = 'registry'
   AND "key" IN ('tts.azure.enabled', 'tts.sarvam.enabled', 'tts.kokoro.enabled', 'tts.parler.enabled', 'tts.indicf5.enabled');

-- TASK-881 — the five retired text task keys keep their AiRoutingPolicy rows on an existing database
-- (the seed no longer writes them; nothing resolves them). Soft-retire is an OWNER decision, so it is
-- recorded here and NOT run:
-- UPDATE "core"."AiRoutingPolicy"
--    SET "resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now(), "_version" = "_version" + 1
--  WHERE "taskKey" IN ('text.live', 'text.finalize', 'text.test', 'text.live.fallback', 'text.finalize.fallback');
-- `ResourceType.AiTaskDefault` (enum member) is retained: Postgres cannot DROP VALUE from an enum.
