-- TASK-1045 — consultation lifecycle simplification: the seven-state status, background processing,
-- encounters, the approval snapshot, the segment-based record model, attachments, feedback and the
-- AI activity run record. Target environments are deployed fresh (owner decision 2026-10-05), so
-- this migration carries NO data backfill; it is still correct on a populated database.
--
-- Sections 1–2 mirror the schema. Sections 3–4 are hand-written and invisible to the schema:
-- partial / expression unique indexes (Prisma cannot express them; precedent
-- `Consultation_encounterKey_uq`) and immutability triggers.

-- ==================================================================================================
-- 1. Types, columns, tables
-- ==================================================================================================

-- CreateEnum
CREATE TYPE "core"."ConsultationProcessing" AS ENUM ('IDLE', 'FINALIZING_TRANSCRIPT', 'SUMMARIZING', 'PROCESSING_ATTACHMENT', 'AWAITING_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."ConsultationClosedReason" AS ENUM ('AUTO', 'MANUAL', 'APPROVED');

-- CreateEnum
CREATE TYPE "core"."ConsultationAttachmentKind" AS ENUM ('DOCUMENT', 'IMAGE', 'AUDIO', 'CASE_NOTE');

-- CreateEnum
CREATE TYPE "core"."ConsultationAttachmentPurpose" AS ENUM ('ATTACHMENT', 'FEEDBACK');

-- CreateEnum
CREATE TYPE "core"."ConsultationAttachmentStatus" AS ENUM ('INTENT', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "core"."FeedbackRating" AS ENUM ('UP', 'DOWN', 'CLEARED');

-- CreateEnum
CREATE TYPE "core"."FeedbackTargetKind" AS ENUM ('NOTE', 'SECTION', 'SEGMENT', 'ENTITY', 'TRANSCRIPT', 'RECAP');

-- CreateEnum
CREATE TYPE "core"."AiActivityKind" AS ENUM ('TRANSCRIBE_STREAM', 'TRANSCRIBE_BATCH', 'NER', 'LIVE_SUMMARY', 'PRE_SUMMARY', 'FACT_LEDGER', 'NOTE_GENERATE', 'NOTE_SECTION_GROUP', 'NOTE_SECTION_REGEN', 'NOTE_REPAIR', 'SENSOR', 'ATTACHMENT_EXTRACT');

-- CreateEnum
CREATE TYPE "core"."AiActivityRunStatus" AS ENUM ('OK', 'ERROR', 'DEGRADED', 'TIMEOUT', 'SKIPPED');

-- AlterEnum — ConsultationStatus is REPLACED by the seven-state vocabulary. The USING clause maps
-- every old value onto the new one, so the swap is correct on a populated table as well as on an
-- empty one (PRIMED/REOPENED → OPEN; DRAINING/DRAFT_PENDING_SENSORS/PENDING_REVIEW → STOPPED;
-- SIGNED → APPROVED; TIMED_OUT → CLOSED_INCOMPLETE; CLOSED → CLOSED_COMPLETE; the rest keep
-- their name). Takes an ACCESS EXCLUSIVE lock and rewrites the table.
BEGIN;
CREATE TYPE "core"."ConsultationStatus_new" AS ENUM ('OPEN', 'RECORDING', 'PAUSED', 'STOPPED', 'APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE');
ALTER TABLE "core"."Consultation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "core"."Consultation" ALTER COLUMN "status" TYPE "core"."ConsultationStatus_new" USING (
  CASE "status"::text
    WHEN 'PRIMED' THEN 'OPEN'
    WHEN 'REOPENED' THEN 'OPEN'
    WHEN 'DRAINING' THEN 'STOPPED'
    WHEN 'DRAFT_PENDING_SENSORS' THEN 'STOPPED'
    WHEN 'PENDING_REVIEW' THEN 'STOPPED'
    WHEN 'SIGNED' THEN 'APPROVED'
    WHEN 'TIMED_OUT' THEN 'CLOSED_INCOMPLETE'
    WHEN 'CLOSED' THEN 'CLOSED_COMPLETE'
    ELSE "status"::text
  END
)::"core"."ConsultationStatus_new";
ALTER TYPE "core"."ConsultationStatus" RENAME TO "ConsultationStatus_old";
ALTER TYPE "core"."ConsultationStatus_new" RENAME TO "ConsultationStatus";
DROP TYPE "core"."ConsultationStatus_old";
ALTER TABLE "core"."Consultation" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;

-- AlterTable
ALTER TABLE "core"."AudioRecording" ADD COLUMN     "codec" TEXT,
ADD COLUMN     "encounterSeq" INTEGER,
ADD COLUMN     "recordingStartMs" INTEGER,
ADD COLUMN     "sttSessionId" TEXT;

-- AlterTable
ALTER TABLE "core"."Consultation" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedReason" "core"."ConsultationClosedReason",
ADD COLUMN     "currentEncounterSeq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "processing" "core"."ConsultationProcessing" NOT NULL DEFAULT 'IDLE',
ADD COLUMN     "processingPrior" "core"."ConsultationProcessing",
ADD COLUMN     "processingReason" TEXT,
ADD COLUMN     "processingRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "processingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "recordingCursorMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reopenCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "segmentSeqHead" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "encounterSeq" INTEGER,
ADD COLUMN     "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "segmentKey" TEXT,
ADD COLUMN     "segmentSeq" INTEGER,
ADD COLUMN     "speaker" TEXT,
ADD COLUMN     "t0Ms" INTEGER,
ADD COLUMN     "t1Ms" INTEGER;

-- AlterTable
ALTER TABLE "core"."GateEditExemplar" ADD COLUMN     "feedbackId" TEXT,
ADD COLUMN     "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'GATE',
ADD COLUMN     "targetKind" TEXT;

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "budgetStrategy" TEXT,
ADD COLUMN     "coverageGapCount" INTEGER,
ADD COLUMN     "coverageStatus" TEXT,
ADD COLUMN     "encryptedCoverageReport" BYTEA,
ADD COLUMN     "noteInputDigest" TEXT;

-- CreateTable
CREATE TABLE "core"."AiActivityRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "consultationId" TEXT,
    "encounterSeq" INTEGER,
    "activityKind" "core"."AiActivityKind" NOT NULL,
    "status" "core"."AiActivityRunStatus" NOT NULL,
    "workflowSlug" TEXT,
    "workflowVersion" INTEGER,
    "workflowRunId" TEXT,
    "nodeId" TEXT,
    "agentId" TEXT,
    "agentSlug" TEXT,
    "agentVersion" INTEGER,
    "promptTemplateId" TEXT,
    "promptVersion" INTEGER,
    "model" TEXT,
    "provider" TEXT,
    "deployment" "core"."AiDeploymentKind",
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "contextUsed" INTEGER,
    "contextWindow" INTEGER,
    "outputCap" INTEGER,
    "stopReason" TEXT,
    "budgetStrategy" TEXT,
    "callIndex" INTEGER,
    "callCount" INTEGER,
    "costMicros" BIGINT,
    "costBasis" "core"."AiCostBasis",
    "usageRequestId" TEXT,
    "errorCode" TEXT,
    "contextItemId" TEXT,
    "outputVersionNumber" INTEGER,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiActivityRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationAttachment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "encounterSeq" INTEGER,
    "purpose" "core"."ConsultationAttachmentPurpose" NOT NULL DEFAULT 'ATTACHMENT',
    "kind" "core"."ConsultationAttachmentKind" NOT NULL,
    "status" "core"."ConsultationAttachmentStatus" NOT NULL DEFAULT 'INTENT',
    "uploadMode" TEXT NOT NULL DEFAULT 'PRESIGNED',
    "declaredMime" TEXT NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "declaredSha256" TEXT NOT NULL,
    "bucketName" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "encryptedFileName" BYTEA,
    "keyVersion" INTEGER,
    "idempotencyKey" TEXT,
    "uploadExpiresAt" TIMESTAMP(3) NOT NULL,
    "intentExpiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "mediaId" TEXT,
    "contextItemId" TEXT,
    "transcriptionJobId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "encounterSeq" INTEGER,
    "actorUserId" TEXT NOT NULL,
    "actorCredentialClass" TEXT NOT NULL,
    "actorPrincipalId" TEXT,
    "clientApp" TEXT,
    "clientSurface" TEXT,
    "targetKind" "core"."FeedbackTargetKind",
    "targetContextItemId" TEXT,
    "targetVersionNumber" INTEGER,
    "targetSectionKey" TEXT,
    "targetDocumentKey" TEXT,
    "targetEntityRef" TEXT,
    "entityLabel" TEXT,
    "targetKey" TEXT,
    "rating" "core"."FeedbackRating",
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedComment" BYTEA,
    "keyVersion" INTEGER,
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "correctionContextItemId" TEXT,
    "correctionVersionNumber" INTEGER,
    "provenance" JSONB,
    "provAgentSlug" TEXT,
    "provAgentVersion" INTEGER,
    "provModelName" TEXT,
    "provPromptVersion" TEXT,
    "provWorkflowRunId" TEXT,
    "provActivityRunId" TEXT,
    "idempotencyKey" TEXT,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "supersedesId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationFeedbackDailyRollup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "targetKind" "core"."FeedbackTargetKind" NOT NULL,
    "agentSlug" TEXT NOT NULL DEFAULT '',
    "agentVersion" INTEGER NOT NULL DEFAULT 0,
    "modelName" TEXT NOT NULL DEFAULT '',
    "promptVersion" TEXT NOT NULL DEFAULT '',
    "sectionKey" TEXT NOT NULL DEFAULT '',
    "entityLabel" TEXT NOT NULL DEFAULT '',
    "reasonCode" TEXT NOT NULL DEFAULT '',
    "upCount" INTEGER NOT NULL DEFAULT 0,
    "downCount" INTEGER NOT NULL DEFAULT 0,
    "clearedCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "reasonedCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationFeedbackDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationEncounter" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "visitType" TEXT NOT NULL,
    "externalRef" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "recordingStartMs" INTEGER,
    "recordingEndMs" INTEGER,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationEncounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationApproval" (
    "_metadata" JSONB,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consultationVersion" INTEGER NOT NULL,
    "encounterCount" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "attestationHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationApproval_pkey" PRIMARY KEY ("id")
);

-- ==================================================================================================
-- 2. Indexes and foreign keys
-- ==================================================================================================

-- CreateIndex
CREATE UNIQUE INDEX "AiActivityRun_runKey_key" ON "core"."AiActivityRun"("runKey");

-- CreateIndex
CREATE INDEX "AiActivityRun_tenant_consultation_started_idx" ON "core"."AiActivityRun"("tenantId", "consultationId", "startedAt");

-- CreateIndex
CREATE INDEX "AiActivityRun_tenant_workflowRun_idx" ON "core"."AiActivityRun"("tenantId", "workflowRunId");

-- CreateIndex
CREATE INDEX "AiActivityRun_tenant_item_version_idx" ON "core"."AiActivityRun"("tenantId", "contextItemId", "outputVersionNumber");

-- CreateIndex
CREATE INDEX "ConsultationAttachment_tenantId_idx" ON "core"."ConsultationAttachment"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationAttachment_tenant_consultation_idx" ON "core"."ConsultationAttachment"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "ConsultationAttachment_reap_idx" ON "core"."ConsultationAttachment"("status", "intentExpiresAt");

-- CreateIndex
CREATE INDEX "ConsultationAttachment_job_idx" ON "core"."ConsultationAttachment"("transcriptionJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationAttachment_idem_uq" ON "core"."ConsultationAttachment"("tenantId", "consultationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_tenantId_consultationId_createdAt_idx" ON "core"."ConsultationFeedback"("tenantId", "consultationId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_tenantId_createdAt_idx" ON "core"."ConsultationFeedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_tenantId_actorUserId_targetKey_isLates_idx" ON "core"."ConsultationFeedback"("tenantId", "actorUserId", "targetKey", "isLatest");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationFeedbackDailyRollup_dim_uq" ON "core"."ConsultationFeedbackDailyRollup"("tenantId", "day", "targetKind", "agentSlug", "agentVersion", "modelName", "promptVersion", "sectionKey", "entityLabel", "reasonCode");

-- CreateIndex
CREATE INDEX "ConsultationEncounter_tenantId_idx" ON "core"."ConsultationEncounter"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationEncounter_consultationId_idx" ON "core"."ConsultationEncounter"("consultationId");

-- CreateIndex
CREATE INDEX "ConsultationEncounter_tenant_externalRef_idx" ON "core"."ConsultationEncounter"("tenantId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationEncounter_consultation_seq_key" ON "core"."ConsultationEncounter"("consultationId", "seq");

-- CreateIndex
CREATE INDEX "ConsultationApproval_tenantId_idx" ON "core"."ConsultationApproval"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationApproval_consultation_approvedAt_idx" ON "core"."ConsultationApproval"("consultationId", "approvedAt");

-- CreateIndex
CREATE INDEX "Consultation_status_lastActivity_idx" ON "core"."Consultation"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Consultation_openKey_idx" ON "core"."Consultation"("tenantId", "doctorId", "patientId", "departmentId");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_occurred_idx" ON "core"."ContextItem"("consultationId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_type_segmentSeq_idx" ON "core"."ContextItem"("consultationId", "type", "segmentSeq");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_encounter_idx" ON "core"."ContextItem"("consultationId", "encounterSeq");

-- CreateIndex
CREATE INDEX "GateEditExemplar_tenant_source_idx" ON "core"."GateEditExemplar"("tenantId", "source");

-- AddForeignKey
ALTER TABLE "core"."ConsultationEncounter" ADD CONSTRAINT "ConsultationEncounter_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ConsultationApproval" ADD CONSTRAINT "ConsultationApproval_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==================================================================================================
-- 3. Partial / expression unique indexes
-- ==================================================================================================

-- The OPEN KEY: at most one non-closed consultation per (tenant, doctor, patient, department),
-- department null-safe. Soft-deleted rows are outside the key. A racing `open` loses on this index
-- and returns the winner. `Consultation_encounterKey_uq` (TASK-1020) is kept.
CREATE UNIQUE INDEX "Consultation_openKey_uq" ON "core"."Consultation"("tenantId", "doctorId", "patientId", COALESCE("departmentId", ''))
  WHERE "status" NOT IN ('CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') AND "resourceStatus" <> 'DELETED';

-- An encounter's caller ref names one encounter per consultation; encounters without a ref repeat.
CREATE UNIQUE INDEX "ConsultationEncounter_externalRef_uq" ON "core"."ConsultationEncounter"("consultationId", "externalRef")
  WHERE "externalRef" IS NOT NULL;

-- Segment ingest is idempotent: "<sttSessionId>:<utteranceIndex>" once per consultation.
CREATE UNIQUE INDEX "ContextItem_segmentKey_uq" ON "core"."ContextItem"("consultationId", "segmentKey")
  WHERE "segmentKey" IS NOT NULL;

-- One live FULL_TRANSCRIPT per consultation (later rebuilds are versions of it).
CREATE UNIQUE INDEX "ContextItem_fullTranscript_uq" ON "core"."ContextItem"("consultationId")
  WHERE "type" = 'FULL_TRANSCRIPT' AND "resourceStatus" <> 'DELETED';

-- One live fact ledger and one live recap per encounter.
CREATE UNIQUE INDEX "ContextItem_encounterArtifact_uq" ON "core"."ContextItem"("consultationId", "type", "encounterSeq")
  WHERE "type" IN ('FACT_LEDGER', 'ENCOUNTER_RECAP') AND "resourceStatus" <> 'DELETED';

-- One LATEST rating per (tenant, actor, target); superseded rows and comment-only rows repeat.
CREATE UNIQUE INDEX "ConsultationFeedback_latest_uq" ON "core"."ConsultationFeedback"("tenantId", "actorUserId", "targetKey")
  WHERE "isLatest" AND "rating" IS NOT NULL AND "targetKey" IS NOT NULL;

-- ==================================================================================================
-- 4. Immutability triggers
-- ==================================================================================================

-- ContextItemVersion: a version is history — a correction is a NEW version. DELETE always raises;
-- UPDATE raises only when the row would actually change, so an idempotent seed upsert that rewrites
-- identical values is tolerated.
CREATE OR REPLACE FUNCTION "core"."context_item_version_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ContextItemVersion %: versions are immutable — a correction is a new version, never a delete', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ContextItemVersion %: versions are immutable — a correction is a new version, never an update', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "context_item_version_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."ContextItemVersion"
FOR EACH ROW
EXECUTE FUNCTION "core"."context_item_version_immutability_guard"();

-- ConsultationApproval: the approval snapshot is written once; a re-approval is a new row.
CREATE OR REPLACE FUNCTION "core"."consultation_approval_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ConsultationApproval %: approval snapshots are immutable — a re-approval writes a new row', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "consultation_approval_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."ConsultationApproval"
FOR EACH ROW
EXECUTE FUNCTION "core"."consultation_approval_immutability_guard"();
