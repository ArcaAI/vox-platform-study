/**
 * Cross-tenant probes against the attachment, feedback and feedback-rollup routes.
 *
 * Every consultation-scoped route resolves the consultation inside the caller's tenant, so a
 * seeded `__GLOBAL__` consultation probed from a token bound to tenant ARCAAI must answer 404
 * (never 403, never 200) and be indistinguishable from an unknown id. The owning doctor must
 * still reach the same consultation, which proves the 404 is the tenant boundary and not a
 * missing route.
 *
 * Authored for the post-merge e2e pass; the rollup read is admin-plane only (API keys 403).
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/** `SEED_CONSULTATION_IDS.GEN_COMPLETED`, owned by the `doctor` user in tenant `__GLOBAL__`. */
const GLOBAL_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';
const SYNTHETIC_ID = '018f0000-0000-7000-8000-000000000000';
const SHA256 = 'a'.repeat(64);

test.describe('consultation attachments + feedback — tenant ownership', () => {
  let doctorToken: string;
  let arcaaiToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doctor!.token;
    const arcaai = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaai, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiToken = arcaai!.token;
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  test('attachment intent from another tenant → 404, same as an unknown id', async ({ request }) => {
    const body = { kind: 'case_note', mime: 'text/plain', sizeBytes: 5, sha256: SHA256 };
    const foreign = await request.post(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/attachments`, { headers: auth(arcaaiToken), data: body });
    const unknown = await request.post(`/api/v1/consultations/${SYNTHETIC_ID}/attachments`, { headers: auth(arcaaiToken), data: body });
    expect(foreign.status()).toBe(404);
    expect(unknown.status()).toBe(404);
  });

  test('attachment list/get/complete from another tenant → 404', async ({ request }) => {
    const base = `/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/attachments`;
    expect((await request.get(base, { headers: auth(arcaaiToken) })).status()).toBe(404);
    expect((await request.get(`${base}/${SYNTHETIC_ID}`, { headers: auth(arcaaiToken) })).status()).toBe(404);
    expect((await request.post(`${base}/${SYNTHETIC_ID}/complete`, { headers: auth(arcaaiToken), data: {} })).status()).toBe(404);
  });

  test('the owning doctor reaches the attachment list (200), proving the 404 above is the tenant boundary', async ({ request }) => {
    const res = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/attachments`, { headers: auth(doctorToken) });
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('feedback create/list from another tenant → 404', async ({ request }) => {
    const create = await request.post(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/feedback`, {
      headers: auth(arcaaiToken),
      data: { comment: 'probe' },
    });
    const list = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/feedback`, { headers: auth(arcaaiToken) });
    expect(create.status()).toBe(404);
    expect(list.status()).toBe(404);
  });

  test('the owning doctor can list feedback and read the reason codes', async ({ request }) => {
    const list = await request.get(`/api/v1/consultations/${GLOBAL_CONSULTATION_ID}/feedback`, { headers: auth(doctorToken) });
    expect(list.status()).toBe(200);
    const reasons = await request.get('/api/v1/consultations/feedback/reason-codes', { headers: auth(doctorToken) });
    expect(reasons.status()).toBe(200);
    expect((await reasons.json()).items.length).toBeGreaterThan(0);
  });

  test('rollups are admin-plane: an API key is 403', async ({ request }) => {
    const res = await request.get('/api/v1/admin/feedback/rollups', { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(res.status()).toBe(403);
  });
});
