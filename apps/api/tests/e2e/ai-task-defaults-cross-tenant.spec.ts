/**
 * Cross-tenant + governance probes against AiTaskDefaultAdminController
 * (`/api/v1/admin/ai-task-defaults`), following the cross-tenant pattern.
 *
 * Governance contracts (`SUPER_ADMIN_ONLY_TASK_PREFIXES` in
 * `packages/applications/src/services/ai-task-default/constants.ts` covers
 * `nlp.` AND `harness.` only. REMOVED `smr.` (earlier) and `guardrail.`
 * (TASK-735 Phase 0, owner decision 2026-08-16, reversing the 2026-07-17
 * super-admin-only directive) — both are now TENANT-ADMIN configurable, so a
 * tenant admin may write them for their OWN tenant while `nlp.`/`harness.`
 * stay super-admin-only. `guardrail.*` carries an ADDITIONAL platform floor
 * on top (D2, tighten-only): a tenant write must name a `modelSlug` that
 * resolves to a SYSTEM-tenant `AiModel` row (the platform-approved list) —
 * also 403 otherwise. The seeded slug `granite-guardian-4.1-8b` used below is
 * a SYSTEM-catalog row, so it satisfies that floor):
 *  1. Tenant scoping — a tenant admin is pinned to their CLS tenant; an explicit
 *     foreign `?tenantId=` is REJECTED (403/404, 200 never; no foreign row
 *     content in the body).
 *  2. Task-key governance — writes to a SUPER_ADMIN-ONLY task key
 *     (nlp./harness.) are refused: a tenant admin PUT → 403 even for
 *     their OWN tenant (a privilege verdict, deliberately raised BEFORE the OCC
 *     compare — so a tenant admin sees 403, not 412, on any version). The
 *     un-locked `smr.*`/`guardrail.*` keys are the exception: a tenant admin
 *     PUT succeeds for their own tenant (guardrail.* subject to the
 *     platform-approved-list floor above).
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
    // guardrail.validate/safety/groundedness, nlp.ner/classification/diagnosis
    // + TASK-729's nlp.sentiment/toxicity, text.live/finalize + the
    // tenant-configurable smr.*.fallback keys + text.test, harness.judge, and
    // vlm.extract.
    expect(body.map((e) => e.taskKey)).toEqual([
      'guardrail.validate',
      'guardrail.safety',
      'guardrail.groundedness',
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

  test('TASK-735: tenant admin PUT on guardrail.validate for their OWN tenant → 200 (guardrail left the super-admin-only set)', async ({
    request,
  }) => {
    // Reverses the OLD "GOVERNANCE: tenant admin PUT on guardrail.validate …
    // → 403 (deliberate, not 404)" contract (owner directive 2026-07-17).
    // TASK-735 Phase 0 (owner decision 2026-08-16) makes guardrail.*
    // tenant-admin configurable, same cascade as smr.*. The seeded slug is a
    // SYSTEM-catalog row, so it also satisfies the D2 platform-approved-list
    // floor (see the negative probe below for the floor itself).
    const row = await readRowVersion(request, tenantAdminToken, 'guardrail.validate');
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'granite-guardian-4.1-8b' },
    });
    expect(resp.status()).toBe(200);
    const updated = (await resp.json()) as AiTaskDefaultRow;
    expect(updated.modelSlug).toBe('granite-guardian-4.1-8b');
    // Written into the tenant admin's OWN tenant, not SYSTEM.
    expect(updated.tenantId).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  test('TASK-735 D2: tenant admin PUT on guardrail.validate with a slug OUTSIDE the platform-approved (SYSTEM) list → 403', async ({ request }) => {
    // The platform-approved-list floor is independent of the blanket
    // super-admin-only governance check above (which no longer fires for
    // guardrail.* at all) — it rejects an unvetted slug even for the
    // caller's OWN tenant.
    const row = await readRowVersion(request, tenantAdminToken, 'guardrail.validate');
    const resp = await request.put(`${BASE}/row?taskKey=guardrail.validate`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'not-a-platform-approved-slug' },
    });
    expect(resp.status()).toBe(403);
  });

  test('GOVERNANCE: a still-locked prefix stays global-only — nlp.ner PUT by a tenant admin → 403', async ({ request }) => {
    // nlp./harness. remain SUPER_ADMIN-ONLY (smr. and, since TASK-735,
    // guardrail. were un-locked). The 403 fires BEFORE the OCC compare, so
    // any valid If-Match sees it.
    const row = await readRowVersion(request, tenantAdminToken, 'nlp.ner');
    const resp = await request.put(`${BASE}/row?taskKey=nlp.ner`, {
      headers: { Authorization: `Bearer ${tenantAdminToken}`, 'If-Match': `"${row.version}"` },
      data: { modelSlug: 'medical-ner' },
    });
    expect(resp.status()).toBe(403);
    expect(JSON.stringify(await resp.json())).toContain('super administrators only');
  });

  test('Tenant admin CAN write an smr.* key (text.finalize) for their OWN tenant → 200', async ({ request }) => {
    // `smr.` left SUPER_ADMIN_ONLY_TASK_PREFIXES: the smr.* keys are
    // now tenant-admin configurable. Unlike the guardrail/nlp negative probes
    // above, this write is accepted for the caller's own CLS-pinned tenant. On a
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
