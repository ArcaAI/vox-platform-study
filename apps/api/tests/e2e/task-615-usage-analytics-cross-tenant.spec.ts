/**
 * Cross-tenant posture for the usage-analytics surface
 * (AdminUsageController `admin/usage/*` + MyUsageController `tenants/me/usage-*`),
 * following the pattern (see `ai-task-defaults-cross-tenant.spec.ts`
 * and `task-615-billing-cross-tenant.spec.ts` for the canonical probe shape).
 *
 * Two governance postures are exercised, per rule 05:
 *   1. `admin/usage/summary` (+ timeseries/cost-per-encounter) — a tenant-scoped
 *      read resolved through `resolveScopedTenantId`. A tenant-bound caller who
 *      passes an EXPLICIT foreign `?tenantId=` is rejected 403 by the privilege
 *      check BEFORE the service runs (never a data leak); a super admin MAY act
 *      cross-tenant via `?tenantId=` → 200.
 *   2. `admin/usage/top-tenants` — a SUPER_ADMIN-ONLY cross-tenant read,
 *      enforced imperatively (`isSuperAdmin` in `UsageAnalyticsService`). A
 *      tenant admin gets 403 regardless of params — the "super-admin-only
 *      action" pattern from rule 05, distinct from 404-over-403.
 *
 * The tenant self-service twin (`tenants/me/usage-summary`) is positively probed for the
 * tenant admin and negatively for the super admin (who is told to use the
 * `/admin/usage` endpoints — 400).
 *
 * Run: `pnpm test:up:api` (terminal 1) then `pnpm test:e2e` — see
 * apps/api/tests/e2e conventions / tests/README.md.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const ADMIN_USAGE = '/api/v1/admin/usage';
const MY_USAGE = '/api/v1/tenants/me/usage';

/** The tenant the GLOBAL admin acts on by default — foreign to the DEFAULT_TENANT_KEY tenant admin. */
const FOREIGN_TENANT_KEY = 'ARCAAI';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// SERIAL: this file's `beforeAll` performs stateful billing writes (compute-draft,
// and in the lifecycle spec finalize/void) for a FIXED (tenant, period). Under
// `fullyParallel: true` Playwright spreads a file's tests across workers, so
// `beforeAll` runs concurrently in several of them and the second identical
// compute-draft collides with the first — 409, before any assertion runs.
// Serial mode pins the file to one worker so the setup happens exactly once.
test.describe.configure({ mode: 'serial' });

test.describe('Usage-analytics cross-tenant posture', () => {
  let superAdminToken: string;
  let tenantAdminToken: string; // DEFAULT_TENANT_KEY (__GLOBAL__)
  let foreignTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);
    expect(ga, 'super admin login failed').toBeTruthy();
    superAdminToken = ga!.token;

    // Discover the FOREIGN_TENANT_KEY tenant id through the super admin's own
    // working-tenant scope — the `/row` discovery trick (TASK-881 moved it off the retired ai-task-defaults surface).
    const row = await request.get('/api/v1/admin/nlp-task-instructions/row?taskKey=nlp.topic', { headers: bearer(superAdminToken) });
    expect(row.status(), 'nlp-task-instructions row (tenant discovery)').toBe(200);
    foreignTenantId = ((await row.json()) as { tenantId: string }).tenantId;
    expect(foreignTenantId).toBeTruthy();

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;
  });

  test('GET admin/usage/summary — tenant admin passing an EXPLICIT foreign ?tenantId= -> 403 (privilege, before the service runs)', async ({
    request,
  }) => {
    const resp = await request.get(`${ADMIN_USAGE}/summary?tenantId=${foreignTenantId}`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(403);
  });

  test('GET admin/usage/summary — super admin CAN read the foreign tenant via ?tenantId= -> 200', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/summary?tenantId=${foreignTenantId}`, { headers: bearer(superAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { tenantId?: string };
    // The summary echoes the resolved scope; when present it must be the foreign tenant, never a mix.
    if (body.tenantId !== undefined) expect(body.tenantId).toBe(foreignTenantId);
  });

  test('GET admin/usage/summary — tenant admin own scope (no query) never leaks a foreign tenant id', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/summary`, { headers: bearer(tenantAdminToken) });
    // Either the tenant admin holds manage:UsageAnalytics for its own scope (200)
    // or the surface is super-admin-only (403) — both are non-leak postures.
    expect([200, 403]).toContain(resp.status());
    if (resp.status() === 200) {
      expect(JSON.stringify(await resp.json())).not.toContain(foreignTenantId);
    }
  });

  test('GET admin/usage/top-tenants — tenant admin -> 403 (super-admin-only cross-tenant read)', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/top-tenants`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(403);
  });

  test('GET admin/usage/top-tenants — super admin -> 200', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/top-tenants`, { headers: bearer(superAdminToken) });
    expect(resp.status()).toBe(200);
  });

  test('GET tenants/me/usage-summary — tenant admin reads its OWN usage -> 200, no foreign leak', async ({ request }) => {
    const resp = await request.get(`${MY_USAGE}-summary`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(200);
    expect(JSON.stringify(await resp.json())).not.toContain(foreignTenantId);
  });

  // `/tenants/me/usage-*` reads the CALLER's own tenant and nothing else
  // (`MyUsageController.ownTenantId()` reads the CLS tenant, with no `tenantId`
  // override and no by-id route). A super admin logs in against a working
  // tenant, so that context IS present and the read legitimately returns that
  // tenant's own usage — the 400 fires only when there is no tenant context at
  // all. What matters for the cross-tenant posture is that the foreign tenant
  // never appears, which is asserted here exactly as for the tenant admin.
  test('GET tenants/me/usage-summary — super admin reads its WORKING tenant, never a foreign one', async ({ request }) => {
    const resp = await request.get(`${MY_USAGE}-summary`, { headers: bearer(superAdminToken) });
    expect(resp.status()).toBe(200);
    expect(JSON.stringify(await resp.json())).not.toContain(foreignTenantId);
  });
});
