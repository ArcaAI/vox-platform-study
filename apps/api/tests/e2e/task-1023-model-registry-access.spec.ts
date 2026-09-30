/**
 * TASK-1023 OD-1 / OD-4 — DEPTH coverage for the model-registry access split.
 *
 * The route-authorization MATRIX (`task-776-route-authz-matrix.spec.ts`) covers the breadth once
 * `GET admin/ai-models/access` and `GET admin/ai-models/registry` appear in a regenerated manifest.
 * This file pins what the matrix cannot express:
 *   - a TENANT admin reads the registry view (read-only, redacted) and learns it cannot manage;
 *   - the tenant admin's writes and the platform-only reads stay refused;
 *   - a platform admin with NO working tenant can manage; the SAME super admin with a working
 *     tenant selected cannot (one gate for every registry operation).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/ai-models';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';

/** The redacted view — asserted as an EXACT key set. */
const VIEW_KEYS = [
  'availability',
  'deploymentKind',
  'description',
  'format',
  'gated',
  'id',
  'isPlatformDefaultFor',
  'languages',
  'libraryName',
  'license',
  'lifecycleStatus',
  'memorySizeMb',
  'name',
  'resourceStatus',
  'servedBy',
  'slug',
  'taskType',
  'updatedAt',
].sort();

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

test.describe('TASK-1023 — model registry access', () => {
  test('a TENANT admin reads the registry view, redacted, and cannot manage', async ({ request }) => {
    const headers = { Authorization: `Bearer ${await tenantAdminToken(request)}` };

    const registry = await request.get(`${BASE}/registry?page=1&limit=50`, { headers });
    expect(registry.status()).toBe(200);
    const page = await registry.json();
    expect(page).toMatchObject({ page: 1, limit: 50 });
    expect(typeof page.total).toBe('number');
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length, 'the seeded SYSTEM registry is not empty').toBeGreaterThan(0);
    for (const item of page.data) {
      expect(Object.keys(item).sort()).toEqual(VIEW_KEYS);
      expect(typeof item.lifecycleStatus).toBe('string');
    }
    const wire = JSON.stringify(page);
    for (const hidden of ['bucketPrefix', 'primaryObject', 'localPath', 'checksum', 'manifestDigest', '_metadata', 'metaData', 'referrers', '/mnt/models-bucket']) {
      expect(wire, `the registry view must not carry ${hidden}`).not.toContain(hidden);
    }

    const access = await request.get(`${BASE}/access`, { headers });
    expect(access.status()).toBe(200);
    const body = await access.json();
    expect(body.canManage).toBe(false);
    expect(typeof body.tenantManagementEnabled).toBe('boolean');
  });

  test('a filter on a column the view does not return is a 400', async ({ request }) => {
    const headers = { Authorization: `Bearer ${await tenantAdminToken(request)}` };
    const response = await request.get(`${BASE}/registry?filters=${encodeURIComponent('bucketPrefix[contains]:hf')}`, { headers });
    expect(response.status()).toBe(400);
  });

  test('a TENANT admin is still refused registration and the platform list', async ({ request }) => {
    const headers = { Authorization: `Bearer ${await tenantAdminToken(request)}` };

    const register = await request.post(`${BASE}/register-from-hub`, { headers, data: { repoId: 'hf-internal-testing/tiny-random-bert' } });
    expect(register.status()).toBe(403);

    const list = await request.get(`${BASE}/list`, { headers });
    expect(list.status()).toBe(403);
  });

  test('a platform admin with NO working tenant can manage', async ({ request }) => {
    const headers = { Authorization: `Bearer ${await superAdminToken(request)}` };

    const access = await request.get(`${BASE}/access`, { headers });
    expect(access.status()).toBe(200);
    expect((await access.json()).canManage).toBe(true);

    const list = await request.get(`${BASE}/list`, { headers });
    expect(list.status()).toBe(200);
  });

  test('the same super admin WITH a working tenant cannot manage (one gate for the whole registry)', async ({ request }) => {
    const headers = { Authorization: `Bearer ${await superAdminToken(request)}`, 'X-Tenant-Id': GLOBAL_TENANT_ID };

    const access = await request.get(`${BASE}/access`, { headers });
    expect(access.status()).toBe(200);
    expect((await access.json()).canManage).toBe(false);

    const list = await request.get(`${BASE}/list`, { headers });
    expect(list.status()).toBe(403);

    const registry = await request.get(`${BASE}/registry`, { headers });
    expect(registry.status()).toBe(200);
  });
});
