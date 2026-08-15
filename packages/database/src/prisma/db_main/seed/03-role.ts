import type { CorePrismaClient } from '../../../client';
import { SEED_ROLE_IDS } from './00-constants';

/**
 * Policy-Based Role Seed Data - Healthcare-Focused Design
 *
 * This script creates default roles and assigns policies to them.
 * Implements the RBAC best practices design for HOPE platform.
 *
 * Role Hierarchy:
 * - SUPER_ADMIN (Global) - System-wide access (renamed from GLOBAL_ADMIN by
 *   TASK-707, D8; before that rename, the legacy SUPER_ADMIN role was
 *   consolidated into it by TASK-417)
 * - TENANT_ADMIN (Tenant) - Full tenant access
 * - DOCTOR (Tenant) - Clinical role, owns consultations
 *   └── DEPARTMENT_HEAD (extends DOCTOR) - + delegation + department view
 * - NURSE (Tenant) - Clinical support, read-only
 *   └── SENIOR_NURSE (extends NURSE) - + broader access
 * - SERVICE_ACCOUNT (Tenant) - API/Integration access
 *
 * Key Rules:
 * - System roles (isSystemRole: true) cannot be deleted
 * - Tenant custom roles must have a parent (inherit from system role)
 * - All users get user-profile-own policy automatically
 *
 * See: docs/RBAC_BEST_PRACTICES.md for full design documentation
 */

// =============================================================================
// SYSTEM ROLES - Core roles that cannot be deleted
// Exported for testing purposes
// =============================================================================
export const SYSTEM_ROLES = [
  // The former SUPER_ADMIN role (id …0001) was consolidated into GLOBAL_ADMIN
  // (see GLOBAL_ROLES below, itself renamed back to SUPER_ADMIN by TASK-707)
  // and soft-retired by data migration; it must never be re-seeded.
  {
    id: SEED_ROLE_IDS.TENANT_ADMIN,
    name: 'TENANT_ADMIN',
    description: 'Tenant administrator with full access within their tenant',
    externalName: 'Tenant Administrator',
    isSystemRole: true,
    parentRoleId: null,
    policies: ['tenant-full-access', 'rbac-tenant-manage', 'rbac-delegate', 'user-profile-own', 'prompt-template-manage', 'audit-log-read'],
  },
  {
    id: SEED_ROLE_IDS.DOCTOR,
    name: 'DOCTOR',
    description: 'Clinical role - owns and manages consultations',
    externalName: 'Doctor / Clinician',
    isSystemRole: true,
    parentRoleId: null,
    // `prompt-template-read` lets a clinician populate the
    // Pre-Summary / Summary template selector via the end-user
    // `GET /prompt-templates/available` route (read-only; NOT the admin
    // `manage` plane). DEPARTMENT_HEAD inherits these via parentRoleId.
    policies: [
      'consultation-own-manage',
      'consultation-shared-patient-read',
      'user-profile-own',
      'api-key-own-manage',
      'storage-upload',
      'prompt-template-read',
    ],
  },
  {
    id: SEED_ROLE_IDS.NURSE,
    name: 'NURSE',
    description: 'Clinical support role - read-only access to consultations',
    externalName: 'Nurse / Assistant',
    isSystemRole: true,
    parentRoleId: null,
    policies: ['consultation-read-assigned', 'user-profile-own'],
  },
  {
    id: SEED_ROLE_IDS.SERVICE_ACCOUNT,
    name: 'SERVICE_ACCOUNT',
    description: 'Service account for API/backend integrations',
    externalName: 'Service Account',
    isSystemRole: true,
    parentRoleId: null,
    policies: ['service-integration', 'federated-learning-access'],
  },
];

// =============================================================================
// GLOBAL ROLES
// Elevated, platform-wide role kept separate from the count-pinned SYSTEM_ROLES
// array. `SUPER_ADMIN` (renamed from GLOBAL_ADMIN by TASK-707, D8) is THE
// elevated role recognized by the code-side guard
// (`tenant-guards.ELEVATED_ROLES`) and carries the full system-level policy
// grants. It is a reserved system role (cannot be deleted) with no parent.
// =============================================================================
export const GLOBAL_ROLES = [
  {
    id: SEED_ROLE_IDS.SUPER_ADMIN,
    name: 'SUPER_ADMIN',
    description: 'Elevated platform-wide administrator with full access across all tenants',
    externalName: 'Global Administrator',
    isSystemRole: true,
    parentRoleId: null,
    // `prisma-studio-manage` (manage:PrismaStudio) is the
    // dedicated production-capable Prisma Studio grant; `manage:all` would
    // also pass the guard, but the explicit policy keeps studio access
    // delegable without full access.
    policies: ['system-full-access', 'rbac-system-manage', 'global-settings-manage', 'prisma-studio-manage'],
  },
];

// =============================================================================
// TENANT EXTENDABLE ROLES - Examples of custom roles tenants can create
// These inherit from system roles and add additional permissions
// Exported for testing purposes
// =============================================================================
export const TENANT_EXTENDABLE_ROLES = [
  {
    id: SEED_ROLE_IDS.DEPARTMENT_HEAD,
    name: 'DEPARTMENT_HEAD',
    description: 'Doctor with department-wide access and role delegation capabilities',
    externalName: 'Department Head',
    isSystemRole: false,
    parentRoleId: SEED_ROLE_IDS.DOCTOR,
    policies: ['consultation-department-read', 'rbac-delegate'],
  },
  {
    id: SEED_ROLE_IDS.SENIOR_NURSE,
    name: 'SENIOR_NURSE',
    description: 'Nurse with broader read access across departments',
    externalName: 'Senior Nurse',
    isSystemRole: false,
    parentRoleId: SEED_ROLE_IDS.NURSE,
    policies: ['consultation-department-read'],
  },
];

// Combine all roles
// Exported for testing purposes
export const DEFAULT_ROLES = [...SYSTEM_ROLES, ...GLOBAL_ROLES, ...TENANT_EXTENDABLE_ROLES];

export const seedRole = async (client: CorePrismaClient) => {
  console.log('Seeding roles...');
  console.log('  System roles:', SYSTEM_ROLES.length);
  console.log('  Global roles:', GLOBAL_ROLES.length);
  console.log('  Tenant extendable roles:', TENANT_EXTENDABLE_ROLES.length);

  const policies = await client.policy.findMany();
  const policyMap = new Map<string, string>(policies.map((p) => [p.name, p.id]));

  // Track created roles for hierarchy resolution
  const createdRoleIds = new Map<string, string>();

  // Seed roles in order: system first, then extendable (which have parents), then legacy
  for (const roleData of DEFAULT_ROLES) {
    // Use findFirst instead of findUnique for Prisma 7 compatibility
    let role = await client.role.findFirst({
      where: { name: roleData.name },
    });

    // Resolve parent role ID if specified
    let resolvedParentRoleId: string | null = null;
    if (roleData.parentRoleId) {
      const parentRole = await client.role.findFirst({
        where: { id: roleData.parentRoleId },
      });
      if (parentRole) {
        resolvedParentRoleId = parentRole.id;
      } else {
        console.warn(`    Warning: Parent role ID "${roleData.parentRoleId}" not found for "${roleData.name}"`);
      }
    }

    if (role) {
      console.log(`  Role "${roleData.name}" already exists, updating...`);
      role = await client.role.update({
        where: { id: role.id },
        data: {
          description: roleData.description,
          externalName: roleData.externalName,
          isSystemRole: roleData.isSystemRole,
          parentRoleId: resolvedParentRoleId,
        },
      });
    } else {
      console.log(`  Creating role "${roleData.name}"...`);
      role = await client.role.create({
        data: {
          id: roleData.id,
          name: roleData.name,
          description: roleData.description,
          externalName: roleData.externalName,
          isSystemRole: roleData.isSystemRole,
          parentRoleId: resolvedParentRoleId,
        },
      });
    }

    createdRoleIds.set(roleData.id, role.id);

    // Create role-policy assignments
    for (let i = 0; i < roleData.policies.length; i++) {
      const policyName = roleData.policies[i] as string;
      if (!policyName) continue;

      const foundPolicyId = policyMap.get(policyName);

      if (!foundPolicyId) {
        console.warn(`    Warning: Policy "${policyName}" not found for role "${roleData.name}"`);
        continue;
      }

      // TypeScript narrowing - policyId is guaranteed to be string here
      const policyId: string = foundPolicyId;

      const existingRolePolicy = await client.rolePolicy.findFirst({
        where: {
          roleId: role.id,
          policyId: policyId,
        },
      });

      if (!existingRolePolicy) {
        console.log(`    Assigning policy "${policyName}" to role "${roleData.name}"...`);
        await client.rolePolicy.create({
          data: {
            roleId: role.id,
            policyId: policyId,
            priority: i,
          },
        });
      }
    }
  }

  console.log(`Seeded ${DEFAULT_ROLES.length} roles`);
  return { success: true, count: DEFAULT_ROLES.length };
};
