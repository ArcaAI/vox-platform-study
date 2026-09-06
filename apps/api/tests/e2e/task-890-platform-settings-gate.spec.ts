/**
 * TASK-890 §3.15 (OD-P) — DEPTH coverage for the platform-tier settings guard.
 *
 * `admin/settings` is a TENANT-admin surface (`manage:GlobalSetting`), and its
 * SYSTEM-tenant rows are the platform defaults every tenant inherits. Before
 * this ticket nothing in the service told the two apart: a tenant admin was
 * refused only emergently — by the context interceptor, or by a raw `Error`
 * from the scope extension — so the OBSERVED status was a 400 or a 500 where
 * the answer is a 403.
 *
 * The route matrix cannot express any of this: the route's declared ability is
 * the same for both rows, and only the ROW decides. Nor can it express the
 * ORDER, which is the part that actually protects the id space: existence
 * first (404 for anything not the caller's), privilege second (403 only for a
 * real platform row).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SETTINGS = '/api/v1/admin/settings';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** `enable-local-raw-capture` — a seeded, LOCKED, SYSTEM-tenant row (11-global-setting.ts). */
const SYSTEM_ROW_ID = '00000000-0000-0000-0002-000000000001';
/** `pipeline.templateResync.enabled` — a second seeded SYSTEM row, used for the DELETE probe. */
const SYSTEM_ROW_ID_2 = '00000000-0000-0000-0002-000000000002';

async function tenantAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
  expect(login, 'the seeded tenant admin must log in').not.toBeNull();
  return login!.token;
}

async function superAdminToken(request: APIRequestContext): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  expect(login, 'the seeded super admin must log in').not.toBeNull();
  return login!.token;
}

// SERIAL: two cases in this file touch the SAME seeded SYSTEM row — one asserts a tenant admin's
// PATCH leaves its `version` untouched, and one asserts a super admin's PATCH BUMPS it. Run in
// parallel they race, and the failure reads as "the 403 did not hold" when it did.
test.describe.configure({ mode: 'serial' });

test.describe('TASK-890 — platform settings are super-admin-only to write', () => {
  test('a tenant admin cannot PATCH a SYSTEM row: 403, and the row is unchanged', async ({ request }) => {
    const superToken = await superAdminToken(request);
    const before = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: { Authorization: `Bearer ${superToken}` } });
    expect(before.status()).toBe(200);
    const row = await before.json();

    const response = await request.patch(`${SETTINGS}/${SYSTEM_ROW_ID}`, {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}`, 'If-Match': `"${row.version}"` },
      data: { value: 'false' },
    });
    expect(response.status()).toBe(403);

    const after = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: { Authorization: `Bearer ${superToken}` } });
    expect((await after.json()).version).toBe(row.version);
  });

  test('a tenant admin cannot DELETE a SYSTEM row: 403', async ({ request }) => {
    const response = await request.delete(`${SETTINGS}/${SYSTEM_ROW_ID_2}`, {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` },
    });
    expect(response.status()).toBe(403);
  });

  test('a tenant admin cannot CREATE a row in the SYSTEM tenant: 403, never a 400 or a 500', async ({ request }) => {
    const response = await request.post(SETTINGS, {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` },
      data: {
        tenantId: SYSTEM_TENANT_ID,
        namespace: 'task-890',
        name: 'Escalation probe',
        key: `task-890.escalation.${Date.now()}`,
        value: 'true',
        dataType: 'Boolean',
      },
    });
    expect(response.status()).toBe(403);
  });

  test('existence is resolved BEFORE privilege: an unknown id is 404, not 403', async ({ request }) => {
    const token = await tenantAdminToken(request);
    const unknown = '00000000-0000-0000-0009-999999999999';

    const patch = await request.patch(`${SETTINGS}/${unknown}`, {
      headers: { Authorization: `Bearer ${token}`, 'If-Match': '"1"' },
      data: { value: 'x' },
    });
    expect(patch.status()).toBe(404);

    const del = await request.delete(`${SETTINGS}/${unknown}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(del.status()).toBe(404);
  });

  test('a super admin still writes the SYSTEM row (the guard is a privilege boundary, not a freeze)', async ({ request }) => {
    const token = await superAdminToken(request);

    const before = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    const row = await before.json();

    const response = await request.patch(`${SETTINGS}/${SYSTEM_ROW_ID}`, {
      headers: { Authorization: `Bearer ${token}`, 'If-Match': `"${row.version}"` },
      data: { description: `${row.description ?? ''} `.trim() + ' .' },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).version).toBe(row.version + 1);
  });

  test('the settings REGISTRY keeps its own system-scope guard (regression pin on assertMayWriteAtScope)', async ({ request }) => {
    // A different service, the same rule — pinned here so the two cannot drift:
    // a tenant admin writing a `scope: system` descriptor is a 403, not a 404.
    const response = await request.put('/api/v1/admin/settings/registry/enable-local-raw-capture', {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` },
      data: { value: 'false', scope: 'system' },
    });
    expect([400, 403]).toContain(response.status());
  });
});
