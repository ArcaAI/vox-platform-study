-- TASK-490 — UserVoiceProfile.tenantId (voice-profile tenant scoping).
--
-- WHY:
--   The speaker `embedding` on `core."UserVoiceProfile"` is biometric PHI, but
--   the table carried no `tenantId`, so the STT diarization preseed lookups
--   could not be tenant-scoped (TASK-474 finding B-04; the filter in
--   `apps/stt/src/stt/core/database/voice_profile_model.py` was a
--   documented TASK-296 M-6 TODO awaiting this column — master roadmap P2-5).
--   This migration adds the column so every voice-profile read filters by
--   tenant: a cross-tenant lookup returns nothing (404-over-403 posture).
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. Add `tenantId` as NULLABLE so existing rows can be backfilled.
--   2. Backfill each profile with its owner's earliest ENABLED
--      `UserRoleAssignment` tenant (deterministic: createdAt, then id).
--      Profiles whose owner has NO enabled role assignment fall back to the
--      reserved SYSTEM tenant (00000000-…-000000000000). SYSTEM never equals a
--      real tenant in the equality filter, so such rows become unreachable by
--      tenant-scoped reads — fail-closed; the user re-enrolls under a tenant.
--   3. Enforce NOT NULL (house template: `tenantId` NOT NULL, no default —
--      `NULL = global` is banned).
--   4. Index the new column for the tenant-scoped lookups.
--
-- SEMANTICS:
--   `tenantId` is the ENROLLMENT tenant. A user who works in multiple tenants
--   enrolls a profile per tenant; a profile enrolled under tenant A is never
--   served to a session of tenant B (see `TENANT_SCOPED_MODELS` in
--   `packages/database/src/extensions/tenant-scope.ts`, also updated by
--   TASK-490).
--
-- IDEMPOTENCY / SAFETY:
--   Runs once via Prisma Migrate. Step 2 only touches rows where `tenantId`
--   IS NULL (all rows at that point in the migration); no rows are deleted
--   and the biometric payload is untouched. Diarization preseed is off by
--   default (enabled by TASK-475), so there is no live read path racing this
--   backfill.

-- 1) Add the column NULLABLE for the backfill.
ALTER TABLE "core"."UserVoiceProfile" ADD COLUMN "tenantId" TEXT;

-- 2) Backfill from the owner's earliest ENABLED role-assignment tenant;
--    SYSTEM tenant when the owner has none (fail-closed, see header).
UPDATE "core"."UserVoiceProfile" uvp
SET "tenantId" = COALESCE(
  (
    SELECT ura."tenantId"
    FROM "core"."UserRoleAssignment" ura
    WHERE ura."userId" = uvp."userId"
      AND ura."resourceStatus" = 'ENABLED'
    ORDER BY ura."createdAt" ASC, ura."id" ASC
    LIMIT 1
  ),
  '00000000-0000-0000-0000-000000000000'
)
WHERE uvp."tenantId" IS NULL;

-- 3) Enforce NOT NULL (no default — writes must always name their tenant).
ALTER TABLE "core"."UserVoiceProfile" ALTER COLUMN "tenantId" SET NOT NULL;

-- 4) Index for tenant-scoped lookups.
CREATE INDEX "UserVoiceProfile_tenantId_idx" ON "core"."UserVoiceProfile"("tenantId");
