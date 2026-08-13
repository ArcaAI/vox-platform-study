-- CreateEnum
CREATE TYPE "core"."HarnessAuditAction" AS ENUM ('GENERATE', 'SENSOR_RUN', 'GATE_DECISION', 'ATTEST', 'CONSENT_GIVEN', 'CONSENT_WITHDRAWN', 'BREACH_REPORTED', 'REDUCED_ASSURANCE');

-- CreateTable
CREATE TABLE "core"."GoldenSet" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pinnedVersion" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GoldenCase" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "label" TEXT,
    "transcript" TEXT NOT NULL,
    "referenceNote" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."EvalRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "promptTemplateId" TEXT,
    "promptVersion" TEXT,
    "judgeModel" TEXT,
    "status" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "aggregateScores" JSONB,
    "notes" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."EvalScore" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "goldenCaseId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION,
    "rationale" TEXT,
    "judgeModel" TEXT,
    "details" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."HarnessAuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "contextItemVersionId" TEXT,
    "action" "core"."HarnessAuditAction" NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "promptTemplateId" TEXT,
    "promptVersion" TEXT,
    "sensorScores" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "gateDecision" TEXT,
    "clinicianId" TEXT,
    "attestationHash" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarnessAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoldenSet_tenantId_idx" ON "core"."GoldenSet"("tenantId");

-- CreateIndex
CREATE INDEX "GoldenSet_tenant_name_idx" ON "core"."GoldenSet"("tenantId", "name");

-- CreateIndex
CREATE INDEX "GoldenCase_tenantId_idx" ON "core"."GoldenCase"("tenantId");

-- CreateIndex
CREATE INDEX "GoldenCase_goldenSetId_idx" ON "core"."GoldenCase"("goldenSetId");

-- CreateIndex
CREATE INDEX "GoldenCase_tenant_set_idx" ON "core"."GoldenCase"("tenantId", "goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenantId_idx" ON "core"."EvalRun"("tenantId");

-- CreateIndex
CREATE INDEX "EvalRun_goldenSetId_idx" ON "core"."EvalRun"("goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenant_set_idx" ON "core"."EvalRun"("tenantId", "goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenant_createdAt_idx" ON "core"."EvalRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EvalScore_tenantId_idx" ON "core"."EvalScore"("tenantId");

-- CreateIndex
CREATE INDEX "EvalScore_evalRunId_idx" ON "core"."EvalScore"("evalRunId");

-- CreateIndex
CREATE INDEX "EvalScore_goldenCaseId_idx" ON "core"."EvalScore"("goldenCaseId");

-- CreateIndex
CREATE INDEX "EvalScore_tenant_run_idx" ON "core"."EvalScore"("tenantId", "evalRunId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenantId_idx" ON "core"."HarnessAuditEvent"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenant_consultation_idx" ON "core"."HarnessAuditEvent"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenant_createdAt_idx" ON "core"."HarnessAuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_consultationId_idx" ON "core"."HarnessAuditEvent"("consultationId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_prevHash_idx" ON "core"."HarnessAuditEvent"("prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "HarnessAuditEvent_hash_key" ON "core"."HarnessAuditEvent"("hash");

-- AddForeignKey
ALTER TABLE "core"."GoldenCase" ADD CONSTRAINT "GoldenCase_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "core"."GoldenSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalRun" ADD CONSTRAINT "EvalRun_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "core"."GoldenSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalScore" ADD CONSTRAINT "EvalScore_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "core"."EvalRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalScore" ADD CONSTRAINT "EvalScore_goldenCaseId_fkey" FOREIGN KEY ("goldenCaseId") REFERENCES "core"."GoldenCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- WORM enforcement for HarnessAuditEvent (append-only)
--
-- The bootstrap (manual/vault-admin-bootstrap.sql) sets ALTER DEFAULT
-- PRIVILEGES so newly-created `core` tables auto-grant SELECT/INSERT/UPDATE/
-- DELETE to `hope_app_template` (whose privilege set every dynamic app user
-- inherits via `INHERIT IN ROLE`). Strip UPDATE + DELETE on the audit table so
-- rows are append-only at the DB-privilege layer — not just in application
-- code. INSERT + SELECT remain, so the hash-chained log can be written and read
-- but never mutated or deleted by the application role.
--
-- Privilege change only — NOT data-destructive (no row is touched). The block
-- is role-existence-guarded + idempotent: REVOKE of a privilege a role does not
-- hold is a no-op, and the guard keeps this migration replayable on a shadow /
-- CI database where the app roles are absent.
-- =============================================================================
DO $worm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."HarnessAuditEvent" FROM hope_app_template';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."HarnessAuditEvent" FROM hope_app';
  END IF;
END
$worm$;
