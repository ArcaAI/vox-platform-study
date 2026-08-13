-- CreateTable
CREATE TABLE "core"."HarnessPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityFaithfulnessThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "coverageThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "citationPresenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "numericDoseThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "groundednessThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "safetyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "phiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "phiFailClosed" BOOLEAN NOT NULL DEFAULT true,
    "safetyProvider" TEXT NOT NULL DEFAULT 'lm-studio',
    "safetyModel" TEXT NOT NULL DEFAULT 'granite-guardian-4.1-8b',
    "smrProvider" TEXT,
    "smrModel" TEXT,
    "maxRegen" INTEGER NOT NULL DEFAULT 2,
    "gateSlaSeconds" INTEGER NOT NULL DEFAULT 86400,
    "gateEscalationSeconds" INTEGER NOT NULL DEFAULT 43200,
    "toolAllowlist" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarnessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."HarnessPolicyChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "changedBy" TEXT,
    "policyVersion" INTEGER,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarnessPolicyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HarnessPolicy_tenantId_key" ON "core"."HarnessPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessPolicyChange_tenantId_idx" ON "core"."HarnessPolicyChange"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessPolicyChange_tenant_createdAt_idx" ON "core"."HarnessPolicyChange"("tenantId", "createdAt");

-- =============================================================================
-- WORM enforcement for HarnessPolicyChange (append-only)
--
-- The bootstrap (manual/vault-admin-bootstrap.sql) sets ALTER DEFAULT
-- PRIVILEGES so newly-created `core` tables auto-grant SELECT/INSERT/UPDATE/
-- DELETE to `hope_app_template` (whose privilege set every dynamic app user
-- inherits via `INHERIT IN ROLE`). Strip UPDATE + DELETE on the policy-change
-- table so rows are append-only at the DB-privilege layer — not just in
-- application code. INSERT + SELECT remain, so every policy edit can be written
-- and read but never mutated or deleted by the application role. Mirrors the
-- HarnessAuditEvent WORM block in
-- `20260606143138_task_330_add_clinical_harness_eval_and_worm_audit`.
--
-- Privilege change only — NOT data-destructive (no row is touched). The block
-- is role-existence-guarded + idempotent: REVOKE of a privilege a role does not
-- hold is a no-op, and the guard keeps this migration replayable on a shadow /
-- CI database where the app roles are absent.
-- =============================================================================
DO $worm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."HarnessPolicyChange" FROM hope_app_template';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."HarnessPolicyChange" FROM hope_app';
  END IF;
END
$worm$;

-- =============================================================================
-- Bootstrap the GLOBAL-DEFAULT policy row (system tenant).
--
-- Every tenant computes its effective policy as "own row OVERRIDES the system
-- default", and the durable worker reads the effective policy through
-- `GET /internal/harness/policy`. Both paths — plus the OCC `If-Match` write
-- contract (which requires an existing row at `_version >= 1`) — need the
-- SYSTEM-tenant default to exist. Seed exactly one row here so a fresh database
-- is immediately usable; all knob columns fall back to their DB `@default`s
-- (which mirror the harness code defaults), so this single INSERT stays in
-- lock-step with the schema. `updatedAt` has no column default (Prisma owns it
-- via `@updatedAt`), so it is supplied explicitly.
--
-- Additive + idempotent: `ON CONFLICT ("tenantId") DO NOTHING` makes the
-- statement a no-op when the row already exists (replay / re-run safe). No row
-- is ever updated or deleted.
-- =============================================================================
INSERT INTO "core"."HarnessPolicy" ("id", "tenantId", "updatedAt")
VALUES (
  '00000000-0000-0000-0000-0000000000a6',
  '00000000-0000-0000-0000-000000000000',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("tenantId") DO NOTHING;
