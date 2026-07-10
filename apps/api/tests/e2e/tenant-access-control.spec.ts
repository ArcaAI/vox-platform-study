/**
 * Tenant Access Control E2E Tests (TASK-258 Issues #2 & #3)
 *
 * Verifies the access control hardening on tenant endpoints:
 *   1. /admin/tenants/* now requires manage:Tenant (super-admin) — non-super-admin
 *      users (e.g., a regular doctor) get 403 from POST/DELETE/PATCH.
 *   2. A super-admin still succeeds on POST /admin/tenants.
 *   3. /tenant/me no longer falls back silently to the __GLOBAL__ tenant when the
 *      caller has no tenant context — it returns 400 instead.
 *
 * NOTE: These tests rely on the shared seeded users (super_admin, doctor) and
 * do NOT create resources that require external cleanup beyond the tenant
 * created by case (4). The created tenant is removed via the same admin
 * endpoint inside the same test to keep the database clean.
 */

import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

test.describe('Tenant Access Control (TASK-258)', () => {
  let superAdminToken: string;
  let doctorToken: string;
  let superAdminTokenWithoutTenant: string;

  test.beforeAll(async ({ request }) => {
    // Super-admin logs in WITH tenant context (legacy default tenant).
    const superAdminLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, DEFAULT_TENANT_KEY);
    expect(superAdminLogin, 'super_admin login (with tenantKey) failed').toBeTruthy();
    superAdminToken = superAdminLogin!.token;

    // Super-admin without tenant context — drives Issue #3 verification.
    const superAdminGlobal = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdminGlobal, 'super_admin login (no tenantKey) failed').toBeTruthy();
    superAdminTokenWithoutTenant = superAdminGlobal!.token;

    // Doctor — non super-admin tenant member.
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login failed').toBeTruthy();
    doctorToken = doctorLogin!.token;
  });

  // ========================================================================
  // Issue #2 — manage:Tenant gate on /admin/tenants/*
  // ========================================================================

  test.describe('Issue #2: /admin/tenants/* requires manage:Tenant', () => {
    test('non-super-admin (doctor) is rejected with 403 on POST /admin/tenants', async ({ request }) => {
      const response = await request.post('/api/v1/admin/tenants', {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: {
          name: `denied-tenant-${Date.now()}`,
          key: `denied-tenant-${Date.now()}`,
          description: 'Should never be created — caller lacks manage:Tenant',
        },
      });
      expect(response.status()).toBe(403);
    });

    test('non-super-admin (doctor) is rejected with 403 on DELETE /admin/tenants/:id', async ({ request }) => {
      const response = await request.delete('/api/v1/admin/tenants/00000000-0000-0000-0000-000000000000', {
        headers: { Authorization: `Bearer ${doctorToken}` },
      });
      // The CASL guard runs before the service-layer NotFoundException.
      expect(response.status()).toBe(403);
    });

    test('non-super-admin (doctor) is rejected with 403 on PATCH /admin/tenants/configs/:id', async ({ request }) => {
      const response = await request.patch('/api/v1/admin/tenants/configs/some-config-identifier', {
        headers: { Authorization: `Bearer ${doctorToken}` },
        data: [{ id: '00000000-0000-0000-0000-000000000000', value: 'denied' }],
      });
      expect(response.status()).toBe(403);
    });

    test('super-admin succeeds on POST /admin/tenants', async ({ request }) => {
      const uniqueKey = `task258-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const createResponse = await request.post('/api/v1/admin/tenants', {
        headers: { Authorization: `Bearer ${superAdminToken}` },
        data: {
          name: uniqueKey,
          key: uniqueKey,
          description: 'TASK-258 E2E temp tenant — auto-cleaned',
        },
      });

      expect([200, 201]).toContain(createResponse.status());
      const created = await createResponse.json();
      expect(created).toHaveProperty('id');

      // Cleanup: remove the temp tenant we just created.
      const deleteResponse = await request.delete(`/api/v1/admin/tenants/${created.id}`, {
        headers: { Authorization: `Bearer ${superAdminToken}` },
      });
      expect([200, 204]).toContain(deleteResponse.status());
    });
  });

  // ========================================================================
  // Issue #3 — /tenant/me returns 400 when CLS has no tenant context
  // ========================================================================

  test.describe('Issue #3: /tenant/me requires CLS tenant context', () => {
    test('super_admin without tenant context gets 400 from GET /tenant/me (no silent global fallback)', async ({ request }) => {
      const response = await request.get('/api/v1/tenant/me', {
        headers: { Authorization: `Bearer ${superAdminTokenWithoutTenant}` },
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty('message');
      expect(String(body.message)).toMatch(/tenant context/i);
    });
  });
});
