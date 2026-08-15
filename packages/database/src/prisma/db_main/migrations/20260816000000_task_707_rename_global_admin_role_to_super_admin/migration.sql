-- TASK-707 (naming-alignment, D8): rename the elevated Role.name literal
-- 'GLOBAL_ADMIN' to 'SUPER_ADMIN' (data migration, no DDL on this table).
--
-- WHY:
--   design.md D8 confirms this is a pure rename, not a semantic merge:
--   `ELEVATED_ROLES` (packages/applications/src/common/tenant-guards.ts) is
--   `readonly string[] = [GLOBAL_ADMIN_ROLE]` — exactly one entry — so there
--   is only one elevated role to rename. This migration renames the live
--   Role row; the code-side literal sweep (ELEVATED_ROLES, seed source
--   arrays, DTOs, SDK constants, ...) is a SEPARATE ticket task (Task 9/10)
--   that must land in the SAME deploy window as this migration, never split
--   across a release boundary (an un-renamed code literal would no longer
--   recognize any row this migration touches — a full lockout of the
--   platform's only elevated role).
--
-- PRECEDENT SHAPE IMITATED (mirror-image rename):
--   20260705000000_task_417_consolidate_super_admin_into_global_admin
--   That migration retired the id 00000000-0000-0000-0000-000000000001 role
--   row by soft-deleting it — WITHOUT renaming its `name` column away from
--   'SUPER_ADMIN'. `Role.name` carries a plain (non-partial) unique index
--   (`Role_name_key`, confirmed in migration 20260320044312 —
--   `CREATE UNIQUE INDEX "Role_name_key" ON "core"."Role"("name")`), so a
--   soft-deleted row still occupies its `name` value. Renaming the LIVE
--   GLOBAL_ADMIN row (id ...0003) straight to 'SUPER_ADMIN' would collide
--   with that still-occupied dead value and fail the unique constraint —
--   this is a genuinely new problem the reverse rename has that the forward
--   one didn't (GLOBAL_ADMIN had no pre-existing retired row squatting on
--   its name in 2026-07-05). STEP 1 below clears that collision first.
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. Renames the retired (soft-deleted) legacy role at id ...0001 away
--      from 'SUPER_ADMIN' to a clearly-dead placeholder, freeing the
--      'SUPER_ADMIN' name for the live elevated role. No-ops if that row no
--      longer holds name = 'SUPER_ADMIN' (already migrated, or never seeded
--      in this environment because TASK-417 hasn't landed here).
--   2. Renames the live GLOBAL_ADMIN role row (id ...0003, or any row
--      currently named 'GLOBAL_ADMIN' — there can only ever be one, by the
--      same unique index) to 'SUPER_ADMIN'.
--
-- IDEMPOTENCY:
--   Re-running is a no-op. Both UPDATEs are guarded by an exact-match WHERE
--   on the CURRENT name, so a second run finds zero matching rows for either
--   step.
--
-- SAFETY / BACKWARD COMPATIBILITY:
--   - UPDATE only — no DELETE / DROP / TRUNCATE / INSERT (platform hard
--     rule); no row's resourceStatus or soft-delete state changes, only
--     `name` (+ the standard audit/version bump).
--   - Writer id 60000000-0000-0000-0000-000000000000 is the System user.
--   - This migration does NOT touch `core."ChangelogAudience"` (a real
--     Prisma enum with a GLOBAL_ADMIN member, packages/database/src/prisma/
--     db_main/enums.prisma). That half of TASK-707's Group B Task 8 is
--     HUMAN-GATED and intentionally deferred — see the standalone finding
--     below. Do not add `ALTER TYPE "core"."ChangelogAudience" RENAME VALUE
--     'GLOBAL_ADMIN' TO 'SUPER_ADMIN'` to this or any migration without that
--     gate being explicitly cleared by a human first.
--
-- PRE-FLIGHT (ops — snapshot what will be touched):
--   SELECT id, name, "resourceStatus" FROM core."Role"
--   WHERE name IN ('GLOBAL_ADMIN', 'SUPER_ADMIN');
--
-- POST-FLIGHT (expect: exactly one row named 'SUPER_ADMIN' with
-- "resourceStatus" = 'ENABLED' (id ...0003); the id ...0001 legacy row, if
-- it existed, now carries the placeholder name and is still DELETED; zero
-- rows remain named 'GLOBAL_ADMIN'):
--   SELECT id, name, "resourceStatus" FROM core."Role"
--   WHERE name IN ('GLOBAL_ADMIN', 'SUPER_ADMIN', 'SUPER_ADMIN__RETIRED_TASK_417');

-- =============================================================================
-- STEP 1 — Free the 'SUPER_ADMIN' name from the TASK-417-retired legacy row
-- =============================================================================

UPDATE core."Role"
SET name                      = 'SUPER_ADMIN__RETIRED_TASK_417',
    "updatedBy"                = '60000000-0000-0000-0000-000000000000',
    "updatedAt"                = now(),
    "_version"                 = "_version" + 1
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND name = 'SUPER_ADMIN'
  AND "resourceStatus" = 'DELETED';

-- =============================================================================
-- STEP 2 — Rename the live GLOBAL_ADMIN role to SUPER_ADMIN
-- =============================================================================

UPDATE core."Role"
SET name                      = 'SUPER_ADMIN',
    "updatedBy"                = '60000000-0000-0000-0000-000000000000',
    "updatedAt"                = now(),
    "_version"                 = "_version" + 1
WHERE name = 'GLOBAL_ADMIN';
