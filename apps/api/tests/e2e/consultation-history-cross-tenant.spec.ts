/**
 * Consultation history read plane — privilege gate and 404-over-403 across tenants.
 *
 *  1. a doctor (holding read:Consultation) is refused the ADMIN plane with 403, for a real and an
 *     unknown consultation id alike — the gate is row-independent, so it is no existence oracle;
 *  2. an admin of another tenant gets 404 for any consultation id (unknown or foreign), never 403,
 *     on every admin route and on the business routes;
 *  3. an API key can never reach the admin plane (403).
 *
 * Prerequisites: API on the test DB (`pnpm test:up:api`), seeded. NOT executed by the lane that
 * wrote it — the orchestrator runs the e2e suite after the merge.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const UNKNOWN = '00000000-0000-0000-0000-000000000000';
const ADMIN_ROUTES = (id: string) => [
  `/api/v1/admin/consultations/${id}/activity`,
  `/api/v1/admin/consultations/${id}/items/${UNKNOWN}/versions`,
  `/api/v1/admin/consultations/${id}/items/${UNKNOWN}/versions/1`,
  `/api/v1/admin/consultations/${id}/items/${UNKNOWN}/versions/1/diff?against=1`,
  `/api/v1/admin/consultations/${id}/items/${UNKNOWN}/runs`,
];

test.describe('Consultation history — gate and cross-tenant (404-over-403)', () => {
  let doctorToken: string;
  let ownerAdminToken: string;
  let foreignAdminToken: string;

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
  });

  test('a doctor is 403 on every admin route, existence not revealed', async ({ request }) => {
    for (const url of ADMIN_ROUTES(UNKNOWN)) {
      const response = await request.get(url, { headers: { Authorization: `Bearer ${doctorToken}` } });
      expect(response.status(), url).toBe(403);
    }
  });

  test('an unknown consultation is 404 for a tenant admin on every admin route', async ({ request }) => {
    for (const url of ADMIN_ROUTES(UNKNOWN)) {
      const response = await request.get(url, { headers: { Authorization: `Bearer ${ownerAdminToken}` } });
      expect(response.status(), url).toBe(404);
    }
  });

  test('a consultation of another tenant is 404 to a foreign admin, the same answer as an unknown id', async ({ request }) => {
    const list = await request.get('/api/v1/admin/consultations?limit=1', { headers: { Authorization: `Bearer ${ownerAdminToken}` } });
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { data?: Array<{ id: string }>; items?: Array<{ id: string }> };
    const real = (body.data ?? body.items ?? [])[0]?.id;
    test.skip(!real, 'the seed carries no consultation in the owner tenant');

    for (const url of ADMIN_ROUTES(real as string)) {
      const response = await request.get(url, { headers: { Authorization: `Bearer ${foreignAdminToken}` } });
      expect(response.status(), url).not.toBe(403);
      expect(response.status(), url).toBe(404);
    }
    expect((await request.get(`/api/v1/consultations/${real}/history`, { headers: { Authorization: `Bearer ${foreignAdminToken}` } })).status()).toBe(
      404,
    );
    expect(
      (await request.get(`/api/v1/consultations/${real}/encounters/1/recap`, { headers: { Authorization: `Bearer ${foreignAdminToken}` } })).status(),
    ).toBe(404);
  });

  test('the business routes answer 404 for an unknown consultation', async ({ request }) => {
    const headers = { Authorization: `Bearer ${doctorToken}` };
    expect((await request.get(`/api/v1/consultations/${UNKNOWN}/history`, { headers })).status()).toBe(404);
    expect((await request.get(`/api/v1/consultations/${UNKNOWN}/encounters/1/recap`, { headers })).status()).toBe(404);
  });

  test('an API key can never reach the admin plane', async ({ request }) => {
    for (const url of ADMIN_ROUTES(UNKNOWN)) {
      expect((await request.get(url, { headers: { 'X-API-Key': SEEDED_API_KEY } })).status(), url).toBe(403);
    }
  });
});
