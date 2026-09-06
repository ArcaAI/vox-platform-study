/*
  Warnings:

  - You are about to drop the column `downloadStatus` on the `AiModel` table. All the data in the column will be lost.
  - You are about to drop the column `downloadedAt` on the `AiModel` table. All the data in the column will be lost.
  - You are about to drop the column `fileSizeMb` on the `AiModel` table. All the data in the column will be lost.
  - You are about to drop the column `localPath` on the `AiModel` table. All the data in the column will be lost.

*/

-- TASK-890 (L2) — context-schema pin, BYO model provenance, the deprecated
-- download bookkeeping dropped, and the routing repoint at `wireModelId`.
--
-- §3.1 / §3.4 / §3.11 of `docs/implementation/TASK-890-Agent-Prompt-Context-Journeys/README.md`.
-- Authored on a throwaway shadow database (`hope_shadow_890`) per rule 02
-- §"Authoring a migration"; `prisma migrate diff --from-config-datasource --to-schema`
-- reports an empty migration against the schema after this file is applied.
--
-- The DATA step is first, and it is the only statement here that is not DDL:
-- `AiModel.wireModelId` becomes the ROUTED id (what goes on the wire), so every
-- engine-served row that carried its wire id in `sourceUri` alone is backfilled
-- BEFORE anything downstream starts reading `wireModelId`. `sourceUri` keeps its
-- LOCATOR meaning (the Hub repo / bucket source the inventory job publishes from).
--
-- Deliberately NO `SET NOT NULL` on `wireModelId`: the requirement is CONDITIONAL
-- (`deploymentKind = CLOUD` or an engine-served SELF_HOSTED row), and a SELF_HOSTED
-- row whose identity IS its bucket prefix — the whisper / VAD / denoise / NER weights
-- the platform's own services load — legitimately has none. A column-level NOT NULL
-- would reject exactly those rows; the service enforces the conditional rule on write.
--
-- The provider list mirrors `ENGINE_SERVED_PROVIDERS`
-- (`packages/applications/src/services/ai-provider-connection/constants.ts:195`);
-- `built-in` is deliberately absent — it is the platform-self-host sentinel, not an
-- engine with its own model store.

-- DataMigration: `wireModelId` is the routed id (§3.1)
UPDATE "core"."AiModel"
   SET "wireModelId" = "sourceUri"
 WHERE "wireModelId" IS NULL
   AND "sourceUri" IS NOT NULL
   AND "provider" IN ('lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp');

-- AlterTable
ALTER TABLE "core"."Agent" ADD COLUMN     "contextSchemaId" TEXT,
ADD COLUMN     "contextSchemaVersionNumber" INTEGER;

-- AlterTable
ALTER TABLE "core"."AiModel" DROP COLUMN "downloadStatus",
DROP COLUMN "downloadedAt",
DROP COLUMN "fileSizeMb",
DROP COLUMN "localPath",
ADD COLUMN     "sourceConnectionId" TEXT;

-- AlterTable
ALTER TABLE "core"."PromptTemplate" ADD COLUMN     "sourceTemplateId" TEXT,
ADD COLUMN     "templateLocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "core"."WorkflowDefinition" ADD COLUMN     "sourceTemplateSlug" TEXT,
ADD COLUMN     "templateLocked" BOOLEAN NOT NULL DEFAULT false;

-- DropEnum
DROP TYPE "core"."AiModelDownloadStatus";

-- CreateIndex
CREATE INDEX "Agent_contextSchemaId_idx" ON "core"."Agent"("contextSchemaId");

-- CreateIndex
CREATE INDEX "AiModel_sourceConnectionId_idx" ON "core"."AiModel"("sourceConnectionId");

-- CreateIndex
CREATE INDEX "PromptTemplate_tenant_sourceTemplateId_idx" ON "core"."PromptTemplate"("tenantId", "sourceTemplateId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenant_sourceTemplateSlug_idx" ON "core"."WorkflowDefinition"("tenantId", "sourceTemplateSlug");

-- AddForeignKey
ALTER TABLE "core"."AiModel" ADD CONSTRAINT "AiModel_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "core"."AiProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
