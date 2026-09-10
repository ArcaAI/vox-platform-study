/**
 * Cross-tenant + governance probes against `TenantAllowedOriginController`
 * (`/api/v1/admin/allowed-origins`) —.
 *
 * There was NO e2e coverage at all for this surface before this file
 * (confirmed: nothing under `apps/api/tests/e2e/` matched `origin` or
 * `task-610`). It matters now because relaxed the surface from
 * SUPER_ADMIN-only to TENANT_ADMIN-reachable (README steps 4/6):
 *
 *  - The blanket `assertSuperAdmin()` imperative gate is GONE from every
 *    handler; the class-level `@CanManage('TenantAllowedOrigin')` now
 *    actually admits a TENANT_ADMIN via the `tenant-full-access` policy row
 *    scoped to `conditions.tenantId` (seed `01-policy.ts`).
 *  - Two privilege boundaries moved INTO `TenantAllowedOriginService`,
 *    imperatively, because a permission decorator cannot see the SHAPE of a
 * value: a wildcard/pattern origin and a SYSTEM-tenant write
 *    stay SUPER_ADMIN-only on both `create` and `update` — `update` is the
 *    escalation path (PATCHing an exact row's `origin` into a pattern).
 *  - Cross-tenant reads/writes by id are unaffected and still resolve via
 *    `findOwnedOrThrow` — 404, never 403 (404-over-403 posture), because
 *    unlike `AiTaskDefaultAdminController` this surface has NO `?tenantId=`
 *    query override at all: every handler is scoped purely off CLS.
 *
 * Modeled closely on `ai-provider-connections-cross-tenant.spec.ts` /
 * `tenant-bucket-cross-tenant.spec.ts` — same auth/bootstrap helpers
 * (`loginUser`, `SEEDED_USERS`, `DEFAULT_TENANT_KEY`), same 404-over-403 style
 * assertions (status code AND no foreign-row content in the body).
 *
 * Two distinct customer tenants, both with a login-able TENANT_ADMIN, are
 * needed for the cross-tenant probes — reused from the sibling specs:
 *   - Tenant A = `__GLOBAL__` (`DEFAULT_TENANT_KEY`), admin `tenant_admin`.
 *   - Tenant B = `ARCAAI`, admin `arcaai_admin`.
 * A SUPER_ADMIN (`super_admin`) logs in once per tenant via `tenantKey` to
 * exercise the SAME tenant scope a TENANT_ADMIN of that tenant would see —
 * this surface has no `?tenantId=` override, so "acting cross-tenant" for a
 * super admin means logging into the target tenant's working context, same
 * as the `ai-provider-connections` spec's `superAdmin` login pattern.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/allowed-origins';
const TENANT_A_KEY = DEFAULT_TENANT_KEY; // '__GLOBAL__'
const TENANT_B_KEY = 'ARCAAI';

interface AllowedOriginRow {
  id: string;
  tenantId: string;
  isPlatform: boolean;
  origin: string;
  label: string;
  version: number;
}

/** A unique, syntactically valid exact origin per test run — avoids 409s across retries/parallel runs. */
function uniqueExactOrigin(tag: string): string {
  return `https://task-641-${tag}-${Date.now()}-${Math.floor(Math.random() * 100000)}.example.org`;
}

async function createOrigin(
  request: APIRequestContext,
  token: string,
  origin: string,
  label: string,
): Promise<{ status: number; body: AllowedOriginRow | Record<string, unknown> }> {
  const resp = await request.post(BASE, {
    headers: { Authorization: `Bearer ${token}` },
    data: { origin, label },
  });
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status(), body };
}

test.describe('TenantAllowedOrigin admin surface (cross-tenant + governance)', () => {
  let tenantAAdminToken: string; // TENANT_ADMIN of tenant A (__GLOBAL__)
  let tenantBAdminToken: string; // TENANT_ADMIN of tenant B (ARCAAI)
  let superAdminOnATenantToken: string; // SUPER_ADMIN, working tenant = A
  let superAdminOnBTenantToken: string; // SUPER_ADMIN, working tenant = B

  test.beforeAll(async ({ request }) => {
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, TENANT_A_KEY);
    expect(ta, `tenant_admin login (${TENANT_A_KEY}) failed`).toBeTruthy();
    tenantAAdminToken = ta!.token;

    const tb = await loginUser(request, 'arcaai_admin', SEEDED_USERS.admin.password, TENANT_B_KEY);
    expect(tb, `arcaai_admin login (${TENANT_B_KEY}) failed`).toBeTruthy();
    tenantBAdminToken = tb!.token;

    const gaA = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, TENANT_A_KEY);
    expect(gaA, `super_admin login (${TENANT_A_KEY}) failed`).toBeTruthy();
    superAdminOnATenantToken = gaA!.token;

    const gaB = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, TENANT_B_KEY);
    expect(gaB, `super_admin login (${TENANT_B_KEY}) failed`).toBeTruthy();
    superAdminOnBTenantToken = gaB!.token;
  });

  test.describe('TENANT_ADMIN full CRUD on an exact origin, own tenant only', () => {
    test('create / list / update / delete an exact origin', async ({ request }) => {
      const origin = uniqueExactOrigin('fr1-crud');

      const created = await createOrigin(request, tenantAAdminToken, origin, 'Lane I e2e — FR-1 CRUD');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = created.body as AllowedOriginRow;
      expect(row.origin).toBe(origin);
      expect(row.isPlatform).toBe(false);
      expect(row.version).toBeGreaterThanOrEqual(1);

      const listResp = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(listResp.status()).toBe(200);
      const list = (await listResp.json()) as AllowedOriginRow[];
      expect(list.some((r) => r.id === row.id)).toBe(true);
      // Every row this tenant admin can see belongs to their own tenant (or SYSTEM).
      for (const r of list) {
        expect(r.tenantId === row.tenantId || r.isPlatform).toBe(true);
      }

      const patchResp = await request.patch(`${BASE}/${row.id}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}`, 'If-Match': `"${row.version}"` },
        data: { label: 'Lane I e2e — FR-1 CRUD (renamed)', expectedVersion: row.version },
      });
      expect(patchResp.status(), JSON.stringify(await patchResp.json().catch(() => ({})))).toBe(200);
      const updated = (await patchResp.json()) as AllowedOriginRow;
      expect(updated.label).toBe('Lane I e2e — FR-1 CRUD (renamed)');
      expect(updated.version).toBeGreaterThan(row.version);

      const deleteResp = await request.delete(`${BASE}/${row.id}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}` },
      });
      expect(deleteResp.status()).toBe(200);

      const listAfterDelete = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      const afterList = (await listAfterDelete.json()) as AllowedOriginRow[];
      expect(
        afterList.some((r) => r.id === row.id),
        'soft-deleted row must not appear in the live list',
      ).toBe(false);
    });
  });

  test.describe('Cross-tenant isolation — 404, never 403 (404-over-403 posture)', () => {
    let tenantBRowId: string;

    test.beforeAll(async ({ request }) => {
      const created = await createOrigin(request, tenantBAdminToken, uniqueExactOrigin('cross-tenant-victim'), 'Lane I e2e — tenant B row');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      tenantBRowId = (created.body as AllowedOriginRow).id;
    });

    test("tenant A cannot READ tenant B's row by id → 404, no leak", async ({ request }) => {
      const resp = await request.get(`${BASE}/${tenantBRowId}`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(resp.status()).toBe(404);
      const body = await resp.json().catch(() => ({}));
      expect(String((body as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
    });

    test("tenant A cannot UPDATE tenant B's row by id → 404", async ({ request }) => {
      const resp = await request.patch(`${BASE}/${tenantBRowId}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}`, 'If-Match': '"1"' },
        data: { label: 'hijacked', expectedVersion: 1 },
      });
      expect(resp.status()).toBe(404);
    });

    test("tenant A cannot DELETE tenant B's row by id → 404, row still exists", async ({ request }) => {
      const resp = await request.delete(`${BASE}/${tenantBRowId}`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(resp.status()).toBe(404);

      const stillThere = await request.get(`${BASE}/${tenantBRowId}`, { headers: { Authorization: `Bearer ${tenantBAdminToken}` } });
      expect(stillThere.status()).toBe(200);
    });

    test('synthetic uuidv7 id (never allocated) → 404 (same shape as a real cross-tenant miss)', async ({ request }) => {
      const SYNTHETIC_ID = '018f0000-0000-7100-8000-000000000000';
      const resp = await request.get(`${BASE}/${SYNTHETIC_ID}`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(resp.status()).toBe(404);
    });
  });

  test.describe('wildcard registration stays SUPER_ADMIN-only', () => {
    test('TENANT_ADMIN registering a subdomain wildcard → 403', async ({ request }) => {
      const resp = await createOrigin(request, tenantAAdminToken, 'https://*.example.org:*', 'Lane I e2e — wildcard attempt');
      expect(resp.status, JSON.stringify(resp.body)).toBe(403);
    });

    test('TENANT_ADMIN registering the bare allow-all token → 403', async ({ request }) => {
      const resp = await createOrigin(request, tenantAAdminToken, '*', 'Lane I e2e — allow-all attempt');
      expect(resp.status, JSON.stringify(resp.body)).toBe(403);
    });

    test("TENANT_ADMIN PATCHing their OWN exact row's origin into a wildcard pattern → 403 (the escalation path)", async ({ request }) => {
      const created = await createOrigin(request, tenantAAdminToken, uniqueExactOrigin('fr2-escalation'), 'Lane I e2e — escalation source row');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = created.body as AllowedOriginRow;

      const escalateResp = await request.patch(`${BASE}/${row.id}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}`, 'If-Match': `"${row.version}"` },
        data: { origin: 'https://*.evil.example:*', expectedVersion: row.version },
      });
      expect(escalateResp.status(), JSON.stringify(await escalateResp.json().catch(() => ({})))).toBe(403);

      // Row must be UNCHANGED — the escalation must not have partially applied.
      const reread = await request.get(`${BASE}/${row.id}`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(reread.status()).toBe(200);
      const stillExact = (await reread.json()) as AllowedOriginRow;
      expect(stillExact.origin).toBe(row.origin);
      expect(stillExact.version).toBe(row.version);
    });
  });

  test.describe('SUPER_ADMIN retains full capability (no regression)', () => {
    test('SUPER_ADMIN can register a wildcard and the bare allow-all token', async ({ request }) => {
      const pattern = await createOrigin(request, superAdminOnATenantToken, `https://*.ga-${Date.now()}.example.org:*`, 'Lane I e2e — GA wildcard');
      expect(pattern.status, JSON.stringify(pattern.body)).toBe(201);
      expect((pattern.body as AllowedOriginRow).origin).toContain('*');
    });

    test("SUPER_ADMIN can escalate an exact row's origin into a wildcard via PATCH", async ({ request }) => {
      const created = await createOrigin(request, superAdminOnATenantToken, uniqueExactOrigin('ga-escalation'), 'Lane I e2e — GA escalation source');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = created.body as AllowedOriginRow;

      const escalateResp = await request.patch(`${BASE}/${row.id}`, {
        headers: { Authorization: `Bearer ${superAdminOnATenantToken}`, 'If-Match': `"${row.version}"` },
        data: { origin: `https://*.ga-escalated-${Date.now()}.example:*`, expectedVersion: row.version },
      });
      expect(escalateResp.status(), JSON.stringify(await escalateResp.json().catch(() => ({})))).toBe(200);
      const updated = (await escalateResp.json()) as AllowedOriginRow;
      expect(updated.origin).toContain('*');
    });

    test('SUPER_ADMIN full CRUD succeeds for tenant B exactly as it does for tenant A', async ({ request }) => {
      const origin = uniqueExactOrigin('ga-tenant-b-crud');
      const created = await createOrigin(request, superAdminOnBTenantToken, origin, 'Lane I e2e — GA tenant B CRUD');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = created.body as AllowedOriginRow;

      const patchResp = await request.patch(`${BASE}/${row.id}`, {
        headers: { Authorization: `Bearer ${superAdminOnBTenantToken}`, 'If-Match': `"${row.version}"` },
        data: { label: 'Lane I e2e — GA tenant B CRUD (renamed)', expectedVersion: row.version },
      });
      expect(patchResp.status()).toBe(200);

      const deleteResp = await request.delete(`${BASE}/${row.id}`, { headers: { Authorization: `Bearer ${superAdminOnBTenantToken}` } });
      expect(deleteResp.status()).toBe(200);
    });
  });

  test.describe('enforcement posture disclosure', () => {
    test('GET /admin/allowed-origins/posture returns { enforcementEnabled: boolean }', async ({ request }) => {
      const resp = await request.get(`${BASE}/posture`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } });
      expect(resp.status()).toBe(200);
      const body = (await resp.json()) as { enforcementEnabled: unknown };
      expect(typeof body.enforcementEnabled).toBe('boolean');
    });

    test('posture is readable by a TENANT_ADMIN too (not SUPER_ADMIN-gated)', async ({ request }) => {
      const [taResp, gaResp] = await Promise.all([
        request.get(`${BASE}/posture`, { headers: { Authorization: `Bearer ${tenantAAdminToken}` } }),
        request.get(`${BASE}/posture`, { headers: { Authorization: `Bearer ${superAdminOnATenantToken}` } }),
      ]);
      expect(taResp.status()).toBe(200);
      expect(gaResp.status()).toBe(200);
      const [taBody, gaBody] = await Promise.all([taResp.json(), gaResp.json()]);
      // Platform-wide, single boolean — must agree regardless of caller role.
      expect(taBody.enforcementEnabled).toBe(gaBody.enforcementEnabled);
    });
  });

  test.describe('OCC — RFC 7232 optimistic concurrency on PATCH', () => {
    let occRowId: string;
    let occRowVersion: number;

    test.beforeAll(async ({ request }) => {
      const created = await createOrigin(request, tenantAAdminToken, uniqueExactOrigin('occ'), 'Lane I e2e — OCC row');
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const row = created.body as AllowedOriginRow;
      occRowId = row.id;
      occRowVersion = row.version;
    });

    test('PATCH without If-Match → 428 (Precondition Required)', async ({ request }) => {
      const resp = await request.patch(`${BASE}/${occRowId}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}` },
        data: { label: 'no if-match', expectedVersion: occRowVersion },
      });
      expect(resp.status()).toBe(428);
    });

    test('PATCH with a stale If-Match → 412 (Precondition Failed)', async ({ request }) => {
      const resp = await request.patch(`${BASE}/${occRowId}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}`, 'If-Match': '"999"' },
        data: { label: 'stale version', expectedVersion: 999 },
      });
      expect(resp.status()).toBe(412);
    });

    test('PATCH with the correct current If-Match → 200, and the version advances', async ({ request }) => {
      const resp = await request.patch(`${BASE}/${occRowId}`, {
        headers: { Authorization: `Bearer ${tenantAAdminToken}`, 'If-Match': `"${occRowVersion}"` },
        data: { label: 'correct version', expectedVersion: occRowVersion },
      });
      expect(resp.status(), JSON.stringify(await resp.json().catch(() => ({})))).toBe(200);
      const updated = (await resp.json()) as AllowedOriginRow;
      expect(updated.version).toBeGreaterThan(occRowVersion);
    });
  });
});
