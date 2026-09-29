-- AlterTable
ALTER TABLE "core"."AuditLog" ADD COLUMN     "traceId" VARCHAR(32);

-- CreateIndex
CREATE INDEX "AuditLog_traceId_idx" ON "core"."AuditLog"("traceId");
