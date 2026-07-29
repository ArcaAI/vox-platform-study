/**
 * Role and Policy Test Fixtures
 *
 * Factory functions for creating test roles, policies, and assignments.
 */

import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../helpers/db.helper';
import { DEFAULT_TEST_TENANT_ID, SYSTEM_USER_ID } from './users.fixture';

/**
 * CASL rule structure
 */
export interface CaslRule {
  action: string | string[];
  subject: string | string[];
  conditions?: Record<string, unknown>;
  fields?: string[];
  inverted?: boolean;
  reason?: string;
}

/**
 * Options for creating a test role
 */
export interface CreateRoleOptions {
  id?: string;
  name?: string;
  description?: string;
  isSystemRole?: boolean;
  parentRoleId?: string;
}

/**
 * Options for creating a test policy
 */
export interface CreatePolicyOptions {
  id?: string;
  name?: string;
  description?: string;
  rules: CaslRule[];
  scope?: 'GLOBAL' | 'TENANT' | 'USER';
}

/**
 * Created role result
 */
export interface CreatedRole {
  id: string;
  name: string;
  description: string | null;
}

/**
 * Created policy result
 */
export interface CreatedPolicy {
  id: string;
  name: string;
  rules: CaslRule[];
}

/**
 * Generate a unique ID for tests
 */
function generateTestId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a test role in the database
 */
export async function createRoleFixture(options: CreateRoleOptions = {}, prisma?: PrismaClient): Promise<CreatedRole> {
  const client = prisma || getPrismaClient();
  const id = options.id || generateTestId();
  const name = options.name || `test-role-${id}`;

  const role = await client.role.create({
    data: {
      id,
      name,
      description: options.description || `Test role: ${name}`,
      isSystemRole: options.isSystemRole ?? false,
      parentRoleId: options.parentRoleId,
      createdBy: SYSTEM_USER_ID,
    },
  });

  return {
    id: role.id,
    name: role.name,
    description: role.description,
  };
}

/**
 * Create a test policy in the database
 */
export async function createPolicyFixture(options: CreatePolicyOptions, prisma?: PrismaClient): Promise<CreatedPolicy> {
  const client = prisma || getPrismaClient();
  const id = options.id || generateTestId();
  const name = options.name || `test-policy-${id}`;

  const policy = await client.policy.create({
    data: {
      id,
      name,
      description: options.description || `Test policy: ${name}`,
      rules: options.rules as unknown as object,
      scope: options.scope || 'TENANT',
      createdBy: SYSTEM_USER_ID,
    },
  });

  return {
    id: policy.id,
    name: policy.name,
    rules: options.rules,
  };
}

/**
 * Link a policy to a role
 */
export async function linkPolicyToRole(roleId: string, policyId: string, priority: number = 0, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  await client.rolePolicy.create({
    data: {
      id: generateTestId(),
      roleId,
      policyId,
      priority,
      createdBy: SYSTEM_USER_ID,
    },
  });
}

/**
 * Assign a role to a user
 */
export async function assignRoleToUser(
  userId: string,
  roleId: string,
  tenantId: string = DEFAULT_TEST_TENANT_ID,
  prisma?: PrismaClient,
): Promise<void> {
  const client = prisma || getPrismaClient();

  await client.userRoleAssignment.create({
    data: {
      id: generateTestId(),
      userId,
      roleId,
      tenantId,
      createdBy: SYSTEM_USER_ID,
    },
  });
}

/**
 * Remove a role from a user
 */
export async function removeRoleFromUser(
  userId: string,
  roleId: string,
  tenantId: string = DEFAULT_TEST_TENANT_ID,
  prisma?: PrismaClient,
): Promise<void> {
  const client = prisma || getPrismaClient();

  await client.userRoleAssignment.deleteMany({
    where: {
      userId,
      roleId,
      tenantId,
    },
  });
}

/**
 * Create a role with policies in one operation
 */
export async function createRoleWithPolicies(
  roleOptions: CreateRoleOptions,
  policies: CreatePolicyOptions[],
  prisma?: PrismaClient,
): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  const role = await createRoleFixture(roleOptions, prisma);
  const createdPolicies: CreatedPolicy[] = [];

  for (let i = 0; i < policies.length; i++) {
    const policy = await createPolicyFixture(policies[i], prisma);
    await linkPolicyToRole(role.id, policy.id, i, prisma);
    createdPolicies.push(policy);
  }

  return { role, policies: createdPolicies };
}

/**
 * Delete a test role from the database
 */
export async function deleteRoleFixture(roleId: string, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  try {
    await client.role.delete({
      where: { id: roleId },
    });
  } catch (error) {
    console.warn(`Could not delete role ${roleId}:`, error);
  }
}

/**
 * Delete a test policy from the database
 */
export async function deletePolicyFixture(policyId: string, prisma?: PrismaClient): Promise<void> {
  const client = prisma || getPrismaClient();

  try {
    await client.policy.delete({
      where: { id: policyId },
    });
  } catch (error) {
    console.warn(`Could not delete policy ${policyId}:`, error);
  }
}

// ============================================================================
// Pre-defined Role and Policy Templates
// ============================================================================

/**
 * Create a read-only user role
 */
export async function createReadOnlyRole(prisma?: PrismaClient): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  return createRoleWithPolicies(
    { name: 'read-only-user', description: 'Can only read resources' },
    [
      {
        name: 'read-all-policy',
        description: 'Read access to all resources',
        rules: [
          { action: 'read', subject: 'all' },
          { action: 'list', subject: 'all' },
        ],
      },
    ],
    prisma,
  );
}

/**
 * Create an admin role with full access
 */
export async function createAdminRole(prisma?: PrismaClient): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  return createRoleWithPolicies(
    { name: 'admin', description: 'Full administrative access' },
    [
      {
        name: 'admin-full-access-policy',
        description: 'Full access to all resources',
        rules: [{ action: 'manage', subject: 'all' }],
      },
    ],
    prisma,
  );
}

/**
 * Create a user management role
 */
export async function createUserManagerRole(prisma?: PrismaClient): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  return createRoleWithPolicies(
    { name: 'user-manager', description: 'Can manage users' },
    [
      {
        name: 'user-management-policy',
        description: 'Full access to user management',
        rules: [
          { action: 'manage', subject: 'User' },
          { action: 'manage', subject: 'UserRoleAssignment' },
          { action: 'read', subject: 'Role' },
          { action: 'list', subject: 'Role' },
        ],
      },
    ],
    prisma,
  );
}

/**
 * Create a tenant-scoped role (can only access own tenant's data)
 */
export async function createTenantScopedRole(prisma?: PrismaClient): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  return createRoleWithPolicies(
    { name: 'tenant-user', description: 'Access limited to own tenant' },
    [
      {
        name: 'tenant-scoped-policy',
        description: 'Access limited to own tenant',
        rules: [
          {
            action: ['read', 'list'],
            subject: 'all',
            conditions: { tenantId: '${context.tenantId}' },
          },
        ],
        scope: 'TENANT',
      },
    ],
    prisma,
  );
}

/**
 * Create a self-only role (can only access own data)
 */
export async function createSelfOnlyRole(prisma?: PrismaClient): Promise<{ role: CreatedRole; policies: CreatedPolicy[] }> {
  return createRoleWithPolicies(
    { name: 'self-only', description: 'Can only access own data' },
    [
      {
        name: 'self-only-policy',
        description: 'Access limited to own data',
        rules: [
          {
            action: ['read', 'update'],
            subject: 'User',
            conditions: { id: '${user.id}' },
          },
        ],
        scope: 'USER',
      },
    ],
    prisma,
  );
}
