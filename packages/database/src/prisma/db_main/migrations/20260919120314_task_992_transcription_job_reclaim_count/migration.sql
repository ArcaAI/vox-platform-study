-- AlterTable
ALTER TABLE "core"."TranscriptionJob" ADD COLUMN     "reclaimCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "TranscriptionJob_status_updated_idx" ON "core"."TranscriptionJob"("status", "updatedAt");
