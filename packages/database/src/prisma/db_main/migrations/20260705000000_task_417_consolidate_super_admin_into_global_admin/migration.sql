-- Consolidate SUPER_ADMIN into GLOBAL_ADMIN (data migration, no DDL).
--
-- WHY:
--   SUPER_ADMIN and GLOBAL_ADMIN were treated identically by the code-side
-- guard (`tenant-guards.ELEVATED_ROLES`). collapses the pair into a
--   single canonical elevated role: GLOBAL_ADMIN. After this migration the
--   SUPER_ADMIN role is retired (soft-deleted) and every user that held it
--   holds an equivalent GLOBAL_ADMIN assignment instead.
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. Ensures the GLOBAL_ADMIN role row exists (seed-reserved id …0003) when
--      a live SUPER_ADMIN row exists — for environments seeded before
-- Introduced GLOBAL_ADMIN.
--   2. Copies every live RolePolicy attachment from SUPER_ADMIN to
--      GLOBAL_ADMIN so GLOBAL_ADMIN carries everything SUPER_ADMIN had
--      (system-full-access, rbac-system-manage, global-settings-manage, …).
--   3. Reassigns every live SUPER_ADMIN UserRoleAssignment to GLOBAL_ADMIN —
--      INSERT of an equivalent row preserving tenantId / scopeOverrides /
--      resourceStatus (operator-DISABLED assignments stay disabled).
--   4. Soft-deletes the now-redundant SUPER_ADMIN assignments.
--   5. Soft-deletes the SUPER_ADMIN role row itself.
--   SUPER_ADMIN's own RolePolicy rows are left in place (inert once the role
--   is DELETED) as a historical record of what the retired role granted.
--
-- IDEMPOTENCY:
--   Re-running is a no-op. Every INSERT is guarded by ON CONFLICT DO NOTHING
--   on the table's natural unique key; both UPDATEs skip rows already
--   DELETED; steps 2-4 find no live SUPER_ADMIN rows on a second run.
--
-- SAFETY / BACKWARD COMPATIBILITY:
--   - UPDATE/INSERT only — no DELETE / DROP / TRUNCATE (platform hard rule).
--   - Soft delete follows the platform convention: resourceStatus='DELETED'
--     + resourceStatusUpdatedAt/By + updatedBy/updatedAt + _version bump.
--   - Reassignment happens BEFORE retirement, inside one migration
--     transaction — no window where a former SUPER_ADMIN user is unprivileged.
--   - Writer id 60000000-0000-0000-0000-000000000000 is the System user.
--
-- PRE-FLIGHT (ops — snapshot what will be touched):
--   SELECT r.name, r."resourceStatus", count(ura.id) AS live_assignments
--   FROM core."Role" r
--   LEFT JOIN core."UserRoleAssignment" ura
--     ON ura."roleId" = r.id AND ura."resourceStatus" <> 'DELETED'
--   WHERE r.name IN ('SUPER_ADMIN', 'GLOBAL_ADMIN')
--   GROUP BY 1, 2;
--
-- POST-FLIGHT (expect: SUPER_ADMIN role DELETED with 0 live assignments;
-- every former holder has a GLOBAL_ADMIN assignment in the same tenant):
--   SELECT count(*) FROM core."UserRoleAssignment" ura
--   JOIN core."Role" r ON r.id = ura."roleId"
--   WHERE r.name = 'SUPER_ADMIN' AND ura."resourceStatus" <> 'DELETED';
--   -- expect 0

-- =============================================================================
-- STEP 1 — Ensure the GLOBAL_ADMIN role exists (seed-reserved id …0003)
-- =============================================================================

INSERT INTO core."Role" (
    id, "_metadata", "_version", name, description, "externalName",
    "isSystemRole", "parentRoleId",
    "resourceStatus", "createdBy", "createdAt", "updatedAt"
)
SELECT
    '00000000-0000-0000-0000-000000000003',
    '{}'::jsonb,
    1,
    'GLOBAL_ADMIN',
    'Elevated platform-wide administrator with full access across all tenants',
    'Global Administrator',
    true,
    NULL,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    now(),
    now()
WHERE EXISTS (
    SELECT 1 FROM core."Role"
    WHERE name = 'SUPER_ADMIN' AND "resourceStatus" <> 'DELETED'
)
  AND NOT EXISTS (
    SELECT 1 FROM core."Role"
    WHERE id = '00000000-0000-0000-0000-000000000003'
)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- STEP 2 — GLOBAL_ADMIN inherits every live SUPER_ADMIN policy attachment
-- =============================================================================

INSERT INTO core."RolePolicy" (
    id, "_metadata", "_version", priority,
    "resourceStatus", "createdBy", "createdAt", "updatedAt",
    "roleId", "policyId"
)
SELECT
    gen_random_uuid()::text,
    '{}'::jsonb,
    1,
    rp.priority,
    'ENABLED',
    '60000000-0000-0000-0000-000000000000',
    now(),
    now(),
    ga.id,
    rp."policyId"
FROM core."RolePolicy" rp
JOIN core."Role" sa ON sa.id = rp."roleId" AND sa.name = 'SUPER_ADMIN'
JOIN core."Role" ga ON ga.name = 'GLOBAL_ADMIN'
WHERE rp."resourceStatus" <> 'DELETED'
ON CONFLICT ("roleId", "policyId") DO NOTHING;

-- =============================================================================
-- STEP 3 — Reassign live SUPER_ADMIN user-role assignments to GLOBAL_ADMIN
--          (tenantId / scopeOverrides / resourceStatus preserved; existing
--          GLOBAL_ADMIN assignments are skipped by the unique-key guard)
-- =============================================================================

INSERT INTO core."UserRoleAssignment" (
    id, "_metadata", "_version", "tenantId", "scopeOverrides",
    "resourceStatus", "createdBy", "createdAt", "updatedAt",
    "userId", "roleId"
)
SELECT
    gen_random_uuid()::text,
    ura."_metadata",
    1,
    ura."tenantId",
    ura."scopeOverrides",
    ura."resourceStatus",
    '60000000-0000-0000-0000-000000000000',
    now(),
    now(),
    ura."userId",
    ga.id
FROM core."UserRoleAssignment" ura
JOIN core."Role" sa ON sa.id = ura."roleId" AND sa.name = 'SUPER_ADMIN'
JOIN core."Role" ga ON ga.name = 'GLOBAL_ADMIN'
WHERE ura."resourceStatus" <> 'DELETED'
ON CONFLICT ("userId", "roleId", "tenantId") DO NOTHING;

-- =============================================================================
-- STEP 4 — Soft-delete the now-redundant SUPER_ADMIN assignments
-- =============================================================================

UPDATE core."UserRoleAssignment" ura
SET "resourceStatus"          = 'DELETED',
    "resourceStatusUpdatedAt" = now(),
    "resourceStatusUpdatedBy" = '60000000-0000-0000-0000-000000000000',
    "updatedBy"               = '60000000-0000-0000-0000-000000000000',
    "updatedAt"               = now(),
    "_version"                = ura."_version" + 1
FROM core."Role" sa
WHERE sa.id = ura."roleId"
  AND sa.name = 'SUPER_ADMIN'
  AND ura."resourceStatus" <> 'DELETED';

-- =============================================================================
-- STEP 5 — Soft-delete (retire) the SUPER_ADMIN role row
-- =============================================================================

UPDATE core."Role"
SET "resourceStatus"          = 'DELETED',
    "resourceStatusUpdatedAt" = now(),
    "resourceStatusUpdatedBy" = '60000000-0000-0000-0000-000000000000',
    "updatedBy"               = '60000000-0000-0000-0000-000000000000',
    "updatedAt"               = now(),
    "_version"                = "_version" + 1
WHERE name = 'SUPER_ADMIN'
  AND "resourceStatus" <> 'DELETED';
