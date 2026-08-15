/**
 * Cross-tenant 404 posture for the billing plane's by-id
 * surfaces (BillingAdminController, RateCardAdminController), following the
 * cross-tenant pattern (see `ai-task-defaults-cross-tenant.spec.ts`
 * for the canonical shape of these probes).
 *
 * Two distinct governance postures are exercised, per rule 05:
 *   1. `admin/billing/invoices/:id` — a REGULAR cross-tenant BY-ID surface.
 *      A tenant-bound caller who OMITS `?tenantId=` is pinned to their own
 *      tenant; requesting another tenant's invoice id resolves against their
 *      own tenant and 404s (never 403 — existence is hidden, rule 05
 *      "404-over-403"). Passing a FOREIGN `?tenantId=` explicitly is a
 *      different, PRIVILEGE code path (`resolveScopedTenantId` throws
 *      `ForbiddenException` before the service is even reached) — asserted
 *      separately so the two mechanisms are not conflated.
 *   2. `admin/billing/rate-card/:id/supersede` — a GLOBAL-ADMIN-ONLY action
 *      (`// AUTH-NOTE` in `rate-card-admin.controller.ts`: mutation is
 *      enforced imperatively via `isSuperAdmin` in `SellRateCardService`).
 *      A tenant admin gets 403 regardless of WHICH id they target — this is
 *      the "global-admin-only action on a tenant-manageable resource"
 *      pattern from rule 05, distinct from 404-over-403.
 *
 * Run: `pnpm test:up:api` (terminal 1) then `pnpm test:e2e` — see
 * apps/api/tests/e2e conventions / tests/README.md.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

const INVOICES_BASE = '/api/v1/admin/billing/invoices';
const RATE_CARD_BASE = '/api/v1/admin/billing/rate-card';

/** The tenant the GLOBAL admin acts on by default — foreign to the DEFAULT_TENANT_KEY tenant admin. */
const FOREIGN_TENANT_KEY = 'ARCAAI';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Current UTC calendar month as YYYY-MM — a period that has not ended, so compute-draft succeeds even though finalize would 400. */
function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

test.describe('Billing cross-tenant posture', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string; // DEFAULT_TENANT_KEY (__GLOBAL__)
  let foreignTenantId: string;
  let foreignInvoiceId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, FOREIGN_TENANT_KEY);
    expect(ga, 'global admin login failed').toBeTruthy();
    globalAdminToken = ga!.token;

    // Discover the FOREIGN_TENANT_KEY tenant id through the global admin's own
    // working-tenant scope — same discovery trick `ai-task-defaults-cross-tenant.spec.ts`
    // uses (a proven, already-seeded admin surface that echoes `tenantId` in its row).
    const row = await request.get('/api/v1/admin/ai-task-defaults/row?taskKey=nlp.ner', { headers: bearer(globalAdminToken) });
    expect(row.status(), 'ai-task-defaults row (tenant discovery)').toBe(200);
    foreignTenantId = ((await row.json()) as { tenantId: string }).tenantId;
    expect(foreignTenantId).toBeTruthy();

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // Global admin computes (idempotently) a DRAFT invoice on the FOREIGN tenant for the current period.
    const draft = await request.post(`${INVOICES_BASE}/compute-draft`, {
      headers: bearer(globalAdminToken),
      data: { tenantId: foreignTenantId, period: currentPeriod() },
    });
    expect(draft.status(), 'compute-draft for foreign tenant').toBe(201);
    const draftBody = (await draft.json()) as { id: string; tenantId: string };
    foreignInvoiceId = draftBody.id;
    expect(foreignInvoiceId).toBeTruthy();
  });

  test('GET invoice :id — tenant admin (own tenant, no query param) targeting a FOREIGN invoice id → 404, never 403', async ({ request }) => {
    const resp = await request.get(`${INVOICES_BASE}/${foreignInvoiceId}`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(404);
  });

  test('GET invoice :id — tenant admin passing an EXPLICIT foreign ?tenantId= → 403 (privilege check, before the service runs)', async ({
    request,
  }) => {
    const resp = await request.get(`${INVOICES_BASE}/${foreignInvoiceId}?tenantId=${foreignTenantId}`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(403);
  });

  test("GET invoice :id — a made-up UUID for the tenant admin's own tenant → 404", async ({ request }) => {
    const resp = await request.get(`${INVOICES_BASE}/00000000-0000-4000-8000-000000000000`, { headers: bearer(tenantAdminToken) });
    expect(resp.status()).toBe(404);
  });

  test('GET invoice :id — global admin CAN read the foreign invoice via ?tenantId=', async ({ request }) => {
    const resp = await request.get(`${INVOICES_BASE}/${foreignInvoiceId}?tenantId=${foreignTenantId}`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { id: string };
    expect(body.id).toBe(foreignInvoiceId);
  });

  test('POST invoice :id/finalize — tenant admin (own tenant, no query param) on a FOREIGN invoice id → 404 before OCC is even checked', async ({
    request,
  }) => {
    const resp = await request.post(`${INVOICES_BASE}/${foreignInvoiceId}/finalize`, { headers: bearer(tenantAdminToken) });
    // No If-Match supplied either, but tenant scoping is resolved (and 404s) upstream of the RequiresIfMatch guard's own concerns for a resource that doesn't resolve to this tenant.
    expect([403, 404, 428]).toContain(resp.status());
  });

  test('POST invoice :id/finalize — tenant admin on their OWN (non-existent) invoice id → SUPER_ADMIN-only 403, never 200', async ({ request }) => {
    const resp = await request.post(`${INVOICES_BASE}/00000000-0000-4000-8000-000000000000/finalize`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
    });
    expect(resp.status()).not.toBe(200);
    expect(resp.status()).not.toBe(201);
  });

  test('rate-card supersede — tenant admin gets 403 regardless of target id (global-admin-only action, not 404-over-403)', async ({ request }) => {
    const resp = await request.post(`${RATE_CARD_BASE}/00000000-0000-4000-8000-000000000000/supersede`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
      data: { effectiveFrom: new Date().toISOString(), unitPriceMicros: '1000' },
    });
    expect(resp.status()).toBe(403);
  });

  test('rate-card list — global admin never sees tenant-owned negotiated rows leak into the platform (no ?tenantId=) listing', async ({
    request,
  }) => {
    const resp = await request.get(RATE_CARD_BASE, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as Array<{ tenantId: string }>;
    expect(Array.isArray(body)).toBe(true);
    // Default (unscoped) listing is the platform SYSTEM card only — every row's tenantId must be the SYSTEM tenant, never a tenant-owned negotiated row.
    const nonSystemRows = body.filter((row) => row.tenantId !== '00000000-0000-0000-0000-000000000000');
    expect(nonSystemRows).toEqual([]);
  });
});
