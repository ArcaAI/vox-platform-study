/**
 * Cross-tenant + governance probes against AiTaskDefaultAdminController
 * (`/api/v1/admin/ai-task-defaults`), following the task-307 cross-tenant pattern.
 *
 * Locked contracts (`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts` covers
 * `guardrail.`, `smr.`, `nlp.` AND `harness.`, i.e. EVERY registered task key —
 * none of them are tenant-grantable):
 *  1. Tenant scoping — a tenant admin is pinned to their CLS tenant; an explicit
 *     foreign `?tenantId=` is REJECTED (403/404, 200 never; no foreign row
 *     content in the body).
 *  2. Task-key governance — writes to ANY registered task key are
 *     GLOBAL-ADMIN-ONLY: a tenant admin PUT → 403 even for their OWN tenant
 *     (a privilege verdict, deliberately raised BEFORE the OCC compare — so a
 *     tenant admin sees 403, not 412, on any version).
 *  3. Global admin acts cross-tenant via `?tenantId=` (PUT succeeds).
 *  4. RFC 7232 OCC — PUT without `If-Match` → 428; stale `If-Match` → 412
 *     (asserted on the seeded SYSTEM row, where a version ≥ 1 exists).
 *  5. Unknown taskKey → 400.
 *
 * OCC create lane: `If-Match: "0"` is the first-edit/create precondition
 * (parser accepts 0 as a deliberate owner decision); the service CAS
 * decides create-vs-412.
 *
 * Prereqs (seeded): registry slugs `granite-guardian-4.1-8b`
 * (GUARDRAIL) and `medical-ner` (TOKEN_CLASSIFICATION) exist in the SYSTEM catalog.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const BASE = '/api/v1/admin/ai-task-defaults';

interface AiTaskDefaultRow {
  tenantId: string;
  taskKey: string;
  modelSlug: string | null;
  version: number;
}

/** Read the caller-scoped row so PUTs always carry the CURRENT version. */
async function readRowVersion(request: APIRequestContext, token: string, taskKey: string, tenantId?: string): Promise<AiTaskDefaultRow> {
  const qs = tenantId ? `?taskKey=${taskKey}&tenantId=${tenantId}` : `?taskKey=${taskKey}`;
  const resp = await request.get(`${BASE}/row${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(resp.status(), `GET row ${taskKey}`).toBe(200);
  return (await resp.json()) as AiTaskDefaultRow;
}

test.describe('AiTaskDefault admin surface (cross-tenant + guardrail governance)', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;
  /** The tenant the GLOBAL admin acts on (ARCAAI) — foreign to the tenant admin (__GLOBAL__). */
  let arcaaiTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed').toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // Discover the ARCAAI tenant id through the global admin's own scope.
    const row = await readRowVersion(request, globalAdminToken, 'nlp.ner');
    arcaaiTenantId = row.tenantId;
    expect(arcaaiTenantId).toBeTruthy();
  });

  test('tenant admin reads their OWN effective defaults (all keys, no taskKey)', async ({ request }) => {
    const resp = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as Array<{ taskKey: string }>;
    expect(Array.isArray(body)).toBe(true);
    // The full registry: guardrail.safety/groundedness,
    // nlp.diagnosis, smr.live/finalize and harness.judge.
    expect(body.map((e) => e.taskKey)).toEqual([
      'guardrail.validate',
      'guardrail.safety',
      'guardrail.groundedness',
      'nlp.ner',
      'nlp.classification',
      'nlp.diagnosis',
      'smr.live',
      'smr.finalize',
      'harness.judge',
    ]);
  });

  test('unknown taskKey → 400', async ({ request }) => {
    const resp = await request.get(`${BASE}?taskKey=not.a.task`, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(400);
  });

  test("tenant admin CANNOT READ another tenant's rows via ?tenantId= (rejected, never 200)", async ({ request }) => {
    const resp = await request.get(`${BASE}/row?taskKey=nlp.ner&tenantId=${arcaaiTenantId}`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
    });
    // Shared resolveScopedTenantId posture: 403 (404 acceptable on surfaces that
    // choose the no-existence-leak mapping). The load-bearing assertion: no 200,
    // and no foreign row content in the body.
    expect([403, 404]).toContain(resp.status());
    const body = await resp.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain(arcaaiTenantId);
  });

  test("tenant admin CANNOT WRITE another tenant's rows via ?tenantId= (rejected, never 200)", async ({ request }) => {
    const resp = await request.put(`${BASE}/row?taskKey=nlp.ner&tenantId=${arcaaiTenantId}`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': '"0"' },
      data: { modelSlug: 'medical-ner' },
    });
    expect([403, 404]).toContain(resp.status());
  });

  test('GOVERNANCE: tenant admin PUT on guardrail.validate for their OWN tenant → 403 (deliberate, not 404)', async ({ request }) => {
    const row = await readRowVersion(request, tenantAdminToken, 'guardrail.validate');
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    // A privilege rule on a key the caller can already read — 403 by owner
    // directive (2026-07-17), NOT the 404-over-403 tenancy posture.
    expect(resp.status()).toBe(403);
  });

  test('GOVERNANCE: NO task key remains tenant-grantable — nlp.ner PUT by a tenant admin → 403', async ({ request }) => {
    // Every registered prefix (guardrail./smr./nlp./harness.) is
    // GLOBAL-ADMIN-ONLY. The 403 fires BEFORE the OCC compare, so any valid
    // If-Match sees it.
    const row = await readRowVersion(request, tenantAdminToken, 'nlp.ner');
    const resp = await request.put(`${BASE}/row?taskKey=nlp.ner`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'medical-ner' },
    });
    expect(resp.status()).toBe(403);
    expect(JSON.stringify(await resp.json())).toContain('global administrators only');
  });

  // First edit on a fresh seed: the ARCAAI tenant row is a version-0
  // placeholder, so this PUT travels the `If-Match: "0"` create lane
  // (accepted as a deliberate owner decision).
  test('global admin PUT with ?tenantId= succeeds cross-tenant (incl. guardrail.validate)', async ({ request }) => {
    const row = await readRowVersion(request, globalAdminToken, 'guardrail.validate', arcaaiTenantId);
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${arcaaiTenantId}`, {
      headers: { Authorization: `Bearer ${globalAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    expect(resp.status()).toBe(200);
    const updated = (await resp.json()) as AiTaskDefaultRow;
    expect(updated.tenantId).toBe(arcaaiTenantId);
    expect(updated.modelSlug).toBe('granite-guardian-4.1-8b');
  });

  test('r2605 Finding A: global admin with an ELEVATED working tenant (x-tenant-id) targeting ?tenantId=SYSTEM — GET row + PUT both 200', async ({
    request,
  }) => {
    // The BFF proxy always sends the global admin's working tenant as
    // `x-tenant-id`, which the gateway elevates into CLS. Pre-fix, targeting
    // `?tenantId=SYSTEM` under that elevated context made the tenant-scope
    // extension inject the working tenant: reads silently missed, the CAS
    // update matched 0 rows (eternal 412 even with a correct If-Match) and the
    // create lane threw `TenantScope: tenantId mismatch` (500). The service's
    // cross-tenant base-client lane must make both the read and the write 200.
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const headers = { Authorization: `Bearer ${globalAdminToken}`, 'x-tenant-id': arcaaiTenantId };

    const read = await request.get(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, { headers });
    expect(read.status(), 'GET SYSTEM row under an elevated working tenant').toBe(200);
    const row = (await read.json()) as AiTaskDefaultRow;
    expect(row.tenantId).toBe(SYSTEM_TENANT_ID);

    const put = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { ...headers, 'If-Match': `"${row.version}"` },
      // A unique configJson stamp guarantees a real change even when the slug
      // is already the persisted value (the no-op guard would otherwise 400).
      data: { modelSlug: 'granite-guardian-4.1-8b', configJson: { e2eStamp: `finding-a-${Date.now()}` } },
    });
    expect(put.status(), 'PUT SYSTEM row under an elevated working tenant').toBe(200);
    const updated = (await put.json()) as AiTaskDefaultRow;
    expect(updated.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(updated.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(updated.version).toBeGreaterThan(row.version);
  });

  test('PUT without If-Match → 428 (Precondition Required)', async ({ request }) => {
    const resp = await request.put(`${BASE}/row?taskKey=nlp.ner`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}` },
      data: { modelSlug: 'medical-ner' },
    });
    expect(resp.status()).toBe(428);
  });

  test('PUT with a stale If-Match → 412 (Precondition Failed)', async ({ request }) => {
    // A tenant admin gets the governance 403 BEFORE
    // the OCC compare on every key, so the 412 contract is asserted where it
    // still lives — a global admin against the seeded SYSTEM row (version ≥ 1).
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${globalAdminToken}`, 'If-Match': '"999"' },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    expect(resp.status()).toBe(412);
  });

  test('GET row stamps an ETag from the row version once a row exists', async ({ request }) => {
    // Tenant rows are version-0 placeholders on a fresh
    // seed (their creation is governance-blocked), so assert on the seeded SYSTEM row.
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const resp = await request.get(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${globalAdminToken}` },
    });
    expect(resp.status()).toBe(200);
    const row = (await resp.json()) as AiTaskDefaultRow;
    expect(row.version).toBeGreaterThanOrEqual(1);
    expect(resp.headers()['etag']).toBe(`"${row.version}"`);
  });
});
