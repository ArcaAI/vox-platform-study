-- CreateEnum
CREATE TYPE "core"."PipelinePolicyScope" AS ENUM ('TENANT', 'DEPARTMENT', 'DOCTOR');

-- CreateTable
CREATE TABLE "core"."PipelinePolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "autoSummaryEnabled" BOOLEAN,
    "autoNerEnabled" BOOLEAN,
    "harnessEnabled" BOOLEAN,
    "dnaStyleEnabled" BOOLEAN,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelinePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PipelinePolicyChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "changedBy" TEXT,
    "policyVersion" INTEGER,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelinePolicyChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelinePolicy_tenant_scope_idx" ON "core"."PipelinePolicy"("tenantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "PipelinePolicy_tenantId_scope_scopeId_key" ON "core"."PipelinePolicy"("tenantId", "scope", "scopeId");

-- CreateIndex
CREATE INDEX "PipelinePolicyChange_tenantId_idx" ON "core"."PipelinePolicyChange"("tenantId");

-- CreateIndex
CREATE INDEX "PipelinePolicyChange_tenant_createdAt_idx" ON "core"."PipelinePolicyChange"("tenantId", "createdAt");

-- =============================================================================
-- TASK-356 Phase 5 — WORM enforcement for PipelinePolicyChange (append-only)
--
-- The bootstrap (manual/vault-admin-bootstrap.sql) sets ALTER DEFAULT
-- PRIVILEGES so newly-created `core` tables auto-grant SELECT/INSERT/UPDATE/
-- DELETE to `hope_app_template` (whose privilege set every dynamic app user
-- inherits via `INHERIT IN ROLE`). Strip UPDATE + DELETE on the policy-change
-- table so rows are append-only at the DB-privilege layer — not just in
-- application code. INSERT + SELECT remain, so every policy edit can be written
-- and read but never mutated or deleted by the application role. Mirrors the
-- HarnessPolicyChange WORM block in
-- `20260607120000_task_330_phase6_harness_policy`.
--
-- Privilege change only — NOT data-destructive (no row is touched). The block
-- is role-existence-guarded + idempotent: REVOKE of a privilege a role does not
-- hold is a no-op, and the guard keeps this migration replayable on a shadow /
-- CI database where the app roles are absent.
-- =============================================================================
DO $worm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app_template') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."PipelinePolicyChange" FROM hope_app_template';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'hope_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "core"."PipelinePolicyChange" FROM hope_app';
  END IF;
END
$worm$;

-- =============================================================================
-- TASK-356 Phase 5 — bootstrap the GLOBAL-DEFAULT pipeline policy (system tenant).
--
-- The realtime cascade (ConfigResolver) resolves each toggle
-- DOCTOR → DEPARTMENT → TENANT → SYSTEM-default → code-default. Seeding exactly
-- ONE SYSTEM-tenant TENANT-scope row means a fresh database is immediately usable
-- and NO per-tenant rows are required: every tenant without an override row falls
-- through to this platform default. The toggles are set explicitly to preserve
-- today's behavior — `autoSummaryEnabled`/`autoNerEnabled` match
-- DEFAULT_PIPELINE_CONFIG (both `true`), and `harnessEnabled = false` matches the
-- legacy platform default (today only the clinical-workspace demo opted into the
-- harness, via the hard-coded UI metadata). Back-compat is therefore preserved
-- platform-wide: removing the UI hard-code does NOT silently route every tenant
-- into the harness. The demo's harness is instead preserved by a SEPARATE demo-
-- tenant TENANT-scope row (`harnessEnabled = true`) written by the
-- `14-pipeline-policy` seed. `dnaStyleEnabled` is left NULL (per-doctor storage;
-- written in Phase 6). `updatedAt` has no column default (Prisma owns it via
-- `@updatedAt`), so it is supplied explicitly.
--
-- Additive + idempotent: a fixed sentinel id + `ON CONFLICT ("id") DO NOTHING`
-- makes the statement a no-op when the row already exists (replay / re-run safe;
-- the PK conflict target avoids the NULLS-DISTINCT semantics of the
-- (tenantId, scope, scopeId) unique index for the null-`scopeId` TENANT row).
-- No row is ever updated or deleted.
-- =============================================================================
INSERT INTO "core"."PipelinePolicy" (
  "id", "tenantId", "scope", "scopeId",
  "autoSummaryEnabled", "autoNerEnabled", "harnessEnabled", "dnaStyleEnabled",
  "updatedAt"
)
VALUES (
  '00000000-0000-0000-0000-0000000000b5',
  '00000000-0000-0000-0000-000000000000',
  'TENANT',
  NULL,
  true,
  true,
  false,
  NULL,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
