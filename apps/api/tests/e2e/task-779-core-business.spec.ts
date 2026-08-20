/**
 * TASK-779 area 3 — CORE BUSINESS TASKS: the consultation lifecycle end to end.
 *
 * The neighbouring suites already cover a lot and are NOT duplicated here:
 * `consultation-state-machine.spec.ts` owns prime/close/reopen and their OCC gates,
 * `consultation-job-cross-tenant.spec.ts` / `-cross-user.spec.ts` own the job
 * tenancy boundaries, and `task-709-note-occ.spec.ts` owns note versioning. What had
 * no executing coverage, and is covered here:
 *
 *  - `POST /consultations/open` as a GET-OR-CREATE (the SDK's only session entry
 *    point): the second call must return the SAME consultation, not a duplicate;
 *  - the capture path: a case note posted to `:id/context` shows up in the
 *    case-notes projection AND on the timeline;
 *  - the ASYNC JOB contract: enqueue → a job envelope → a terminal state, with the
 *    status vocabulary and monotonic progress pinned;
 *  - the FAIL-CLOSED contract on summary generation: when the downstream generator
 *    is unavailable the gateway answers a typed 503 and mints NO job — it never
 *    hands back a phantom job id or an empty success;
 *  - the job read plane's 401/404 — assertions that exist today only in
 *    `consultation-jobs.spec.ts`, a file the Playwright `testMatch`
 *    (`**\/*.spec.ts`) does not select, so they have never run (ticket finding F-3).
 *
 * FIXTURE HYGIENE: every consultation is opened for a patient id unique to this
 * run, so nothing collides with a previous or concurrent run. Consultations have
 * no DELETE route on this API (only their context items do), so the rows persist —
 * that is residue by design of the surface, not by carelessness, and it cannot
 * break a later run because the ids are never reused or asserted on.
 *
 * Prerequisites: API running against the test DB and seeded. Run with `RESET_DB=false`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string, tenantId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
});

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Terminal job states. Anything else must be one of the in-flight states below. */
const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'];
const IN_FLIGHT_STATES = ['PENDING', 'RUNNING'];

let doctorToken: string;
let doctor2Token: string;
let superAdminToken: string;
let foreignTenantId: string;
let ownTenantId: string;

/** Unique per run so fixtures never collide across runs or parallel workers. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const patientId = (label: string) => `t779-${label}-${RUN_ID}`;

interface Consultation {
  id: string;
  status: string;
  patientId: string;
  version: number;
  tenantId?: string;
}

/**
 * The tenant a token authenticated into, read from the JWT payload.
 *
 * Deliberately NOT read off a consultation: `ConsultationResponse` carries no
 * `tenantId` field, so an earlier draft of this spec silently resolved
 * `undefined` and then picked the caller's OWN tenant as the "foreign" one —
 * which turned a cross-tenant probe into a same-tenant one and asserted the
 * wrong status code. Decoding (not verifying) the payload is enough: this is
 * only used to choose a DIFFERENT tenant id.
 */
function tenantIdOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { tenantId?: string };
  expect(payload.tenantId, 'the access token must carry a tenantId').toBeTruthy();
  return payload.tenantId as string;
}

async function openConsultation(request: APIRequestContext, label: string): Promise<Consultation> {
  const response = await request.post('/api/v1/consultations/open', {
    headers: bearer(doctorToken),
    data: { patientId: patientId(label) },
  });
  expect(response.status(), `open consultation for ${label}`).toBe(201);
  return (await response.json()) as Consultation;
}

test.beforeAll(async ({ request }) => {
  const [doc, doc2, sa] = await Promise.all([
    loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY),
    loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password),
  ]);
  expect(doc?.token, 'doctor login failed — is the stack seeded?').toBeTruthy();
  expect(doc2?.token, 'doctor2 login failed').toBeTruthy();
  expect(sa?.token, 'super_admin login failed').toBeTruthy();
  doctorToken = doc!.token;
  doctor2Token = doc2!.token;
  superAdminToken = sa!.token;

  const tenants = await request.get('/api/v1/admin/tenants?page=0&limit=50', { headers: bearer(superAdminToken) });
  expect(tenants.status(), 'list tenants').toBe(200);
  const rows = ((await tenants.json()).data as Array<{ id: string }>).filter((t) => t.id !== SYSTEM_TENANT_ID);
  expect(rows.length, 'at least two customer tenants must be seeded').toBeGreaterThanOrEqual(2);

  ownTenantId = tenantIdOf(doctorToken);
  expect(
    rows.map((t) => t.id),
    'the clinician tenant must be among the listed tenants',
  ).toContain(ownTenantId);
  foreignTenantId = rows.find((t) => t.id !== ownTenantId)!.id;
  expect(foreignTenantId, 'a second customer tenant is required for the cross-tenant probe').toBeTruthy();
  expect(foreignTenantId).not.toBe(ownTenantId);
});

test.describe('TASK-779 core business — session open is GET-OR-CREATE', () => {
  test('opening twice for the same patient+day returns the SAME consultation, not a duplicate', async ({ request }) => {
    const first = await openConsultation(request, 'getorcreate');
    expect(first.status, 'a newly opened consultation is OPEN').toBe('OPEN');
    expect(first.version, 'a fresh row starts at _version 1').toBe(1);

    const second = await request.post('/api/v1/consultations/open', {
      headers: bearer(doctorToken),
      data: { patientId: first.patientId },
    });
    expect(second.status()).toBe(201);
    const secondBody = (await second.json()) as Consultation;
    expect(secondBody.id, 'open is idempotent — the SDK has no separate create call, so a re-open must resolve the same session').toBe(first.id);
    expect(secondBody.version, 'a get-or-create hit must not mutate the row').toBe(first.version);

    // And exactly one row is visible for that patient.
    const history = await request.get(`/api/v1/consultations?patientId=${encodeURIComponent(first.patientId)}&page=1&limit=50`, {
      headers: bearer(doctorToken),
    });
    expect(history.status()).toBe(200);
    const listed = ((await history.json()).data ?? []) as Consultation[];
    expect(
      listed.filter((c) => c.patientId === first.patientId).length,
      'a second open must not have created a second consultation for the same patient/day',
    ).toBe(1);
  });

  test('a consultation id from another tenant is 404, and an unknown id is 404 with the same shape', async ({ request }) => {
    const mine = await openConsultation(request, 'crosstenant');

    const foreign = await request.get(`/api/v1/consultations/${mine.id}`, { headers: bearer(superAdminToken, foreignTenantId) });
    expect(foreign.status(), 'a real consultation read from the wrong tenant → 404, never 403').toBe(404);

    const unknown = await request.get('/api/v1/consultations/01a01b00-0000-7000-8000-000000000779', { headers: bearer(doctorToken) });
    expect(unknown.status(), 'a synthetic uuidv7 → the same 404, so the two are indistinguishable').toBe(404);
  });

  test('a same-tenant peer clinician gets 403, not 404 — inside the tenant the boundary is PRIVILEGE, across it, EXISTENCE', async ({ request }) => {
    const mine = await openConsultation(request, 'peerread');

    const peer = await request.get(`/api/v1/consultations/${mine.id}`, { headers: bearer(doctor2Token) });
    // The two postures side by side are the point: a peer inside the tenant is
    // told "not yours" (403) because the row's existence is not a secret from
    // them; a caller in another tenant is told "no such thing" (404) because it
    // is. Collapsing either into the other is the bug this pins.
    expect(peer.status(), 'a same-tenant clinician who is not the consulting doctor → 403').toBe(403);

    const foreign = await request.get(`/api/v1/consultations/${mine.id}`, { headers: bearer(superAdminToken, foreignTenantId) });
    expect(foreign.status(), 'the same row, from another tenant → 404').toBe(404);
  });
});

test.describe('TASK-779 core business — the capture path', () => {
  test('a case note posted to :id/context appears in the case-notes projection and on the timeline', async ({ request }) => {
    const consultation = await openConsultation(request, 'casenote');
    const content = `t779 capture probe ${RUN_ID}`;

    const created = await request.post(`/api/v1/consultations/${consultation.id}/context`, {
      headers: bearer(doctorToken),
      data: { type: 'CASE_NOTE', content },
    });
    expect(created.status(), 'add context item').toBe(201);
    const item = await created.json();
    expect(item.consultationId).toBe(consultation.id);
    expect(item.type).toBe('CASE_NOTE');
    expect(item.currentVersionNumber, 'a new context item starts at version 1').toBe(1);

    const caseNotes = await request.get(`/api/v1/consultations/${consultation.id}/context/case-notes`, { headers: bearer(doctorToken) });
    expect(caseNotes.status(), 'case-notes projection').toBe(200);
    const notes = (await caseNotes.json()) as Array<{ id: string; content: string }>;
    expect(
      notes.map((n) => n.id),
      'the note must be in the typed projection, not only the generic context list',
    ).toContain(item.id);
    expect(notes.find((n) => n.id === item.id)?.content).toBe(content);

    const timeline = await request.get(`/api/v1/consultations/${consultation.id}/timeline`, { headers: bearer(doctorToken) });
    expect(timeline.status(), 'timeline').toBe(200);
    const timelineBody = (await timeline.json()) as { consultationId: string; events: Array<{ type: string }> };
    expect(timelineBody.consultationId).toBe(consultation.id);
    expect(
      timelineBody.events.map((e) => e.type),
      'opening the session is itself a timeline event — the timeline is not merely a note list',
    ).toContain('consultation_opened');
    expect(timelineBody.events.length, 'the note added an event on top of the open event').toBeGreaterThan(1);
  });

  test('summary/latest on a consultation that has never been summarised is a 404 (TASK-780 F-6 fixed)', async ({ request }) => {
    const consultation = await openConsultation(request, 'nosummary');
    const response = await request.get(`/api/v1/consultations/${consultation.id}/summary/latest`, { headers: bearer(doctorToken) });
    // TASK-780 F-6 fixed: "no summary yet" now answers 404, matching the house pattern
    // used by every other "optional latest resource" endpoint (getDnaReport, getJob,
    // getLiveSession) — a client that calls `.json()` unconditionally no longer throws
    // on a zero-byte body.
    expect(response.status(), 'no summary yet is a missing resource, not an empty success').toBe(404);
  });
});

test.describe('TASK-779 core business — the async job contract', () => {
  test('an async pre-summary enqueues a job that reaches a terminal state, with a legal status vocabulary and monotonic progress', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const consultation = await openConsultation(request, 'asyncjob');
    await request.post(`/api/v1/consultations/${consultation.id}/context`, {
      headers: bearer(doctorToken),
      data: { type: 'CASE_NOTE', content: 'Patient reports headache for three days. No fever.' },
    });

    const enqueued = await request.post(`/api/v1/consultations/${consultation.id}/summary/pre-summary/async`, {
      headers: bearer(doctorToken),
      data: {},
    });
    expect(enqueued.status(), 'enqueue an async pre-summary').toBe(201);
    const envelope = await enqueued.json();
    expect(envelope.jobId, 'the enqueue response must carry a resolvable job id').toBeTruthy();
    expect(envelope.consultationId).toBe(consultation.id);

    const jobId = envelope.jobId as string;
    const seenProgress: number[] = [];
    const seenStates: string[] = [];
    const deadline = Date.now() + 90_000;
    let final: { status: string; progress: number; type: string; consultationId: string } | undefined;

    while (Date.now() < deadline) {
      const poll = await request.get(`/api/v1/consultations/jobs/${jobId}`, { headers: bearer(doctorToken) });
      expect(poll.status(), 'polling an own job').toBe(200);
      const body = await poll.json();
      expect(body.jobId).toBe(jobId);
      expect(body.consultationId, 'the job stays bound to its consultation').toBe(consultation.id);
      expect(
        [...IN_FLIGHT_STATES, ...TERMINAL_STATES],
        `unexpected job status '${body.status}' — the status vocabulary is a client contract`,
      ).toContain(body.status);
      seenStates.push(body.status);
      seenProgress.push(body.progress);
      if (TERMINAL_STATES.includes(body.status)) {
        final = body;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(
      final,
      `the job never reached a terminal state within 90s (states seen: ${seenStates.join(' → ') || 'none'}). ` +
        'That means the BullMQ worker behind /consultations/jobs is not draining the queue — a real failure, not an environment excuse.',
    ).toBeTruthy();
    expect(final!.type, 'the job declares what it is').toBe('PRE_SUMMARY');
    expect(
      seenProgress.every((p, i) => i === 0 || p >= seenProgress[i - 1]),
      `progress went backwards: ${seenProgress.join(',')}`,
    ).toBe(true);
    if (final!.status === 'COMPLETED') {
      expect(final!.progress, 'a COMPLETED job reports 100').toBe(100);
    }
  });

  test('summary generation FAILS CLOSED: either a job is enqueued, or a typed 503 — never a phantom job or a silent empty success', async ({
    request,
  }) => {
    // This route depends on the downstream generator (`apps/text`). Rather than
    // skipping when it is down — a silent skip reads as a pass — the assertion is
    // written as the CONTRACT that must hold in BOTH worlds. The one outcome that
    // would be a defect (200/201 with no resolvable job) is excluded either way.
    const consultation = await openConsultation(request, 'failclosed');
    await request.post(`/api/v1/consultations/${consultation.id}/context`, {
      headers: bearer(doctorToken),
      data: { type: 'CASE_NOTE', content: 'Follow-up visit, no new complaints.' },
    });

    const response = await request.post(`/api/v1/consultations/${consultation.id}/summary/async`, {
      headers: bearer(doctorToken),
      data: {},
    });
    const body = await response.json();
    expect([201, 202, 503], `unexpected status ${response.status()} from summary/async: ${JSON.stringify(body).slice(0, 300)}`).toContain(
      response.status(),
    );

    if (response.status() === 503) {
      // Fail-closed: a typed, retryable gateway error and NO job handed back.
      expect(body.code, 'the unavailable downstream must be a typed error the client can branch on').toBe('GATEWAY.DOWNSTREAM_UNAVAILABLE');
      expect(body.jobId, 'a failed enqueue must not hand back a job id that will never resolve').toBeUndefined();
      test.info().annotations.push({
        type: 'downstream-unavailable',
        description:
          'apps/text was NOT reachable during this run, so the 503 fail-closed branch was exercised (the 201/202 enqueue branch was not). ' +
          'This is asserted, not skipped.',
      });
    } else {
      expect(body.jobId, 'a successful enqueue must carry a resolvable job id').toBeTruthy();
      const poll = await request.get(`/api/v1/consultations/jobs/${body.jobId}`, { headers: bearer(doctorToken) });
      expect(poll.status(), 'the id handed back by the enqueue must resolve on the job plane').toBe(200);
    }
  });

  test('the job read plane: unauthenticated → 401, unknown job id → 404 (restores the assertions in the never-selected .e2e-spec.ts file)', async ({
    request,
  }) => {
    const anonymous = await request.get('/api/v1/consultations/jobs/t779-missing-id');
    expect(anonymous.status(), 'deny-by-default — no credential, no answer').toBe(401);

    const unknown = await request.get('/api/v1/consultations/jobs/t779-does-not-exist', { headers: bearer(doctorToken) });
    expect(unknown.status(), 'an unknown job id → 404').toBe(404);

    const cancelAnonymous = await request.patch('/api/v1/consultations/jobs/t779-missing-id/cancel');
    expect(cancelAnonymous.status(), 'cancel is authenticated too').toBe(401);

    const cancelUnknown = await request.patch('/api/v1/consultations/jobs/t779-does-not-exist/cancel', { headers: bearer(doctorToken) });
    expect(cancelUnknown.status(), 'cancelling an unknown job → 404').toBe(404);
  });
});
