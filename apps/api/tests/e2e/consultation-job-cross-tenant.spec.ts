/**
 * Cross-tenant probes against ConsultationJobController.
 *
 * Without this guard, `GET /consultations/jobs/:jobId` would return 200
 * with the status of jobs owned by ANY tenant
 * (`docs/multi-tenancy-audit/04-api-design-review.md`).
 * `TenantOwnedResourceInterceptor` reads
 * `@TenantOwnedResource('ConsultationJob', 'jobId')` and
 * asserts `status.tenantId === cls.tenantId`, throwing 404
 * ("Resource not found") on mismatch — the DEF-C3 no-existence-leak
 * posture.
 *
 * Genuine probe: a synthetic uuidv7 probe would assert only that the 404
 * SHAPE was correct (since Redis has no matching job, the
 * resource-not-found branch fires regardless of the cross-tenant logic).
 * This spec instead:
 *
 *   1. Bootstraps a real summarisation job in tenant `__GLOBAL__` via
 *      `POST /consultations/:id/summary/pre-summary/async`, which
 *      persists `tenantId` + `userId` on the Redis status payload
 *      before `BullModule` enqueues the work to the TEXT worker.
 *   2. Confirms the originating doctor can resolve the job (200), so
 *      the 404 from the cross-tenant probe must be tenant-mismatch
 *      and not "Redis lost the job".
 *   3. Probes the same `jobId` from a token scoped to tenant ARCAAI
 *      (via `super_admin` re-logged with `tenantKey: 'ARCAAI'`) and
 *      asserts every endpoint (get, cancel, stream) responds 404.
 *   4. Re-checks the originating doctor can STILL see the job after
 *      the cross-tenant probes — proving the probes neither leaked
 *      nor mutated the resource.
 *
 * The synthetic-id probe is retained as a baseline shape assertion so
 * an unknown id and a cross-tenant id are indistinguishable on the
 * wire (DEF-C3).
 *
 * Live-stack requirement: this spec depends on the dev stack
 * (`docker compose up postgres redis`) plus the seed in
 * `09-consultation.ts` (`GEN_COMPLETED` consultation owned by the
 * `doctor` user). The TEXT worker does NOT need to be running — the
 * status payload is persisted synchronously to Redis by
 * `ConsultationJobService.createPreSummaryJob` BEFORE the BullMQ job
 * is enqueued, so the probe sees a "pending" job that exists.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded `GEN_COMPLETED` consultation id from
 * `packages/database/src/prisma/db_main/seed/00-constants.ts`
 * (`SEED_CONSULTATION_IDS.GEN_COMPLETED`). Owned by the `doctor` user
 * in tenant `__GLOBAL__`.
 */
const GEN_COMPLETED_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';

/**
 * uuidv7-shaped id that no tenant has ever seen. The interceptor's
 * 404 for this id must match the 404 shape from the genuine cross-
 * tenant probe — DEF-C3 "no existence leak".
 */
const SYNTHETIC_JOB_ID = '018f0000-0000-7000-8000-000000000000';

test.describe('AC-2/AC-3 — ConsultationJob ownership genuine probe (AC-10)', () => {
  let doctorToken: string;
  let arcaaiSuperAdminToken: string;
  let jobId: string;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doctorLogin!.token;

    // super_admin re-logged with tenantKey=ARCAAI binds the JWT to
    // tenant ARCAAI — every interceptor read of `cls.get('tenantId')`
    // sees the ARCAAI id, so probing a __GLOBAL__-owned job must 404.
    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiLogin!.token;

    // Bootstrap a REAL job in tenant __GLOBAL__. The async pre-summary
    // endpoint is the cheapest path to a persisted ConsultationJob
    // status — only the metadata round-trip is mandatory; the TEXT
    // worker may or may not pick up the BullMQ job, which doesn't
    // matter for the cross-tenant probe (the status row is written
    // BEFORE enqueue per `consultation-job.service.ts`).
    const createResp = await request.post(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary/pre-summary/async`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
      data: {},
    });
    expect(createResp.status(), `create async pre-summary job for GEN_COMPLETED — body: ${await createResp.text()}`).toBeGreaterThanOrEqual(200);
    expect(createResp.status()).toBeLessThan(300);

    const created = (await createResp.json()) as { jobId: string };
    expect(created.jobId, 'create async pre-summary returned jobId').toBeTruthy();
    jobId = created.jobId;
  });

  test('creator (doctor in __GLOBAL__) can resolve the job — sanity for the cross-tenant assertion', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    // 200 is the happy path. We tolerate 404 only if the job has
    // already aged out of Redis (JOB_TTL) — but inside a single
    // `beforeAll`-bootstrapped describe this should not happen.
    // Forbid 401 (auth bypass) and 403 (the W3 fix is supposed to
    // normalise to 404, not 403).
    expect([200, 202]).toContain(response.status());
  });

  test('GET /consultations/jobs/:jobId from tenant ARCAAI → 404 (no controller body leak)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` } });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('PATCH /consultations/jobs/:jobId/cancel from tenant ARCAAI → 404 (no cancel-by-id-leak)', async ({ request }) => {
    const response = await request.patch(`/api/v1/consultations/jobs/${jobId}/cancel`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });

  test('GET /consultations/jobs/:jobId/stream from tenant ARCAAI → not 200 (no SSE channel leak)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${jobId}/stream`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    // The SSE handler must reject before opening the stream. We
    // accept 401 (stream-ticket path rejecting) or 404 (interceptor
    // rejecting before SSE) — either is the no-leak contract.
    expect([401, 404]).toContain(response.status());
  });

  test('after cross-tenant probes, the doctor in __GLOBAL__ still sees the job (no collateral damage)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    // The cross-tenant probes must NOT have deleted the row.
    expect(response.status()).not.toBe(401);
    expect([200, 202]).toContain(response.status());
  });

  test('synthetic uuidv7 jobId → 404 (DEF-C3: same shape as cross-tenant 404)', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${SYNTHETIC_JOB_ID}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });
});
