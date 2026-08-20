/**
 * TASK-776 F-07 — sub-collection routes must 404 when the PARENT is missing.
 *
 * Nine routes returned `200` with an empty sub-collection for a NONEXISTENT
 * parent id, because the only existence signal each relied on doubled as a
 * "no rows" signal:
 *
 *   - `/admin/users/:id/{roles,departments,api-keys,settings,profile,voice-profiles}`
 *     called `assertUserInScope`, whose SUPER_ADMIN branch returned
 *     immediately — the tenant-membership lookup (the only thing that would
 *     have 404'd) never ran for that caller.
 *   - `/admin/departments/:id/children` (`DepartmentService.getChildren`) and
 *     `/admin/prompt-templates/:id/{versions,usage}`
 *     (`PromptManagementService.getVersions`/`getUsageStats`) never loaded
 *     the parent row at all — they queried the child table directly.
 *
 * A client could not distinguish "no roles" from "no such user". Fixed by
 * proving the parent exists (and, for a non-SUPER_ADMIN caller, belongs to
 * the caller's tenant) before returning the sub-collection — 404, never a
 * silent 200 empty list, and never 403 (404-over-403: a cross-tenant parent
 * must be indistinguishable from a nonexistent one).
 *
 * This spec proves, against the LIVE gateway, for every one of the nine
 * routes:
 *   1. a bogus (well-formed but nonexistent) parent id -> 404;
 *   2. a REAL parent id that belongs to a DIFFERENT tenant -> 404 (never
 *      403, never 200) — the strong form of the invariant, using the
 *      ArcaAI tenant (`50000000-…0001`, `packages/database/src/prisma/
 *      db_main/seed/00-constants.ts`) as tenant B against the tenant_admin
 *      user's own tenant (`__GLOBAL__`, `50000000-…0000`) as tenant A;
 *   3. the SAME real parent, read by an unscoped SUPER_ADMIN (who is exempt
 *      from tenant containment but NOT from existence) -> 200 with the real
 *      sub-collection — proving the fix did not regress the happy path.
 *
 * Prerequisites: API server running against the test DB (`pnpm test:up:api`),
 * seeded (`pnpm test:db:seed`).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

// `packages/database/src/prisma/db_main/seed/00-constants.ts` —
// `SEED_CUSTOMER_TENANT_IDS.ARCAAI`. The single retained second customer
// tenant, seeded exactly to back cross-tenant isolation specs like this one.
const ARCAAI_TENANT_ID = '50000000-0000-0000-0000-000000000001';
const BOGUS_ID = '00000000-dead-4000-8000-000000000776';

test.describe('TASK-776 F-07 — sub-collection parent-existence guard', () => {
  let superAdminToken: string;
  let tenantAdminToken: string; // __GLOBAL__ tenant — NOT ArcaAI
  let arcaaiUserId: string;
  let arcaaiDepartmentId: string;
  let arcaaiTemplateId: string;

  test.beforeAll(async ({ request }) => {
    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin?.token, 'super-admin login failed').toBeTruthy();
    superAdminToken = superAdmin!.token as string;

    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(tenantAdmin?.token, 'tenant_admin (__GLOBAL__) login failed').toBeTruthy();
    tenantAdminToken = tenantAdmin!.token as string;

    // Discover REAL rows living in the ArcaAI tenant (tenant B), via the
    // super admin with an elevated `X-Tenant-Id`, so this spec depends on no
    // hardcoded row ids beyond the well-known seed tenant/user constants.
    const users = await request.get('/api/v1/admin/users?limit=1', { headers: bearer(superAdminToken, ARCAAI_TENANT_ID) });
    expect(users.status(), 'list ArcaAI users').toBe(200);
    const usersBody = await users.json();
    expect(usersBody.data.length, 'ArcaAI tenant must have at least one seeded user').toBeGreaterThan(0);
    arcaaiUserId = usersBody.data[0].id;

    const departments = await request.get('/api/v1/admin/departments/roots', { headers: bearer(superAdminToken, ARCAAI_TENANT_ID) });
    expect(departments.status(), 'list ArcaAI root departments').toBe(200);
    const departmentsBody = await departments.json();
    expect(departmentsBody.length, 'ArcaAI tenant must have at least one seeded root department').toBeGreaterThan(0);
    arcaaiDepartmentId = departmentsBody[0].id;

    const templates = await request.get('/api/v1/admin/prompt-templates?limit=1', { headers: bearer(superAdminToken, ARCAAI_TENANT_ID) });
    expect(templates.status(), 'list ArcaAI prompt templates').toBe(200);
    const templatesBody = await templates.json();
    expect(templatesBody.data.length, 'ArcaAI tenant must have at least one seeded prompt template').toBeGreaterThan(0);
    arcaaiTemplateId = templatesBody.data[0].id;
  });

  const userSubRoutes = ['roles', 'departments', 'api-keys', 'settings', 'profile', 'voice-profiles'];

  for (const sub of userSubRoutes) {
    test(`GET /admin/users/:id/${sub} — bogus parent id -> 404 (SUPER_ADMIN, was 200)`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/users/${BOGUS_ID}/${sub}`, { headers: bearer(superAdminToken) });
      expect(res.status(), await res.text()).toBe(404);
    });

    test(`GET /admin/users/:id/${sub} — real cross-tenant parent -> 404, never 403 (tenant_admin)`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/users/${arcaaiUserId}/${sub}`, { headers: bearer(tenantAdminToken) });
      expect(res.status(), await res.text()).toBe(404);
    });

    test(`GET /admin/users/:id/${sub} — real SAME-tenant-scope parent (SUPER_ADMIN) -> 200`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/users/${arcaaiUserId}/${sub}`, { headers: bearer(superAdminToken) });
      expect(res.status(), await res.text()).toBe(200);
    });
  }

  test('GET /admin/departments/:id/children — bogus parent id -> 404 (was 200 [])', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/departments/${BOGUS_ID}/children`, { headers: bearer(superAdminToken) });
    expect(res.status(), await res.text()).toBe(404);
  });

  test('GET /admin/departments/:id/children — real cross-tenant parent -> 404, never 403', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/departments/${arcaaiDepartmentId}/children`, { headers: bearer(tenantAdminToken) });
    expect(res.status(), await res.text()).toBe(404);
  });

  test('GET /admin/departments/:id/children — real parent (SUPER_ADMIN) -> 200', async ({ request }) => {
    const res = await request.get(`/api/v1/admin/departments/${arcaaiDepartmentId}/children`, { headers: bearer(superAdminToken) });
    expect(res.status(), await res.text()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  for (const sub of ['versions', 'usage']) {
    test(`GET /admin/prompt-templates/:id/${sub} — bogus parent id -> 404 (was 200)`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/prompt-templates/${BOGUS_ID}/${sub}`, { headers: bearer(superAdminToken) });
      expect(res.status(), await res.text()).toBe(404);
    });

    test(`GET /admin/prompt-templates/:id/${sub} — real cross-tenant parent -> 404, never 403`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/prompt-templates/${arcaaiTemplateId}/${sub}`, { headers: bearer(tenantAdminToken) });
      expect(res.status(), await res.text()).toBe(404);
    });

    test(`GET /admin/prompt-templates/:id/${sub} — real parent (SUPER_ADMIN) -> 200`, async ({ request }) => {
      const res = await request.get(`/api/v1/admin/prompt-templates/${arcaaiTemplateId}/${sub}`, { headers: bearer(superAdminToken) });
      expect(res.status(), await res.text()).toBe(200);
    });
  }
});
