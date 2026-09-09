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
 * ## Why this is gated, and on what
 *
 * It exercises apps/api + Postgres + Redis + the TEXT and NLP backends the live flush and the
 * finalizer both call + the harness worker + Temporal. A gate is what stops CI reporting a
 * fabricated pass when they are not wired.
 *
 * The gate is `HARNESS_E2E_API` — that substrate WITHOUT audio or STT. `HARNESS_E2E_FULL` is
 * still honoured so the sibling harness specs' one flag runs this too.
 *
 *     pnpm setup:test && pnpm test:up:api   # terminal 1
 *     HARNESS_E2E_API=1 npx dotenv -e .env.test -- npx playwright test task-932-finalize
 *
 * It runs as the seeded `arcaai_doctor`, who has a seeded DNA writing-style report — which is
 * what makes the DNA half assertable rather than assumed.
 *
 * ## What an API-only run can and cannot drive (measured 2026-09-09, TASK-932 lane H)
 *
 * This plane drives the realtime lane through CASE_NOTE context adds. Each one emits
 * `ContextAdded`, which `LiveDocumentationService.handleContextAdded` folds into
 * `session.contextNotes` and which nudges a flush — so `runFlush` runs the tenant's REAL
 * governing graph, with the notes in the generated prompt.
 *
 * It cannot supply a TRANSCRIPT, and the reason is worth recording so nobody re-attempts it:
 *
 *  * `POST /consultations/:id/context` with `type: 'TRANSCRIPT'` IS reachable by an
 *    authenticated doctor — `AddContextRequest.type` is the bare `ContextItemType` enum, the
 *    only gate is `verifyConsultationOwnership`, and `ContextService`'s `LIVE_CONTEXT_TYPES`
 *    already includes TRANSCRIPT, so the event fires. No authorization change would be needed.
 *  * But `LIVE_DOC_CONTEXT_TYPES` (`live-documentation.service.ts`) deliberately excludes it,
 *    on the documented ground that transcripts drive the session through `ingestSegment`.
 *  * And widening that filter would NOT help: `handleContextAdded` appends to
 *    `session.contextNotes`, never to `session.transcriptParts`.
 *  * `transcriptParts` has exactly ONE writer, `ingestSegment`, whose only caller is the STT
 *    result subscription in `attachSttStream` — the Redis stream `stt:result:{sessionId}` that
 *    the STT service writes. There is no HTTP door to it at all.
 *
 * The seeded ArcaAI graph is transcript-rooted through that value:
 * `n_asr` (transcript ← `pendingGraphTranscript`) → `n_ner` (`in` ← `n_asr.transcript`) →
 * `n_summary_new` / `n_summary_revisit` (`in` ← `n_ner.out`) → `n_finalize` (`in` ←
 * `n_summary_*.out`). With no audio, `pendingGraphTranscript` is `''`.
 *
 * So the assertions below are written to state what they actually observed. Where the realtime
 * chain produced nothing on this plane, the spec FAILS with that named — it never synthesises a
 * handoff record from persisted items and never posts a node's output on a node's behalf, both
 * of which would fabricate the very thing under test. The microphone journey
 * (`task-932-consultation-audio`, admin console, `chromium-audio`) is the run that supplies a
 * real transcript; this one is its API-plane complement, not its replacement.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { loginUser } from '../../../../tests/helpers';

const ARCAAI_TENANT_KEY = 'ARCAAI';
const ARCAAI_DOCTOR_USERNAME = 'arcaai_doctor';
const SEED_PASSWORD = 'password123';

/** ArcaAI's General Practice department — the scope `arcaai_doctor` is a member of. */
const GEN_DEPARTMENT_ID = '70000000-0000-0000-0001-000000000001';

/**
 * The substrate this needs, or nothing: see the header. `HARNESS_E2E_API` is the honest
 * requirement — apps/api + Postgres + Redis + TEXT + NLP + the harness worker + Temporal, no
 * audio and no STT. `HARNESS_E2E_FULL` is still honoured so the sibling harness specs' single
 * flag keeps running this one too.
 */
const RUN_API = !!process.env.HARNESS_E2E_API || !!process.env.HARNESS_E2E_FULL;

/** The finalize is a durable LLM call behind a live drain; 180s is the ticket's own bound. */
const FINALIZE_TIMEOUT_MS = 180_000;
/**
 * How long to wait for the LIVE lane to publish a first running note before stopping. One
 * realtime SOAP generation measured 14s idle and 20-52s under load on `hope-v2-dev`, so this is
 * a little over two of the slow ones. Coming back empty is not a failure here — it makes the
 * "not the live snapshot verbatim" identity check vacuous, which that test annotates.
 */
const LIVE_FLUSH_TIMEOUT_MS = 60_000;
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

/**
 * Poll `summary/latest` until a note exists, or the bound expires. Returns null on timeout.
 *
 * `timeoutMs` is a parameter because the two waits this spec performs are different questions
 * with different costs: "has the LIVE lane published anything yet" is one TEXT round trip and
 * is allowed to come back empty, while "has the DURABLE finalize landed" is the ticket's own
 * 180s bound. A fixed sleep answered neither — it was simply longer than one and shorter than
 * the other.
 */
async function waitForLatestSummary(
  request: APIRequestContext,
  token: string,
  consultationId: string,
  timeoutMs: number = FINALIZE_TIMEOUT_MS,
): Promise<LatestSummary | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: auth(token) });
    if (response.status() === 200) {
      const body = (await response.json()) as LatestSummary;
      if (body.content?.trim()) return body;
    }
    if (Date.now() + POLL_INTERVAL_MS >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

test.describe('TASK-932 R-16a — stop finalizes the consultation note', () => {
  test.skip(!RUN_API, 'requires TEXT + NLP + the harness worker + Temporal (no audio): set HARNESS_E2E_API=1');
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

    // Give the live lane a bounded window to flush at least once, so there is something to hand
    // off — polled rather than slept, so a fast stack does not pay for a slow one's worst case
    // and a slow one is not cut off at an arbitrary 15s. Coming back empty is a legitimate
    // outcome on this plane (see the header: no transcript roots the seeded graph's chain), so
    // this is a wait, never an assertion.
    const live = await waitForLatestSummary(request, doctorToken, consultationId, LIVE_FLUSH_TIMEOUT_MS);
    liveSnapshot = live?.content ?? null;

    const stopped = await request.post(`/api/v1/consultations/${consultationId}/recording/stop`, {
      headers: auth(doctorToken),
      data: { persistSnapshot: true },
    });
    expect(stopped.status(), 'POST :id/recording/stop').toBe(200);

    const summary = await waitForLatestSummary(request, doctorToken, consultationId);
    expect(
      summary,
      `no finalized note appeared within ${FINALIZE_TIMEOUT_MS}ms — the consultation is stuck with an empty final note. ` +
        'Check, in order: the harness worker is running and connected to Temporal; the run reached `n_finalize`; ' +
        'and whether the live handoff carried an `n_summary_*` output at all (the header explains why an API-only ' +
        'plane cannot root that chain in a transcript).',
    ).not.toBeNull();
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

    // A BOOLEAN either way: `true` means a redaction ran and replaced something, `false` means it
    // ran and found nothing to replace. `null` would mean the finalizer declared no redaction
    // contract at all, which the seeded `casenote-finalization` agent does declare — so `null`
    // here is the regression this asserts against.
    //
    // Since H-3 the source of that marker depends on what the clinician configured: with DNA
    // redaction rules the DETERMINISTIC engine ran before persist and the manifest names the
    // rules that fired; without them the finalizer's own self-report stands. Both are honest
    // provenance and both are a boolean — which is why this asserts the type, not the value.
    expect(typeof body.redactionApplied, 'SummaryMeta.redactionApplied must be recorded by the finalize').toBe('boolean');
    expect(body.modelName, 'the generating model must be recorded').toBeTruthy();

    // OD-6's forced review flag (`SummaryMeta.gateDecision = FLAG` when the deterministic
    // redaction cannot be confirmed) is deliberately NOT on this response, and neither is the
    // manifest: both are encrypted at rest and answer no question a clinician asks at the
    // bedside. Asserting them here would mean asserting `undefined`, so that behaviour is pinned
    // where it is observable instead — `test_task932_finalize_persist.py`,
    // `TestTheDeterministicRedaction`.
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
