/**
 * TASK-932 Lane T — `GET /storage/buckets?includePhysical=true`, the storage
 * browser "All tenants" view for an unscoped platform admin.
 *
 * `TenantBucketService.listBucketsCrossTenantWithPhysical` merges every
 * tenant's registered `TenantBucket` rows (`findAllCrossTenant`) with the
 * physical bucket list from the storage provider, and is restricted to a
 * SUPER_ADMIN with NO working tenant — a tenant-bound caller (even a super
 * admin who picked a working tenant) gets 400, never a silent fallback to its
 * own tenant. Plain `GET /storage/buckets` (no flag) is unchanged and stays
 * covered by `storage-cross-tenant.spec.ts` (F-1: tenant-scoped only).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

interface BucketWithScopeRow {
  name: string;
  creationDate?: string;
  tenantId: string | null;
  tenantName: string | null;
  registered: boolean;
  physicalMissing: boolean;
}

test.describe('TASK-932 — GET /storage/buckets?includePhysical=true', () => {
  let unscopedSuperAdminToken: string;
  let arcaaiSuperAdminToken: string;
  let globalTenantAdminToken: string;

  test.beforeAll(async ({ request }) => {
    // No tenantKey → unscoped (no X-Tenant-Id equivalent on the JWT).
    const unscoped = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(unscoped, 'unscoped super_admin login failed').toBeTruthy();
    unscopedSuperAdminToken = unscoped!.token;

    const scoped = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(scoped, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = scoped!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
    globalTenantAdminToken = ta!.token;
  });

  test('an unscoped super admin lists rows spanning both seeded customer tenants (Global + ArcaAI)', async ({ request }) => {
    const response = await request.get('/api/v1/storage/buckets?includePhysical=true', {
      headers: { Authorization: `Bearer ${unscopedSuperAdminToken}` },
    });
    expect(response.status()).toBe(200);

    const rows = (await response.json()) as BucketWithScopeRow[];
    expect(Array.isArray(rows)).toBe(true);

    const registeredTenantIds = new Set(rows.filter((row) => row.registered).map((row) => row.tenantId));
    expect(registeredTenantIds.size).toBeGreaterThan(1);

    // Every row carries the includePhysical-only shape — never a partial one.
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.registered).toBe('boolean');
      expect(typeof row.physicalMissing).toBe('boolean');
      if (row.registered) {
        expect(typeof row.tenantId).toBe('string');
        expect(typeof row.tenantName).toBe('string');
      } else {
        expect(row.tenantId).toBeNull();
        expect(row.tenantName).toBeNull();
      }
    }
  });

  test('a super admin WITH a working tenant (ARCAAI) gets 400, not a silent same-tenant fallback', async ({ request }) => {
    const response = await request.get('/api/v1/storage/buckets?includePhysical=true', {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect(response.status()).toBe(400);
  });

  test("a tenant admin (__GLOBAL__) gets 400 and never sees another tenant's buckets", async ({ request }) => {
    const response = await request.get('/api/v1/storage/buckets?includePhysical=true', {
      headers: { Authorization: `Bearer ${globalTenantAdminToken}` },
    });
    expect(response.status()).toBe(400);
  });

  test('the plain listing (no flag) for the __GLOBAL__ tenant admin is unaffected — only its own tenant', async ({ request }) => {
    const response = await request.get('/api/v1/storage/buckets', {
      headers: { Authorization: `Bearer ${globalTenantAdminToken}` },
    });
    expect(response.status()).toBe(200);
    const rows = (await response.json()) as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    // Byte-identical shape to the pre-existing route: no includePhysical-only fields leak in.
    for (const row of rows) {
      expect(row).not.toHaveProperty('tenantId');
      expect(row).not.toHaveProperty('tenantName');
      expect(row).not.toHaveProperty('registered');
      expect(row).not.toHaveProperty('physicalMissing');
    }
  });
});
