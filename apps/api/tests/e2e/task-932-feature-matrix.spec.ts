/**
 * TASK-932 R-8 — the feature-availability plane.
 *
 * DEPTH the route-authz matrix cannot express: both matrix routes declare
 * `read`/`manage:GlobalSetting`, which a tenant admin legitimately holds for its
 * OWN rows — the SUPER_ADMIN boundary is imperative
 * (`FeatureAvailabilityService.assertPlatformMatrixAccess`), so only a
 * hand-written case can prove it. Likewise the batch's PARTIAL semantics: a
 * refused cell answers 200 with an `errors[]` entry, and asserting that is the
 * difference between "the save worked" and "the save reported what it did".
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const FEATURES = '/api/v1/admin/settings/features';
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** A console visibility gate: `global-kv`, boolean, per-tenant, default OFF. */
const GATE = 'console.mlflow.enabled';
/** `maxScope: 'system'` — its consumer has no tenant, so it has no tenant cells. */
const PLATFORM_ONLY_GATE = 'registration.selfSignupEnabled';

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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface MatrixBody {
  features: Array<{ key: string; default: boolean; maxScope: string; category: string }>;
  tenants: Array<{ id: string; name: string; slug: string }>;
  cells: Array<{ key: string; tenantId: string; value: boolean | null; version: number }>;
}

// SERIAL: the write cases move the SAME rows, and run in parallel they race —
// the failure then reads as "the cascade is wrong" when it is not.
test.describe.configure({ mode: 'serial' });

test.describe('GET features/effective — caller-scoped, every admin', () => {
  test('a super admin with no working tenant gets the platform values', async ({ request }) => {
    const response = await request.get(`${FEATURES}/effective`, { headers: auth(await superAdminToken(request)) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { items: Array<{ key: string; value: boolean; sourceScope: string }> };

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => typeof i.value === 'boolean')).toBe(true);
    expect(body.items.some((i) => i.key === GATE)).toBe(true);
    // Never a tenant's value: an unscoped platform admin asks the platform tier,
    // and "Global" (50000000-…) is a customer tenant, never a fallback.
    expect(body.items.every((i) => i.sourceScope !== 'tenant')).toBe(true);
  });

  test('a TENANT admin may read its own gates, although every descriptor is globalOnly', async ({ request }) => {
    // Deliberate (see the route's AUTH-NOTE): these are values about the
    // caller's own tenant, and the console cannot decide whether to render a
    // screen without them. Withholding them would not protect anything — it
    // would only make the tenant admin's navigation wrong.
    const response = await request.get(`${FEATURES}/effective`, { headers: auth(await tenantAdminToken(request)) });
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });
});

test.describe('the matrix is SUPER_ADMIN only', () => {
  test('a tenant admin gets 403 on read and on write — a privilege boundary, not a 404', async ({ request }) => {
    const headers = auth(await tenantAdminToken(request));
    expect((await request.get(`${FEATURES}/matrix`, { headers })).status()).toBe(403);
    expect((await request.put(`${FEATURES}/matrix`, { headers, data: { cells: [{ key: GATE, tenantId: 'system', value: true }] } })).status()).toBe(
      403,
    );
  });
});

test.describe('GET features/matrix', () => {
  test('lists every non-SYSTEM tenant and a platform column that always has a value', async ({ request }) => {
    const response = await request.get(`${FEATURES}/matrix`, { headers: auth(await superAdminToken(request)) });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as MatrixBody;

    expect(body.features.length).toBeGreaterThan(0);
    expect(body.features.every((f) => f.category === 'Feature Availability')).toBe(true);
    // SYSTEM is the platform COLUMN, not a tenant.
    expect(body.tenants.some((t) => t.id === SYSTEM_TENANT_ID)).toBe(false);
    expect(body.tenants.length).toBeGreaterThan(0);

    for (const cell of body.cells.filter((c) => c.tenantId === 'system')) {
      expect(typeof cell.value, `${cell.key} platform cell`).toBe('boolean');
    }
  });

  test('a platform-only feature contributes NO tenant cells', async ({ request }) => {
    const body = (await (await request.get(`${FEATURES}/matrix`, { headers: auth(await superAdminToken(request)) })).json()) as MatrixBody;
    const cells = body.cells.filter((c) => c.key === PLATFORM_ONLY_GATE);
    expect(cells.map((c) => c.tenantId)).toEqual(['system']);
  });
});

test.describe('PUT features/matrix', () => {
  test('sets a tenant override, then resets it with null and the tenant inherits again', async ({ request }) => {
    const headers = auth(await superAdminToken(request));
    const read = async () => (await (await request.get(`${FEATURES}/matrix`, { headers })).json()) as MatrixBody;

    let before = await read();
    const tenant = before.tenants[0]!;
    const cellOf = (body: MatrixBody) => body.cells.find((c) => c.key === GATE && c.tenantId === tenant.id)!;
    // Start from INHERIT: another suite (the console matrix spec shares this
    // database) may have left an override behind, and a same-value write is a
    // per-cell 400 by design.
    if (cellOf(before).value !== null) {
      const clear = await request.put(`${FEATURES}/matrix`, {
        headers,
        data: { cells: [{ key: GATE, tenantId: tenant.id, value: null, expectedVersion: cellOf(before).version }] },
      });
      expect(clear.status(), await clear.text()).toBe(200);
      before = await read();
    }
    const original = cellOf(before);

    const set = await request.put(`${FEATURES}/matrix`, {
      headers,
      data: { cells: [{ key: GATE, tenantId: tenant.id, value: true, ...(original.version > 0 ? { expectedVersion: original.version } : {}) }] },
    });
    expect(set.status(), await set.text()).toBe(200);
    expect((await set.json()).errors).toEqual([]);
    expect(cellOf(await read()).value).toBe(true);

    const afterSet = cellOf(await read());
    const reset = await request.put(`${FEATURES}/matrix`, {
      headers,
      data: { cells: [{ key: GATE, tenantId: tenant.id, value: null, expectedVersion: afterSet.version }] },
    });
    expect(reset.status(), await reset.text()).toBe(200);
    expect((await reset.json()).errors).toEqual([]);

    // `null` means the row is GONE, so the tenant follows the platform default
    // again — not a copy of it frozen at today's value.
    expect(cellOf(await read()).value).toBeNull();
  });

  test('a drifted cell is reported per cell, and the VALID cells in the same batch still land', async ({ request }) => {
    // The batch is ordered and PARTIAL. Failing the whole save on one drifted
    // cell would discard a screenful of unrelated valid edits and say nothing
    // about which cell to re-read.
    const headers = auth(await superAdminToken(request));
    const read = async () => (await (await request.get(`${FEATURES}/matrix`, { headers })).json()) as MatrixBody;
    let before = await read();
    const tenant = before.tenants[0]!;
    const NEIGHBOUR = 'console.tools.mcp.enabled';
    const neighbourOf = (body: MatrixBody) => body.cells.find((c) => c.key === NEIGHBOUR && c.tenantId === tenant.id)!;
    // The neighbour must start from INHERIT (no row): a previous run that
    // failed before its restore, or the console suite sharing this database,
    // may have left an override behind, and a stored row demands If-Match.
    if (neighbourOf(before).value !== null) {
      const clear = await request.put(`${FEATURES}/matrix`, {
        headers,
        data: { cells: [{ key: NEIGHBOUR, tenantId: tenant.id, value: null, expectedVersion: neighbourOf(before).version }] },
      });
      expect(clear.status(), await clear.text()).toBe(200);
      before = await read();
    }

    const response = await request.put(`${FEATURES}/matrix`, {
      headers,
      data: {
        cells: [
          // Deliberately stale.
          { key: GATE, tenantId: tenant.id, value: true, expectedVersion: 9999 },
          // Valid, and must survive its neighbour's failure.
          { key: NEIGHBOUR, tenantId: tenant.id, value: true },
        ],
      },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { cells: unknown[]; errors: Array<{ key: string; tenantId: string; status: number }> };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.key).toBe(GATE);
    expect(body.errors[0]!.status).toBe(412);

    const after = await read();
    expect(neighbourOf(after).value).toBe(true);

    // Restore.
    const applied = neighbourOf(after);
    await request.put(`${FEATURES}/matrix`, {
      headers,
      data: { cells: [{ key: NEIGHBOUR, tenantId: tenant.id, value: null, expectedVersion: applied.version }] },
    });
  });

  test('refuses a key that is not a feature-availability setting', async ({ request }) => {
    const response = await request.put(`${FEATURES}/matrix`, {
      headers: auth(await superAdminToken(request)),
      data: { cells: [{ key: 'rateLimit.maxRequests', tenantId: 'system', value: true }] },
    });
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { errors: Array<{ status: number }> }).errors[0]!.status).toBe(400);
  });

  test('null on the PLATFORM column rewrites the row to the descriptor default', async ({ request }) => {
    // The asymmetry is the design: there is nothing above the platform row to
    // inherit from, so "back to the default" is a WRITE of that value, stated
    // and versioned as such, never a delete.
    const headers = auth(await superAdminToken(request));
    const read = async () => (await (await request.get(`${FEATURES}/matrix`, { headers })).json()) as MatrixBody;

    const before = await read();
    const feature = before.features.find((f) => f.key === GATE)!;
    const platformCell = before.cells.find((c) => c.key === GATE && c.tenantId === 'system')!;

    const response = await request.put(`${FEATURES}/matrix`, {
      headers,
      data: {
        cells: [{ key: GATE, tenantId: 'system', value: null, ...(platformCell.version > 0 ? { expectedVersion: platformCell.version } : {}) }],
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()).errors).toEqual([]);

    const after = await read();
    expect(after.cells.find((c) => c.key === GATE && c.tenantId === 'system')!.value).toBe(feature.default);
  });
});
