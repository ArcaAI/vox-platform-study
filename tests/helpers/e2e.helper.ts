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
 * Service-account key (`SEED_API_KEY_RAW.SERVICE_ACCOUNT` in 00-constants.ts).
 * Service accounts are API-key-only principals — they cannot sign in
 * interactively — so this key is the ONLY way for a test to reach that
 * principal. (It authenticated for the first time after a 401-on-every-key
 * bug; before that fix every API key on the platform returned 401.)
 */
export const SEEDED_API_KEY_SERVICE_ACCOUNT = 'hope_sa_test_d9f0h89a87f7760ieg0fh0ggh2_964571';

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
// Internal diagnostics (not exported)
// =============================================================================

const MAX_BODY_EXCERPT = 500;

interface MinimalResponse {
  status: () => number;
  text: () => Promise<string>;
}

/**
 * Read up to MAX_BODY_EXCERPT chars from a response body, swallowing read errors.
 * Used purely for log diagnostics; never raises.
 */
async function readBodyExcerpt(response: MinimalResponse): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return '<empty body>';
    return text.length > MAX_BODY_EXCERPT ? `${text.slice(0, MAX_BODY_EXCERPT)}…` : text;
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Log a structured warning for a non-2xx HTTP response so test failures point
 * at the API answer rather than a bare `null`/`false` sentinel.
 */
async function warnHttpFailure(method: string, url: string, response: MinimalResponse): Promise<void> {
  const excerpt = await readBodyExcerpt(response);
  console.warn(`[e2e.helper] ${method} ${url} returned ${response.status()}: ${excerpt}`);
}

/**
 * Wrap a transport-level failure (DNS, connection refused, timeout, …) so the
 * stack trace pinpoints API unreachability instead of being swallowed.
 */
function wrapTransportError(method: string, url: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    `Failed to reach API at ${method} ${url}: ${message}. Is the dev/test stack running?`,
    error instanceof Error ? { cause: error } : undefined,
  );
  return wrapped;
}

// =============================================================================
// Authentication Helpers
// =============================================================================

/**
 * Login and get auth token for a user.
 * Non-super-admin users require tenantKey (defaults to DEFAULT_TENANT_KEY).
 *
 * Error semantics:
 * - HTTP 2xx with a parseable body → return parsed `{ token, refreshToken, user }`.
 * - HTTP non-2xx → log a structured warning (method, url, status, body excerpt)
 *   to stderr and return `null`. This preserves the long-standing sentinel for
 *   credential / seed mismatches.
 * - Network / DNS / timeout errors are RETHROWN (wrapped with a clear message)
 *   so test failures surface "API unreachable" rather than masquerading as
 *   `Received: null`.
 */
export async function loginUser(
  request: APIRequestContext,
  username: string,
  password: string,
  tenantKey?: string,
): Promise<{ token: string; refreshToken: string; user: { id: string; username: string } } | null> {
  const url = '/api/v1/auth/login';
  const data: Record<string, string> = { username, password };
  if (tenantKey) data.tenantKey = tenantKey;

  let response;
  try {
    response = await request.post(url, { data });
  } catch (error) {
    throw wrapTransportError('POST', url, error);
  }

  if (response.status() === 200) {
    const body = await response.json();
    return {
      token: body.token,
      refreshToken: body.refreshToken,
      user: body.user,
    };
  }

  await warnHttpFailure('POST', url, response);
  return null;
}

/**
 * Login all seeded users and return their tokens
 */
export async function loginSeededUsers(request: APIRequestContext): Promise<{
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
 * Create a test user via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `null`. See `loginUser` for the rationale.
 */
export async function createTestUser(
  request: APIRequestContext,
  token: string,
  data: { username?: string; email?: string; password?: string } = {},
  registry?: TestDataRegistry,
): Promise<TestUserCredentials | null> {
  const username = data.username || generateUniqueUsername();
  const email = data.email || `${username}@test.com`;
  const password = data.password || 'TestPassword123!';
  const url = '/api/v1/users';

  let response;
  try {
    response = await request.post(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: { username, email, password },
    });
  } catch (error) {
    throw wrapTransportError('POST', url, error);
  }

  if (response.status() === 200 || response.status() === 201) {
    const body = await response.json();
    const credentials: TestUserCredentials = {
      id: body.id,
      username,
      email,
      password,
    };

    if (registry) {
      registry.users.push(body.id);
    }

    return credentials;
  }

  await warnHttpFailure('POST', url, response);
  return null;
}

/**
 * Delete a test user via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `false`. See `loginUser` for the rationale.
 */
export async function deleteTestUser(request: APIRequestContext, token: string, userId: string): Promise<boolean> {
  const url = `/api/v1/users/${userId}`;
  let response;
  try {
    response = await request.delete(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw wrapTransportError('DELETE', url, error);
  }

  if (response.status() === 200 || response.status() === 204) {
    return true;
  }

  await warnHttpFailure('DELETE', url, response);
  return false;
}

// =============================================================================
// Role Management Helpers
// =============================================================================

/**
 * Create a test role via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `null`. See `loginUser` for the rationale.
 */
export async function createTestRole(
  request: APIRequestContext,
  token: string,
  data: { name?: string; description?: string } = {},
  registry?: TestDataRegistry,
): Promise<{ id: string; name: string } | null> {
  const name = data.name || `test-role-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const description = data.description || `E2E test role: ${name}`;
  const url = '/api/v1/admin/rbac/roles';

  let response;
  try {
    response = await request.post(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, description, isSystemRole: false },
    });
  } catch (error) {
    throw wrapTransportError('POST', url, error);
  }

  if (response.status() === 201) {
    const body = await response.json();

    if (registry) {
      registry.roles.push(body.id);
    }

    return { id: body.id, name: body.name };
  }

  await warnHttpFailure('POST', url, response);
  return null;
}

/**
 * Delete a test role via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `false`. See `loginUser` for the rationale.
 */
export async function deleteTestRole(
  request: APIRequestContext,
  token: string,
  roleId: string,
  /**
   * Role deletion requires break-glass step-up (caller's current
   * password + the exact role name). Defaults to the seeded test password;
   * the name is fetched from the API when not supplied.
   */
  breakGlass: { password?: string; confirmationName?: string } = {},
): Promise<boolean> {
  const url = `/api/v1/admin/rbac/roles/${roleId}`;

  let confirmationName = breakGlass.confirmationName;
  if (!confirmationName) {
    try {
      const lookup = await request.get(url, { headers: { Authorization: `Bearer ${token}` } });
      if (lookup.status() === 200) {
        confirmationName = ((await lookup.json()) as { name?: string }).name;
      }
    } catch {
      // fall through — the DELETE below will surface the real failure
    }
  }

  let response;
  try {
    response = await request.delete(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        password: breakGlass.password ?? SEEDED_USERS.superAdmin.password,
        confirmationName,
      },
    });
  } catch (error) {
    throw wrapTransportError('DELETE', url, error);
  }

  if (response.status() === 200 || response.status() === 204) {
    return true;
  }

  await warnHttpFailure('DELETE', url, response);
  return false;
}

// =============================================================================
// Policy Management Helpers
// =============================================================================

/**
 * Create a test policy via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `null`. See `loginUser` for the rationale.
 */
export async function createTestPolicy(
  request: APIRequestContext,
  token: string,
  data: {
    name?: string;
    description?: string;
    rules?: Array<{ action: string; subject: string; conditions?: Record<string, unknown> }>;
  } = {},
  registry?: TestDataRegistry,
): Promise<{ id: string; name: string } | null> {
  const name = data.name || `test-policy-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const description = data.description || `E2E test policy: ${name}`;
  const rules = data.rules || [{ action: 'read', subject: 'TestResource' }];
  const url = '/api/v1/admin/rbac/policies';

  let response;
  try {
    response = await request.post(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, description, scope: 'TENANT', rules },
    });
  } catch (error) {
    throw wrapTransportError('POST', url, error);
  }

  if (response.status() === 201) {
    const body = await response.json();

    if (registry) {
      registry.policies.push(body.id);
    }

    return { id: body.id, name: body.name };
  }

  await warnHttpFailure('POST', url, response);
  return null;
}

/**
 * Delete a test policy via API.
 *
 * Network failures rethrow (wrapped); non-2xx responses log a structured
 * warning and return `false`. See `loginUser` for the rationale.
 */
export async function deleteTestPolicy(
  request: APIRequestContext,
  token: string,
  policyId: string,
  /**
   * Policy deletion requires break-glass step-up (caller's current
   * password + the exact policy name). Defaults to the seeded test password;
   * the name is fetched from the API when not supplied.
   */
  breakGlass: { password?: string; confirmationName?: string } = {},
): Promise<boolean> {
  const url = `/api/v1/admin/rbac/policies/${policyId}`;

  let confirmationName = breakGlass.confirmationName;
  if (!confirmationName) {
    try {
      const lookup = await request.get(url, { headers: { Authorization: `Bearer ${token}` } });
      if (lookup.status() === 200) {
        confirmationName = ((await lookup.json()) as { name?: string }).name;
      }
    } catch {
      // fall through — the DELETE below will surface the real failure
    }
  }

  let response;
  try {
    response = await request.delete(url, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        password: breakGlass.password ?? SEEDED_USERS.superAdmin.password,
        confirmationName,
      },
    });
  } catch (error) {
    throw wrapTransportError('DELETE', url, error);
  }

  if (response.status() === 200 || response.status() === 204) {
    return true;
  }

  await warnHttpFailure('DELETE', url, response);
  return false;
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
  registry: TestDataRegistry,
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
export async function checkApiHealth(request: APIRequestContext): Promise<boolean> {
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
export async function verifySeededData(request: APIRequestContext): Promise<{ ready: boolean; message: string }> {
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
