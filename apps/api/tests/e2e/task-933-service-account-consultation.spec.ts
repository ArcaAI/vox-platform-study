/**
 * TASK-933 — the NATIVE service-account realtime consultation plane, end to end.
 *
 * The ticket's claim is that an external system authenticated as a HOPE **service account**
 * (`X-Service-Account-Token`, tenant bound at exchange) can drive a whole consultation for a
 * NAMED clinician, without borrowing a human's credential anywhere. This spec is that claim as
 * HTTP calls, in the order a broker actually makes them:
 *
 *   discover the tenant's context schema -> open for a clinician -> read the row back ->
 *   start recording -> create + refresh + close an STT streaming session it OWNS ->
 *   reach the live SSE plane -> write a case note -> stop recording -> read the note ->
 *   list the consultation-bound workflows.
 *
 * Plus the four refusals that make the grant meaningful, all asserted here rather than implied:
 * a machine that names nobody (400), a human that names someone (400), a clinician the tenant
 * does not have or who may not own a consultation (404), and a consultation in another tenant
 * (404, never 403).
 *
 * ─── How to run it ─────────────────────────────────────────────────────────
 *
 *   pnpm setup:test && pnpm test:up:api        # terminal 1 (or an already-seeded stack)
 *   SKIP_DB_PRECHECK=true RESET_DB=false API_URL=http://localhost:8868/api/v1 \
 *     npx dotenv -e .env.test -- npx playwright test apps/api/tests/e2e/task-933
 *
 * (`pnpm test:e2e -- <filter>` does NOT filter — the `--` is swallowed. See
 * `01-development-workflow.md` §Test Placement.)
 *
 * ─── Fixtures it needs ─────────────────────────────────────────────────────
 *
 * A seeded database, and nothing hand-made:
 *   · the ArcaAI service account `hope_svc_a4ca1a11ad3141b0c0de0001` with its dev fixture secret
 *     (`SEED_SERVICE_ACCOUNT_DEV_SECRETS.ARCAAI_ADMIN`, seeded only in development/test), which
 *     since TASK-933 carries the five realtime scopes;
 *   · `arcaai_doctor` (`70000000-…-040`, role DOCTOR, tenant ArcaAI) as the named clinician;
 *   · `arcaai_nurse` (`70000000-…-041`, role NURSE) as the user who may NOT own a consultation;
 *   · `GEN_ARCAAI` (`70000000-0000-0000-0001-000000000001`) as the department;
 *   · the Global-tenant consultation `90000000-…-0001` as the cross-tenant probe;
 *   · a tenant-admin JWT (`SEEDED_USERS.admin`) for the human-caller refusal.
 *
 * Patient ids are generated per run, so the spec is re-runnable and never joins a consultation a
 * previous run opened.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Open an SSE route and resolve on its response HEADERS, then destroy the socket.
 * `APIRequestContext.get` waits for the body, which an event stream never finishes.
 */
function openSse(path: string, headers: Record<string, string>): Promise<{ status: number; contentType: string }> {
  const origin = new URL(process.env.API_URL ?? 'http://localhost:8968/api/v1').origin;
  const url = new URL(path, origin);
  const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = lib(url, { method: 'GET', headers: { ...headers, Accept: 'text/event-stream' } }, (res) => {
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers['content-type'] ?? '');
      res.destroy();
      resolve({ status, contentType });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('SSE open timed out')));
    req.end();
  });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SVC_CLIENT_ID = 'hope_svc_a4ca1a11ad3141b0c0de0001';
const SVC_CLIENT_SECRET = 'hope_svcsec_test_4f0b1d7a2e6c48b39a15d0c7e2f83b6104d9a7c5e18f2b6039d4c8a71e0b5f2d';

const ARCAAI_DOCTOR = '70000000-0000-0000-0000-000000000040';
const ARCAAI_NURSE = '70000000-0000-0000-0000-000000000041';
/** A Global-tenant clinician: a real user, in a tenant this account is not bound to. */
const GLOBAL_DOCTOR = '70000000-0000-0000-0000-000000000010';
const GEN_ARCAAI = '70000000-0000-0000-0001-000000000001';
/** Seeded Global-tenant consultation — the cross-tenant probe. */
const CONSULTATION_GLOBAL = '90000000-0000-0000-0000-000000000001';

const svcHeaders = (token: string) => ({ 'X-Service-Account-Token': token, 'Content-Type': 'application/json' });

async function serviceAccountToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/service-token', {
    data: { clientId: SVC_CLIENT_ID, clientSecret: SVC_CLIENT_SECRET },
  });
  expect(res.status(), 'service-token exchange').toBe(200);
  return (await res.json()).accessToken as string;
}

/** A patient id unique to this run, so `getOrCreate` always takes its CREATE branch. */
const patientId = () => `PAT-T933-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ─── Suite ──────────────────────────────────────────────────────────────────

test.describe('TASK-933 — a service account drives a consultation for a named clinician', () => {
  let svcToken: string;
  let tenantAdminJwt: string;

  test.beforeAll(async ({ request }) => {
    svcToken = await serviceAccountToken(request);
    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, 'tenant-admin login').not.toBeNull();
    tenantAdminJwt = ta!.token;
  });

  // ── 1. Discovery: what may I submit? ──────────────────────────────────────

  test('reads the tenant context-schema discovery bundle (svc:tenant:context-schema:read)', async ({ request }) => {
    const res = await request.get('/api/v1/tenants/me/context-schema', { headers: svcHeaders(svcToken) });

    // A tenant with no configured schema answers 200 with null fields and ETag `"none"` — never
    // 404, which a client cannot tell apart from a routing mistake. Either way it is REACHABLE,
    // which is the authorization fact under test.
    expect(res.status()).toBe(200);
    expect(res.headers()['etag']).toBeTruthy();
  });

  // ── 2. Open, and the four refusals ────────────────────────────────────────

  test('opens a consultation for the named clinician and records THEM as the doctor', async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: ARCAAI_DOCTOR, departmentId: GEN_ARCAAI, language: 'en' },
    });

    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.doctorId).toBe(ARCAAI_DOCTOR);
    expect(body.departmentId).toBe(GEN_ARCAAI);
    // The machine is NEVER the doctor. This is the whole point of the field.
    expect(body.doctorId).not.toBe('e0000000-0000-0000-0000-000000000001');
  });

  test('a machine that names no clinician is 400 CLINICIAN_REQUIRED', async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), departmentId: GEN_ARCAAI },
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_REQUIRED');
  });

  test('a HUMAN caller that names a clinician is 400 CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER', async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: { Authorization: `Bearer ${tenantAdminJwt}`, 'Content-Type': 'application/json' },
      data: { patientId: patientId(), clinicianUserId: ARCAAI_DOCTOR },
    });

    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER');
  });

  test("a clinician in ANOTHER tenant is 404 — the user id space is not the caller's to probe", async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: GLOBAL_DOCTOR },
    });

    expect(res.status()).toBe(404);
  });

  test('a tenant user who may not OWN a consultation (a nurse) is 404, not 403', async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: ARCAAI_NURSE, departmentId: GEN_ARCAAI },
    });

    // 404 and not 403 on purpose: "that user exists but is a nurse" is exactly the fact not to
    // disclose, and it must be indistinguishable from "no such user".
    expect(res.status()).toBe(404);
  });

  test('a malformed clinician id is refused at the edge, before any tenant read', async ({ request }) => {
    const res = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: 'not-an-id' },
    });

    expect(res.status()).toBe(400);
  });

  // ── 3. The whole lifecycle on one consultation ────────────────────────────

  test('drives the consultation: read, record, stream, note, stop, read the note, list workflows', async ({ request }) => {
    // `recording/stop` runs the realtime lane's FINAL flush before it answers; with a case note
    // on file that is a TEXT call, bounded by the platform's realtime text timeout (observed
    // 34 s against a busy LM Studio), so this journey gets a budget beyond the 30 s default.
    test.setTimeout(150_000);
    const opened = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: ARCAAI_DOCTOR, departmentId: GEN_ARCAAI, language: 'en' },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    const consultationId = (await opened.json()).id as string;

    // READ BACK — `svc:consultation:session:read`. Before TASK-933 this was a 401 from
    // `getDoctorId()`: the account could open a consultation it could not then read.
    const read = await request.get(`/api/v1/consultations/${consultationId}`, { headers: svcHeaders(svcToken) });
    expect(read.status(), await read.text()).toBe(200);
    expect((await read.json()).doctorId).toBe(ARCAAI_DOCTOR);

    // RECORDING START — `svc:consultation:session:write`, and consent was recorded at open (the
    // `@RequiresConsent(AI_DOCUMENTATION)` gate would otherwise 403 here).
    const started = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, {
      headers: svcHeaders(svcToken),
      data: {},
    });
    expect(started.status(), await started.text()).toBe(200);
    expect((await started.json()).recording).toBe(true);

    // GOVERNING RUN ON THE WORKFLOWS PLANE (H3-5) — `recording/start` dispatched the department's
    // tenant workflow and stamped `metadata.governingEngine` on the row. That run is anchored
    // under the consultation dispatcher's session key (`wf-<runId>`), which the workflows plane
    // used to look past (404 for every consultation-governed run). The service account must be
    // able to read it and its clinician review gate — that is what lets an integrator such as
    // ALaaS release the gate on the clinician's behalf (owner decision OD-14, 2026-09-09).
    const governed = await request.get(`/api/v1/consultations/${consultationId}`, { headers: svcHeaders(svcToken) });
    expect(governed.status(), await governed.text()).toBe(200);
    const engine = ((await governed.json()).metadata ?? {}).governingEngine as
      { workflowRunId?: string; workflowDefinitionSlug?: string } | undefined;
    expect(engine?.workflowRunId, 'recording/start must record the governing run').toBeTruthy();
    expect(engine?.workflowDefinitionSlug).toBeTruthy();
    const runStatus = await request.get(`/api/v1/workflows/${engine!.workflowDefinitionSlug}/runs/${engine!.workflowRunId}`, {
      headers: svcHeaders(svcToken),
    });
    expect(runStatus.status(), await runStatus.text()).toBe(200);
    expect((await runStatus.json()).runId).toBe(engine!.workflowRunId);
    const gate = await request.get(`/api/v1/workflows/${engine!.workflowDefinitionSlug}/runs/${engine!.workflowRunId}/reviews/n_review`, {
      headers: svcHeaders(svcToken),
    });
    expect(gate.status(), await gate.text()).toBe(200);
    // The gate only opens after finalization; before stop it does not exist yet, and nothing
    // here may ever read as an approval.
    expect((await gate.json()).decided).toBe(false);

    // LIVE PLANE — the SSE route authenticates the service-account HEADER directly; no
    // `POST /auth/stream-ticket` is involved (that route stays closed to machines by design).
    // The assertion is that the stream OPENS, which is the authorization fact; the events
    // themselves depend on a harness that this spec does not require.
    // Playwright's request context buffers the whole body, and an SSE body never ends —
    // so the OPEN is asserted on the response headers with a raw request that is torn down
    // the moment they arrive.
    const stream = await openSse(`/api/v1/consultations/${consultationId}/live-summary/stream`, {
      'X-Service-Account-Token': svcToken,
    });
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');

    // CASE NOTE — a real `ContextItem` write against a patient's consultation.
    const note = await request.post(`/api/v1/consultations/${consultationId}/context`, {
      headers: svcHeaders(svcToken),
      data: { type: 'CASE_NOTE', content: 'Patient reports a sore throat for three days.' },
    });
    expect(note.status(), await note.text()).toBe(201);

    // CONSULTATION-BOUND WORKFLOWS — opened by the owner decision of 2026-09-09.
    const workflows = await request.get(`/api/v1/consultations/${consultationId}/workflows`, { headers: svcHeaders(svcToken) });
    expect(workflows.status(), await workflows.text()).toBe(200);
    expect(Array.isArray((await workflows.json()).data)).toBe(true);

    // RECORDING STOP.
    const stopped = await request.post(`/api/v1/consultations/${consultationId}/recording/stop`, {
      headers: svcHeaders(svcToken),
      data: { persistSnapshot: false },
    });
    expect(stopped.status(), await stopped.text()).toBe(200);
    expect((await stopped.json()).recording).toBe(false);

    // THE FINALIZED NOTE — `svc:consultation:report:read`. Nothing has generated one in this
    // spec (that needs a live harness), so the honest assertion is that the route is REACHED:
    // 200 with a summary, or 404 "no summary has been generated yet". A 401/403 would be the
    // regression this test exists to catch.
    const latest = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: svcHeaders(svcToken) });
    expect([200, 404]).toContain(latest.status());
    if (latest.status() === 404) {
      expect((await latest.json()).message).toContain('No summary');
    }
  });

  // ── 4. The STT streaming session it OWNS ──────────────────────────────────

  test('creates, refreshes and closes a streaming session it owns', async ({ request }) => {
    const opened = await request.post('/api/v1/consultations/open', {
      headers: svcHeaders(svcToken),
      data: { patientId: patientId(), clinicianUserId: ARCAAI_DOCTOR, departmentId: GEN_ARCAAI },
    });
    expect(opened.status()).toBe(201);
    const consultationId = (await opened.json()).id as string;

    const created = await request.post('/api/v1/audio/transcription-jobs/stream/session', {
      headers: svcHeaders(svcToken),
      data: { consultationId, sampleRate: 16000 },
    });

    // 503 means apps/stt is not running in this environment. That is a TRANSPORT fact, not an
    // authorization one, and the two must not be conflated: a 401/403 here would be the
    // regression. When STT is up the session lifecycle below is the real assertion.
    expect([201, 503], await created.text()).toContain(created.status());
    test.skip(created.status() === 503, 'apps/stt is not running — the streaming-session lifecycle needs it');

    const session = await created.json();
    expect(session.sessionId).toBeTruthy();
    // The one-shot ticket is minted BY session create; a machine never calls
    // `POST /auth/stream-ticket`, which stays closed to it.
    expect(session.ticket).toBeTruthy();
    expect(session.wsUrl).toBe('/ws/stt/stream');

    // REFRESH — reaches `@TenantOwnedResource('StreamSession')`, whose owner check now resolves
    // the service account. Before TASK-933 this was a 404 on the account's OWN session.
    const refreshed = await request.post(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}/refresh-ticket`, {
      headers: svcHeaders(svcToken),
      data: {},
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    expect((await refreshed.json()).ticket).toBeTruthy();

    // A DIFFERENT principal must still 404 on the same session id.
    const foreign = await request.post(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}/refresh-ticket`, {
      headers: { Authorization: `Bearer ${tenantAdminJwt}`, 'Content-Type': 'application/json' },
      data: {},
    });
    expect(foreign.status()).toBe(404);

    // CLOSE — the same owner gate.
    const closed = await request.delete(`/api/v1/audio/transcription-jobs/stream/session/${session.sessionId}`, {
      headers: svcHeaders(svcToken),
    });
    expect(closed.status()).toBe(204);
  });

  // ── 5. The tenant boundary ────────────────────────────────────────────────

  test("another tenant's consultation is 404 on every verb, never 403", async ({ request }) => {
    const read = await request.get(`/api/v1/consultations/${CONSULTATION_GLOBAL}`, { headers: svcHeaders(svcToken) });
    expect(read.status()).toBe(404);

    const record = await request.post(`/api/v1/consultations/${CONSULTATION_GLOBAL}/recording/start`, {
      headers: svcHeaders(svcToken),
      data: {},
    });
    expect(record.status()).toBe(404);

    const note = await request.post(`/api/v1/consultations/${CONSULTATION_GLOBAL}/context`, {
      headers: svcHeaders(svcToken),
      data: { type: 'CASE_NOTE', content: 'should never land' },
    });
    expect(note.status()).toBe(404);

    const summary = await request.get(`/api/v1/consultations/${CONSULTATION_GLOBAL}/summary/latest`, { headers: svcHeaders(svcToken) });
    expect(summary.status()).toBe(404);
  });

  // ── 6. Deny-by-default is still the default ───────────────────────────────

  test('a consultation route this ticket did NOT open is still 403 for a machine', async ({ request }) => {
    // `GET /consultations/:id/context/shared` declares no `@RequiredSvcScopes`. The grant is
    // per-route and enumerated, not a blanket opening of the controller. (`GET :id/workflow`
    // used to be this spec's example of an ungranted route, but TASK-946 D8/OD-7 declared
    // `svc:consultation:session:read` on it, along with `:id/context`, `:id/context/case-notes`,
    // `:id/context/transcriptions`, `:id/named-entities`, `:id/timeline`, `:id/chain`, and
    // `svc:consultation:report:read` on `:id/summary`, `:id/documents/sections`,
    // `:id/documents/:documentKey/sections[/:sectionKey]` — the route manifest is the oracle.)
    const res = await request.get(`/api/v1/consultations/${CONSULTATION_GLOBAL}/context/shared`, { headers: svcHeaders(svcToken) });

    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe('This route does not accept service-account authentication');
  });

  test('POST /auth/stream-ticket stays closed to machines — a server-side client never needs it', async ({ request }) => {
    const res = await request.post('/api/v1/auth/stream-ticket', {
      headers: svcHeaders(svcToken),
      data: { scope: 'consultation_live_summary:whatever' },
    });

    expect([401, 403]).toContain(res.status());
  });
});
