/**
 * TASK-932 R-16a — "when the clinician selects stop, it must finalize and redact the summary
 * based on the clinician's DNA writing style", end to end over HTTP.
 *
 * ## The defect this spec exists to keep closed
 *
 * Measured on the live dev stack, 2026-09-09. Interpreter workflow
 * `workflow-interpreter-01a082e8-df34-7553-8f7b-47136b0c754c`: `interpreter.core_agent` for the
 * seeded `n_finalize` node was scheduled with `bound_inputs: {}` and completed
 * `{"status":"DEGRADED","reason":"core.agent: nothing bound on `in`/`context` to generate from"}`.
 * 29 e2e consultations sat in `DRAINING`; not one had a `RAW_SUMMARY` / `MODIFIED_SUMMARY`
 * `ContextItem` or a `SummaryMeta` row. Three independent causes, all three now fixed:
 *
 *  1. the durable interpreter SKIPS every `realtime` node of a consultation-bound run and stored
 *     no output for it, so the `onEnd` finalizer had nothing to bind;
 *  2. the run is dispatched at consultation OPEN and the stage walk had no wait, so the finalizer
 *     ran a second after the consultation opened — before a word had been spoken;
 *  3. nothing in a `core` graph persisted the finalized note as the consultation's own.
 *
 * ## Why this is RUN_FULL-gated
 *
 * It exercises the whole substrate: apps/api + Postgres + Redis + the TEXT backend the live
 * flush and the finalizer both call + the harness worker + Temporal. A gate is what stops CI
 * reporting a fabricated pass when they are not wired; the flag is deliberately the SAME
 * `HARNESS_E2E_FULL` the sibling harness specs use.
 *
 *     pnpm setup:test && pnpm test:up:api   # terminal 1
 *     HARNESS_E2E_FULL=1 npx dotenv -e .env.test -- npx playwright test task-932-finalize
 *
 * It runs as the seeded `arcaai_doctor`, who has a seeded DNA writing-style report — which is
 * what makes the DNA half assertable rather than assumed.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { loginUser } from '../../../../tests/helpers';

const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_DOCTOR_USERNAME = 'arcaai_doctor';
const SEED_PASSWORD = 'password123';

/** ArcaAI's General Practice department — the scope `arcaai_doctor` is a member of. */
const GEN_DEPARTMENT_ID = '70000000-0000-0000-0001-000000000001';

/** The whole substrate, or nothing: see the header. */
const RUN_FULL = !!process.env.HARNESS_E2E_FULL;

/** The finalize is a durable LLM call behind a live drain; 180s is the ticket's own bound. */
const FINALIZE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface LatestSummary {
  id: string;
  content: string;
  structuredData?: { dnaStyleId?: string };
}

async function openConsultation(request: APIRequestContext, token: string): Promise<string> {
  const response = await request.post('/api/v1/consultations/open', {
    headers: auth(token),
    data: {
      patientId: `task932-finalize-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      departmentId: GEN_DEPARTMENT_ID,
      // §3.7 — the note's own language, independent of the STT language mode.
      language: 'en',
    },
  });
  expect([200, 201], 'POST /consultations/open').toContain(response.status());
  return (await response.json()).id as string;
}

async function addCaseNote(request: APIRequestContext, token: string, consultationId: string, content: string): Promise<void> {
  const response = await request.post(`/api/v1/consultations/${consultationId}/context`, {
    headers: auth(token),
    data: { type: 'CASE_NOTE', content },
  });
  expect([200, 201], 'POST /consultations/:id/context').toContain(response.status());
}

/** Poll `summary/latest` until a note exists, or the bound expires. Returns null on timeout. */
async function waitForLatestSummary(request: APIRequestContext, token: string, consultationId: string): Promise<LatestSummary | null> {
  const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: auth(token) });
    if (response.status() === 200) {
      const body = (await response.json()) as LatestSummary;
      if (body.content?.trim()) return body;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

test.describe('TASK-932 R-16a — stop finalizes the consultation note', () => {
  test.skip(!RUN_FULL, 'requires the full stack (TEXT + harness worker + Temporal): set HARNESS_E2E_FULL=1');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(FINALIZE_TIMEOUT_MS + 120_000);

  let doctorToken: string;
  let dnaReportId: string;
  let consultationId: string;
  let liveSnapshot: string | null = null;

  test.beforeAll(async ({ request }) => {
    const doctor = await loginUser(request, ARCAAI_DOCTOR_USERNAME, SEED_PASSWORD, ARCAAI_TENANT_KEY);
    expect(doctor, 'arcaai_doctor login failed — is the stack seeded?').toBeTruthy();
    doctorToken = doctor!.token;

    // The clinician's OWN report, read as that clinician. Looked up rather than hardcoded: the
    // assertion this spec makes is "the note was styled by THIS doctor's report", and a literal
    // would still pass if the resolution picked somebody else's.
    const style = await request.get('/api/v1/dna-writing-styles/my-style', { headers: auth(doctorToken) });
    expect(style.status(), 'arcaai_doctor must have a seeded DNA writing-style report').toBe(200);
    dnaReportId = (await style.json()).id as string;
    expect(dnaReportId, 'the report must carry an id').toBeTruthy();
  });

  test('a recorded consultation finalizes into a persisted note when the clinician stops', async ({ request }) => {
    consultationId = await openConsultation(request, doctorToken);

    // Two prior case notes: the finalizer's own instruction says it merges the running partial
    // summaries and the clinician's work notes, so both channels are exercised.
    await addCaseNote(request, doctorToken, consultationId, 'Known type 2 diabetes, on metformin 500 mg BD since March.');
    await addCaseNote(request, doctorToken, consultationId, 'Reports a dry cough for three days. No fever, no chest pain.');

    const started = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: auth(doctorToken), data: {} });
    expect(started.status(), 'POST :id/recording/start').toBe(200);

    // Two more context adds while RECORDING: `handleContextAdded` folds each into the live
    // session and nudges a flush, so the realtime lane produces a running note without needing
    // audio on this plane. Audio is the admin-console spec's job.
    await addCaseNote(request, doctorToken, consultationId, 'Examination: chest clear, afebrile, sats 98% on air.');
    await addCaseNote(request, doctorToken, consultationId, 'Impression: viral upper respiratory tract infection. Plan: fluids, review in 48 hours.');

    // Let the live lane flush at least once before stop, so there is something to hand off.
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const live = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: auth(doctorToken) });
    if (live.status() === 200) liveSnapshot = ((await live.json()) as LatestSummary).content ?? null;

    const stopped = await request.post(`/api/v1/consultations/${consultationId}/recording/stop`, {
      headers: auth(doctorToken),
      data: { persistSnapshot: true },
    });
    expect(stopped.status(), 'POST :id/recording/stop').toBe(200);

    const summary = await waitForLatestSummary(request, doctorToken, consultationId);
    expect(summary, `no finalized note appeared within ${FINALIZE_TIMEOUT_MS}ms — the consultation is stuck with an empty final note`).not.toBeNull();
    expect(summary!.content.trim().length, 'the finalized note must not be empty').toBeGreaterThan(0);
  });

  test('the finalized note is not the live snapshot verbatim — the finalizer actually ran', async ({ request }) => {
    const summary = await waitForLatestSummary(request, doctorToken, consultationId);
    expect(summary).not.toBeNull();
    if (liveSnapshot === null) {
      // The live lane published nothing this run (a TEXT outage), so there is no snapshot to
      // compare against. Reported rather than silently passed.
      test.info().annotations.push({ type: 'note', description: 'no live snapshot was captured before stop; the identity check is vacuous' });
      return;
    }
    expect(summary!.content, 'the finalized note is byte-identical to the live running note — nothing finalized it').not.toBe(liveSnapshot);
  });

  test('the note carries the clinician’s own DNA writing-style provenance', async ({ request }) => {
    const summary = await waitForLatestSummary(request, doctorToken, consultationId);
    expect(summary).not.toBeNull();

    // Resolved by the gateway at the live handoff, under the tenant AND doctor gate, and stamped
    // onto the note row — never supplied by the caller.
    expect(summary!.structuredData?.dnaStyleId, "the finalized note must name the clinician's own DNA report").toBe(dnaReportId);
  });

  test('the redaction marker is recorded on the note’s provenance', async ({ request }) => {
    const summary = await waitForLatestSummary(request, doctorToken, consultationId);
    expect(summary).not.toBeNull();

    const provenance = await request.get(`/api/v1/consultations/${consultationId}/summary/${summary!.id}/provenance`, { headers: auth(doctorToken) });
    expect(provenance.status(), 'GET :id/summary/:contextItemId/provenance').toBe(200);
    const body = await provenance.json();

    // A BOOLEAN either way: `true` means the redaction transform ran and replaced something,
    // `false` means it ran and found nothing to replace. `null` would mean the finalizer declared
    // no redaction contract at all, which the seeded `casenote-finalization` agent does declare —
    // so `null` here is the regression this asserts against.
    expect(typeof body.redactionApplied, 'SummaryMeta.redactionApplied must be recorded by the finalize').toBe('boolean');
    expect(body.modelName, 'the generating model must be recorded').toBeTruthy();
  });

  test('the consultation is not left stuck without a note', async ({ request }) => {
    const response = await request.get(`/api/v1/consultations/${consultationId}`, { headers: auth(doctorToken) });
    expect(response.status()).toBe(200);
    const consultation = await response.json();

    // `persist_draft` advances DRAINING -> PENDING_REVIEW, which is exactly the state the
    // graph's `core.humanReview` gate waits in while the clinician signs off. Still DRAINING with
    // no note is the defect state this whole ticket exists to remove.
    expect(['PENDING_REVIEW', 'DRAFT_PENDING_SENSORS', 'SIGNED'], `consultation stuck in ${consultation.status}`).toContain(consultation.status);
  });
});
