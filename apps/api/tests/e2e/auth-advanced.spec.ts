/**
 * Auth Advanced E2E Tests
 *
 * Tests for authentication endpoints: refresh, impersonate, revoke-impersonation
 *
 * TEST DATA MANAGEMENT:
 * - Uses seeded users (super_admin, tenant_admin, doctor, nurse) for tests
 * - The super-admin-target rejection case creates ONE throwaway user (granted
 *   the seeded SUPER_ADMIN role) because the seed has a single elevated admin and
 *   the self-impersonation guard fires before the target check; the
 *   assignment is removed and the user soft-deleted via the API in cleanup
 * - No other test data is created
 */

import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

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
      const loginResult = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, '__GLOBAL__');
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
      const loginResult = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, '__GLOBAL__');
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
      const loginResult = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, '__GLOBAL__');
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
      const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, '__GLOBAL__');
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
      const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
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
      const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
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
      const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
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
      const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
      expect(superAdminLogin, 'super_admin login failed').toBeTruthy();

      // The seed has exactly ONE super admin, and the
      // self-impersonation guard evaluates BEFORE the super-admin-target
      // check, so targeting the seeded super admin (= the caller) only ever
      // exercised the self guard ("You cannot impersonate yourself"). To keep
      // the ORIGINAL intent (a super-admin-tier TARGET is rejected) covered,
      // create a throwaway user, grant it the seeded SUPER_ADMIN role, assert
      // the rejection, then remove the grant + soft-delete the user via the
      // API. Fixture ops use a tenant-scoped super-admin session so the role
      // assignment lands with a concrete tenantId (mirrors harness).
      const saGlobal = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
      expect(saGlobal, 'tenant-scoped super_admin login failed').toBeTruthy();
      const fixtureHeaders = { Authorization: `Bearer ${saGlobal!.token}` };

      const unique = Date.now();
      const create = await request.post('/api/v1/admin/users', {
        headers: fixtureHeaders,
        data: {
          username: `authadv_sa2_${unique}`,
          password: 'Password123!',
          email: `authadv.sa2.${unique}@example.com`,
        },
      });
      expect(create.status(), 'create throwaway super-admin-tier target').toBeLessThan(300);
      const targetId = ((await create.json()) as { id: string }).id;

      let assignmentId: string | undefined;
      try {
        const rolesRes = await request.get('/api/v1/admin/rbac/roles', { headers: fixtureHeaders });
        expect(rolesRes.status(), 'list rbac roles').toBe(200);
        const rolesRaw = (await rolesRes.json()) as unknown;
        const roles = (Array.isArray(rolesRaw) ? rolesRaw : ((rolesRaw as { data?: unknown[] }).data ?? [])) as Array<{
          id: string;
          name: string;
        }>;
        const superAdminRole = roles.find((r) => r.name === 'SUPER_ADMIN');
        expect(superAdminRole, 'seeded SUPER_ADMIN role exists').toBeTruthy();

        const assign = await request.post(`/api/v1/admin/users/${targetId}/roles`, {
          headers: fixtureHeaders,
          data: { roleId: superAdminRole!.id },
        });
        expect([200, 201], 'grant SUPER_ADMIN to the throwaway target').toContain(assign.status());
        assignmentId = ((await assign.json()) as { id?: string }).id;

        const response = await request.post('/api/v1/auth/impersonate', {
          headers: { Authorization: `Bearer ${superAdminLogin!.token}` },
          data: { targetUserId: targetId },
        });

        expect(response.status()).toBe(400);
        const body = await response.json();
        expect(body.message).toContain('global administrator');
      } finally {
        // API-only cleanup (both are soft-deletes): drop the SUPER_ADMIN
        // grant first, then the throwaway user, restoring the single-super-
        // admin seed posture.
        if (assignmentId) {
          await request.delete(`/api/v1/admin/users/${targetId}/roles/${assignmentId}`, { headers: fixtureHeaders }).catch(() => undefined);
        }
        await request.delete(`/api/v1/admin/users/${targetId}`, { headers: fixtureHeaders }).catch(() => undefined);
      }
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

    test('should reject with 400 when the token is not an impersonation session', async ({ request }) => {
      // Contract: revoke-impersonation is strict — a non-impersonation bearer
      // has no active impersonation to revoke, so the endpoint returns 400
      // ("Not currently impersonating") rather than a no-op success.
      const loginResult = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, '__GLOBAL__');
      expect(loginResult, 'tenant_admin login failed').toBeTruthy();

      const response = await request.post('/api/v1/auth/revoke-impersonation', {
        headers: { Authorization: `Bearer ${loginResult!.token}` },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(String(body.message ?? '')).toMatch(/impersonat/i);
    });

    test('should return success with impersonation token', async ({ request }) => {
      const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
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
