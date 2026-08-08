/**
 * TASK-615 #9 — cross-tenant posture for the usage-analytics surface
 * (AdminUsageController `admin/usage/*` + MyUsageController `usage/me/*`),
 * following the task-307 pattern (see `ai-task-defaults-cross-tenant.spec.ts`
 * and `task-615-billing-cross-tenant.spec.ts` for the canonical probe shape).
 *
 * Two governance postures are exercised, per rule 05:
 *   1. `admin/usage/summary` (+ timeseries/cost-per-encounter) — a tenant-scoped
 *      read resolved through `resolveScopedTenantId`. A tenant-bound caller who
 *      passes an EXPLICIT foreign `?tenantId=` is rejected 403 by the privilege
 *      check BEFORE the service runs (never a data leak); a global admin MAY act
 *      cross-tenant via `?tenantId=` → 200.
 *   2. `admin/usage/top-tenants` — a GLOBAL-ADMIN-ONLY cross-tenant read,
 *      enforced imperatively (`isSuperAdmin` in `UsageAnalyticsService`). A
 *      tenant admin gets 403 regardless of params — the "global-admin-only
 *      action" pattern from rule 05, distinct from 404-over-403.
 *
 * The tenant self-service twin (`usage/me/summary`) is positively probed for the
 * tenant admin and negatively for the global admin (who is told to use the
 * `/admin/usage` endpoints — 400).
 *
 * Run: `pnpm test:up:api` (terminal 1) then `pnpm test:e2e` — see
 * apps/api/tests/e2e conventions / tests/README.md.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const ADMIN_USAGE = '/api/v1/admin/usage';
const MY_USAGE = '/api/v1/usage/me';

/** The tenant the GLOBAL admin acts on by default — foreign to the DEFAULT_TENANT_KEY tenant admin. */
const FOREIGN_TENANT_KEY = 'ARCAAI';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('TASK-615 usage-analytics cross-tenant posture', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string; // DEFAULT_TENANT_KEY (__GLOBAL__)
  let foreignTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);
    expect(ga, 'global admin login failed').toBeTruthy();
    globalAdminToken = ga!.token;

    // Discover the FOREIGN_TENANT_KEY tenant id through the global admin's own
    // working-tenant scope — the proven ai-task-defaults `/row` discovery trick.
    const row = await request.get('/api/v1/admin/ai-task-defaults/row?taskKey=nlp.ner', { headers: bearer(globalAdminToken) });
    expect(row.status(), 'ai-task-defaults row (tenant discovery)').toBe(200);
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

  test('GET admin/usage/summary — global admin CAN read the foreign tenant via ?tenantId= -> 200', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/summary?tenantId=${foreignTenantId}`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { tenantId?: string };
    // The summary echoes the resolved scope; when present it must be the foreign tenant, never a mix.
    if (body.tenantId !== undefined) expect(body.tenantId).toBe(foreignTenantId);
  });

  test('GET admin/usage/summary — tenant admin own scope (no query) never leaks a foreign tenant id', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/summary`, { headers: bearer(tenantAdminToken) });
    // Either the tenant admin holds manage:UsageAnalytics for its own scope (200)
    // or the surface is global-admin-only (403) — both are non-leak postures.
    expect([200, 403]).toContain(resp.status());
    if (resp.status() === 200) {
      expect(JSON.stringify(await resp.json())).not.toContain(foreignTenantId);
    }
  });

  test('GET admin/usage/top-tenants — tenant admin -> 403 (global-admin-only cross-tenant read)', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/top-tenants`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(403);
  });

  test('GET admin/usage/top-tenants — global admin -> 200', async ({ request }) => {
    const resp = await request.get(`${ADMIN_USAGE}/top-tenants`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
  });

  test('GET usage/me/summary — tenant admin reads its OWN usage -> 200, no foreign leak', async ({ request }) => {
    const resp = await request.get(`${MY_USAGE}/summary`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(200);
    expect(JSON.stringify(await resp.json())).not.toContain(foreignTenantId);
  });

  test('GET usage/me/summary — global admin is redirected to the admin endpoints -> 400', async ({ request }) => {
    const resp = await request.get(`${MY_USAGE}/summary`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(400);
  });
});
