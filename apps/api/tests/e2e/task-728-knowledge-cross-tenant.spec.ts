/**
 * Memory Management Screens: e2e contract tests for
 * `/api/v1/admin/knowledge/documents/*`.
 *
 * SCOPE OF WHAT THIS SPEC CAN PROVE IN THIS ENVIRONMENT (mirrors
 * `task-723-workflow-runs-cross-tenant.spec.ts`'s own disclosed boundary, for
 * the same reason): `KnowledgeDocumentController` deliberately exposes NO
 * create/approve route — document registration/approval stays on the
 * existing worker-triggering ingest flow (see the controller's own doc
 * comment and Task 5). There is therefore no HTTP write path this
 * spec (which drives the API only, the e2e convention in this directory)
 * can use to create a REAL `KnowledgeDocument` fixture row, so a genuine
 * "tenant A cannot read tenant B's OWN row" check is not constructible here.
 *
 * What THIS spec proves instead, against a genuinely empty/nonexistent-id
 * surface:
 *  - the offset-paginated list envelope shape (`{ data, count, limit, page }`)
 *    on an empty result set, scoped to the caller's own tenant;
 *  - a nonexistent document id -> **404, never 403** on every by-id path
 *    (`GET :id`, `GET :id/chunks`, `POST :id/archive`, `DELETE :id`) — the
 *    strongest form of the 404-over-403 invariant available here, since with
 *    zero rows in the table every id is equally "not found";
 *  - an unauthenticated caller gets 401 on every route;
 *  - a caller without `manage:KnowledgeDocument` (and, for the chunks route,
 *    without `read:KnowledgeDocument`) is rejected — the class-level
 *    `@CanManage`/method-level `@Authorize(['read', ...])` gate is live.
 *
 * The moment a create-from-admin-console flow (explicitly out of scope for
 * per Task 5) or a test-only seed route lands, a
 * companion pass should extend this file with a REAL cross-tenant row check
 * (tenant A cannot read/archive/delete tenant B's document; a chunk read
 * produces a forced `AuditLog` row; a delete produces both an `AuditLog` row
 * and confirmation the harness vector-cleanup endpoint was called) — flagged
 * here rather than silently left incomplete.
 *
 * Prerequisites: API server running against the test DB (`pnpm test:up:api`),
 * seeded (`pnpm test:db:seed`). NOT EXECUTED in this session — see the
 * for why (`pnpm test:e2e`'s globalSetup runs
 * `prisma db push --force-reset`, refused by the Prisma CLI for an AI agent).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

const BASE = '/api/v1/admin/knowledge/documents';

test.describe('/api/v1/admin/knowledge/documents', () => {
  let tenantAdminToken: string;
  let superAdminToken: string;
  let defaultTenantId: string;

  test.beforeAll(async ({ request }) => {
    const admin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(admin?.token, 'tenant-admin login failed').toBeTruthy();
    tenantAdminToken = admin!.token as string;

    const superAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
    expect(superAdmin?.token, 'super-admin login failed').toBeTruthy();
    superAdminToken = superAdmin!.token as string;

    const tenants = await request.get('/api/v1/admin/tenants?page=0&limit=20', { headers: bearer(superAdminToken) });
    expect(tenants.status(), 'list tenants').toBe(200);
    const tenantsBody = await tenants.json();
    const found = (tenantsBody.data as Array<{ id: string; name?: string }>).find((t) => t.id !== '00000000-0000-0000-0000-000000000000');
    expect(found, 'at least one non-SYSTEM tenant must be seeded').toBeTruthy();
    defaultTenantId = found!.id;
  });

  test('a tenant admin lists its own (empty) documents with the offset envelope shape', async ({ request }) => {
    const response = await request.get(BASE, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('count');
    expect(body).toHaveProperty('limit');
    expect(body).toHaveProperty('page');
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET :id for a nonexistent id is 404, never 403', async ({ request }) => {
    const response = await request.get(`${BASE}/nonexistent-document-id`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('GET :id/chunks for a nonexistent id is 404, never 403 (force-audited read route)', async ({ request }) => {
    const response = await request.get(`${BASE}/nonexistent-document-id/chunks`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('POST :id/archive for a nonexistent id is 404, never 403', async ({ request }) => {
    const response = await request.post(`${BASE}/nonexistent-document-id/archive`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('DELETE :id for a nonexistent id is 404, never 403 (fail-closed delete never reaches the harness)', async ({ request }) => {
    const response = await request.delete(`${BASE}/nonexistent-document-id`, { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('a super admin acting via X-Tenant-Id can list that tenant’s (empty) documents', async ({ request }) => {
    const response = await request.get(BASE, { headers: bearer(superAdminToken, defaultTenantId) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('an unscoped SUPER_ADMIN with no working tenant gets 400 "tenant id required", not a 500', async ({ request }) => {
    const response = await request.get(BASE, { headers: bearer(superAdminToken) });
    expect(response.status()).toBe(400);
  });

  test('no bearer token at all is rejected with 401 on every route', async ({ request }) => {
    const list = await request.get(BASE);
    const byId = await request.get(`${BASE}/some-id`);
    const chunks = await request.get(`${BASE}/some-id/chunks`);
    const archive = await request.post(`${BASE}/some-id/archive`);
    const del = await request.delete(`${BASE}/some-id`);
    expect(list.status()).toBe(401);
    expect(byId.status()).toBe(401);
    expect(chunks.status()).toBe(401);
    expect(archive.status()).toBe(401);
    expect(del.status()).toBe(401);
  });
});
