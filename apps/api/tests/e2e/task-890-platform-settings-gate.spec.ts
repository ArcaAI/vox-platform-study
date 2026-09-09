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

  /**
   * TASK-932 S2-4 — this case used to tolerate `[400, 403]` and probe
   * `enable-local-raw-capture`, which was an UNREGISTERED key at the time. It
   * therefore pinned nothing: the write lane refused it at step 1 ("unknown
   * key"), and `assertMayWriteAtScope` — the guard the test is named after —
   * was never reached. Since the visibility work landed
   * (`descriptorOr404` on the write route, 2026-09-09) that same request answers
   * 404, so the tolerance had gone stale in the other direction too.
   *
   * Split in two, each probing the guard it names:
   *   - the scope guard, with a key a tenant admin CAN see, written at `system`;
   *   - the platform-only 404, with the key this lane just registered.
   */
  test('the settings REGISTRY keeps its own system-scope guard (regression pin on assertMayWriteAtScope)', async ({ request }) => {
    // `rateLimit.maxRequests` is `global-kv`, NOT `globalOnly`, `maxScope:
    // 'tenant'` — a tenant admin may see it and may set it FOR ITSELF. Writing
    // it at `system` scope changes it platform-wide, which is the 403 this
    // guard exists to raise, and the only shape that reaches it.
    const response = await request.put('/api/v1/admin/settings/registry/rateLimit.maxRequests', {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` },
      data: { value: 10, scope: 'system' },
    });
    expect(response.status(), 'a system-scope write by a tenant admin is a privilege 403, not a 404 or a 400').toBe(403);
  });

  test('a registered platform-only key is 404 on the write route — existence hiding, not the scope 403', async ({ request }) => {
    // `enable-local-raw-capture` is now a registered `Feature Availability`
    // descriptor: `global-kv`, `globalOnly`, `maxScope: 'system'`. Being
    // `globalOnly` it is absent from a tenant admin's CATALOG, and the write
    // route answers the same 404 the GET does so the lane cannot be walked as a
    // directory of the platform's configuration.
    //
    // This is deliberately NOT the write lane's own `globalOnly` 403: that 403
    // is the backstop for a key the caller CAN see. Which of the two answers a
    // key gets is decided by `isTenantVisibleSetting`, not by the guard order,
    // and conflating them is how a platform key becomes enumerable.
    const response = await request.put('/api/v1/admin/settings/registry/enable-local-raw-capture', {
      headers: { Authorization: `Bearer ${await tenantAdminToken(request)}` },
      data: { value: false, scope: 'system' },
    });
    expect(response.status(), 'a platform-only key must be indistinguishable from an unknown one to a tenant admin').toBe(404);

    // ...and it is a REAL key, so the 404 above is a visibility rule and not a
    // broken fixture: the super admin reads it from the catalog by name.
    const catalog = await request.get('/api/v1/admin/settings/catalog', { headers: { Authorization: `Bearer ${await superAdminToken(request)}` } });
    const body = (await catalog.json()) as { items: Array<{ key: string; globalOnly?: boolean; maxScope: string }> };
    const descriptor = body.items.find((i) => i.key === 'enable-local-raw-capture');
    expect(descriptor, 'the descriptor must exist — this is the proof the S2-4 registration landed').toBeDefined();
    expect(descriptor!.globalOnly).toBe(true);
    expect(descriptor!.maxScope).toBe('system');
  });
});

/**
 * TASK-932 S2-1 — a `(tenantId, key)` pair holds at most ONE live row.
 *
 * `create` used to probe only for a soft-DELETED row at the exact
 * `(tenantId, name, key)` — the shape of the OLD unique index — so the same key
 * under a different `name`/`namespace` was accepted and stored twice. Nothing
 * about that is cosmetic: `AppSettingsService` rebuilds its cache keyed by key
 * alone and REFUSES the whole cache when it finds two ("duplicate platform
 * key(s) detected"), so the second row does not shadow one setting, it takes
 * the settings cache down for the process.
 *
 * Pinned here and not in the route matrix because the refusal depends on the
 * STATE of the table, not on the caller: the same POST from the same super
 * admin succeeds or 400s according to whether the key is already occupied.
 */
test.describe('TASK-932 S2-1 — the settings table holds one live row per (tenantId, key)', () => {
  test('a super admin cannot create a second row for an occupied key in another namespace', async ({ request }) => {
    const token = await superAdminToken(request);

    // The seeded, SYSTEM-tenant `enable-local-raw-capture` row lives in
    // namespace `feature-flags`; this asks for the same key in another one.
    const before = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(before.status(), 'the seeded platform row must exist for this test to mean anything').toBe(200);
    const row = await before.json();
    expect(row.key).toBe('enable-local-raw-capture');

    const response = await request.post(SETTINGS, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        tenantId: SYSTEM_TENANT_ID,
        namespace: 'task-932-duplicate-probe',
        name: 'Duplicate probe',
        key: row.key,
        value: 'false',
        dataType: 'Boolean',
      },
    });

    expect(response.status(), 'a duplicate key is a 400 that NAMES the occupying namespace, never a second row').toBe(400);
    expect(JSON.stringify(await response.json())).toContain('feature-flags');

    // Nothing was written: the original row is untouched, and it is still the
    // only one carrying that key.
    const after = await request.get(`${SETTINGS}/${SYSTEM_ROW_ID}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await after.json()).version).toBe(row.version);

    const list = await request.get(`${SETTINGS}/tenant/${SYSTEM_TENANT_ID}?limit=200`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await list.json()) as { data: Array<{ key: string }> };
    expect(body.data.filter((i) => i.key === row.key)).toHaveLength(1);
  });
});
