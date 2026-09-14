/**
 * TASK-974 §5.1 item 11 — the DNA writing-sample INGEST surface, as an HTTP contract.
 *
 * Two things this spec exists to prove, neither of which a unit test can:
 *
 *  1. **All three credential classes really reach it.** Owner request (c) is that a machine can
 *     build a clinician's writing style; the unit tests prove the service's rules, but only a
 *     live gateway proves that `UnifiedAuthGuard` admits an API key and a service-account token
 *     on this route — the scope registry, the derived `svc:` family, the boot audits and the
 *     seeded grants all have to agree for that to happen.
 *  2. **The platform analyst is invisible.** D-1 says the hidden agent is never listed and never
 *     invokable on the business plane — and the tenant that matters is GLOBAL, because it OWNS
 *     the authored row. Every other tenant would pass vacuously.
 *
 * Credentials come ONLY from `tests/helpers/e2e.helper.ts` (rule 05 §API Test Standard).
 *
 * Prerequisites: a live gateway against the test DB (`pnpm test:up:api`), seeded
 * (`pnpm test:db:seed`). The seeded consultation graphs carry `core.agent` nodes with
 * `dna.enabled: true`, which is what makes the tenant half of the DNA gate true; if that ever
 * stops being seeded, the ACCEPTED cases below fail with a message saying so rather than with an
 * opaque 409.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_API_KEY, SEEDED_API_KEY_DOCTOR2, SEEDED_API_KEY_SERVICE_ACCOUNT, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const INGEST = '/api/v1/dna-writing-styles/ingest';
const INGEST_JOB = (jobId: string) => `/api/v1/dna-writing-styles/ingest/jobs/${jobId}`;
const AGENTS = '/api/v1/agents';

/** The PLATFORM HIDDEN analyst (`PLATFORM_HIDDEN_AGENTS`), seeded into SYSTEM and into Global. */
const HIDDEN_AGENT_SLUG = 'dna-writing-style-analyst';

/**
 * The seeded ArcaAI service account (`00-constants.ts`). It is bound to the ARCAAI tenant, so
 * every clinician it names must be an ARCAAI clinician — which is also what makes the
 * cross-tenant case below real rather than contrived.
 */
const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

/** Seeded users (`91-user.ts`) the helper does not surface by id. */
const USER_ARCAAI_DOCTOR = '70000000-0000-0000-0000-000000000040';

const sample = (
  writtenAt: string,
  text = 'Patient seen for follow-up. Symptoms improved on current regimen. Continue and review in four weeks.',
) => ({
  text,
  writtenAt,
  kind: 'CASE_NOTE' as const,
});

const batch = () => ({ items: [sample('2026-08-01T09:00:00.000Z'), sample('2026-09-01T09:00:00.000Z')] });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', { data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET } });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

/**
 * Assert an ACCEPTED ingest, and explain a 409 rather than letting it read as a contract break.
 *
 * `DNA_STYLE_DISABLED` means the ENVIRONMENT's DNA gate is off (the tenant's graph carries no
 * `dna.enabled` node, or the clinician opted out), not that the route misbehaved — and a bare
 * "expected 202, got 409" would send the next reader into the authorization code.
 */
async function expectAccepted(response: { status(): number; json(): Promise<unknown> }, label: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status() === 409) {
    throw new Error(
      `${label}: the gateway answered 409 ${(body as { code?: string }).code ?? ''} — DNA writing style is disabled for this clinician in the ` +
        'test environment. Re-seed (the seeded consultation graphs enable it) or enable it for this tenant; the route itself is fine.',
    );
  }
  expect(response.status(), `${label}: ${JSON.stringify(body)}`).toBe(202);
  return body;
}

test.describe('TASK-974 — DNA writing-sample ingest', () => {
  let doctorJwt: string;
  let adminJwt: string;
  let svcToken: string;

  test.beforeAll(async ({ request }) => {
    const [doctor, admin] = await Promise.all([
      loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
      loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY),
    ]);
    expect(doctor?.token, 'doctor login failed').toBeTruthy();
    expect(admin?.token, 'tenant-admin login failed').toBeTruthy();
    doctorJwt = doctor!.token as string;
    adminJwt = admin!.token as string;
    svcToken = await serviceAccountToken(request);
  });

  // ─── Reach: all three credential classes ────────────────────────────────────────────────────

  test('a clinician JWT ingests their OWN samples — 202 with the resolved window', async ({ request }) => {
    const res = await request.post(INGEST, { headers: { Authorization: `Bearer ${doctorJwt}` }, data: batch() });

    const body = await expectAccepted(res, 'doctor JWT self-ingest');
    expect(body).toMatchObject({
      status: 'PENDING',
      clinicianUserId: SEEDED_USERS.doctor.id,
      acceptedItems: 2,
      window: { from: '2026-08-01T09:00:00.000Z', to: '2026-09-01T09:00:00.000Z' },
    });
    expect(body.jobId).toBeTruthy();
  });

  test('an API key holding the scope reaches the route and ingests for its bound clinician', async ({ request }) => {
    // A machine must NAME the clinician — even one bound to a user. `SEEDED_API_KEY` is bound to
    // the seeded doctor, so naming them is the in-tenant case.
    const res = await request.post(INGEST, {
      headers: { 'X-API-Key': SEEDED_API_KEY },
      data: { clinicianUserId: SEEDED_USERS.doctor.id, ...batch() },
    });

    const body = await expectAccepted(res, 'API-key ingest');
    expect(body.clinicianUserId).toBe(SEEDED_USERS.doctor.id);
  });

  test('a service-account token ingests for a clinician of ITS tenant', async ({ request }) => {
    const res = await request.post(INGEST, {
      headers: { 'X-Service-Account-Token': svcToken },
      data: { clinicianUserId: USER_ARCAAI_DOCTOR, ...batch() },
    });

    const body = await expectAccepted(res, 'service-account ingest');
    expect(body.clinicianUserId).toBe(USER_ARCAAI_DOCTOR);
  });

  test('a tenant admin may ingest on a clinician`s behalf', async ({ request }) => {
    const res = await request.post(INGEST, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { clinicianUserId: SEEDED_USERS.doctor.id, ...batch() },
    });

    const body = await expectAccepted(res, 'tenant-admin ingest');
    expect(body.clinicianUserId).toBe(SEEDED_USERS.doctor.id);
  });

  // ─── Refusals ───────────────────────────────────────────────────────────────────────────────

  test('an API key WITHOUT the scope is refused by the scope gate, not by the handler', async ({ request }) => {
    // The seeded internal STT-worker key: ACTIVE, and scoped to `internal:stt:worker` alone.
    const res = await request.post(INGEST, {
      headers: { 'X-API-Key': SEEDED_API_KEY_SERVICE_ACCOUNT },
      data: { clinicianUserId: SEEDED_USERS.doctor.id, ...batch() },
    });

    expect(res.status()).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/scope/i);
  });

  test('a MACHINE that names no clinician is refused — it is never one itself', async ({ request }) => {
    const res = await request.post(INGEST, { headers: { 'X-API-Key': SEEDED_API_KEY }, data: batch() });

    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('DNA_INGEST_CLINICIAN_REQUIRED');
  });

  test('a clinician may not name ANOTHER clinician', async ({ request }) => {
    const res = await request.post(INGEST, {
      headers: { Authorization: `Bearer ${doctorJwt}` },
      data: { clinicianUserId: SEEDED_USERS.doctor2.id, ...batch() },
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('DNA_INGEST_CLINICIAN_NOT_ALLOWED');
  });

  test('a clinician of ANOTHER tenant is 404 — never 403, and never a confirmation that they exist', async ({ request }) => {
    const res = await request.post(INGEST, {
      headers: { Authorization: `Bearer ${adminJwt}` },
      data: { clinicianUserId: USER_ARCAAI_DOCTOR, ...batch() },
    });

    expect(res.status()).toBe(404);
  });

  test('the request body is whitelisted — an undeclared field rejects the call', async ({ request }) => {
    const res = await request.post(INGEST, {
      headers: { Authorization: `Bearer ${doctorJwt}` },
      data: { ...batch(), doctorId: SEEDED_USERS.doctor2.id },
    });

    expect(res.status()).toBe(400);
  });

  test('an empty batch is refused by validation', async ({ request }) => {
    const res = await request.post(INGEST, { headers: { Authorization: `Bearer ${doctorJwt}` }, data: { items: [] } });

    expect(res.status()).toBe(400);
  });

  // ─── The job read ───────────────────────────────────────────────────────────────────────────

  test('a caller reads back the job they enqueued, and nobody else`s', async ({ request }) => {
    const created = await request.post(INGEST, { headers: { Authorization: `Bearer ${doctorJwt}` }, data: batch() });
    const { jobId } = (await expectAccepted(created, 'job-read setup')) as { jobId: string };

    const own = await request.get(INGEST_JOB(jobId), { headers: { Authorization: `Bearer ${doctorJwt}` } });
    expect(own.status()).toBe(200);
    expect((await own.json()).jobId).toBe(jobId);

    // Another clinician of the SAME tenant: 404, indistinguishable from a job that never existed.
    const other = await loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY);
    const foreign = await request.get(INGEST_JOB(jobId), { headers: { Authorization: `Bearer ${other!.token}` } });
    expect(foreign.status()).toBe(404);

    // A MACHINE did not enqueue it, so a machine cannot read it — even one holding the scope.
    const machine = await request.get(INGEST_JOB(jobId), { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(machine.status()).toBe(404);
  });

  test('a machine reads back the job ITS credential enqueued', async ({ request }) => {
    const created = await request.post(INGEST, {
      headers: { 'X-API-Key': SEEDED_API_KEY },
      data: { clinicianUserId: SEEDED_USERS.doctor.id, ...batch() },
    });
    const { jobId } = (await expectAccepted(created, 'machine job-read setup')) as { jobId: string };

    const own = await request.get(INGEST_JOB(jobId), { headers: { 'X-API-Key': SEEDED_API_KEY } });
    expect(own.status()).toBe(200);
    expect((await own.json()).jobId).toBe(jobId);

    // The clinician the job is ABOUT may read it: the human gate is `doctorId` (README §4.1), and
    // the job is their own writing-style profile being rebuilt — owner access, not a leak.
    const owner = await request.get(INGEST_JOB(jobId), { headers: { Authorization: `Bearer ${doctorJwt}` } });
    expect(owner.status()).toBe(200);

    // Another clinician of the same tenant is 404 — the job is not about them.
    const other = await loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY);
    const foreignHuman = await request.get(INGEST_JOB(jobId), { headers: { Authorization: `Bearer ${other!.token}` } });
    expect(foreignHuman.status()).toBe(404);

    // A DIFFERENT machine credential — holding the scope, in the same tenant — is 404: the
    // machine gate compares `requestedBy.principalId`, and this key did not enqueue the job.
    // (This is the case the `requestedBy` gate exists for.)
    const otherMachine = await request.get(INGEST_JOB(jobId), { headers: { 'X-API-Key': SEEDED_API_KEY_DOCTOR2 } });
    expect(otherMachine.status()).toBe(404);
  });

  test('an unknown job id is 404', async ({ request }) => {
    const res = await request.get(INGEST_JOB('00000000-0000-0000-0000-0000000000ff'), { headers: { Authorization: `Bearer ${doctorJwt}` } });
    expect(res.status()).toBe(404);
  });

  // ─── The platform analyst is invisible on the business plane (D-1) ───────────────────────────

  test.describe('the hidden analyst', () => {
    test('is not listed by GET /agents — in GLOBAL, the tenant that OWNS the authored row', async ({ request }) => {
      const all = await request.get(AGENTS, { headers: { Authorization: `Bearer ${adminJwt}` } });
      expect(all.status()).toBe(200);
      const slugs = ((await all.json()).data as Array<{ slug: string }>).map((agent) => agent.slug);
      expect(slugs).not.toContain(HIDDEN_AGENT_SLUG);
      // …and the list is not empty, so the assertion above is not vacuous.
      expect(slugs.length).toBeGreaterThan(0);

      const byTask = await request.get(`${AGENTS}?task=TEXT_GENERATION`, { headers: { Authorization: `Bearer ${adminJwt}` } });
      expect(byTask.status()).toBe(200);
      expect(((await byTask.json()).data as Array<{ slug: string }>).map((agent) => agent.slug)).not.toContain(HIDDEN_AGENT_SLUG);
    });

    test('answers 404 by slug — the same answer an unknown agent gets', async ({ request }) => {
      const res = await request.get(`${AGENTS}/${HIDDEN_AGENT_SLUG}`, { headers: { Authorization: `Bearer ${adminJwt}` } });
      expect(res.status()).toBe(404);
    });

    test('cannot be invoked', async ({ request }) => {
      const res = await request.post(`${AGENTS}/${HIDDEN_AGENT_SLUG}/invocations`, {
        headers: { Authorization: `Bearer ${adminJwt}` },
        data: { text: 'anything' },
      });
      expect(res.status()).toBe(404);
    });

    test('cannot be assigned — 409, and the row is real, so this is about the relationship', async ({ request }) => {
      const res = await request.post('/api/v1/admin/agent-assignments', {
        headers: { Authorization: `Bearer ${adminJwt}` },
        data: { scope: 'TENANT', task: 'TEXT_GENERATION', agentSlug: HIDDEN_AGENT_SLUG },
      });
      expect(res.status()).toBe(409);
      expect((await res.json()).code).toBe('AGENT_NOT_ASSIGNABLE');
    });

    test('IS visible to the admin surface, flagged — an administrator must see the agent they own', async ({ request }) => {
      const res = await request.get('/api/v1/admin/agents?task=TEXT_GENERATION', { headers: { Authorization: `Bearer ${adminJwt}` } });
      expect(res.status()).toBe(200);
      const rows = (await res.json()) as Array<{ slug: string; hidden?: boolean }>;
      const analyst = rows.find((agent) => agent.slug === HIDDEN_AGENT_SLUG);
      expect(analyst, 'Global authors the analyst, so its admin list must carry it').toBeTruthy();
      expect(analyst!.hidden).toBe(true);
    });
  });
});
