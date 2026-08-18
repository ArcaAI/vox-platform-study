/**
 * Phase 0 red-team suite.
 *
 * Every test here proves a specific exploit chain is closed. Tests live in
 * CI forever per Decision D8.
 *
 * Sections:
 *   - Item 1+2 mass-assignment chain (B.1)
 *   - Item 3 privilege escalation via admin/users (C.1)
 */

import { test, expect } from '@playwright/test';

test.describe('Phase 0 — Item 1+2: mass-assignment chain', () => {
  let doctorToken: string;
  let tenantAdminToken: string;
  let tenantAdminConfigId: string;
  let tenantAdminConfigVersion: number;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(doctorLogin.status(), 'doctor login failed').toBe(200);
    doctorToken = (await doctorLogin.json()).token;

    const tenantAdminLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'tenant_admin', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(tenantAdminLogin.status(), 'tenant_admin login failed').toBe(200);
    tenantAdminToken = (await tenantAdminLogin.json()).token;

    // Defense-in-depth gated PATCH /tenants/me/config behind
    // `update:Tenant` — a DOCTOR token no longer reaches the ValidationPipe at
    // all (see the dedicated 403 test below), so the mass-assignment chain is
    // now proven through tenant_admin, the caller actually authorized to PATCH.
    const configs = await request.get('/api/v1/tenants/me/config?limit=200&page=1', {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    expect(configs.status(), 'tenant config fetch failed').toBe(200);
    const body = await configs.json();
    const unlocked = body.data.find((c: { locked?: boolean; version?: number }) => c.locked !== true);
    expect(unlocked, 'no unlocked GlobalSetting found for tenant_admin — test seed gap').toBeDefined();
    tenantAdminConfigId = unlocked.id;
    tenantAdminConfigVersion = unlocked.version;
  });

  // A non-elevated end-user (DOCTOR) must never reach the
  // config write at all: the authorization guard rejects it before the
  // ValidationPipe (and therefore before mass-assignment checking) runs.
  test('PATCH /tenants/me/config as a non-admin end-user is blocked with 403 (defense-in-depth)', async ({ request }) => {
    const response = await request.patch('/api/v1/tenants/me/config', {
      headers: {
        Authorization: `Bearer ${doctorToken}`,
        'If-Match': '"1"',
      },
      data: [{ id: 'irrelevant', value: 'irrelevant' }],
    });
    expect(response.status(), 'non-admin PATCH must be blocked before reaching mass-assignment validation').toBe(403);
  });

  test('PATCH /tenants/me/config with extra fields (key, tenantId, locked) is rejected with 400', async ({ request }) => {
    // The route is guarded by @RequiresIfMatch, so a
    // valid strong-validator If-Match is required to clear the 428 gate and let
    // the request reach the ValidationPipe — which is where the mass-assignment
    // (smuggled key/locked/tenantId/defaultValue) is rejected with 400.
    const response = await request.patch('/api/v1/tenants/me/config', {
      headers: {
        Authorization: `Bearer ${tenantAdminToken}`,
        'If-Match': `"${tenantAdminConfigVersion}"`,
      },
      data: [
        {
          id: tenantAdminConfigId,
          value: 'attacker-controlled-jwt-secret',
          // Smuggled fields — must be rejected by ValidationPipe (Item 1)
          // and never reach the service (Item 2 allowlist).
          key: 'JWT_SECRET_KEY',
          locked: true,
          tenantId: '50000000-0000-0000-0000-000000000000',
          defaultValue: 'evil-default',
        },
      ],
    });
    expect(response.status(), 'mass-assignment must be rejected with 400').toBe(400);
  });

  test('after rejection, the underlying setting is unchanged', async ({ request }) => {
    const after = await request.get('/api/v1/tenants/me/config?limit=200&page=1', {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    const body = await after.json();
    const row = body.data.find((c: { id: string }) => c.id === tenantAdminConfigId);
    expect(row.key, 'key must NOT have been overwritten').not.toBe('JWT_SECRET_KEY');
    expect(row.locked, 'locked must NOT have been escalated').not.toBe(true);
  });
});

test.describe('Phase 0 — Item 3: privilege escalation via admin/users', () => {
  let doctorToken: string;
  let superAdminRoleId: string;
  let victimUserId: string;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(doctorLogin.status()).toBe(200);
    doctorToken = (await doctorLogin.json()).token;

    // Discover the SUPER_ADMIN role id and a victim user id via a super-admin
    // session. These are seeded by tests/setup/playwright.global-setup.ts.
    const adminLogin = await request.post('/api/v1/auth/login', {
      data: { username: 'super_admin', password: 'password123' },
    });
    const adminToken = (await adminLogin.json()).token;
    const rolesResp = await request.get('/api/v1/admin/rbac/roles', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const roles = (await rolesResp.json()).data;
    superAdminRoleId = roles.find((r: { name: string }) => r.name === 'SUPER_ADMIN')?.id;
    expect(superAdminRoleId, 'SUPER_ADMIN role id not discoverable').toBeDefined();

    // This super-admin session has NO tenant scope, so `/admin/users` returns the
    // full cross-tenant set (now 33+ seeded users incl. per-tenant admins). Use a
    // page large enough to include `nurse`; a small page (e.g. limit=10) drops it.
    const usersResp = await request.get('/api/v1/admin/users?page=1&limit=200', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const users = (await usersResp.json()).data;
    victimUserId = users.find((u: { username: string }) => u.username === 'nurse')?.id;
    expect(victimUserId, 'nurse user id not discoverable').toBeDefined();
  });

  test('POST /admin/users/:id/roles from DOCTOR is rejected with 403', async ({ request }) => {
    const response = await request.post(`/api/v1/admin/users/${victimUserId}/roles`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
      data: { roleId: superAdminRoleId },
    });
    expect(response.status(), 'DOCTOR must NOT escalate roles').toBe(403);
  });

  test('GET /admin/users from DOCTOR is rejected with 403', async ({ request }) => {
    const response = await request.get('/api/v1/admin/users?page=1&limit=10', {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status(), 'DOCTOR must NOT list users').toBe(403);
  });
});
