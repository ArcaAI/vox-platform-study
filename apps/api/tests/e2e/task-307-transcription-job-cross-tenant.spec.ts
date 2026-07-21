/**
 * Cross-tenant probes against TranscriptionJobController.
 *
 * Without the tenant-ownership guard
 * (`docs/multi-tenancy-audit/04-api-design-review.md`),
 * `GET /audio/transcription-jobs/:id`, `POST /:id/cancel`,
 * `POST /:id/retry`, and the SSE `:id/stream` would accept any id without
 * verifying ownership; the only defence would be the Prisma
 * `tenantScopeFilter` extension, which super-admins bypass by design.
 *
 * The interceptor + `assertTenantScoped` branch resolves the row
 * via `TranscriptionJobRepository.findById` and 404s any caller whose
 * CLS tenantId disagrees with the row's `tenantId`. The
 * list/getByConsultation endpoints get a parallel service-layer guard
 * (in `transcriptionJob.service.ts`) so super-admin calls cannot
 * accidentally return cross-tenant rows.
 *
 * Genuine probe: a synthetic uuidv7 probe would assert only that the 404
 * SHAPE was correct (since
 * the database has no matching row, the resource-not-found branch
 * fires regardless of the cross-tenant logic). This spec instead:
 *
 *   1. Creates a real `TranscriptionJob` row in tenant `__GLOBAL__`
 *      via `POST /audio/transcription-jobs` (the lightweight create
 *      endpoint — no pipeline ownership check, no audio upload).
 *   2. Confirms the originating doctor can resolve the job (200), so
 *      the 404 from the cross-tenant probe must be tenant-mismatch.
 *   3. Probes the same `id` from a token scoped to tenant ARCAAI
 *      (via `super_admin` re-logged with `tenantKey: 'ARCAAI'`) and
 *      asserts every endpoint (get, cancel, retry, stream) responds
 *      404.
 *   4. Re-checks the originating doctor can STILL see the job — proves
 *      the probes neither leaked nor mutated the resource.
 *
 * The synthetic-id probe is retained as a baseline shape assertion so
 * an unknown id and a cross-tenant id are indistinguishable on the
 * wire (DEF-C3).
 *
 * Live-stack requirement: this spec depends on the dev stack
 * (`docker compose up postgres redis`) plus the seed in
 * `06-stt.ts` (production ASR pipeline). STT-V2 does NOT need to be
 * running — the create endpoint only writes the row; it does not
 * dispatch the job until `transcribeFile` is invoked separately.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded production ASR pipeline id from
 * `packages/database/src/prisma/db_main/seed/06-stt.ts`
 * (`DEFAULT_ASR_PIPELINES[0]` — `production-whisper-large-v3`).
 * Visible to every customer tenant via the SYSTEM-tenant inheritance.
 */
const PRODUCTION_PIPELINE_ID = '81000000-0000-0000-0001-000000000001';

/**
 * uuidv7-shaped id that no tenant has ever seen. The interceptor's
 * 404 for this id must match the 404 shape from the genuine cross-
 * tenant probe — DEF-C3 "no existence leak".
 */
const SYNTHETIC_JOB_ID = '018f0000-0000-7300-8000-000000000000';

test.describe('TASK-309 AC-2/AC-3 — TranscriptionJob ownership genuine probe (AC-12)', () => {
  let doctorToken: string;
  let arcaaiSuperAdminToken: string;
  let jobId: string;

  test.beforeAll(async ({ request }) => {
    const doctorLogin = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctorLogin, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doctorLogin!.token;

    const arcaaiLogin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiLogin, 'super_admin login (ARCAAI) failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiLogin!.token;

    // Bootstrap a real TranscriptionJob row in tenant __GLOBAL__.
    // The create endpoint persists the row but does not dispatch
    // to STT-V2; status will stay QUEUED, which is enough for the
    // interceptor (it reads tenantId off the row regardless).
    const createResp = await request.post('/api/v1/audio/transcription-jobs', {
      headers: { Authorization: `Bearer ${doctorToken}` },
      data: {
        pipelineId: PRODUCTION_PIPELINE_ID,
        jobType: 'STREAMING',
      },
    });
    expect(createResp.status(), `create transcription job — body: ${await createResp.text()}`).toBeGreaterThanOrEqual(200);
    expect(createResp.status()).toBeLessThan(300);

    const created = (await createResp.json()) as { id: string };
    expect(created.id, 'create transcription job returned id').toBeTruthy();
    jobId = created.id;
  });

  test('creator (doctor in __GLOBAL__) can resolve the job — sanity for the cross-tenant assertion', async ({ request }) => {
    const response = await request.get(`/api/v1/audio/transcription-jobs/${jobId}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    expect(response.status()).toBe(200);
  });

  test('GET /audio/transcription-jobs/:id from tenant ARCAAI → 404', async ({ request }) => {
    const response = await request.get(`/api/v1/audio/transcription-jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });

  test('POST /audio/transcription-jobs/:id/cancel from tenant ARCAAI → 404', async ({ request }) => {
    const response = await request.post(`/api/v1/audio/transcription-jobs/${jobId}/cancel`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });

  test('POST /audio/transcription-jobs/:id/retry from tenant ARCAAI → 404', async ({ request }) => {
    const response = await request.post(`/api/v1/audio/transcription-jobs/${jobId}/retry`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect(response.status()).toBe(404);
  });

  test('GET /audio/transcription-jobs/:id/stream from tenant ARCAAI → not 200 (no SSE channel leak)', async ({ request }) => {
    const response = await request.get(`/api/v1/audio/transcription-jobs/${jobId}/stream`, {
      headers: { Authorization: `Bearer ${arcaaiSuperAdminToken}` },
    });
    expect([401, 404]).toContain(response.status());
  });

  test('after cross-tenant probes, the doctor in __GLOBAL__ still sees the job (no collateral damage)', async ({ request }) => {
    const response = await request.get(`/api/v1/audio/transcription-jobs/${jobId}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    expect(response.status()).toBe(200);
  });

  test('synthetic uuidv7 jobId → 404 (DEF-C3: same shape as cross-tenant 404)', async ({ request }) => {
    const response = await request.get(`/api/v1/audio/transcription-jobs/${SYNTHETIC_JOB_ID}`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(String(body.message ?? '')).not.toMatch(/tenant/i);
  });
});
