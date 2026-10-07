/**
 * TASK-1050 W2e — guardrail notice / hold / evaluation routes: privilege gates, If-Match and
 * 404-over-403 across tenants.
 *
 *  1. the withheld review route is 403 for a doctor (row-independent, so for a real and an unknown
 *     id alike), and an API key never reaches the admin plane;
 *  2. an admin of another tenant gets 404 for a consultation it does not own on every guardrail
 *     route — business and admin — never 403;
 *  3. the ack / resume commands require If-Match (428) before anything else is decided;
 *  4. the internal ingest refuses an unauthenticated caller (401) and a missing X-Tenant-Id (400);
 *     a body whose records belong to another tenant than X-Tenant-Id is 400.
 *
 * Prerequisites: API on the test DB (`pnpm test:up:api`), seeded, `INTERNAL_ACCESS_TOKEN` in the
 * test env. NOT executed by the lane that wrote it — the orchestrator runs the e2e suite after the merge.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const UNKNOWN = '00000000-0000-0000-0000-000000000000';
const UNKNOWN_NOTICE = '01927f6e-9999-7000-8000-000000000000';

const ADMIN_LIST = (id: string) => `/api/v1/admin/consultations/${id}/guardrail-evaluations`;
const ADMIN_WITHHELD = (id: string) => `/api/v1/admin/consultations/${id}/guardrail-evaluations/${UNKNOWN}/withheld`;
const NOTICES = (id: string) => `/api/v1/consultations/${id}/guardrail-notices`;
const ACK = (id: string) => `/api/v1/consultations/${id}/guardrail-notices/${UNKNOWN_NOTICE}/ack`;
const RESUME = (id: string) => `/api/v1/consultations/${id}/guardrail-hold/resume`;

test.describe('TASK-1050 — guardrail notices, hold and evaluations: gates and cross-tenant (404-over-403)', () => {
  let doctorToken: string;
  let ownerAdminToken: string;
  let foreignAdminToken: string;
  let realConsultationId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor?.token, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token as string;
    const owner = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(owner?.token, 'owner-tenant admin login failed').toBeTruthy();
    ownerAdminToken = owner!.token as string;
    const foreign = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(foreign?.token, 'foreign-tenant login failed').toBeTruthy();
    foreignAdminToken = foreign!.token as string;

    const list = await request.get('/api/v1/admin/consultations?limit=1', { headers: { Authorization: `Bearer ${ownerAdminToken}` } });
    if (list.status() === 200) {
      const body = (await list.json()) as { data?: Array<{ id: string }>; items?: Array<{ id: string }> };
      realConsultationId = (body.data ?? body.items ?? [])[0]?.id;
    }
  });

  test('the withheld review is 403 for a doctor, whatever the id', async ({ request }) => {
    const headers = { Authorization: `Bearer ${doctorToken}` };
    expect((await request.get(ADMIN_WITHHELD(UNKNOWN), { headers })).status()).toBe(403);
    if (realConsultationId) expect((await request.get(ADMIN_WITHHELD(realConsultationId), { headers })).status()).toBe(403);
  });

  test('an unknown consultation is 404 to its tenant admin on the admin routes and the notice list', async ({ request }) => {
    const headers = { Authorization: `Bearer ${ownerAdminToken}` };
    expect((await request.get(ADMIN_LIST(UNKNOWN), { headers })).status()).toBe(404);
    expect((await request.get(ADMIN_WITHHELD(UNKNOWN), { headers })).status()).toBe(404);
    expect((await request.get(NOTICES(UNKNOWN), { headers })).status()).toBe(404);
  });

  test('another tenant`s consultation is 404 — never 403 — on every guardrail route', async ({ request }) => {
    test.skip(!realConsultationId, 'the seed carries no consultation in the owner tenant');
    const id = realConsultationId as string;
    const headers = { Authorization: `Bearer ${foreignAdminToken}` };
    for (const url of [ADMIN_LIST(id), ADMIN_WITHHELD(id), NOTICES(id)]) {
      const response = await request.get(url, { headers });
      expect(response.status(), url).not.toBe(403);
      expect(response.status(), url).toBe(404);
    }
    const ack = await request.post(ACK(id), { headers: { ...headers, 'If-Match': '"1"' }, data: {} });
    expect(ack.status(), 'ack').toBe(404);
    const resume = await request.post(RESUME(id), {
      headers: { ...headers, 'If-Match': '"1"' },
      data: { noticeId: UNKNOWN_NOTICE, resolution: 'item_excluded' },
    });
    expect(resume.status(), 'resume').toBe(404);
  });

  test('ack and resume require If-Match (428)', async ({ request }) => {
    const headers = { Authorization: `Bearer ${doctorToken}` };
    expect((await request.post(ACK(UNKNOWN), { headers, data: {} })).status()).toBe(428);
    expect((await request.post(RESUME(UNKNOWN), { headers, data: { noticeId: UNKNOWN_NOTICE, resolution: 'item_excluded' } })).status()).toBe(428);
  });

  test('resume refuses an unknown resolution (400)', async ({ request }) => {
    const headers = { Authorization: `Bearer ${doctorToken}`, 'If-Match': '"1"' };
    expect((await request.post(RESUME(UNKNOWN), { headers, data: { noticeId: UNKNOWN_NOTICE, resolution: 'ignore' } })).status()).toBe(400);
  });

  test('an API key never reaches the admin guardrail plane', async ({ request }) => {
    for (const url of [ADMIN_LIST(UNKNOWN), ADMIN_WITHHELD(UNKNOWN)]) {
      expect((await request.get(url, { headers: { 'X-API-Key': SEEDED_API_KEY } })).status(), url).toBe(403);
    }
  });

  test('the internal ingest: 401 without a service token, 400 without X-Tenant-Id, 400 on a tenant mismatch', async ({ request }) => {
    const url = '/api/v1/internal/guardrail/evaluations?service=guardrail';
    const record = {
      evaluationId: '01927f6e-8b1a-7c3e-9d2f-000000001050',
      tenantId: UNKNOWN,
      requestId: 'req-e2e-1050',
      caller: 'text.generate',
      direction: 'inbound',
      decision: 'allow',
      checks: [],
      policyVersion: 'pv-e2e',
      noticeIds: [],
      occurredAt: new Date().toISOString(),
    };
    expect((await request.post(url, { data: { evaluations: [record] } })).status()).toBe(401);

    const token = process.env.INTERNAL_ACCESS_TOKEN;
    test.skip(!token, 'INTERNAL_ACCESS_TOKEN is not set in the test env');
    const headers = { 'X-Service-Token': token as string };
    expect((await request.post(url, { headers, data: { evaluations: [record] } })).status()).toBe(400);
    expect(
      (
        await request.post(url, { headers: { ...headers, 'X-Tenant-Id': '50000000-0000-0000-0000-000000000000' }, data: { evaluations: [record] } })
      ).status(),
    ).toBe(400);
  });
});
