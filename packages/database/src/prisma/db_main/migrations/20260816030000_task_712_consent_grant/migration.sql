-- Consent & ABAC (TASK-712) — the ConsentGrant model, its two enums, the
-- partial-unique-active-grant constraint, and the legacy-grant backfill
-- that must ship in the SAME deploy as HTTP consent enforcement.
--
-- Proven empty-diff against a throwaway `hope_shadow` database via
-- `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
-- per .claude/rules/02-database-prisma.md §Migration Workflow — see
-- docs/implementation/TASK-712-Consent-Abac/README.md §7 for the pasted
-- output and date.
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. CreateEnum ConsentPurpose, ConsentGrantMethod.
--   2. AlterEnum ResourceType += 'ConsentGrant' (AuditLog INSERT parity —
--      packages/domains/src/enums/__tests__/resourceType.enum-parity.test.ts).
--   3. CreateTable ConsentGrant + its two plain query indexes.
--   4. CreateIndex — a PARTIAL unique index scoped to ACTIVE grants only
--      (`WHERE "revokedAt" IS NULL`). Prisma 7 cannot express a partial
--      unique index in schema DSL (consent.prisma documents this; the
--      `UserVoiceProfile_userId_active_unique` index in
--      20260413000000_add_user_voice_profile is the same pattern in this
--      repo). A PLAIN @@unique on (tenantId, externalPatientId, purpose)
--      would be wrong: Postgres unique indexes treat every row as live
--      regardless of `revokedAt`, so `revoke()` — which never deletes —
--      would permanently block a fresh grant for the same purpose. The
--      partial index is what makes "revoke, then grant again" (and the
--      widening-is-a-new-row design in consent-design.md §3) actually work.
--   5. INSERT — the legacy-grant backfill (Q2, owner-decided 2026-08-16,
--      option (a) in docs/implementation/TASK-712-Consent-Abac/README.md
--      §6): a dated legacy `ConsentGrant`, `grantMethod = 'IMPORTED'`, per
--      existing (tenantId, externalPatientId) pair that already has at
--      least one Consultation — for the two purposes THIS deploy actually
--      gates at HTTP enforcement (see PatientConsentGuard route wiring on
--      apps/api/src/modules/consultation/consultation.controller.ts, shipped
--      in this SAME deploy): AI_DOCUMENTATION (capture start) and
--      HISTORY_RETRIEVAL (history/chain reads). EXTERNAL_TOOL_LOOKUP,
--      STYLE_LEARNING, QUALITY_REVIEW are NOT backfilled — nothing gates on
--      them yet (Phase 4/harness wiring is not part of this deploy), so
--      manufacturing a grant for them now would be a fabricated consent
--      record with no corresponding enforcement to justify it.
--
-- CRITICAL ORDERING — this is the whole risk this migration exists to
-- retire. Step 5 runs inside THIS migration's transaction, ahead of any
-- code deploy. If the backfill INSERT fails for any reason, the ENTIRE
-- migration rolls back (schema change included) and `prisma migrate
-- deploy`'s exit code is non-zero — which is exactly what the `db-migrate`
-- PreSync Job (`.claude/rules/09-infrastructure-devops.md` — Cluster
-- Deploys — k3s + ArgoCD) gates the API rollout on. A failed backfill
-- therefore means the API image carrying `PatientConsentGuard` never rolls
-- out, and every existing chart stays reachable under the OLD (no-consent)
-- code. Never split this migration from the guard's code deploy, and never
-- apply this migration without the backfill step — that combination is
-- exactly "fail-closed enforcement ships with zero legacy grants", which
-- bricks every pre-existing chart (README §6 Q2's stated impact).
--
-- IDEMPOTENCY: every statement below is IF NOT EXISTS / ON CONFLICT DO
-- NOTHING guarded. Safe to re-run, including by hand against the
-- db-push-managed dev/test databases described in
-- .claude/rules/02-database-prisma.md §Migration Workflow (`pnpm db:push`
-- applies the schema; it does NOT execute this file's DML, so on those
-- databases re-apply this file's INSERT — Step 5 only — by hand, e.g. via
-- `psql "$DATABASE_URL" -f <this file>` or the `mcp__postgres__execute`
-- tool, after `pnpm db:push`).
--
-- BACKWARD COMPATIBILITY: additive only — no existing table, column, or
-- enum value is altered or dropped.

-- CreateEnum
CREATE TYPE "core"."ConsentPurpose" AS ENUM ('AI_DOCUMENTATION', 'HISTORY_RETRIEVAL', 'EXTERNAL_TOOL_LOOKUP', 'STYLE_LEARNING', 'QUALITY_REVIEW');

-- CreateEnum
CREATE TYPE "core"."ConsentGrantMethod" AS ENUM ('VERBAL_ATTESTED', 'WRITTEN', 'PORTAL', 'IMPORTED');

-- AlterEnum
-- Audit resource type for ConsentGrant create/revoke. MUST stay in
-- lock-step with packages/domains/src/enums/generated/ResourceType.ts —
-- omitting it makes every AuditLog INSERT for this resource throw and rolls
-- the originating mutation into a 500 (guard: resourceType.enum-parity.test.ts).
-- Safe inside the migration transaction (PostgreSQL >= 12 allows ADD VALUE in
-- a transaction block provided the new value is not USED in the same
-- transaction — the backfill below inserts ConsentGrant rows, not AuditLog
-- rows, so it never reads this enum value back out).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ConsentGrant';

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."ConsentGrant" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalPatientId" TEXT NOT NULL,
    "purpose" "core"."ConsentPurpose" NOT NULL,
    "scope" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantMethod" "core"."ConsentGrantMethod" NOT NULL,
    "evidenceRef" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConsentGrant_tenantId_idx" ON "core"."ConsentGrant"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ConsentGrant_tenant_patient_idx" ON "core"."ConsentGrant"("tenantId", "externalPatientId");

-- CreateIndex (PARTIAL — see the header note above; this is the real
-- uniqueness guarantee, not the plain indexes above).
CREATE UNIQUE INDEX IF NOT EXISTS "ConsentGrant_tenant_patient_purpose_active_key"
    ON "core"."ConsentGrant" ("tenantId", "externalPatientId", "purpose")
    WHERE "revokedAt" IS NULL;

-- Legacy-grant backfill (Q2 option (a); see header). Idempotent via
-- ON CONFLICT against the partial unique index above.
INSERT INTO "core"."ConsentGrant" (
    "id", "tenantId", "externalPatientId", "purpose", "grantedAt", "grantedBy",
    "grantMethod", "evidenceRef", "createdBy", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    c."tenantId",
    c."patientId",
    p."purpose",
    now(),
    '60000000-0000-0000-0000-000000000000',
    'IMPORTED',
    'task-712-legacy-backfill',
    '60000000-0000-0000-0000-000000000000',
    now()
FROM (
    -- TRIM matches normalizeExternalPatientId (Q3 — trim only, exact-case
    -- match; packages/applications/src/services/consent/consent.constants.ts)
    -- so the backfilled row's key matches exactly what assertConsent looks
    -- up. Rows with a blank patientId (never a real identifier) are skipped.
    SELECT DISTINCT "tenantId", TRIM("patientId") AS "patientId"
    FROM "core"."Consultation"
    WHERE TRIM("patientId") <> ''
) c
CROSS JOIN (VALUES ('AI_DOCUMENTATION'::"core"."ConsentPurpose"), ('HISTORY_RETRIEVAL'::"core"."ConsentPurpose")) AS p("purpose")
ON CONFLICT DO NOTHING;
