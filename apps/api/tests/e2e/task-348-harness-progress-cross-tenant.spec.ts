/**
 * Cross-tenant probes against the harness-progress SSE stream (TASK-348 / TG-4).
 *
 * TASK-345 added `GET /consultations/:id/harness-progress/stream`, guarded the
 * same way as the live-summary stream:
 *
 *   - `@TenantOwnedResource('Consultation', 'id')` → the global
 *     `TenantOwnedResourceSseGuard` resolves ownership BEFORE the stream opens
 *     and 404s a cross-tenant probe (DEF-C3 no-existence-leak posture).
 *   - `@StreamScope({ namespace: 'consultation_harness_progress', param: 'id' })`
 *     → a single-use ticket may stand in for the JWT.
 *
 * The unit suite asserts that authz only via decorator METADATA; this spec is
 * the genuine wire probe, mirroring
 * `task-307-consultation-job-cross-tenant.spec.ts`:
 *
 *   1. Sanity: the doctor who owns the seeded consultation (tenant
 *      `__GLOBAL__`) can resolve it — so the cross-tenant 404 below is a
 *      tenant mismatch, not a missing row.
 *   2. A super_admin re-logged into tenant ARCAAI probes the stream → 404
 *      with no tenant wording in the body (no SSE channel leak).
 *   3. TASK-348 / MIN-1: the same cross-tenant caller cannot MINT a
 *      `consultation_harness_progress:<id>` stream ticket either → 404
 *      (mint-time ownership, defense-in-depth ahead of the SSE guard).
 *   4. A synthetic uuidv7 consultation id 404s with the same shape, so an
 *      unknown id and a cross-tenant id are indistinguishable on the wire.
 *   5. The originating doctor still sees the consultation afterwards (the
 *      probes neither leaked nor mutated anything).
 *
 * The same-tenant stream itself is NOT probed here: a 200 SSE response stays
 * open (15s heartbeats) and would hang a plain request-context GET. Stream
 * delivery is covered by the HarnessProgressService unit suite.
 *
 * Live-stack requirement: dev stack (postgres + redis) + seed
 * `09-consultation.ts` (GEN_COMPLETED consultation owned by the `doctor`
 * user). The harness worker does NOT need to be running — the guard rejects
 * before any progress data is consulted.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded `GEN_COMPLETED` consultation id from
 * `packages/database/src/prisma/db_main/seed/00-constants.ts`
 * (`SEED_CONSULTATION_IDS.GEN_COMPLETED`). Owned by the `doctor` user in
 * tenant `__GLOBAL__`.
 */
const GEN_COMPLETED_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';

/**
 * uuidv7-shaped id no tenant has ever seen — its 404 must match the genuine
 * cross-tenant 404 (DEF-C3 "no existence leak").
 */
const SYNTHETIC_CONSULTATION_ID = '018f0000-0000-7000-8000-000000000001';

test.describe('TASK-348 TG-4 — harness-progress stream cross-tenant probes', () => {
  let doctorToken: string;
  let arcaaiSuperAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doctorLogin!.token;

    // super_admin re-logged with tenantKey=ARCAAI binds the JWT to tenant
    // ARCAAI — every guard read of `cls.get('tenantId')` sees the ARCAAI
    // id, so probing a __GLOBAL__-owned consultation must 404.
    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiLogin!.token;
  });

  test('creator (doctor in __GLOBAL__) can resolve the consultation — sanity for the cross-tenant assertion', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(200);
  });

  test('GET /consultations/:id/harness-progress/stream from tenant ARCAAI → not 200 (no SSE channel leak)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/harness-progress/stream`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    // The SSE handler must reject before opening the stream. We accept
    // 401 (stream-ticket path rejecting) or 404 (pre-stream guard) —
    // either is the no-leak contract (mirrors the consultation-job spec).
    expect([401, 404]).toContain(response.status());
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('POST /auth/stream-ticket for consultation_harness_progress:<id> from tenant ARCAAI → 404 (TASK-348 MIN-1 mint-time ownership)', async ({
    request,
  }) => {
    const response = await request.post('/api/v1/auth/stream-ticket', {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
      data: { scope: `consultation_harness_progress:${GEN_COMPLETED_CONSULTATION_ID}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('synthetic uuidv7 consultation id → 404 (DEF-C3: same shape as cross-tenant 404)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${SYNTHETIC_CONSULTATION_ID}/harness-progress/stream`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('after cross-tenant probes, the doctor in __GLOBAL__ still sees the consultation (no collateral damage)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(200);
  });
});
