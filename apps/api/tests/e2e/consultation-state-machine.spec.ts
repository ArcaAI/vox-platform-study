/**
 * Session state machine, HTTP-surface e2e.
 *
 * NOT EXECUTED IN THIS PASS. Playwright's `globalSetup` runs
 * `prisma db push --force-reset`, which Prisma's CLI refuses when invoked by
 * an AI agent in this environment — this spec is authored and reviewed for
 * correctness against the shipped controller/service code, but no run
 * output can be pasted for it. Whoever picks this up next runs it with
 * `pnpm test:up:api` (terminal 1) then `pnpm test:e2e`.
 *
 * Follows `consultation-job-cross-tenant.spec.ts` for the tenant-fixture
 * shape (login via `tests/helpers`, `bearer()` header helper) and
 * `harness-gate.spec.ts` for the `RUN_FULL`-gated-live-service pattern.
 *
 * RUNNABLE-HERE vs RUN_FULL-gated:
 *   - Everything in the top-level `test.describe` blocks needs only a live
 *     apps/api + Postgres (no TEXT/NLP/harness/Temporal) — every consultation
 *     used is created fresh via `POST /consultations/open`, so these tests
 *     do not depend on seed data shape or ordering.
 *   - The full open -> prime -> recording -> draft -> approve -> close ->
 *     reopen walk (case 2) and the gate-SLA TIMED_OUT path (case 5) need a
 *     reachable text-generation backend (TEXT) and the harness's internal
 *     service-token callback respectively; both are gated behind
 *     `HARNESS_E2E_FULL` (+ `HARNESS_SERVICE_TOKEN` for case 5) so CI never
 *     reports a fabricated pass when those aren't wired up.
 *
 * Cases covered :
 *   1. POST :id/close on a never-recorded (OPEN) consultation -> rejected (409) — the A-13 repro.
 *   2. Full walk: OPEN -> PRIMED -> RECORDING -> DRAINING -> PENDING_REVIEW -> SIGNED (RUN_FULL).
 *   3. recording/start without prime: kill-switch OFF (default) -> 200 (logged, not blocked);
 *      kill-switch ON -> 409.
 *   4. close after SIGNED -> 200, status CLOSED_COMPLETE; reopen -> REOPENED (RUN_FULL, needs case 2's walk).
 *   5. Gate-SLA abandonment drives TIMED_OUT, visibly unsigned, notification recorded (RUN_FULL).
 *   6. TIMED_OUT -> SIGNED still commits (RUN_FULL, chained off case 5).
 * 7. PATCH :id with {"metadata":{"status":"SIGNED"}} -> response status unchanged ( fix, re-asserted).
 *   8. Cross-tenant POST :id/close / :id/prime -> 404, never 403.
 *   9. PATCH/POST on a transition route without If-Match -> 428; with a stale ETag -> 412.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Unique-enough patientId per test run so `getOrCreate` never collides with a prior run's row. */
function uniquePatientId(label: string): string {
  return `e2e-711-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function openConsultation(request: APIRequestContext, token: string, patientId: string): Promise<{ id: string; version: number }> {
  const res = await request.post('/api/v1/consultations/open', {
    headers: bearer(token),
    data: { patientId },
  });
  // Nest's default @Post() status is 201 Created; the sibling specs
  // (consent-abac.spec.ts, task-635-live-agent-lineage.spec.ts) already
  // accept both. This spec's original `.toBe(200)` was over-strict.
  expect([200, 201], 'POST /consultations/open must succeed').toContain(res.status());
  const body = await res.json();
  expect(typeof body.version, 'ConsultationResponse must carry version for If-Match construction').toBe('number');
  return { id: body.id as string, version: body.version as number };
}

async function getConsultation(request: APIRequestContext, token: string, id: string): Promise<{ status: string; version: number }> {
  const res = await request.get(`/api/v1/consultations/${id}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { status: body.status as string, version: body.version as number };
}

/**
 * `POST :id/prime` carries `@RequiresConsent(ConsentPurpose.AI_DOCUMENTATION)`
 * enforced by `PatientConsentGuard` — a global `APP_GUARD`
 * registered strictly BEFORE `RequiresIfMatchGuard` in `app.module.ts`, and
 * ON BY DEFAULT with no kill-switch (`ConsultationConsentService` denies
 * unconditionally when no `ConsentGrant` row exists — see its doc comment).
 * A freshly-generated `uniquePatientId()` has no grant (the seed only covers
 * EXTERNAL_TOOL_LOOKUP/STYLE_LEARNING/QUALITY_REVIEW for fixed demo
 * patients; AI_DOCUMENTATION is backfilled only for pre-existing rows), so
 * every `prime` call needs one recorded first or the consent guard 403s
 * before the If-Match/OCC guard is ever reached. Only a `manage:ConsentGrant`
 * holder (tenant admin, not a plain doctor — `tenant-full-access` policy)
 * can record it. Mirrors `consent-abac.spec.ts`'s `grant()` helper.
 */
async function grantAiDocumentationConsent(request: APIRequestContext, adminToken: string, externalPatientId: string): Promise<void> {
  const res = await request.post('/api/v1/admin/consent-grants', {
    headers: bearer(adminToken),
    data: { externalPatientId, purpose: 'AI_DOCUMENTATION', grantMethod: 'VERBAL_ATTESTED' },
  });
  expect([200, 201], 'POST /admin/consent-grants (AI_DOCUMENTATION)').toContain(res.status());
}

test.describe('session state machine (RUNNABLE-HERE, apps/api + Postgres only)', () => {
  let doctorToken: string;
  let _doctor2Token: string;
  let tenantAdminToken: string;
  let arcaaiSuperAdminToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token;

    const doctor2 = await loginUser(request, SEEDED_USERS.doctor2.username, SEEDED_USERS.doctor2.password, DEFAULT_TENANT_KEY);
    expect(doctor2, 'doctor2 login failed').toBeTruthy();
    _doctor2Token = doctor2!.token;

    const tenantAdmin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(tenantAdmin, 'tenant admin login failed').toBeTruthy();
    tenantAdminToken = tenantAdmin!.token;

    // super_admin re-logged with tenantKey=ARCAAI, mirroring
    // consultation-job-cross-tenant.spec.ts — binds the JWT's tenant claim
    // to ARCAAI so probes against a __GLOBAL__-owned consultation are
    // genuinely cross-tenant, not just cross-user.
    const arcaaiSuperAdmin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(arcaaiSuperAdmin, 'super_admin (ARCAAI) login failed').toBeTruthy();
    arcaaiSuperAdminToken = arcaaiSuperAdmin!.token;
  });

  // ── Case 1: the A-13 repro — closing a never-recorded consultation ──
  test('case 1: POST :id/close on a never-recorded (OPEN) consultation is rejected (409), not silently closed', async ({ request }) => {
    const { id, version } = await openConsultation(request, doctorToken, uniquePatientId('case1'));

    const res = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${version}"` },
    });

    // The matrix has no OPEN -> CLOSED_COMPLETE/CLOSED_INCOMPLETE edge —
    // ConsultationService.applyTransition maps the domain BusinessException
    // to 409, never silently succeeding the way the pre-711
    // metadata.status tracker did (A-13).
    expect(res.status(), 'closing a never-recorded consultation must be rejected').toBe(409);

    const after = await getConsultation(request, doctorToken, id);
    expect(after.status, 'status must remain OPEN — never silently closed').toBe('OPEN');
  });

  // ── Case 3: the one flagged precondition (kill-switch default OFF) ──
  test('case 3a: recording/start without a prior prime succeeds while the kill-switch is OFF (default)', async ({ request }) => {
    const patientId = uniquePatientId('case3a');
    const { id } = await openConsultation(request, doctorToken, patientId);
    // recording/start is ALSO consent-gated (same AI_DOCUMENTATION
    // purpose as prime) — see grantAiDocumentationConsent's doc comment.
    await grantAiDocumentationConsent(request, tenantAdminToken, patientId);

    const res = await request.post(`/api/v1/consultations/${id}/recording/start`, { headers: bearer(doctorToken) });

    // Default posture: the flag is OFF, so a legacy caller (no prime call)
    // keeps working — logged as a would-be violation, not rejected.
    // Nest's default @Post() status is 201 Created (no @HttpCode override on
    // this route) — see the openConsultation() comment above.
    expect([200, 201], 'recording/start without prime must succeed while the kill-switch is OFF').toContain(res.status());
    const after = await getConsultation(request, doctorToken, id);
    expect(after.status).toBe('RECORDING');
  });

  // ── Case 7: forgery containment, re-asserted now that Task 10 deletes the field ──
  test('case 7: PATCH :id with metadata.status is a no-op on the typed status column', async ({ request }) => {
    const { id, version } = await openConsultation(request, doctorToken, uniquePatientId('case7'));

    // phase 2: `PATCH /consultations/:id` now carries
    // `@RequiresIfMatch()` — it was the last unprotected write on an aggregate
    // whose every OTHER write (prime/close/reopen, context, summary) already
    // required the precondition. Without the header this request is a 428, so
    // the validator read from `open` is echoed here.
    const patchRes = await request.patch(`/api/v1/consultations/${id}`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${version}"` },
      data: { metadata: { status: 'SIGNED', note: 'forgery attempt' } },
    });
    expect(patchRes.status(), 'PATCH must succeed (metadata is a legitimate free-form field now)').toBe(200);
    const body = await patchRes.json();
    expect(body.status, 'the typed status column must be UNCHANGED by any metadata content').toBe('OPEN');
    expect(body.status).not.toBe('SIGNED');
  });

  // ── Case 8: 404-over-403 for the two new/changed lifecycle routes ──
  test('case 8: cross-tenant POST :id/close and :id/prime both 404, never 403', async ({ request }) => {
    // A __GLOBAL__-owned consultation, probed by a token bound to tenant ARCAAI.
    const { id, version } = await openConsultation(request, doctorToken, uniquePatientId('case8'));

    const closeRes = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...bearer(arcaaiSuperAdminToken), 'If-Match': `"${version}"` },
    });
    expect(closeRes.status(), 'cross-tenant close must 404 (never 403 — no existence leak)').toBe(404);

    const primeRes = await request.post(`/api/v1/consultations/${id}/prime`, {
      headers: { ...bearer(arcaaiSuperAdminToken), 'If-Match': `"${version}"` },
    });
    expect(primeRes.status(), 'cross-tenant prime must 404 (never 403 — no existence leak)').toBe(404);
  });

  // ── Case 9: OCC gate on the three new/changed transition routes ──
  test.describe('case 9: If-Match / ExpectedVersion OCC gate', () => {
    test('prime without If-Match -> 428; with a stale version -> 412; with the correct version -> 200', async ({ request }) => {
      const patientId = uniquePatientId('case9-prime');
      const { id, version } = await openConsultation(request, doctorToken, patientId);
      // prime is consent-gated ahead of the OCC guard — see
      // grantAiDocumentationConsent's doc comment.
      await grantAiDocumentationConsent(request, tenantAdminToken, patientId);

      const noHeader = await request.post(`/api/v1/consultations/${id}/prime`, { headers: bearer(doctorToken) });
      expect(noHeader.status(), 'prime without If-Match must 428').toBe(428);

      const stale = await request.post(`/api/v1/consultations/${id}/prime`, {
        headers: { ...bearer(doctorToken), 'If-Match': '"999"' },
      });
      expect(stale.status(), 'prime with a stale If-Match must 412').toBe(412);

      const ok = await request.post(`/api/v1/consultations/${id}/prime`, {
        headers: { ...bearer(doctorToken), 'If-Match': `"${version}"` },
      });
      // Nest default POST status (201), not an override — see openConsultation() comment.
      expect([200, 201], 'prime with the correct If-Match must succeed').toContain(ok.status());
      const body = await ok.json();
      expect(body.status).toBe('PRIMED');
      expect(body.version, 'a real (non-idempotent) transition must bump the version').toBe(version + 1);
    });

    test('close without If-Match -> 428', async ({ request }) => {
      const { id } = await openConsultation(request, doctorToken, uniquePatientId('case9-close'));
      const res = await request.post(`/api/v1/consultations/${id}/close`, { headers: bearer(doctorToken) });
      expect(res.status()).toBe(428);
    });

    test('reopen without If-Match -> 428', async ({ request }) => {
      const { id } = await openConsultation(request, doctorToken, uniquePatientId('case9-reopen'));
      const res = await request.post(`/api/v1/consultations/${id}/reopen`, { headers: bearer(doctorToken) });
      expect(res.status()).toBe(428);
    });
  });

  // Extra: idempotency — priming an already-PRIMED consultation is a no-op
  // (per transitionTo's self-transition rule), so the version must NOT bump.
  test('extra: priming an already-PRIMED consultation is idempotent (no version bump)', async ({ request }) => {
    const patientId = uniquePatientId('case-idem');
    const { id, version } = await openConsultation(request, doctorToken, patientId);
    await grantAiDocumentationConsent(request, tenantAdminToken, patientId);
    const first = await request.post(`/api/v1/consultations/${id}/prime`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${version}"` },
    });
    expect([200, 201], 'prime with the correct If-Match must succeed').toContain(first.status());
    const firstBody = await first.json();
    expect(firstBody.version).toBe(version + 1);

    // Second prime, using the NOW-current version — should no-op (still PRIMED, same version).
    const second = await request.post(`/api/v1/consultations/${id}/prime`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${firstBody.version}"` },
    });
    // Same POST route, same Nest-default status regardless of whether the
    // transition was a real change or a self-transition no-op.
    expect([200, 201], 'idempotent no-op still returns success, not a conflict').toContain(second.status());
    const secondBody = await second.json();
    expect(secondBody.status).toBe('PRIMED');
    expect(secondBody.version, 'a self-transition no-op must NOT bump the version').toBe(firstBody.version);
  });
});

// =============================================================================
// RUN_FULL-gated — needs a reachable text-generation backend (TEXT) for case 2/4,
// and the harness's internal X-Service-Token callback + HARNESS_SERVICE_TOKEN
// for case 5/6. SKIPPED unless HARNESS_E2E_FULL is set, so CI never reports a
// fabricated pass.
//
// TASK-869: this used to read `TASK711_E2E_FULL`, a SECOND flag doing the same
// job as `harness-gate.spec.ts`'s `HARNESS_E2E_FULL` — so a managed run that set
// one still skipped the other's tests. There is now exactly ONE switch, and
// `scripts/test-run.sh` sets it for every managed e2e run.
// =============================================================================
const RUN_FULL = Boolean(process.env.HARNESS_E2E_FULL);
const SERVICE_TOKEN = process.env.HARNESS_SERVICE_TOKEN ?? '';

test.describe('full lifecycle walk (RUN_FULL)', () => {
  test.skip(!RUN_FULL, 'requires a reachable TEXT/text backend; set HARNESS_E2E_FULL=1');

  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token;
  });

  // ── Case 2 + 4: OPEN -> PRIMED -> RECORDING -> DRAINING -> PENDING_REVIEW ->
  //    SIGNED -> CLOSED_COMPLETE -> REOPENED, asserted through GET :id after
  //    each step.
  test('case 2/4: the full walk transitions status correctly end to end', async ({ request }) => {
    const { id, version: v0 } = await openConsultation(request, doctorToken, uniquePatientId('case2'));
    expect((await getConsultation(request, doctorToken, id)).status).toBe('OPEN');

    const primeRes = await request.post(`/api/v1/consultations/${id}/prime`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${v0}"` },
    });
    expect(primeRes.status()).toBe(200);
    expect((await getConsultation(request, doctorToken, id)).status).toBe('PRIMED');

    const startRes = await request.post(`/api/v1/consultations/${id}/recording/start`, { headers: bearer(doctorToken) });
    expect(startRes.status()).toBe(200);
    expect((await getConsultation(request, doctorToken, id)).status).toBe('RECORDING');

    const stopRes = await request.post(`/api/v1/consultations/${id}/recording/stop`, { headers: bearer(doctorToken) });
    expect(stopRes.status()).toBe(200);
    expect((await getConsultation(request, doctorToken, id)).status).toBe('DRAINING');

    // Legacy (non-harness) generation: SummaryProcessor.applyLegacySafetyFloor
    // flips DRAINING -> PENDING_REVIEW as part of the async job. Poll briefly.
    const genRes = await request.post(`/api/v1/consultations/${id}/summary`, {
      headers: bearer(doctorToken),
      data: { transcription: 'Doctor: how are you feeling? Patient: better today.' },
    });
    expect(genRes.status(), 'generateSummary must succeed').toBeLessThan(300);
    const summary = await genRes.json();

    let pendingReview = false;
    for (let i = 0; i < 20 && !pendingReview; i++) {
      const cur = await getConsultation(request, doctorToken, id);
      if (cur.status === 'PENDING_REVIEW') pendingReview = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(pendingReview, 'consultation must reach PENDING_REVIEW after generation').toBe(true);

    const beforeApprove = await getConsultation(request, doctorToken, id);
    const approveRes = await request.post(`/api/v1/consultations/${id}/summary/${summary.id}/approve`, {
      headers: { ...bearer(doctorToken), 'If-Match': '"1"' },
      data: {},
    });
    expect(approveRes.status(), 'approve must succeed').toBe(200);
    expect((await getConsultation(request, doctorToken, id)).status).toBe('SIGNED');

    // Case 4: close after SIGNED -> CLOSED_COMPLETE; reopen -> REOPENED.
    const signed = await getConsultation(request, doctorToken, id);
    const closeRes = await request.post(`/api/v1/consultations/${id}/close`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${signed.version}"` },
    });
    expect(closeRes.status()).toBe(200);
    const closed = await getConsultation(request, doctorToken, id);
    expect(closed.status, 'a signed consultation closes to CLOSED_COMPLETE, not the superseded CLOSED').toBe('CLOSED_COMPLETE');

    const reopenRes = await request.post(`/api/v1/consultations/${id}/reopen`, {
      headers: { ...bearer(doctorToken), 'If-Match': `"${closed.version}"` },
    });
    expect(reopenRes.status()).toBe(200);
    expect((await getConsultation(request, doctorToken, id)).status).toBe('REOPENED');
    void beforeApprove; // referenced for readability of the walk; no additional assertion needed
  });
});

test.describe('gate SLA TIMED_OUT path (RUN_FULL, service-token)', () => {
  test.skip(!RUN_FULL || !SERVICE_TOKEN, 'requires HARNESS_SERVICE_TOKEN + HARNESS_E2E_FULL=1');

  let doctorToken: string;
  let tenantId: string;
  let consultationId: string;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doctor, 'doctor login failed').toBeTruthy();
    doctorToken = doctor!.token;

    const { id, version } = await openConsultation(request, doctorToken, uniquePatientId('case5'));
    consultationId = id;
    tenantId = DEFAULT_TENANT_KEY;

    // Drive it to PENDING_REVIEW so the gate-SLA escalation has a legal
    // predecessor to time out from
    await request.post(`/api/v1/consultations/${id}/prime`, { headers: { ...bearer(doctorToken), 'If-Match': `"${version}"` } });
    await request.post(`/api/v1/consultations/${id}/recording/start`, { headers: bearer(doctorToken) });
    await request.post(`/api/v1/consultations/${id}/recording/stop`, { headers: bearer(doctorToken) });
    const draftRes = await request.post(`/api/v1/internal/harness/consultations/${id}/draft`, {
      headers: { 'X-Service-Token': SERVICE_TOKEN },
      data: { tenantId, content: '{"subjective":"s","objective":"o","assessment":"a","plan":"p"}' },
    });
    expect(draftRes.status(), 'authenticated harness draft write must succeed').toBeLessThan(300);
  });

  // ── Case 5: terminal gate-SLA abandonment drives TIMED_OUT ──
  test('case 5: gate_sla_abandoned drives PENDING_REVIEW -> TIMED_OUT, visibly unsigned', async ({ request }) => {
    const escalateRes = await request.post(`/api/v1/internal/harness/consultations/${consultationId}/escalate`, {
      headers: { 'X-Service-Token': SERVICE_TOKEN },
      data: { tenantId, reason: 'gate_sla_abandoned' },
    });
    expect(escalateRes.status(), 'authenticated terminal escalation must succeed').toBeLessThan(300);

    const after = await getConsultation(request, doctorToken, consultationId);
    // Visibly unsigned: TIMED_OUT, never SIGNED — "the clock never signs".
    expect(after.status).toBe('TIMED_OUT');
    expect(after.status).not.toBe('SIGNED');
  });

  // ── Case 6: TIMED_OUT -> SIGNED still commits (a human can still rescue it) ──
  test('case 6: a clinician can still sign a TIMED_OUT consultation', async ({ request }) => {
    const timedOut = await getConsultation(request, doctorToken, consultationId);
    expect(timedOut.status, 'precondition: must already be TIMED_OUT from case 5').toBe('TIMED_OUT');

    const summariesRes = await request.get(`/api/v1/consultations/${consultationId}/summary`, { headers: bearer(doctorToken) });
    expect(summariesRes.status()).toBe(200);
    const summaries = await summariesRes.json();
    expect(summaries.length, 'the harness draft from beforeAll must have produced a summary').toBeGreaterThan(0);

    const approveRes = await request.post(`/api/v1/consultations/${consultationId}/summary/${summaries[0].id}/approve`, {
      headers: { ...bearer(doctorToken), 'If-Match': '"1"' },
      data: {},
    });
    expect(approveRes.status(), 'sign-off from TIMED_OUT must still succeed — the clock never signs, a human still can').toBe(200);
    expect((await getConsultation(request, doctorToken, consultationId)).status).toBe('SIGNED');
  });
});
