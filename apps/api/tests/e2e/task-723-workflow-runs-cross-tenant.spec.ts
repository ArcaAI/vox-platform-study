/**
 * TASK-723 — Runs Observability: e2e contract tests for `/api/v1/admin/workflow-runs/*`.
 *
 * SCOPE OF WHAT THIS SPEC CAN PROVE IN THIS ENVIRONMENT (mirrors
 * `task-722-workflow-exposure.spec.ts`'s own disclosed boundary, for the same
 * reason): `WorkflowRun` rows are written ONLY by
 * `WorkflowRunService.recordRunStarted`/`recordRunFinished`, and — per the
 * Task 1 contract (`docs/implementation/TASK-723-Runs-Observability/
 * contracts/run-read-model.contract.md`) and README R2 — NOTHING calls them
 * yet: TASK-718's dispatcher is entirely Temporal-native/ephemeral and does
 * not persist a run row. There is also no HTTP write route for this model
 * (by design — it is a telemetry read model, not an admin-authored
 * resource), so no e2e spec can create a real `WorkflowRun` fixture without
 * reaching into the database directly, which the e2e convention in this
 * directory never does (every spec here drives the API only).
 *
 * What THIS spec proves instead, against a genuinely empty table:
 *  - the tenant-scope gate (`WorkflowRunController.resolveWorkingTenantId`):
 *    a tenant admin resolves its own tenant, an unscoped SUPER_ADMIN gets
 *    403 "no tenant selected", and `X-Tenant-Id` lets a super admin act on
 *    behalf of a specific tenant;
 *  - the keyset list envelope shape (`{ data, nextCursor, hasMore, limit }`)
 *    on an empty result set;
 *  - a malformed cursor -> 400;
 *  - a nonexistent run id -> **404, never 403** on both `GET :runId` and
 *    `GET :runId/trace` — the strongest form of this invariant available
 *    here, since with zero rows in the table there is no cross-tenant ROW to
 *    leak in the first place; every id is equally "not found".
 *
 * The moment TASK-718 (or a follow-up) wires `recordRunStarted`, a companion
 * pass should extend this file with a REAL cross-tenant row check (tenant A
 * cannot read tenant B's run by id) — flagged here rather than silently
 * left incomplete.
 *
 * Prerequisites: API server running against the test DB (`pnpm test:up:api`),
 * seeded (`pnpm test:db:seed`). NOT EXECUTED in this session — see the
 * ticket README §7 for why (`pnpm test:e2e`'s globalSetup runs
 * `prisma db push --force-reset`, refused by the Prisma CLI for an AI agent).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

test.describe('TASK-723 — /api/v1/admin/workflow-runs', () => {
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

    // A real tenant id for the X-Tenant-Id header (M3-style pattern, mirrors
    // `role-members-cross-tenant.spec.ts`): list tenants as the super admin
    // and use the tenant-admin's own tenant so both callers act on the same
    // (empty) table for a like-for-like comparison.
    const tenants = await request.get('/api/v1/admin/tenants?page=0&limit=20', { headers: bearer(superAdminToken) });
    expect(tenants.status(), 'list tenants').toBe(200);
    const tenantsBody = await tenants.json();
    const found = (tenantsBody.data as Array<{ id: string; name?: string }>).find((t) => t.id !== '00000000-0000-0000-0000-000000000000');
    expect(found, 'at least one non-SYSTEM tenant must be seeded').toBeTruthy();
    defaultTenantId = found!.id;
  });

  test('a tenant admin lists its own (empty) runs with the keyset envelope shape', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs', { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('nextCursor');
    expect(body).toHaveProperty('hasMore');
    expect(body).toHaveProperty('limit');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  test('includeSandbox=true is accepted and still returns the same envelope shape', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs?includeSandbox=true', { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('a malformed cursor is rejected with 400, not a 500', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs?cursor=not-a-valid-cursor!!', { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(400);
  });

  test('GET :runId for a nonexistent id is 404, never 403', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs/nonexistent-run-id', { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('GET :runId/trace for a nonexistent id is 404, never 403', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs/nonexistent-run-id/trace', { headers: bearer(tenantAdminToken) });
    expect(response.status()).toBe(404);
  });

  test('an unscoped SUPER_ADMIN with no working tenant gets 403 "no tenant selected", not a 500', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs', { headers: bearer(superAdminToken) });
    expect(response.status()).toBe(403);
  });

  test('a super admin acting via X-Tenant-Id can list that tenant’s (empty) runs', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs', { headers: bearer(superAdminToken, defaultTenantId) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('no bearer token at all is rejected with 401', async ({ request }) => {
    const response = await request.get('/api/v1/admin/workflow-runs');
    expect(response.status()).toBe(401);
  });
});
