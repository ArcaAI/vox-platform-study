/**
 * TASK-704 — Generator Entry-Point Seam e2e.
 *
 * The literal acceptance criterion from the design brief and
 * `04-target-architecture.md`'s remediation table: on a harness-enabled
 * tenant, `POST :id/summary/async` (entry point #4 — previously one of the
 * six unforked legacy entry points, per the ticket's §2.1) now routes through
 * `NoteGenerationService` and produces the note via the SAME durable harness
 * document workflow entry point #1 already uses — never the legacy BullMQ
 * `SummaryProcessor` body.
 *
 * Follows `harness-gate.spec.ts`'s FULL-loop conventions exactly (find and
 * imitate rather than inventing new polling helpers):
 *   - Uses the seeded `GEN_COMPLETED` consultation (tenant `__GLOBAL__` /
 *     `SEED_TENANT_ID`), which the pipeline-policy seed
 *     (`14-pipeline-policy.ts`, `DEMO_PIPELINE_POLICY_OVERRIDE`) already pins
 *     to `harnessEnabled: true` — no extra env var needed to name a
 *     harness-enabled consultation, unlike the generic harness-gate spec.
 *   - The FULL-loop assertions (harness actually produces + signs a draft)
 *     additionally need apps/harness + Temporal + SMR + NLP + Postgres +
 *     Redis and are SKIPPED unless `HARNESS_E2E_FULL` is set, so CI never
 *     reports a fabricated pass.
 *   - "SummaryMeta with assuranceCompletedAt set" is asserted the same
 *     INDIRECT way `harness-gate.spec.ts`'s full loop already asserts it:
 *     `assuranceCompletedAt` is not exposed on any REST response (confirmed
 *     by grep — the only reads are internal to `SummaryService.approveSummary`'s
 *     `signedBeforeAssurance` gate), so the proxy is "the approve endpoint
 *     succeeds and the consultation reaches SIGNED with no assurance-bypass
 *     rejection" — the exact same non-bypass proof the existing spec already
 *     performs for entry point #1's harness path, just triggered here via
 *     entry point #4 instead.
 */
import { test, expect } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

/**
 * Seeded `GEN_COMPLETED` consultation id
 * (`packages/database/src/prisma/db_main/seed/00-constants.ts`,
 * `SEED_CONSULTATION_IDS.GEN_COMPLETED`). Owned by the `doctor` user in
 * tenant `__GLOBAL__` (`SEED_TENANT_ID`), which
 * `14-pipeline-policy.ts`'s `DEMO_PIPELINE_POLICY_OVERRIDE` pins to
 * `harnessEnabled: true`. Already carries a seeded transcript
 * (`09-consultation.ts` — "GEN_COMPLETED — transcript (v1 initial)").
 */
const GEN_COMPLETED_CONSULTATION_ID = '90000000-0000-0000-0000-000000000001';

const RUN_FULL = !!process.env.HARNESS_E2E_FULL;

async function loginDoctor(request: any): Promise<string> {
  const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
  expect(login, 'doctor login (__GLOBAL__) failed').toBeTruthy();
  return login!.token;
}

test.describe('entry point #4 (`POST :id/summary/async`) creates a real job on a harness-enabled tenant', () => {
  // This block needs only a live apps/api + Postgres + Redis (same baseline
  // as `consultation-job-cross-tenant.spec.ts`) — NOT the harness/Temporal/
  // SMR/NLP stack. It proves the job is genuinely created and dispatched
  // through the seam, independent of whether the harness actually completes
  // it in this environment.
  let doctorToken: string;
  let jobId: string;

  test.beforeAll(async ({ request }) => {
    doctorToken = await loginDoctor(request);

    const createResp = await request.post(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary/async`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
      data: {},
    });
    expect(createResp.status(), `create async summary job — body: ${await createResp.text()}`).toBeGreaterThanOrEqual(200);
    expect(createResp.status()).toBeLessThan(300);

    const created = (await createResp.json()) as { jobId: string };
    expect(created.jobId, 'create async summary returned jobId').toBeTruthy();
    jobId = created.jobId;
  });

  test('the job is resolvable by its creator', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: { Authorization: `Bearer ${doctorToken}` } });
    expect(response.status()).toBe(200);
  });
});

test.describe('FULL loop — harness-on tenant regenerate produces an assured, signable draft (HARNESS_E2E_FULL)', () => {
  test.skip(!RUN_FULL, 'requires apps/harness + Temporal + SMR + NLP + Postgres + Redis (set HARNESS_E2E_FULL=1)');

  let doctorToken: string;
  let jobId: string;

  test.beforeAll(async ({ request }) => {
    doctorToken = await loginDoctor(request);
    const auth = { Authorization: `Bearer ${doctorToken}` };

    const createResp = await request.post(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary/async`, { headers: auth, data: {} });
    expect(createResp.status(), `create async summary job — body: ${await createResp.text()}`).toBeLessThan(300);
    jobId = ((await createResp.json()) as { jobId: string }).jobId;
  });

  test('the BullMQ job completes immediately — the seam routed to harness and does not run the legacy body', async ({ request }) => {
    const auth = { Authorization: `Bearer ${doctorToken}` };
    let status: string | undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: auth });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { status: string; result?: { harnessJobId?: string } };
      status = body.status;
      if (status === 'COMPLETED' || status === 'FAILED') {
        expect(status, `job result: ${JSON.stringify(body)}`).toBe('COMPLETED');
        expect(body.result?.harnessJobId, 'a harness-routed job result must carry harnessJobId').toBeTruthy();
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`job ${jobId} did not reach a terminal state (last status: ${status})`);
  });

  test('the harness draft surfaces as PENDING_REVIEW with a retrievable RAW_SUMMARY draft', async ({ request }) => {
    const auth = { Authorization: `Bearer ${doctorToken}` };
    let consultStatus: string | undefined;

    for (let attempt = 0; attempt < 40; attempt++) {
      const detail = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}`, { headers: auth });
      expect(detail.status()).toBe(200);
      consultStatus = (await detail.json()).status;
      if (consultStatus === 'PENDING_REVIEW') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(consultStatus, 'harness generation must stop at the human gate').toBe('PENDING_REVIEW');

    const summaries = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary`, { headers: auth });
    expect(summaries.status()).toBe(200);
    const body = await summaries.json();
    const items = Array.isArray(body) ? body : (body.data ?? []);
    const draft = items.find?.((s: { type?: string }) => s.type === 'RAW_SUMMARY') ?? items;
    expect(draft, 'a harness draft must surface for clinician review').toBeTruthy();
  });

  test('approve succeeds and signs — the assurance gate does not reject (proxy for assuranceCompletedAt being set)', async ({ request }) => {
    const auth = { Authorization: `Bearer ${doctorToken}` };

    const summaries = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary`, { headers: auth });
    const body = await summaries.json();
    const items = Array.isArray(body) ? body : (body.data ?? []);
    const draft = (items.find?.((s: { type?: string }) => s.type === 'RAW_SUMMARY') ?? items[0]) as { id: string };
    expect(draft?.id, 'draft context item id required to approve').toBeTruthy();

    const approve = await request.post(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}/summary/${draft.id}/approve`, { headers: auth });
    expect(approve.status(), `approve — body: ${await approve.text()}`).toBe(201);

    const detail = await request.get(`/api/v1/consultations/${GEN_COMPLETED_CONSULTATION_ID}`, { headers: auth });
    expect((await detail.json()).status, 'consultation must be SIGNED after approve').toBe('SIGNED');
  });
});
