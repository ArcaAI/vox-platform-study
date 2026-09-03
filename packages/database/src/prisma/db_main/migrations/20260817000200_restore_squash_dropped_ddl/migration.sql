-- Restore DDL and reference data that the 2026-08-17 migration squash dropped.
--
-- The squashed baseline (20260817000000_init) was generated with
-- `prisma migrate diff --from-empty --to-schema`, which can only emit what the
-- Prisma schema DSL can express. Three things are deliberately NOT expressible
-- and were therefore lost silently:
--
--   1. UserVoiceProfile's partial unique index (one ACTIVE profile per user).
--   2. ConsentGrant's partial unique index — consent.prisma:65-72 explicitly
--      warns NOT to "fix" this with a plain @@unique, because a plain unique
--      would also collide on revoked rows and block re-granting.
-- 3. The legacy-grant backfill (Q2 option (a)) for AI_DOCUMENTATION
--      and HISTORY_RETRIEVAL. 22-consent-grant.ts deliberately does NOT seed
--      those two purposes precisely because this backfill covered them — so
--      losing it left consent enforcement (ON by default) denying the core
--      documentation flow for every seeded patient with
--      `Consent denied for purpose "AI_DOCUMENTATION" (no_grant)`.
--
-- Each statement is copied verbatim from the migration it was lost from and is
-- idempotent (IF NOT EXISTS / ON CONFLICT-free anti-join), so re-running is a
-- no-op on a database that already has them.

CREATE UNIQUE INDEX IF NOT EXISTS "UserVoiceProfile_userId_active_unique"
    ON "core"."UserVoiceProfile"("userId")
    WHERE "isActive" = true AND "resourceStatus" = 'ENABLED';

CREATE UNIQUE INDEX IF NOT EXISTS "ConsentGrant_tenant_patient_purpose_active_key"
    ON "core"."ConsentGrant" ("tenantId", "externalPatientId", "purpose")
    WHERE "revokedAt" IS NULL;

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
