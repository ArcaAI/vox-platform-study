# SEC-003: RBAC Healthcare Role Migration

| Field | Value |
|-------|-------|
| **Ticket Number** | SEC-003 |
| **Feature Name** | Migrate to Healthcare-Focused RBAC Roles |
| **Created Date** | 2026-01-26 |
| **Last Updated** | 2026-01-26 |
| **Status** | Pending |

---

## 1. Requirement Analysis

### 1.1 Background

The HOPE platform has transitioned from a generic RBAC model to a **healthcare-focused RBAC design** as documented in `docs/RBAC_BEST_PRACTICES.md`. This migration ticket covers:

1. Applying the new seed data (roles and policies)
2. Migrating existing users to appropriate new roles
3. Deprecating legacy roles
4. Testing the new permission structure

### 1.2 New Role Structure

| New Role | Replaces | Target Users |
|----------|----------|--------------|
| `SUPER_ADMIN` | SUPER_ADMIN | No change |
| `TENANT_ADMIN` | TENANT_ADMIN, ADMIN | Tenant administrators |
| `DOCTOR` | USER (clinicians) | Doctors, clinicians who own consultations |
| `NURSE` | VIEWER, USER (support) | Nurses, medical assistants |
| `SERVICE_ACCOUNT` | API_USER | Backend integrations |
| `DEPARTMENT_HEAD` | MANAGER | Team leads with delegation |
| `SENIOR_NURSE` | (new) | Senior nursing staff |

### 1.3 Acceptance Criteria

- [ ] New policies seeded to database
- [ ] New roles seeded with correct policy assignments
- [ ] Existing users mapped to appropriate new roles
- [ ] Legacy roles marked as deprecated (not deleted)
- [ ] All existing functionality continues to work
- [ ] Audit log captures role migration changes
- [ ] Documentation updated

---

## 2. Current State Evaluation

### 2.1 Existing Role Assignments

Before migration, audit current role assignments:

```sql
-- Count users per role
SELECT r.name, COUNT(ura.id) as user_count
FROM "core"."Role" r
LEFT JOIN "core"."UserRoleAssignment" ura ON r.id = ura."roleId"
GROUP BY r.name
ORDER BY user_count DESC;
```

### 2.2 Migration Mapping Rules

| Current Role | Condition | New Role |
|--------------|-----------|----------|
| `SUPER_ADMIN` | - | `SUPER_ADMIN` (no change) |
| `TENANT_ADMIN` | - | `TENANT_ADMIN` (no change, policies updated) |
| `ADMIN` | Has management duties | `TENANT_ADMIN` or `DEPARTMENT_HEAD` |
| `MANAGER` | Manages clinical team | `DEPARTMENT_HEAD` |
| `USER` | Creates consultations | `DOCTOR` |
| `USER` | Only views consultations | `NURSE` |
| `VIEWER` | - | `NURSE` |
| `API_USER` | - | `SERVICE_ACCOUNT` |

### 2.3 Risk Assessment

| Risk | Mitigation |
|------|------------|
| Users lose access | Dry-run migration first, verify mappings |
| Breaking changes | Legacy roles preserved, not deleted |
| Data inconsistency | Transaction-based migration |
| Rollback needed | Keep old role assignments, soft migration |

---

## 3. Implementation Plan

### Phase 1: Seed New Data (Low Risk)

**Estimated Effort**: 30 minutes

1. Run the updated seed script to add new policies and roles
2. Verify new roles/policies exist alongside legacy ones
3. No user impact (additive changes only)

**Commands**:
```bash
# From project root
pnpm --filter @arcaai/database db:seed
```

**Verification**:
```sql
-- Verify new policies exist
SELECT name, scope FROM "core"."Policy"
WHERE name IN ('system-full-access', 'consultation-own-manage', 'consultation-read-assigned');

-- Verify new roles exist
SELECT name, "isSystemRole", "parentRoleId" FROM "core"."Role"
WHERE name IN ('DOCTOR', 'NURSE', 'SERVICE_ACCOUNT', 'DEPARTMENT_HEAD');
```

---

### Phase 2: User Mapping Analysis (No Changes)

**Estimated Effort**: 1-2 hours

1. Generate migration report showing current vs proposed role assignments
2. Review with stakeholders
3. Identify edge cases

**Migration Report Query**:
```sql
-- Generate migration mapping report
WITH current_assignments AS (
    SELECT
        u.id as user_id,
        u.username,
        r.name as current_role,
        ura."tenantId"
    FROM "core"."User" u
    JOIN "core"."UserRoleAssignment" ura ON u.id = ura."userId"
    JOIN "core"."Role" r ON ura."roleId" = r.id
    WHERE u."resourceStatus" = 'ENABLED'
)
SELECT
    current_role,
    COUNT(*) as user_count,
    CASE
        WHEN current_role = 'SUPER_ADMIN' THEN 'SUPER_ADMIN (no change)'
        WHEN current_role = 'TENANT_ADMIN' THEN 'TENANT_ADMIN (policies updated)'
        WHEN current_role = 'ADMIN' THEN 'TENANT_ADMIN or DEPARTMENT_HEAD'
        WHEN current_role = 'MANAGER' THEN 'DEPARTMENT_HEAD'
        WHEN current_role = 'USER' THEN 'DOCTOR (if creates consultations) or NURSE'
        WHEN current_role = 'VIEWER' THEN 'NURSE'
        WHEN current_role = 'API_USER' THEN 'SERVICE_ACCOUNT'
        ELSE 'Review manually'
    END as proposed_mapping
FROM current_assignments
GROUP BY current_role
ORDER BY user_count DESC;
```

---

### Phase 3: Migration Script Development

**Estimated Effort**: 2-4 hours

Create migration script: `packages/database/src/migrations/migrate-to-healthcare-roles.ts`

```typescript
/**
 * RBAC Healthcare Role Migration Script
 *
 * This script migrates existing users to the new healthcare-focused roles.
 * It preserves existing assignments and adds new ones, allowing rollback.
 *
 * Usage:
 *   pnpm --filter @arcaai/database migrate:roles --dry-run
 *   pnpm --filter @arcaai/database migrate:roles --execute
 */

import { CorePrismaClient, getPrismaClient } from '../client';

interface MigrationResult {
    userId: string;
    username: string;
    oldRole: string;
    newRole: string;
    status: 'migrated' | 'skipped' | 'error';
    reason?: string;
}

const ROLE_MAPPING: Record<string, string> = {
    // Direct mappings (1:1)
    'SUPER_ADMIN': 'SUPER_ADMIN',
    'TENANT_ADMIN': 'TENANT_ADMIN',
    'API_USER': 'SERVICE_ACCOUNT',
    'VIEWER': 'NURSE',
    'MANAGER': 'DEPARTMENT_HEAD',
};

async function migrateUserRoles(
    client: CorePrismaClient,
    dryRun: boolean = true
): Promise<MigrationResult[]> {
    const results: MigrationResult[] = [];

    // Get all current assignments
    const assignments = await client.userRoleAssignment.findMany({
        include: {
            User: true,
            Role: true,
        },
        where: {
            User: { resourceStatus: 'ENABLED' },
        },
    });

    // Get new role IDs
    const newRoles = await client.role.findMany({
        where: {
            name: { in: ['DOCTOR', 'NURSE', 'SERVICE_ACCOUNT', 'DEPARTMENT_HEAD'] },
        },
    });
    const newRoleMap = new Map(newRoles.map(r => [r.name, r.id]));

    for (const assignment of assignments) {
        const oldRole = assignment.Role.name;
        let newRole: string | null = null;

        // Determine new role
        if (ROLE_MAPPING[oldRole]) {
            newRole = ROLE_MAPPING[oldRole];
        } else if (oldRole === 'USER') {
            // Check if user has created consultations
            const consultationCount = await client.consultation.count({
                where: { doctorId: assignment.userId },
            });
            newRole = consultationCount > 0 ? 'DOCTOR' : 'NURSE';
        }

        if (!newRole || newRole === oldRole) {
            results.push({
                userId: assignment.userId,
                username: assignment.User.username,
                oldRole,
                newRole: newRole || oldRole,
                status: 'skipped',
                reason: newRole === oldRole ? 'Already correct role' : 'No mapping defined',
            });
            continue;
        }

        const newRoleId = newRoleMap.get(newRole);
        if (!newRoleId) {
            results.push({
                userId: assignment.userId,
                username: assignment.User.username,
                oldRole,
                newRole,
                status: 'error',
                reason: `New role ${newRole} not found in database`,
            });
            continue;
        }

        if (!dryRun) {
            // Create new assignment (keep old one for rollback)
            await client.userRoleAssignment.create({
                data: {
                    userId: assignment.userId,
                    roleId: newRoleId,
                    tenantId: assignment.tenantId,
                    metaData: {
                        migratedFrom: oldRole,
                        migratedAt: new Date().toISOString(),
                        originalAssignmentId: assignment.id,
                    },
                },
            });

            // Disable old assignment (soft delete)
            await client.userRoleAssignment.update({
                where: { id: assignment.id },
                data: {
                    resourceStatus: 'DISABLED',
                    metaData: {
                        ...assignment.metaData as object,
                        migratedTo: newRole,
                        disabledAt: new Date().toISOString(),
                    },
                },
            });
        }

        results.push({
            userId: assignment.userId,
            username: assignment.User.username,
            oldRole,
            newRole,
            status: dryRun ? 'skipped' : 'migrated',
            reason: dryRun ? 'Dry run - no changes made' : undefined,
        });
    }

    return results;
}

// Main execution
async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const execute = process.argv.includes('--execute');

    if (!dryRun && !execute) {
        console.log('Usage: migrate-to-healthcare-roles --dry-run | --execute');
        process.exit(1);
    }

    const client = getPrismaClient();

    try {
        console.log(`Running role migration (dry-run: ${dryRun})...\n`);

        const results = await migrateUserRoles(client, dryRun);

        // Summary
        const migrated = results.filter(r => r.status === 'migrated').length;
        const skipped = results.filter(r => r.status === 'skipped').length;
        const errors = results.filter(r => r.status === 'error').length;

        console.log('\n=== Migration Summary ===');
        console.log(`Total users: ${results.length}`);
        console.log(`Migrated: ${migrated}`);
        console.log(`Skipped: ${skipped}`);
        console.log(`Errors: ${errors}`);

        if (errors > 0) {
            console.log('\nErrors:');
            results.filter(r => r.status === 'error').forEach(r => {
                console.log(`  - ${r.username}: ${r.reason}`);
            });
        }

        // Detailed report
        console.log('\n=== Detailed Report ===');
        console.table(results.map(r => ({
            username: r.username,
            oldRole: r.oldRole,
            newRole: r.newRole,
            status: r.status,
        })));

    } finally {
        await client.$disconnect();
    }
}

main().catch(console.error);
```

---

### Phase 4: Execute Migration (Production)

**Estimated Effort**: 1 hour

1. Run dry-run in production environment
2. Review output with stakeholders
3. Execute migration during maintenance window
4. Verify user access post-migration
5. Monitor for issues

**Execution Steps**:

```bash
# Step 1: Dry run
pnpm --filter @arcaai/database migrate:roles --dry-run > migration-report.txt

# Step 2: Review report
cat migration-report.txt

# Step 3: Execute (during maintenance window)
pnpm --filter @arcaai/database migrate:roles --execute

# Step 4: Verify
psql $DATABASE_URL -c "
SELECT r.name, COUNT(ura.id)
FROM \"core\".\"Role\" r
JOIN \"core\".\"UserRoleAssignment\" ura ON r.id = ura.\"roleId\"
WHERE ura.\"resourceStatus\" = 'ENABLED'
GROUP BY r.name;
"
```

---

### Phase 5: Cleanup (Optional, Later)

**Estimated Effort**: 30 minutes

After confirming migration success (wait 2-4 weeks):

1. Archive disabled legacy role assignments
2. Mark legacy roles as `resourceStatus: ARCHIVED`
3. Update documentation

**Note**: Do NOT delete legacy roles/assignments. Archive them for audit trail.

---

## 4. Testing Strategy

### 4.1 Pre-Migration Tests

- [ ] Verify all new roles exist
- [ ] Verify all new policies exist
- [ ] Verify role-policy assignments correct
- [ ] Test new roles in isolation (create test users)

### 4.2 Post-Migration Tests

- [ ] Existing SUPER_ADMIN can still access everything
- [ ] TENANT_ADMIN can manage tenant resources
- [ ] DOCTOR can create/manage own consultations
- [ ] DOCTOR cannot access other doctors' consultations
- [ ] NURSE can read consultations but not create
- [ ] DEPARTMENT_HEAD can delegate roles
- [ ] SERVICE_ACCOUNT can access API endpoints
- [ ] API keys still work with scoped permissions

### 4.3 Rollback Test

- [ ] Re-enable old role assignments
- [ ] Disable new role assignments
- [ ] Verify system returns to previous state

---

## 5. Rollback Plan

If migration fails:

```sql
-- Rollback: Re-enable old assignments, disable new ones
BEGIN;

-- Re-enable old assignments
UPDATE "core"."UserRoleAssignment"
SET "resourceStatus" = 'ENABLED'
WHERE "metaData"->>'migratedTo' IS NOT NULL;

-- Disable new assignments
UPDATE "core"."UserRoleAssignment"
SET "resourceStatus" = 'DISABLED'
WHERE "metaData"->>'migratedFrom' IS NOT NULL;

COMMIT;
```

---

## 6. Implementation Summary

*To be completed after implementation*

---

## 7. Change History

| Date | Update | Author |
|------|--------|--------|
| 2026-01-26 | Initial ticket created | AI Assistant |
