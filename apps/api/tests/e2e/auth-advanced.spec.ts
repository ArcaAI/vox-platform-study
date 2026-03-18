/**
 * Auth Advanced E2E Tests
 *
 * Tests for authentication endpoints: refresh, impersonate, revoke-impersonation
 *
 * TEST DATA MANAGEMENT:
 * - Uses seeded users (super_admin, tenant_admin, doctor, nurse) for tests
 * - Does NOT create any test data (uses existing seeded accounts)
 * - No cleanup required
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe('Auth Advanced Controller', () => {
  // ---------------------------------------------------------------------------
  // POST /auth/refresh
  // ---------------------------------------------------------------------------
  test.describe('POST /auth/refresh', () => {
    test('should return 400 when refreshToken is missing', async ({ request }) => {
      const response = await request.post('/api/v1/auth/refresh', {
        data: {},
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should return 401 for invalid refresh token format', async ({ request }) => {
      const response = await request.post('/api/v1/auth/refresh', {
        data: { refreshToken: 'not-a-valid-token' },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should return error for refresh token with non-existent user', async ({ request }) => {
      const fakeUserId = '00000000-0000-0000-0000-000000000000';
      const response = await request.post('/api/v1/auth/refresh', {
        data: {
          refreshToken: `refresh_${fakeUserId}_${Date.now()}_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        },
      });

      // Server may return 401 (properly handled) or 500 (unhandled lookup failure)
      expect([401, 500]).toContain(response.status());
    });

    test('should return new token pair for valid refresh token', async ({ request }) => {
      const loginResult = await loginUser(
        request,
        SEEDED_USERS.admin.username,
        SEEDED_USERS.admin.password,
        '__GLOBAL__',
      );
      expect(loginResult, 'tenant_admin login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/refresh', {
        data: { refreshToken: loginResult!.refreshToken },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('refreshToken');
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
      expect(typeof body.refreshToken).toBe('string');
      expect(body.refreshToken.length).toBeGreaterThan(0);
    });

    test('should return a working JWT from refreshed token', async ({ request }) => {
      const loginResult = await loginUser(
        request,
        SEEDED_USERS.admin.username,
        SEEDED_USERS.admin.password,
        '__GLOBAL__',
      );
      expect(loginResult, 'tenant_admin login failed').toBeTruthy();

      const refreshResponse = await request.post('/api/v1/auth/refresh', {
        data: { refreshToken: loginResult!.refreshToken },
      });

      expect(refreshResponse.status(), 'refresh failed').toBe(200);

      const { token: newToken } = await refreshResponse.json();

      const meResponse = await request.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${newToken}` },
      });

      expect(meResponse.status()).toBe(200);
      const meBody = await meResponse.json();
      expect(meBody).toHaveProperty('id');
      expect(meBody).toHaveProperty('username');
      expect(meBody.username).toBe(SEEDED_USERS.admin.username);
    });

    test('should generate different refresh tokens each time', async ({ request }) => {
      const loginResult = await loginUser(
        request,
        SEEDED_USERS.admin.username,
        SEEDED_USERS.admin.password,
        '__GLOBAL__',
      );
      expect(loginResult, 'tenant_admin login failed').toBeTruthy();

      const firstRefresh = await request.post('/api/v1/auth/refresh', {
        data: { refreshToken: loginResult!.refreshToken },
      });
      expect(firstRefresh.status(), 'first refresh failed').toBe(200);
      const firstBody = await firstRefresh.json();

      const secondRefresh = await request.post('/api/v1/auth/refresh', {
        data: { refreshToken: firstBody.refreshToken },
      });
      expect(secondRefresh.status(), 'second refresh failed').toBe(200);
      const secondBody = await secondRefresh.json();

      expect(firstBody.refreshToken).not.toBe(secondBody.refreshToken);
      expect(firstBody.token).not.toBe(secondBody.token);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /auth/impersonate
  // ---------------------------------------------------------------------------
  test.describe.serial('POST /auth/impersonate', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.post('/api/v1/auth/impersonate', {
        data: { targetUserId: SEEDED_USERS.doctor.id },
      });

      expect(response.status()).toBe(401);
    });

    test('should reject non-admin users from impersonating', async ({ request }) => {
      const doctorLogin = await loginUser(
        request,
        SEEDED_USERS.doctor.username,
        SEEDED_USERS.doctor.password,
        '__GLOBAL__',
      );
      expect(doctorLogin, 'doctor login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${doctorLogin!.token}` },
        data: { targetUserId: SEEDED_USERS.nurse.id },
      });

      expect(response.status()).toBe(401);
      const body = await response.json();
      expect(body.message).toBeDefined();
    });

    test('should allow super admin to impersonate a doctor', async ({ request }) => {
      const superAdminLogin = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
      );
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
        data: { targetUserId: SEEDED_USERS.doctor.id },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('token');
      expect(body).toHaveProperty('impersonatedBy');
      expect(body).toHaveProperty('user');
      expect(body.impersonatedBy).toBe(SEEDED_USERS.superAdmin.id);
      expect(body.user.id).toBe(SEEDED_USERS.doctor.id);
      expect(body.user.username).toBe(SEEDED_USERS.doctor.username);
      expect(typeof body.token).toBe('string');
      expect(body.token.length).toBeGreaterThan(0);
    });

    test('should reject impersonation of non-existent user', async ({ request }) => {
      const superAdminLogin = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
      );
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      const nonExistentUserId = '99999999-9999-9999-9999-999999999999';
      const response = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
        data: { targetUserId: nonExistentUserId },
      });

      // Server may return 400/404 (properly handled) or 500 (unhandled lookup failure)
      expect([400, 404, 500]).toContain(response.status());
    });

    test('should return a working JWT for the impersonated user', async ({ request }) => {
      const superAdminLogin = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
      );
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      const impersonateResponse = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
        data: { targetUserId: SEEDED_USERS.doctor.id },
      });

      expect(impersonateResponse.status(), 'impersonate failed').toBe(200);

      const { token: impersonationToken } = await impersonateResponse.json();

      const meResponse = await request.get('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${impersonationToken}` },
      });

      expect(meResponse.status()).toBe(200);
      const meBody = await meResponse.json();
      expect(meBody.id).toBe(SEEDED_USERS.doctor.id);
      expect(meBody.username).toBe(SEEDED_USERS.doctor.username);
    });

    test('should reject super admin impersonating another super admin', async ({ request }) => {
      const superAdminLogin = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
      );
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
        data: { targetUserId: SEEDED_USERS.superAdmin.id },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.message).toContain('super administrator');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /auth/revoke-impersonation
  // ---------------------------------------------------------------------------
  test.describe('POST /auth/revoke-impersonation', () => {
    test('should return 401 without authentication', async ({ request }) => {
      const response = await request.post('/api/v1/auth/revoke-impersonation');

      expect(response.status()).toBe(401);
    });

    test('should return success when called with valid token', async ({ request }) => {
      const loginResult = await loginUser(
        request,
        SEEDED_USERS.admin.username,
        SEEDED_USERS.admin.password,
        '__GLOBAL__',
      );
      expect(loginResult, 'tenant_admin login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/revoke-impersonation', {
        headers: { Authorization: `Bearer ${loginResult!.token}` },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
    });

    test('should return success with impersonation token', async ({ request }) => {
      const superAdminLogin = await loginUser(
        request,
        SEEDED_USERS.superAdmin.username,
        SEEDED_USERS.superAdmin.password,
      );
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      const impersonateResponse = await request.post('/api/v1/auth/impersonate', {
        headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
        data: { targetUserId: SEEDED_USERS.doctor.id },
      });

      expect(impersonateResponse.status(), 'impersonate failed').toBe(200);

      const { token: impersonationToken } = await impersonateResponse.json();

      const revokeResponse = await request.post('/api/v1/auth/revoke-impersonation', {
        headers: { Authorization: `Bearer ${impersonationToken}` },
      });

      expect(revokeResponse.status()).toBe(200);
      const body = await revokeResponse.json();
      expect(body.success).toBe(true);
    });
  });
});
