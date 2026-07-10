/**
 * TASK-330 Phase 1 — Clinical Documentation Harness gate e2e.
 *
 * Proves two safety properties of the harness gate adapter at the HTTP edge:
 *
 *   1. The HITL attestation gate cannot be bypassed — the ONLY path that can
 *      produce a SIGNED_NOTE is the authenticated `…/summary/:cid/approve`
 *      endpoint, and the harness's inbound write surface (which only ever sets
 *      PENDING_REVIEW / records WORM audit) is service-token-guarded, so an
 *      unauthenticated caller can neither forge a draft nor sign one.
 *   2. Provenance / citations + statuses surface — asserted by the FULL-loop
 *      block below.
 *
 * RUNNABLE-HERE vs BLOCKED:
 *   - The guard/gate assertions only need a live apps/api (same as the other
 *     specs in this folder) and run without seeded data.
 *   - The FULL loop (transcript → harness workflow → draft → provenance →
 *     approve → GATE_DECISION) additionally needs apps/harness + Temporal + SMR
 *     + NLP + Postgres + Redis. Those assertions live under the
 *     `HARNESS_E2E_FULL`-gated describe and are SKIPPED unless that env flag is
 *     set, so CI never reports a fabricated pass. See the TASK-330 README
 *     "Phase 1 … evidence / what ran vs blocked" note.
 *
 * Note: the gate is ALSO covered at the unit/integration layer — Lane E's
 * live-Postgres attestation-gate test and Lane I's time-skipping workflow tests
 * (gate wait_condition + approval signal + SLA escalation) already assert the
 * server-side gate logic; this spec adds the HTTP-surface non-bypass proof.
 */
import { test, expect } from '@playwright/test';
import { SEEDED_USERS } from '../../../../tests/helpers';

// The four inbound harness callback routes (service-to-service only). Effective
// paths carry the global `/api/v1` prefix + `@Controller('internal/harness')`.
const INTERNAL_HARNESS_BASE = '/api/v1/internal/harness/consultations/e2e-consult-1';

async function loginDoctor(request: any): Promise<string> {
  const response = await request.post('/api/v1/auth/login', {
    data: {
      username: SEEDED_USERS.doctor.username,
      password: SEEDED_USERS.doctor.password,
      tenantKey: '__GLOBAL__',
    },
  });
  expect(response.status(), 'doctor login failed').toBe(200);
  return (await response.json()).token as string;
}

test.describe('TASK-330 — inbound harness endpoints are service-token guarded', () => {
  test('POST entities without X-Service-Token is rejected with 401', async ({ request }) => {
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/entities`, {
      data: { tenantId: 't-1', contextItemId: 'tx-1', entities: [] },
    });
    expect(response.status(), 'entities must require a service token').toBe(401);
  });

  test('POST assemble without X-Service-Token is rejected with 401', async ({ request }) => {
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/assemble`, {
      data: { tenantId: 't-1' },
    });
    expect(response.status(), 'assemble must require a service token').toBe(401);
  });

  test('POST draft without X-Service-Token is rejected with 401', async ({ request }) => {
    // The draft endpoint is the one that flips a consultation to PENDING_REVIEW.
    // It MUST be unreachable without the shared service token so a draft (and its
    // sensor scores / citations) can never be forged by an external caller.
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/draft`, {
      data: { tenantId: 't-1', content: 'S: forged note' },
    });
    expect(response.status(), 'draft must require a service token').toBe(401);
  });

  test('POST gate-decision without X-Service-Token is rejected with 401', async ({ request }) => {
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/gate-decision`, {
      data: { tenantId: 't-1', decision: 'SIGNED', gateDecision: 'PASS' },
    });
    expect(response.status(), 'gate-decision must require a service token').toBe(401);
  });

  test('a wrong X-Service-Token is still rejected with 401 (fail-closed)', async ({ request }) => {
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/draft`, {
      headers: { 'X-Service-Token': 'definitely-not-the-secret' },
      data: { tenantId: 't-1', content: 'S: forged note' },
    });
    expect(response.status(), 'an invalid token must be rejected').toBe(401);
  });

  test('a safety-FLAG draft cannot be forged without a service token (401)', async ({ request }) => {
    // Phase 2: even a draft carrying a "flagged unsafe" verdict must arrive over
    // the service-token-guarded channel — an unauthenticated caller can neither
    // inject a draft NOR fabricate its safety verdict / gate decision.
    const response = await request.post(`${INTERNAL_HARNESS_BASE}/draft`, {
      data: {
        tenantId: 't-1',
        content: 'S: forged note',
        gateDecision: 'FLAG',
        guardrailDecisions: {
          safety: { decision: 'FLAG', unsafe: true, flaggedDimensions: ['violence'] },
        },
      },
    });
    expect(response.status(), 'a safety-FLAG draft must require a service token').toBe(401);
  });
});

test.describe('TASK-330 — the HITL signing gate is not bypassable', () => {
  test('POST approve without authentication is rejected with 401', async ({ request }) => {
    // The clinician approve endpoint is the SINGLE path that writes a SIGNED_NOTE
    // + ATTEST + flips status → SIGNED. It is JWT-guarded, so a SIGNED_NOTE can
    // never be produced anonymously.
    const response = await request.post('/api/v1/consultations/e2e-consult-1/summary/e2e-ctx-1/approve');
    expect(response.status(), 'approve must require authentication').toBe(401);
  });
});

// ===========================================================================
// FULL-LOOP assertions — require the whole stack. Skipped unless HARNESS_E2E_FULL
// is set (do not fabricate a pass when the loop cannot actually run here).
// ===========================================================================
const RUN_FULL = !!process.env.HARNESS_E2E_FULL;

test.describe('TASK-330 — full harness loop (gate not bypassable + provenance surfaced)', () => {
  test.skip(!RUN_FULL, 'requires apps/harness + Temporal + SMR + NLP + Postgres + Redis (set HARNESS_E2E_FULL=1)');

  let doctorToken: string;
  let consultationId: string;

  test.beforeAll(async ({ request }) => {
    doctorToken = await loginDoctor(request);
    // A seeded/created consultation with metadata.pipelineConfig.harnessEnabled=true
    // is required so TranscriptionCreated routes to the durable workflow.
    consultationId = process.env.HARNESS_E2E_CONSULTATION_ID ?? '';
    expect(consultationId, 'set HARNESS_E2E_CONSULTATION_ID to a harness-enabled consult').not.toBe('');
  });

  test('the harness draft surfaces as PENDING_REVIEW with provenance/citations, never auto-SIGNED', async ({ request }) => {
    const auth = { Authorization: `Bearer ${doctorToken}` };

    // The loop persists a RAW_SUMMARY draft + SummaryMeta (sensorScores +
    // citationsMap) and flips status → PENDING_REVIEW. It must NOT be SIGNED.
    const detail = await request.get(`/api/v1/consultations/${consultationId}`, { headers: auth });
    expect(detail.status()).toBe(200);
    const consult = await detail.json();
    expect(consult.status, 'auto-generation must stop at the human gate').toBe('PENDING_REVIEW');

    // The harness-produced RAW_SUMMARY draft must be retrievable for clinician
    // review. The list endpoint is `:id/summary` (singular). (sensorScores /
    // citationsMap are persisted on SummaryMeta and asserted at the
    // unit/integration layer; this endpoint returns the draft context items.)
    const summaries = await request.get(`/api/v1/consultations/${consultationId}/summary`, { headers: auth });
    expect(summaries.status()).toBe(200);
    const body = await summaries.json();
    const items = Array.isArray(body) ? body : (body.data ?? []);
    const draft = items.find?.((s: { type?: string }) => s.type === 'RAW_SUMMARY') ?? items;
    expect(draft, 'a harness draft must surface for clinician review').toBeTruthy();
  });

  test('only the approve path produces a SIGNED_NOTE + GATE_DECISION', async ({ request }) => {
    const auth = { Authorization: `Bearer ${doctorToken}` };
    const contextItemId = process.env.HARNESS_E2E_CONTEXT_ITEM_ID ?? '';
    expect(contextItemId, 'set HARNESS_E2E_CONTEXT_ITEM_ID to the draft ctx id').not.toBe('');

    const approve = await request.post(`/api/v1/consultations/${consultationId}/summary/${contextItemId}/approve`, { headers: auth });
    expect(approve.status(), 'authenticated approve must succeed').toBe(201);

    const detail = await request.get(`/api/v1/consultations/${consultationId}`, { headers: auth });
    expect((await detail.json()).status, 'consultation must be SIGNED after approve').toBe('SIGNED');
  });
});

// ===========================================================================
// Phase 2 — a SAFETY FLAG forces the note into review (never auto-approved).
//
// Deterministic by design: rather than relying on a model to emit unsafe content,
// this drives the service-token-guarded `…/draft` endpoint directly with a
// safety-FLAG verdict (gateDecision=FLAG + guardrailDecisions.safety.decision=FLAG)
// and asserts the consultation lands at PENDING_REVIEW — never auto-SIGNED. The
// ONLY path to SIGNED remains the JWT-guarded clinician approve endpoint (proven
// non-bypassable above), so a flagged note cannot be auto-approved.
//
// Requires a live apps/api + Postgres + the shared HARNESS_SERVICE_TOKEN + a
// seeded consultation (id + tenantId) in a pre-draft state. SKIPPED unless
// HARNESS_E2E_FULL + those env vars are set, so CI never reports a fabricated
// pass (mirrors the full-loop block's evidence policy).
// ===========================================================================
const SERVICE_TOKEN = process.env.HARNESS_SERVICE_TOKEN ?? '';
const FLAG_CONSULT_ID = process.env.HARNESS_E2E_CONSULTATION_ID ?? '';
const FLAG_TENANT_ID = process.env.HARNESS_E2E_TENANT_ID ?? '';

test.describe('TASK-330 Phase 2 — a safety FLAG forces review (never auto-approved)', () => {
  test.skip(
    !RUN_FULL || !SERVICE_TOKEN || !FLAG_CONSULT_ID || !FLAG_TENANT_ID,
    'requires apps/api + Postgres + HARNESS_SERVICE_TOKEN + HARNESS_E2E_CONSULTATION_ID + HARNESS_E2E_TENANT_ID (set HARNESS_E2E_FULL=1)',
  );

  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    doctorToken = await loginDoctor(request);
  });

  test('a safety-FLAG draft persists as PENDING_REVIEW and is never auto-SIGNED', async ({ request }) => {
    // 1) The harness persists a draft whose inferential safety screen FLAGGED it
    //    (gate decision FLAG + the safety guardrail-decision detail), over the
    //    service-token channel — the system-of-record write the loop performs.
    const draftRes = await request.post(`/api/v1/internal/harness/consultations/${FLAG_CONSULT_ID}/draft`, {
      headers: { 'X-Service-Token': SERVICE_TOKEN },
      data: {
        tenantId: FLAG_TENANT_ID,
        content: '{"subjective":"s","objective":"o","assessment":"a","plan":"p"}',
        gateDecision: 'FLAG',
        guardrailDecisions: {
          safety: {
            decision: 'FLAG',
            passed: false,
            unsafe: true,
            flaggedDimensions: ['violence'],
            dimensions: { violence: true, harm: false },
            model: 'granite-guardian-4.1-8b',
          },
          groundedness: { decision: 'PASS', passed: true },
        },
      },
    });
    expect(draftRes.status(), 'authenticated draft write must succeed').toBeLessThan(300);

    // 2) A FLAG must stop at the human gate — the note is forced into review and
    //    is NEVER auto-approved/auto-SIGNED.
    const auth = { Authorization: `Bearer ${doctorToken}` };
    const detail = await request.get(`/api/v1/consultations/${FLAG_CONSULT_ID}`, { headers: auth });
    expect(detail.status()).toBe(200);
    const status = (await detail.json()).status;
    expect(status, 'a FLAG draft must force review, not auto-approve').toBe('PENDING_REVIEW');
    expect(status, 'a FLAG draft must never be auto-SIGNED').not.toBe('SIGNED');
  });
});
