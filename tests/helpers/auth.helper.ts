/**
 * Authentication Test Helpers
 *
 * Utilities for generating test tokens and creating test users.
 */

import { sign, verify, SignOptions } from 'jsonwebtoken';

/**
 * Test user interface matching the JWT payload structure
 */
export interface TestUser {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
}

/**
 * JWT token payload structure
 */
export interface TokenPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
  permissions: string[];
  iat?: number;
  exp?: number;
}

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-testing-only';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

/**
 * Generate a JWT token for a test user
 */
export function generateTestToken(user: TestUser, options: { expiresIn?: string } = {}): string {
  const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
    sub: user.id,
    email: user.email,
    tenantId: user.tenantId,
    roles: user.roles,
    permissions: user.permissions || [],
  };

  const signOptions: SignOptions = {
    expiresIn: options.expiresIn || JWT_EXPIRES_IN,
  };

  return sign(payload, JWT_SECRET, signOptions);
}

/**
 * Generate an expired token for testing token expiration handling
 */
export function generateExpiredToken(user: TestUser): string {
  return generateTestToken(user, { expiresIn: '-1h' });
}

/**
 * Generate an invalid token (malformed)
 */
export function generateInvalidToken(): string {
  return 'invalid.token.here';
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Create a basic test user with default values
 */
export function createTestUser(overrides: Partial<TestUser> = {}): TestUser {
  const timestamp = Date.now();
  return {
    id: overrides.id || `test-user-${timestamp}`,
    email: overrides.email || `test-${timestamp}@example.com`,
    tenantId: overrides.tenantId || 'test-tenant-id',
    roles: overrides.roles || ['user'],
    permissions: overrides.permissions || [],
  };
}

/**
 * Create an admin test user
 */
export function createAdminUser(overrides: Partial<TestUser> = {}): TestUser {
  return createTestUser({
    roles: ['admin'],
    permissions: ['users:read', 'users:write', 'users:delete'],
    ...overrides,
  });
}

/**
 * Create a super admin test user with all permissions
 */
export function createSuperAdminUser(overrides: Partial<TestUser> = {}): TestUser {
  return createTestUser({
    roles: ['super_admin'],
    permissions: ['*'],
    ...overrides,
  });
}

/**
 * Create a test user with specific permissions
 */
export function createUserWithPermissions(permissions: string[], overrides: Partial<TestUser> = {}): TestUser {
  return createTestUser({
    permissions,
    ...overrides,
  });
}

/**
 * Create authorization header value
 */
export function createAuthHeader(user: TestUser): string {
  const token = generateTestToken(user);
  return `Bearer ${token}`;
}

/**
 * Extract user from authorization header
 */
export function extractUserFromHeader(authHeader: string): TestUser | null {
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);
  const payload = verifyToken(token);

  if (!payload) {
    return null;
  }

  return {
    id: payload.sub,
    email: payload.email,
    tenantId: payload.tenantId,
    roles: payload.roles,
    permissions: payload.permissions,
  };
}
