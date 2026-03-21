/**
 * E2E Test Helpers
 *
 * Utilities for managing test data in E2E tests.
 * These helpers use the API to create/cleanup data since E2E tests
 * run against a live API server.
 *
 * IMPORTANT: E2E tests should follow these patterns:
 * 1. Reset test state at the beginning of each test file (beforeAll)
 * 2. Clean up any data created during tests (afterAll)
 * 3. Use unique identifiers to avoid collisions between parallel tests
 * 4. Don't rely on data from other test files
 */

import type { APIRequestContext } from '@playwright/test';

// =============================================================================
// Types
// =============================================================================

export interface TestDataRegistry {
  users: string[];
  roles: string[];
  policies: string[];
  tenants: string[];
  consultations: string[];
}

export interface TestUserCredentials {
  id: string;
  username: string;
  password: string;
  email: string;
  token?: string;
}

export interface SeededUsers {
  superAdmin: TestUserCredentials;
  admin: TestUserCredentials;
  doctor: TestUserCredentials;
  doctor2: TestUserCredentials;
  departmentHead: TestUserCredentials;
  nurse: TestUserCredentials;
  seniorNurse: TestUserCredentials;
  serviceAccount: TestUserCredentials;
}

// =============================================================================
// Constants — must match packages/database/src/prisma/db_main/seed/
// =============================================================================

/**
 * Default tenant key from seed 05-tenant.ts.
 * Non-super-admin users must include this in login requests.
 */
export const DEFAULT_TENANT_KEY = '__GLOBAL__';

/**
 * Seeded API keys from 02-apikey.ts (raw keys, not hashed).
 * The API hashes them on receipt, so tests send the raw value.
 */
export const SEEDED_API_KEY = 'hope_sk_test_a5c5e56x54c4437fbd6ce7dee9_631238';
export const SEEDED_API_KEY_DOCTOR2 = 'hope_sk_test_b7d8f67y65d5548gce8df8eef0_742349';

/**
 * Well-known seeded user credentials.
 * These users are created by 91-user.ts and should always exist after pnpm test:db:seed.
 */
export const SEEDED_USERS: SeededUsers = {
  superAdmin: {
    id: '70000000-0000-0000-0000-000000000001',
    username: 'super_admin',
    password: 'password123',
    email: 'super.admin@example.com',
  },
  admin: {
    id: '70000000-0000-0000-0000-000000000002',
    username: 'tenant_admin',
    password: 'password123',
    email: 'tenant.admin@example.com',
  },
  doctor: {
    id: '70000000-0000-0000-0000-000000000010',
    username: 'doctor',
    password: 'password123',
    email: 'doctor.smith@example.com',
  },
  doctor2: {
    id: '70000000-0000-0000-0000-000000000011',
    username: 'doctor2',
    password: 'password123',
    email: 'doctor.doe@example.com',
  },
  departmentHead: {
    id: '70000000-0000-0000-0000-000000000012',
    username: 'department_head',
    password: 'password123',
    email: 'dept.head@example.com',
  },
  nurse: {
    id: '70000000-0000-0000-0000-000000000013',
    username: 'nurse',
    password: 'password123',
    email: 'nurse.williams@example.com',
  },
  seniorNurse: {
    id: '70000000-0000-0000-0000-000000000014',
    username: 'senior_nurse',
    password: 'password123',
    email: 'senior.nurse@example.com',
  },
  serviceAccount: {
    id: '70000000-0000-0000-0000-000000000020',
    username: 'service_account',
    password: 'password123',
    email: 'service@example.com',
  },
};

// =============================================================================
// Test Data Registry
// =============================================================================

/**
 * Create a new test data registry to track created resources
 * Use this in test files to track data that needs cleanup
 */
export function createTestDataRegistry(): TestDataRegistry {
  return {
    users: [],
    roles: [],
    policies: [],
    tenants: [],
    consultations: [],
  };
}

// =============================================================================
// Authentication Helpers
// =============================================================================

/**
 * Login and get auth token for a user.
 * Non-super-admin users require tenantKey (defaults to DEFAULT_TENANT_KEY).
 */
export async function loginUser(
  request: APIRequestContext,
  username: string,
  password: string,
  tenantKey?: string
): Promise<{ token: string; refreshToken: string; user: { id: string; username: string } } | null> {
  try {
    const data: Record<string, string> = { username, password };
    if (tenantKey) data.tenantKey = tenantKey;
    const response = await request.post('/api/v1/auth/login', {
      data,
    });

    if (response.status() === 200) {
      const body = await response.json();
      return {
        token: body.token,
        refreshToken: body.refreshToken,
        user: body.user,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Login all seeded users and return their tokens
 */
export async function loginSeededUsers(
  request: APIRequestContext
): Promise<{
  superAdminToken: string | null;
  adminToken: string | null;
  userToken: string | null;
}> {
  const [superAdmin, admin, doctor] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);

  return {
    superAdminToken: superAdmin?.token ?? null,
    adminToken: admin?.token ?? null,
    userToken: doctor?.token ?? null,
  };
}

// =============================================================================
// User Management Helpers
// =============================================================================

/**
 * Generate a unique username for tests
 */
export function generateUniqueUsername(prefix = 'test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Create a test user via API
 */
export async function createTestUser(
  request: APIRequestContext,
  token: string,
  data: { username?: string; email?: string; password?: string } = {},
  registry?: TestDataRegistry
): Promise<TestUserCredentials | null> {
  const username = data.username || generateUniqueUsername();
  const email = data.email || `${username}@test.com`;
  const password = data.password || 'TestPassword123!';

  try {
    const response = await request.post('/api/v1/users', {
      headers: { Authorization: `Bearer ${token}` },
      data: { username, email, password },
    });

    if (response.status() === 200 || response.status() === 201) {
      const body = await response.json();
      const credentials: TestUserCredentials = {
        id: body.id,
        username,
        email,
        password,
      };

      // Track for cleanup
      if (registry) {
        registry.users.push(body.id);
      }

      return credentials;
    }

    console.warn(`Failed to create test user: ${response.status()}`);
    return null;
  } catch (error) {
    console.error('Error creating test user:', error);
    return null;
  }
}

/**
 * Delete a test user via API
 */
export async function deleteTestUser(
  request: APIRequestContext,
  token: string,
  userId: string
): Promise<boolean> {
  try {
    const response = await request.delete(`/api/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return response.status() === 200 || response.status() === 204;
  } catch {
    return false;
  }
}

// =============================================================================
// Role Management Helpers
// =============================================================================

/**
 * Create a test role via API
 */
export async function createTestRole(
  request: APIRequestContext,
  token: string,
  data: { name?: string; description?: string } = {},
  registry?: TestDataRegistry
): Promise<{ id: string; name: string } | null> {
  const name = data.name || `test-role-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const description = data.description || `E2E test role: ${name}`;

  try {
    const response = await request.post('/api/v1/admin/rbac/roles', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, description, isSystemRole: false },
    });

    if (response.status() === 201) {
      const body = await response.json();

      if (registry) {
        registry.roles.push(body.id);
      }

      return { id: body.id, name: body.name };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Delete a test role via API
 */
export async function deleteTestRole(
  request: APIRequestContext,
  token: string,
  roleId: string
): Promise<boolean> {
  try {
    const response = await request.delete(`/api/v1/admin/rbac/roles/${roleId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return response.status() === 200 || response.status() === 204;
  } catch {
    return false;
  }
}

// =============================================================================
// Policy Management Helpers
// =============================================================================

/**
 * Create a test policy via API
 */
export async function createTestPolicy(
  request: APIRequestContext,
  token: string,
  data: {
    name?: string;
    description?: string;
    rules?: Array<{ action: string; subject: string; conditions?: Record<string, unknown> }>;
  } = {},
  registry?: TestDataRegistry
): Promise<{ id: string; name: string } | null> {
  const name = data.name || `test-policy-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const description = data.description || `E2E test policy: ${name}`;
  const rules = data.rules || [{ action: 'read', subject: 'TestResource' }];

  try {
    const response = await request.post('/api/v1/admin/rbac/policies', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, description, scope: 'TENANT', rules },
    });

    if (response.status() === 201) {
      const body = await response.json();

      if (registry) {
        registry.policies.push(body.id);
      }

      return { id: body.id, name: body.name };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Delete a test policy via API
 */
export async function deleteTestPolicy(
  request: APIRequestContext,
  token: string,
  policyId: string
): Promise<boolean> {
  try {
    const response = await request.delete(`/api/v1/admin/rbac/policies/${policyId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return response.status() === 200 || response.status() === 204;
  } catch {
    return false;
  }
}

// =============================================================================
// Cleanup Helpers
// =============================================================================

/**
 * Clean up all tracked test data
 * Call this in afterAll to remove all data created during tests
 */
export async function cleanupTestData(
  request: APIRequestContext,
  token: string,
  registry: TestDataRegistry
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Delete in reverse order of dependencies:
  // 1. Policies (may be linked to roles)
  // 2. Roles (may be assigned to users)
  // 3. Users
  // 4. Tenants

  // Clean up policies
  for (const policyId of registry.policies) {
    const deleted = await deleteTestPolicy(request, token, policyId);
    if (!deleted) {
      errors.push(`Failed to delete policy: ${policyId}`);
    }
  }

  // Clean up roles
  for (const roleId of registry.roles) {
    const deleted = await deleteTestRole(request, token, roleId);
    if (!deleted) {
      errors.push(`Failed to delete role: ${roleId}`);
    }
  }

  // Clean up users
  for (const userId of registry.users) {
    const deleted = await deleteTestUser(request, token, userId);
    if (!deleted) {
      errors.push(`Failed to delete user: ${userId}`);
    }
  }

  // Clear the registry
  registry.users = [];
  registry.roles = [];
  registry.policies = [];
  registry.tenants = [];
  registry.consultations = [];

  return {
    success: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Health Check Helpers
// =============================================================================

/**
 * Check if the API is healthy and ready for tests
 */
export async function checkApiHealth(
  request: APIRequestContext
): Promise<boolean> {
  try {
    const response = await request.get('/api/v1/health');
    return response.ok();
  } catch {
    return false;
  }
}

/**
 * Check if seeded users exist and can login
 * This verifies the database has been properly seeded
 */
export async function verifySeededData(
  request: APIRequestContext
): Promise<{ ready: boolean; message: string }> {
  const { superAdminToken, adminToken, userToken } = await loginSeededUsers(request);

  if (!superAdminToken) {
    return {
      ready: false,
      message: 'super_admin user not found or invalid credentials. Run database seeding.',
    };
  }

  if (!adminToken) {
    return {
      ready: false,
      message: 'tenant_admin user not found or invalid credentials. Run database seeding.',
    };
  }

  if (!userToken) {
    return {
      ready: false,
      message: 'doctor user not found or invalid credentials. Run database seeding.',
    };
  }

  return {
    ready: true,
    message: 'All seeded users verified successfully.',
  };
}
