/**
 * Cross-tenant isolation for the admin list ("fetchAll") endpoints.
 *
 * Defect X2 (Critical): `GET /admin/users` historically applied NO tenant
 * scope — `User` is not in the Prisma tenant-scope allow-list, so a
 * TENANT_ADMIN holding `manage:User` could enumerate every user on the
 * platform. The fix routes non-super-admins through the membership-scoped
 * `fetchAllByTenantId` (UserController), while SUPER_ADMIN keeps the
 * cross-tenant operator view.
 *
 * Defect X5: `GET /admin/audit-logs` is service-scoped (`buildTenantWhere`)
 * and now also carries the controller-layer guard; a TENANT_ADMIN must only
 * see their own tenant's rows, SUPER_ADMIN sees across tenants.
 *
 * Probe model: a TENANT_ADMIN logs into `__GLOBAL__` (tenant-scoped) and a
 * SUPER_ADMIN logs in with NO tenant scope — the platform-wide operator view.
 * Because the seed ships multiple customer tenants each with their own users,
 * the cross-tenant operator view (SUPER_ADMIN) MUST be strictly larger than
 * the single-tenant admin view — if the X2 scope regresses, the two views
 * collapse to the same set and these assertions fail.
 *
 * NOTE: a SUPER_ADMIN that authenticates INTO a tenant
 * (login `tenantKey`, or a console `x-tenant-id` selection) is INTENTIONALLY
 * scoped to that tenant on `/admin/{users,audit-logs}` — the cross-tenant view
 * is the no-tenant-scope mode (mirrors `AuditLogController.exportCsv`'s
 * `includeTenant = isSuperAdmin && !callerTenantId`). The sibling
 * storage-cross-tenant spec relies on the inverse (an ARCAAI-scoped super_admin
 * sees only ARCAAI's buckets), so the operator here must omit the tenantKey.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

interface PaginatedBody {
  data: Array<{ id: string }>;
  count: number;
}

const fetchPaginated = async (
  request: import('@playwright/test').APIRequestContext,
  path: string,
  token: string,
): Promise<{ status: number; body: PaginatedBody }> => {
  const res = await request.get(path, {
    headers: { Authorization: `Bearer ${token}` },
    // Admin-plane list endpoints (UserController/AuditLogController) bind the
    // shared `PaginatedQuery` DTO, whose page-size key is `limit` — NOT the
    // RBAC-only `pageSize`.
    // The global ValidationPipe (forbidNonWhitelisted) 400s any other key.
    params: { page: '1', limit: '200' },
  });
  const body = res.status() === 200 ? ((await res.json()) as PaginatedBody) : { data: [], count: 0 };
  return { status: res.status(), body };
};

test.describe('X2/X5 — admin fetchAll cross-tenant isolation', () => {
  let tenantAdminToken: string;
  let superAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant_admin login (__GLOBAL__) failed').toBeTruthy();
    tenantAdminToken = ta!.token;

    // Cross-tenant operator: omit tenantKey so the JWT carries no tenantId
    // (a tenant-scoped super-admin would collapse to that
    // tenant's rows and defeat the cross-tenant comparison below).
    const sa = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(sa, 'super_admin login (cross-tenant operator) failed').toBeTruthy();
    superAdminToken = sa!.token;
  });

  test('GET /admin/users — SUPER_ADMIN sees cross-tenant; TENANT_ADMIN is scoped to fewer (X2)', async ({ request }) => {
    const sa = await fetchPaginated(request, '/api/v1/admin/users', superAdminToken);
    const ta = await fetchPaginated(request, '/api/v1/admin/users', tenantAdminToken);

    expect(sa.status, 'super_admin GET /admin/users').toBe(200);
    expect(ta.status, 'tenant_admin GET /admin/users').toBe(200);

    // Both must return real data; the cross-tenant operator count must be
    // strictly greater than the single-tenant admin count. If X2 regresses
    // (no scope), the tenant admin would see the full platform set and the
    // two counts collapse — failing this assertion.
    expect(sa.body.count).toBeGreaterThan(0);
    expect(ta.body.count).toBeGreaterThan(0);
    expect(ta.body.count, 'TENANT_ADMIN must see strictly fewer users than the cross-tenant SUPER_ADMIN view (X2 scope)').toBeLessThan(sa.body.count);
  });

  test('GET /admin/users — TENANT_ADMIN page is a subset of the SUPER_ADMIN page (X2)', async ({ request }) => {
    const sa = await fetchPaginated(request, '/api/v1/admin/users', superAdminToken);
    const ta = await fetchPaginated(request, '/api/v1/admin/users', tenantAdminToken);

    const saIds = new Set(sa.body.data.map((u) => u.id));
    // Every user the tenant admin can see must also be visible to the
    // cross-tenant operator (sanity: scoping never invents foreign rows).
    for (const u of ta.body.data) {
      expect(saIds.has(u.id), `tenant-admin user ${u.id} should also be in the super-admin view`).toBe(true);
    }
    // And the operator must see at least one user the tenant admin cannot.
    const taIds = new Set(ta.body.data.map((u) => u.id));
    expect(
      sa.body.data.some((u) => !taIds.has(u.id)),
      'SUPER_ADMIN must see at least one cross-tenant user',
    ).toBe(true);
  });

  test('GET /admin/audit-logs — SUPER_ADMIN sees >= TENANT_ADMIN (X5)', async ({ request }) => {
    const sa = await fetchPaginated(request, '/api/v1/admin/audit-logs', superAdminToken);
    const ta = await fetchPaginated(request, '/api/v1/admin/audit-logs', tenantAdminToken);

    expect(sa.status, 'super_admin GET /admin/audit-logs').toBe(200);
    expect(ta.status, 'tenant_admin GET /admin/audit-logs').toBe(200);

    // SUPER_ADMIN bypasses `buildTenantWhere`, so its cross-tenant count is
    // always >= the tenant-scoped admin count.
    expect(sa.body.count).toBeGreaterThanOrEqual(ta.body.count);
  });
});
