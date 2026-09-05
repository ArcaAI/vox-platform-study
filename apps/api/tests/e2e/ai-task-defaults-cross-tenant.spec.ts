/**
 * Cross-tenant + governance probes against AiTaskDefaultAdminController
 * (`/api/v1/admin/ai-task-defaults`), following the cross-tenant pattern.
 *
 * Governance contracts (`SUPER_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts` covers
 * `nlp.`, `harness.` AND — since TASK-872, owner decision #3 of 2026-09-05 —
 * `guardrail.`. Guardrail is built-in and platform-only: it gates every
 * text-generation request before send and every response after receive, so no
 * tenant admin manages any guardrail setting. `text.` is what remains
 * TENANT-ADMIN configurable. `guardrail.*` also keeps its ADDITIONAL platform
 * floor (D2, tighten-only): a write for a non-SYSTEM tenant must name a
 * `modelSlug` that resolves to a SYSTEM-tenant `AiModel` row (the
 * platform-approved list) — 403 otherwise. That floor now bounds the super
 * admin acting on a tenant's behalf, which is the only caller left. The seeded
 * slug `granite-guardian-4.1-8b` used below is a SYSTEM-catalog row, so it
 * satisfies it):
 *  1. Tenant scoping — a tenant admin is pinned to their CLS tenant; an explicit
 *     foreign `?tenantId=` is REJECTED (403/404, 200 never; no foreign row
 *     content in the body).
 *  2. Task-key governance — writes to a SUPER_ADMIN-ONLY task key
 *     (nlp./harness./guardrail.) are refused: a tenant admin PUT → 403 even for
 *     their OWN tenant (a privilege verdict, deliberately raised BEFORE the OCC
 *     compare — so a tenant admin sees 403, not 412, on any version). The
 *     `text.*` keys are the exception: a tenant admin PUT succeeds for their
 *     own tenant.
 *  3. Super admin acts cross-tenant via `?tenantId=` (PUT succeeds).
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
  let superAdminToken: string;
  let tenantAdminToken: string;
  /** The tenant the GLOBAL admin acts on (ARCAAI) — foreign to the tenant admin (__GLOBAL__). */
  let arcaaiTenantId: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'super admin login (ARCAAI) failed').toBeTruthy();
    superAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    // Discover the ARCAAI tenant id through the super admin's own scope.
    const row = await readRowVersion(request, superAdminToken, 'nlp.ner');
    arcaaiTenantId = row.tenantId;
    expect(arcaaiTenantId).toBeTruthy();
  });

  test('tenant admin reads their OWN effective defaults (all keys, no taskKey)', async ({ request }) => {
    const resp = await request.get(BASE, { headers: { Authorization: `Bearer ${tenantAdminToken}` } });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as Array<{ taskKey: string }>;
    expect(Array.isArray(body)).toBe(true);
    // The full registry (AI_TASK_KEYS, ai-task-default/constants.ts):
    // guardrail.validate/safety/groundedness + 's guardrail.pii and
    // guardrail.pii.spans, nlp.ner/classification/diagnosis
    // + nlp.sentiment/toxicity, text.live/finalize + the
    // tenant-configurable text.*.fallback keys + text.test, harness.judge, and
    // vlm.extract.
    //
    // A super-admin-only key still LISTS for a tenant admin — the effective read is the whole
    // registry, and the lock shows up as "the SYSTEM row always wins", not as a hidden key. That
    // is already true of every `nlp.*` key below; the two PII keys join them (SUPER_ADMIN_ONLY_TASK_KEYS).
    expect(body.map((e) => e.taskKey)).toEqual([
      'guardrail.validate',
      'guardrail.safety',
      'guardrail.groundedness',
      'guardrail.pii',
      'guardrail.pii.spans',
      'nlp.ner',
      'nlp.classification',
      'nlp.diagnosis',
      'nlp.sentiment',
      'nlp.toxicity',
      'text.live',
      'text.finalize',
      'text.live.fallback',
      'text.finalize.fallback',
      'text.test',
      'harness.judge',
      'vlm.extract',
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

  test('TASK-872: tenant admin PUT on guardrail.validate for their OWN tenant → 403 (guardrail is platform-only)', async ({ request }) => {
    // Owner decision #3 (2026-09-05) puts `guardrail.` back under
    // SUPER_ADMIN_ONLY_TASK_PREFIXES, reversing the 2026-08-16 window in which
    // this same PUT answered 200. The verdict is a PRIVILEGE 403 raised before
    // the OCC compare, so it does not depend on the version sent.
    const row = await readRowVersion(request, tenantAdminToken, 'guardrail.validate');
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    expect(resp.status()).toBe(403);
    expect(JSON.stringify(await resp.json())).toContain('super administrators only');
  });

  test('D2: super-admin PUT on guardrail.validate with a slug OUTSIDE the platform-approved (SYSTEM) list → 403', async ({ request }) => {
    // The platform-approved-list floor is INDEPENDENT of the super-admin-only
    // governance gate above: it bounds WHICH slug may be bound, not WHO may
    // bind it, so it must still fire for the one caller the gate now leaves —
    // a super admin writing a non-SYSTEM tenant's row.
    const row = await readRowVersion(request, superAdminToken, 'guardrail.validate', arcaaiTenantId);
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${arcaaiTenantId}`, {
      headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'not-a-platform-approved-slug' },
    });
    expect(resp.status()).toBe(403);
    expect(JSON.stringify(await resp.json())).toContain('platform-approved');
  });

  test('GOVERNANCE: a locked prefix stays global-only — nlp.ner PUT by a tenant admin → 403', async ({ request }) => {
    // nlp./harness./guardrail. are SUPER_ADMIN-ONLY; only text. is not. The 403
    // fires BEFORE the OCC compare, so any valid If-Match sees it.
    const row = await readRowVersion(request, tenantAdminToken, 'nlp.ner');
    const resp = await request.put(`${BASE}/row?taskKey=nlp.ner`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'medical-ner' },
    });
    expect(resp.status()).toBe(403);
    expect(JSON.stringify(await resp.json())).toContain('super administrators only');
  });

  test('Tenant admin CAN write an text.* key (text.finalize) for their OWN tenant → 200', async ({ request }) => {
    // `text.` is the one prefix outside SUPER_ADMIN_ONLY_TASK_PREFIXES, so the
    // text.* keys stay tenant-admin configurable. Unlike the guardrail/nlp
    // negative probes above, this write is accepted for the caller's own
    // CLS-pinned tenant. On a
    // fresh seed the tenant row is a version-0 placeholder, so this PUT travels
    // the `If-Match: "0"` create lane (the service CAS decides create-vs-412).
    const row = await readRowVersion(request, tenantAdminToken, 'text.finalize');
    const resp = await request.put(`${BASE}/row?taskKey=text.finalize`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'lms-gemma-4-e2b-it-qat' },
    });
    expect(resp.status()).toBe(200);
    const updated = (await resp.json()) as AiTaskDefaultRow;
    expect(updated.taskKey).toBe('text.finalize');
    expect(updated.modelSlug).toBe('lms-gemma-4-e2b-it-qat');
    // Written into the tenant admin's OWN tenant, not SYSTEM.
    expect(updated.tenantId).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  // First edit on a fresh seed: the ARCAAI tenant row is a version-0
  // placeholder, so this PUT travels the `If-Match: "0"` create lane
  // (accepted as a deliberate owner decision).
  test('super admin PUT with ?tenantId= succeeds cross-tenant (incl. guardrail.validate)', async ({ request }) => {
    const row = await readRowVersion(request, superAdminToken, 'guardrail.validate', arcaaiTenantId);
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${arcaaiTenantId}`, {
      headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    expect(resp.status()).toBe(200);
    const updated = (await resp.json()) as AiTaskDefaultRow;
    expect(updated.tenantId).toBe(arcaaiTenantId);
    expect(updated.modelSlug).toBe('granite-guardian-4.1-8b');
  });

  test('r2605 Finding A: super admin with an ELEVATED working tenant (x-tenant-id) targeting ?tenantId=SYSTEM — GET row + PUT both 200', async ({
    request,
  }) => {
    // The BFF proxy always sends the super admin's working tenant as
    // `x-tenant-id`, which the gateway elevates into CLS. Pre-fix, targeting
    // `?tenantId=SYSTEM` under that elevated context made the tenant-scope
    // extension inject the working tenant: reads silently missed, the CAS
    // update matched 0 rows (eternal 412 even with a correct If-Match) and the
    // create lane threw `TenantScope: tenantId mismatch` (500). The service's
    // cross-tenant base-client lane must make both the read and the write 200.
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const headers = { Authorization: `Bearer ${superAdminToken}`, 'x-tenant-id': arcaaiTenantId };

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
    // still lives — a super admin against the seeded SYSTEM row (version ≥ 1).
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${superAdminToken}`, 'If-Match': '"999"' },
      // A unique configJson stamp guarantees a real change regardless of
      // execution order against the sibling test above (same row, same
      // modelSlug) — without it the no-op guard can win the race and return
      // 400 before the OCC compare ever runs (fullyParallel has no serial
      // ordering across tests in this describe block).
      data: { modelSlug: 'granite-guardian-4.1-8b', configJson: { e2eStamp: `stale-if-match-${Date.now()}` } },
    });
    expect(resp.status()).toBe(412);
  });

  test('GET row stamps an ETag from the row version once a row exists', async ({ request }) => {
    // Tenant rows are version-0 placeholders on a fresh
    // seed (their creation is governance-blocked), so assert on the seeded SYSTEM row.
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const resp = await request.get(`${BASE}/row?taskKey=guardrail.validate&tenantId=${SYSTEM_TENANT_ID}`, {
      headers: { Authorization: `Bearer ${superAdminToken}` },
    });
    expect(resp.status()).toBe(200);
    const row = (await resp.json()) as AiTaskDefaultRow;
    expect(row.version).toBeGreaterThanOrEqual(1);
    expect(resp.headers()['etag']).toBe(`"${row.version}"`);
  });
});
