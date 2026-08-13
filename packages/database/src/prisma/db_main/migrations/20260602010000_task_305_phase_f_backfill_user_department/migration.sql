-- User<->Tenant membership backfill (role + department).
--
-- WHY:
--   Phase F enforces the invariant "a non-exempt user must belong to a tenant
--   via BOTH an ENABLED UserRoleAssignment (role) AND an ENABLED UserDepartment
--   (department)". The role half was always enforced; the department half is
--   new. Without this backfill, every pre-existing user that has a role but no
--   department would be locked out at login (the login flow and
--   `assertUserBelongsToTenant` both require an ENABLED UserDepartment for
--   non-exempt users — see `apps/api/src/modules/auth/auth.controller.ts` and
--   `packages/applications/src/common/tenant-guards.ts`).
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. Ensure a `GEN` (General Practice) department exists for every tenant
--      that has at least one non-exempt, ENABLED role assignment. Idempotent
--      via the existing `Department_tenantId_code_key` unique (tenantId, code).
--   2. Create a PRIMARY, ENABLED `UserDepartment` for every (userId, tenantId)
--      that has a non-exempt, ENABLED `UserRoleAssignment` but no ENABLED
--      `UserDepartment` in that tenant — pointing at that tenant's `GEN`
--      department. Idempotent via the `UserDepartment_tenant_user_department_unique`
--      unique (tenantId, userId, departmentId) + a NOT EXISTS guard.
--
-- EXEMPT (intentionally NOT backfilled — mirrors the login / guard exemption):
--   - Service accounts (`User.isServiceAccount = true`).
--   - `SUPER_ADMIN` role assignments (roleId 00000000-…-000000000001).
--   - The reserved system tenant (00000000-…-000000000000) — platform-wide
--     assignments, not customer memberships.
--
-- IDEMPOTENCY:
--   Re-running is a no-op: step 1 is `ON CONFLICT (tenantId, code) DO NOTHING`;
--   step 2 only targets memberships with NO existing ENABLED UserDepartment and
--   is additionally guarded by `ON CONFLICT (tenantId, userId, departmentId)
--   DO NOTHING`.
--
-- PRE-FLIGHT (ops should confirm BEFORE running this migration):
--   - Snapshot the population this migration will touch:
--       SELECT ura."tenantId", count(DISTINCT ura."userId") AS role_only_users
--       FROM core."UserRoleAssignment" ura
--       JOIN core."User" u ON u.id = ura."userId"
--       WHERE ura."resourceStatus" = 'ENABLED'
--         AND u."isServiceAccount" = false
--         AND ura."roleId" <> '00000000-0000-0000-0000-000000000001'
--         AND ura."tenantId" <> '00000000-0000-0000-0000-000000000000'
--         AND NOT EXISTS (
--           SELECT 1 FROM core."UserDepartment" ud
--           WHERE ud."userId" = ura."userId" AND ud."tenantId" = ura."tenantId"
--             AND ud."resourceStatus" = 'ENABLED')
--       GROUP BY 1 ORDER BY 1;
--     Review the per-tenant counts; each such user gets a primary GEN dept.
--   - If a tenant should map its users to a more specific department than GEN,
--     assign those UserDepartments first (this migration only fills the gap).
--
-- POST-FLIGHT (smoke checks — expect zero rows / one GEN per touched tenant):
--   - Zero non-exempt role-only memberships remain:
--       SELECT count(*)
--       FROM core."UserRoleAssignment" ura
--       JOIN core."User" u ON u.id = ura."userId"
--       WHERE ura."resourceStatus" = 'ENABLED'
--         AND u."isServiceAccount" = false
--         AND ura."roleId" <> '00000000-0000-0000-0000-000000000001'
--         AND ura."tenantId" <> '00000000-0000-0000-0000-000000000000'
--         AND NOT EXISTS (
--           SELECT 1 FROM core."UserDepartment" ud
--           WHERE ud."userId" = ura."userId" AND ud."tenantId" = ura."tenantId"
--             AND ud."resourceStatus" = 'ENABLED');
--       -- expect 0
--   - Every touched tenant has exactly one ENABLED GEN department:
--       SELECT "tenantId", count(*) FROM core."Department"
--       WHERE code = 'GEN' AND "resourceStatus" = 'ENABLED' GROUP BY 1;
--
-- BACKWARD COMPATIBILITY / SAFETY:
--   - INSERT-only. No row is updated, dropped, or deleted.
--   - Existing UserDepartment rows (including more specific, non-GEN
--     assignments) are left untouched; a user who already has any ENABLED
--     department is skipped entirely.
--   - The auto-created GEN departments carry null prompt configuration; a tenant
--     can refine them later via the admin console.
--
-- =============================================================================
-- STEP 1 — Ensure a GEN department exists for every non-exempt tenant
-- =============================================================================

INSERT INTO core."Department" (
    id, "tenantId", code, name, description,
    "defaultSummaryTemplate", "_metadata", "_version",
    "resourceStatus", "createdBy", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    t."tenantId",
    'GEN',
    'General Practice',
    'General medical consultations and primary care (auto-created by TASK-305 Phase F membership backfill).',
    'SOAP',
    '{}'::jsonb,
    1,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    now(),
    now()
FROM (
    SELECT DISTINCT ura."tenantId"
    FROM core."UserRoleAssignment" ura
    JOIN core."User" u ON u.id = ura."userId"
    WHERE ura."resourceStatus" = 'ENABLED'
      AND u."isServiceAccount" = false
      AND ura."roleId" <> '00000000-0000-0000-0000-000000000001'  -- SUPER_ADMIN
      AND ura."tenantId" <> '00000000-0000-0000-0000-000000000000'  -- system tenant
) t
ON CONFLICT ("tenantId", code) DO NOTHING;

-- =============================================================================
-- STEP 2 — Create a primary UserDepartment for every non-exempt, role-only
--          membership, pointing at its tenant's GEN department
-- =============================================================================

INSERT INTO core."UserDepartment" (
    id, "_metadata", "_version", "tenantId", "isPrimary",
    "resourceStatus", "createdBy", "createdAt", "updatedAt",
    "userId", "departmentId"
)
SELECT
    gen_random_uuid()::text,
    '{}'::jsonb,
    1,
    m."tenantId",
    true,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    now(),
    now(),
    m."userId",
    m."departmentId"
FROM (
    SELECT DISTINCT
        ura."userId",
        ura."tenantId",
        d.id AS "departmentId"
    FROM core."UserRoleAssignment" ura
    JOIN core."User" u ON u.id = ura."userId"
    JOIN LATERAL (
        SELECT dep.id
        FROM core."Department" dep
        WHERE dep."tenantId" = ura."tenantId"
          AND dep.code = 'GEN'
          AND dep."resourceStatus" <> 'DELETED'
        ORDER BY (dep."resourceStatus" = 'ENABLED') DESC, dep."createdAt", dep.id
        LIMIT 1
    ) d ON true
    WHERE ura."resourceStatus" = 'ENABLED'
      AND u."isServiceAccount" = false
      AND ura."roleId" <> '00000000-0000-0000-0000-000000000001'  -- SUPER_ADMIN
      AND ura."tenantId" <> '00000000-0000-0000-0000-000000000000'  -- system tenant
      AND NOT EXISTS (
          SELECT 1
          FROM core."UserDepartment" ud
          WHERE ud."userId" = ura."userId"
            AND ud."tenantId" = ura."tenantId"
            AND ud."resourceStatus" = 'ENABLED'
      )
) m
ON CONFLICT ("tenantId", "userId", "departmentId") DO NOTHING;
