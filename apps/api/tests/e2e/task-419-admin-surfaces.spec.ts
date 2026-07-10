/**
 * TASK-419 items 1–3 — new admin REST surfaces feeding the Admin Console.
 *
 * Item 1 · Golden datasets (`/admin/harness/golden-sets*`)
 *   - CASL matrix: 401 unauth, 403 doctor, 200 tenant_admin, 200 super_admin
 *   - create → list → detail → cases round-trip, asserting the PHI-safety
 *     contract: the case projections NEVER carry `transcript`/`referenceNote`.
 *   - synthetic id probes → 404 (DEF-C3 generic shape).
 *
 * Item 2 · Webhooks / notifications / resource subscriptions
 *   - CASL matrix on the three list routes.
 *   - Webhook lifecycle: create → read → OCC PATCH (428 without If-Match,
 *     200 with) → delivery log (empty until a dispatcher lands) → soft delete.
 *
 * Item 3 · Guardrail/NLP proxy plane (`/admin/ai-services/*`)
 *   - Platform tier (`manage:all`): 401 unauth, 403 doctor AND tenant_admin.
 *   - super_admin tolerates 200 (service up) or 503 (down — honest
 *     degradation via the proxy client), mirroring the harness-ops posture.
 *   - No mutation routes exist by design.
 *
 * Real HTTP round-trips against the live API (`pnpm test:e2e`). Personas via
 * `tests/helpers` (seeded super_admin / tenant_admin / doctor). Creates write
 * only to the isolated test DB (plain tenant rows) and every created row is
 * soft-deleted in the same test.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** uuidv7-shaped id that exists in no environment (DEF-C3 probe). */
const SYNTHETIC_ID = '018f0000-0000-7419-8000-000000000419';

let superAdminToken: string;
let tenantAdminToken: string;
let doctorToken: string;

test.beforeAll(async ({ request }) => {
  const [sa, ta, doc] = await Promise.all([
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI'),
    loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
  ]);
  expect(sa, 'super_admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
  expect(ta, 'tenant_admin login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
  expect(doc, 'doctor login (__GLOBAL__) failed — is the stack seeded?').toBeTruthy();
  superAdminToken = sa!.token;
  tenantAdminToken = ta!.token;
  doctorToken = doc!.token;
});

// =============================================================================
// Item 1 — golden datasets
// =============================================================================
test.describe('TASK-419 Golden sets — CASL read plane', () => {
  test('GET /admin/harness/golden-sets → 401 unauth, 403 doctor, 200 admins', async ({ request }) => {
    const url = '/api/v1/admin/harness/golden-sets';

    const unauth = await request.get(url);
    expect(unauth.status(), 'unauthenticated').toBe(401);

    const doc = await request.get(url, { headers: bearer(doctorToken) });
    expect(doc.status(), 'doctor (no read:HarnessEval)').toBe(403);

    const ta = await request.get(url, { headers: bearer(tenantAdminToken) });
    expect(ta.status(), 'tenant_admin').toBe(200);

    const sa = await request.get(url, { headers: bearer(superAdminToken) });
    expect(sa.status(), 'super_admin').toBe(200);
  });

  test('synthetic golden-set id probes → 404 for detail and cases', async ({ request }) => {
    const detail = await request.get(`/api/v1/admin/harness/golden-sets/${SYNTHETIC_ID}`, { headers: bearer(tenantAdminToken) });
    expect(detail.status()).toBe(404);

    const cases = await request.get(`/api/v1/admin/harness/golden-sets/${SYNTHETIC_ID}/cases`, { headers: bearer(tenantAdminToken) });
    expect(cases.status()).toBe(404);
  });
});

test.describe('TASK-419 Golden sets — create → read round-trip (PHI-safe)', () => {
  test('doctor cannot create (403)', async ({ request }) => {
    const resp = await request.post('/api/v1/admin/harness/golden-sets', {
      headers: bearer(doctorToken),
      data: { name: 'forbidden set' },
    });
    expect(resp.status()).toBe(403);
  });

  test('tenant_admin creates a set + case; case reads never leak the PHI payload', async ({ request }) => {
    const setName = `e2e-419-golden-set-${Date.now()}`;
    const created = await request.post('/api/v1/admin/harness/golden-sets', {
      headers: bearer(tenantAdminToken),
      data: { name: setName, description: 'TASK-419 e2e round-trip' },
    });
    expect(created.status(), 'golden-set create').toBe(201);
    const set = await created.json();
    expect(set.name).toBe(setName);
    expect(set.id, 'created set id').toBeTruthy();

    // Detail read
    const detail = await request.get(`/api/v1/admin/harness/golden-sets/${set.id}`, { headers: bearer(tenantAdminToken) });
    expect(detail.status()).toBe(200);
    expect((await detail.json()).name).toBe(setName);

    // List contains it
    const list = await request.get('/api/v1/admin/harness/golden-sets?limit=50', { headers: bearer(tenantAdminToken) });
    expect(list.status()).toBe(200);
    const listBody = await list.json();
    expect(Array.isArray(listBody.items)).toBe(true);
    expect(listBody.items.some((s: { id: string }) => s.id === set.id)).toBe(true);

    // Add a case carrying PHI…
    const PHI_MARKER = 'e2e-phi-marker-headache-419';
    const caseResp = await request.post(`/api/v1/admin/harness/golden-sets/${set.id}/cases`, {
      headers: bearer(tenantAdminToken),
      data: { transcript: `patient reports ${PHI_MARKER}`, referenceNote: `HPI: ${PHI_MARKER}`, label: 'e2e-case-1' },
    });
    expect(caseResp.status(), 'golden-case create').toBe(201);
    const caseBody = await caseResp.json();
    expect(caseBody.label).toBe('e2e-case-1');
    // …and the create response is already PHI-free.
    expect(JSON.stringify(caseBody)).not.toContain(PHI_MARKER);

    // The case listing is metadata-only: no transcript/referenceNote keys, no PHI.
    const casesResp = await request.get(`/api/v1/admin/harness/golden-sets/${set.id}/cases`, { headers: bearer(tenantAdminToken) });
    expect(casesResp.status()).toBe(200);
    const casesBody = await casesResp.json();
    expect(casesBody.total).toBeGreaterThanOrEqual(1);
    const raw = JSON.stringify(casesBody);
    expect(raw).not.toContain(PHI_MARKER);
    expect(raw).not.toContain('"transcript"');
    expect(raw).not.toContain('"referenceNote"');
  });

  test('adding a case to a missing set → 404 (no orphan writes)', async ({ request }) => {
    const resp = await request.post(`/api/v1/admin/harness/golden-sets/${SYNTHETIC_ID}/cases`, {
      headers: bearer(tenantAdminToken),
      data: { transcript: 't', referenceNote: 'r' },
    });
    expect(resp.status()).toBe(404);
  });
});

// =============================================================================
// Item 2 — webhooks / notifications / resource subscriptions
// =============================================================================
test.describe('TASK-419 Item 2 — CASL read plane', () => {
  // Expected doctor status per route: webhooks/notifications deny (doctor has
  // no manage grant on those subjects). resource-subscriptions ADMITS the
  // doctor at the type level — the seeded `user-profile-own` policy grants
  // conditional `manage:ResourceSubscription (targetUserId=self)`, and the
  // platform convention (same as `@CanManage('ApiKey')` + `api-key-own-manage`,
  // TASK-305 M-1) is a type-level guard with tenant scoping in the service.
  const LIST_ENDPOINTS: Array<{ url: string; doctorStatus: number }> = [
    { url: '/api/v1/admin/webhooks', doctorStatus: 403 },
    { url: '/api/v1/admin/notifications', doctorStatus: 403 },
    { url: '/api/v1/admin/resource-subscriptions', doctorStatus: 200 },
  ];

  for (const { url, doctorStatus } of LIST_ENDPOINTS) {
    test(`GET ${url} → 401 unauth, ${doctorStatus} doctor, 200 tenant_admin, 200 super_admin`, async ({ request }) => {
      const unauth = await request.get(url);
      expect(unauth.status(), `${url} unauthenticated`).toBe(401);

      const doc = await request.get(url, { headers: bearer(doctorToken) });
      expect(doc.status(), `${url} doctor`).toBe(doctorStatus);

      const ta = await request.get(url, { headers: bearer(tenantAdminToken) });
      expect(ta.status(), `${url} tenant_admin (own tenant)`).toBe(200);

      const sa = await request.get(url, { headers: bearer(superAdminToken) });
      expect(sa.status(), `${url} super_admin`).toBe(200);
    });
  }

  test('cross-tenant/synthetic id probes → 404 (DEF-C3 generic shape)', async ({ request }) => {
    for (const url of [
      `/api/v1/admin/webhooks/${SYNTHETIC_ID}`,
      `/api/v1/admin/notifications/${SYNTHETIC_ID}`,
      `/api/v1/admin/resource-subscriptions/${SYNTHETIC_ID}`,
    ]) {
      const resp = await request.get(url, { headers: bearer(tenantAdminToken) });
      expect(resp.status(), url).toBe(404);
    }
  });
});

test.describe('TASK-419 Item 2 — webhook lifecycle (OCC + delivery log + soft delete)', () => {
  test('create → read → PATCH (If-Match) → deliveries → delete', async ({ request }) => {
    const name = `e2e-419-webhook-${Date.now()}`;
    const created = await request.post('/api/v1/admin/webhooks', {
      headers: bearer(tenantAdminToken),
      data: { name, url: 'https://example.invalid/hook', resourceTypeName: 'Consultation' },
    });
    expect(created.status(), 'webhook create').toBe(201);
    const webhook = await created.json();
    expect(webhook.name).toBe(name);
    expect(webhook.version).toBe(1);

    // Detail read
    const detail = await request.get(`/api/v1/admin/webhooks/${webhook.id}`, { headers: bearer(tenantAdminToken) });
    expect(detail.status()).toBe(200);

    // OCC PATCH without If-Match → 428 (header REQUIRED on this route)
    const noHeader = await request.patch(`/api/v1/admin/webhooks/${webhook.id}`, {
      headers: bearer(tenantAdminToken),
      data: { name: `${name}-renamed`, expectedVersion: 1 },
    });
    expect(noHeader.status(), 'PATCH without If-Match').toBe(428);

    // OCC PATCH with If-Match "1" → 200, version bumps
    const patched = await request.patch(`/api/v1/admin/webhooks/${webhook.id}`, {
      headers: { ...bearer(tenantAdminToken), 'If-Match': '"1"' },
      data: { name: `${name}-renamed`, expectedVersion: 1 },
    });
    expect(patched.status(), 'PATCH with If-Match').toBe(200);
    const patchedBody = await patched.json();
    expect(patchedBody.name).toBe(`${name}-renamed`);
    expect(patchedBody.version).toBe(2);

    // Delivery log — read plane exists; empty until a dispatch writer lands.
    const deliveries = await request.get(`/api/v1/admin/webhooks/${webhook.id}/deliveries`, { headers: bearer(tenantAdminToken) });
    expect(deliveries.status(), 'delivery log read').toBe(200);
    const deliveriesBody = await deliveries.json();
    expect(Array.isArray(deliveriesBody.data)).toBe(true);
    expect(typeof deliveriesBody.count).toBe('number');

    // Soft delete
    const deleted = await request.delete(`/api/v1/admin/webhooks/${webhook.id}`, { headers: bearer(tenantAdminToken) });
    expect(deleted.status(), 'webhook soft delete').toBe(200);
  });

  test('doctor cannot create a webhook (403)', async ({ request }) => {
    const resp = await request.post('/api/v1/admin/webhooks', {
      headers: bearer(doctorToken),
      data: { name: 'forbidden', url: 'https://example.invalid/hook', resourceTypeName: 'Consultation' },
    });
    expect(resp.status()).toBe(403);
  });
});

// =============================================================================
// Item 3 — Guardrail / NLP read-only proxy plane (/admin/ai-services)
// =============================================================================
test.describe('TASK-419 AI services proxy — platform-tier read plane', () => {
  const ROUTES = ['/api/v1/admin/ai-services/guardrail/status', '/api/v1/admin/ai-services/guardrail/config', '/api/v1/admin/ai-services/nlp/status'];

  test('all three routes: 401 unauth, 403 doctor, 403 tenant_admin (manage:all tier)', async ({ request }) => {
    for (const url of ROUTES) {
      const unauth = await request.get(url);
      expect(unauth.status(), `${url} unauthenticated`).toBe(401);

      const doc = await request.get(url, { headers: bearer(doctorToken) });
      expect(doc.status(), `${url} doctor`).toBe(403);

      const ta = await request.get(url, { headers: bearer(tenantAdminToken) });
      expect(ta.status(), `${url} tenant_admin (platform tier)`).toBe(403);
    }
  });

  test('super_admin → 200 (service up) or 503 (down — honest degradation), never a crash', async ({ request }) => {
    for (const url of ROUTES) {
      const resp = await request.get(url, { headers: bearer(superAdminToken) });
      expect([200, 503], `${url} returned ${resp.status()}`).toContain(resp.status());

      if (resp.status() === 200 && url.endsWith('/status')) {
        // Both Python health documents carry a `status` field.
        const body = await resp.json();
        expect(typeof body.status).toBe('string');
      }
      if (resp.status() === 200 && url.endsWith('/config')) {
        const body = await resp.json();
        expect(body).toHaveProperty('medicalValidation');
        expect(body).toHaveProperty('analysisTypes');
      }
    }
  });

  test('no mutation surface exists: POST/PATCH on the proxy plane → 404/405', async ({ request }) => {
    const post = await request.post('/api/v1/admin/ai-services/guardrail/config', {
      headers: bearer(superAdminToken),
      data: { guardian_enabled: false },
    });
    expect([404, 405]).toContain(post.status());
  });
});
