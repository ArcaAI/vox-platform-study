-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN     "contentCharCount" INTEGER,
ADD COLUMN     "contentWordCount" INTEGER;

-- AlterTable
ALTER TABLE "core"."TranscriptionJob" ADD COLUMN     "resultCharCount" INTEGER,
ADD COLUMN     "resultWordCount" INTEGER,
ADD COLUMN     "servedBy" JSONB,
ADD COLUMN     "streamSessionId" TEXT;

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenant_consultation_occurredAt_idx" ON "core"."AiUsageEvent"("tenantId", "consultationId", "occurredAt");

-- CreateIndex
CREATE INDEX "TranscriptionJob_tenant_jobType_created_idx" ON "core"."TranscriptionJob"("tenantId", "jobType", "createdAt");

-- CreateIndex
CREATE INDEX "TranscriptionJob_streamSessionId_idx" ON "core"."TranscriptionJob"("streamSessionId");
