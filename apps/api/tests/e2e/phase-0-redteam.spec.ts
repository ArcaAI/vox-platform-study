/**
 * Phase 0 red-team suite (TASK-302 Stream A).
 *
 * Every test here proves a specific exploit chain from TASK-301 §Phase 0 is
 * closed. Tests live in CI forever per Decision D8.
 *
 * Sections:
 *   - Item 1+2 mass-assignment chain (B.1)
 *   - Item 3 privilege escalation via admin/users (C.1 — appended in Section C)
 */

import { test, expect } from '@playwright/test';

test.describe('Phase 0 — Item 1+2: mass-assignment chain', () => {
  let doctorToken: string;
  let doctorTenantConfigId: string;

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/v1/auth/login', {
      data: { username: 'doctor', password: 'password123', tenantKey: '__GLOBAL__' },
    });
    expect(login.status(), 'doctor login failed').toBe(200);
    doctorToken = (await login.json()).token;

    // The doctor must own *some* unlocked GlobalSetting to attempt the
    // exploit. Discover one via the tenant-config GET endpoint.
    const configs = await request.get('/api/v1/tenant/me/config?limit=200&page=1', {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(configs.status(), 'tenant config fetch failed').toBe(200);
    const body = await configs.json();
    const unlocked = body.data.find((c: { locked?: boolean }) => c.locked !== true);
    expect(unlocked, 'no unlocked GlobalSetting found for doctor — test seed gap').toBeDefined();
    doctorTenantConfigId = unlocked.id;
  });

  test('PATCH /tenant/me/config with extra fields (key, tenantId, locked) is rejected with 400', async ({ request }) => {
    const response = await request.patch('/api/v1/tenant/me/config', {
      headers: { Authorization: `Bearer ${doctorToken}` },
      data: [
        {
          id: doctorTenantConfigId,
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
    const after = await request.get('/api/v1/tenant/me/config?limit=200&page=1', {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    const body = await after.json();
    const row = body.data.find((c: { id: string }) => c.id === doctorTenantConfigId);
    expect(row.key, 'key must NOT have been overwritten').not.toBe('JWT_SECRET_KEY');
    expect(row.locked, 'locked must NOT have been escalated').not.toBe(true);
  });
});
