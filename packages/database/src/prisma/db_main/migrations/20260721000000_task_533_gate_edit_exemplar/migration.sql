-- Gate-edit mining store.
--
-- A DERIVED, append-only learning corpus built from the clinician
-- approve-vs-edit signal. The WORM `HarnessAuditEvent` remains the audit
-- truth; this table is a queryable projection used for (a) eval
-- regression-corpus export behind the golden-set SME gate and (b) per-department
-- few-shot exemplar retrieval in prompt assembly.
--
-- PHI POSTURE: `redactedBefore` / `redactedAfter` are PHI-REDACTED AT WRITE by
-- the mining job, which fails CLOSED (a redaction failure drops the candidate
-- rather than persisting it). No PHI is expected to reach this table, so —
-- unlike the WORM audit tables — it carries NO UPDATE/DELETE revoke and is
-- deletable wholesale for retention.
--
-- Soft-delete EXEMPT: no `resourceStatus` column (registered in
-- MODELS_WITHOUT_SOFT_DELETE). Tenant-scoped (registered in
-- TENANT_SCOPED_MODELS) and NOT SYSTEM-shared — one tenant's mined exemplars
-- must never surface in another tenant's retrieval.

-- ResourceType is emitted by the mining job's broadcastSysEvent. IF NOT EXISTS
-- because a prior, since-reverted attempt at this migration already appended the
-- label on some developer databases, and Postgres cannot drop an enum value.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'GateEditExemplar';

CREATE TABLE "core"."GateEditExemplar" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "departmentId" TEXT,
    "visitType" TEXT,
    "gateDecision" TEXT NOT NULL,
    "qualitySignal" TEXT NOT NULL,
    "editDistance" INTEGER,
    "editDistanceRatio" DOUBLE PRECISION,
    "timeToSignSeconds" INTEGER,
    "redactedBefore" TEXT,
    "redactedAfter" TEXT,
    "contextItemId" TEXT,
    "modelName" TEXT,
    "promptTemplateId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateEditExemplar_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GateEditExemplar_tenantId_idx" ON "core"."GateEditExemplar"("tenantId");

-- Idempotency guard for the mining job (findByConsultation).
CREATE INDEX "GateEditExemplar_tenant_consultation_idx" ON "core"."GateEditExemplar"("tenantId", "consultationId");

-- Retrieval path: findTopForRetrieval filters (tenantId, qualitySignal
-- [, departmentId]) and orders by createdAt DESC.
CREATE INDEX "GateEditExemplar_retrieval_idx" ON "core"."GateEditExemplar"("tenantId", "departmentId", "qualitySignal", "createdAt");
