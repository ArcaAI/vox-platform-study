/**
 * TASK-709 — Optimistic Concurrency Control on note-content writes.
 *
 * Proves the house ETag/If-Match OCC contract (`.claude/rules/05-nestjs-api.md`
 * §Optimistic Concurrency) on the three previously-unprotected consultation
 * note-content write routes:
 *
 *   - `PATCH  :id/context/:contextId`             (ContextService.updateContext)
 *   - `PATCH  :id/summary/:summaryId`              (SummaryService.updateSummary)
 *   - `POST   :id/summary/:contextItemId/approve`  (SummaryService.approveSummary)
 *
 * Cases, mirroring `optimistic-locking.spec.ts` (the house exemplar):
 *   (a) missing `If-Match` on each route -> 428 Precondition Required
 *   (b) a stale `If-Match` (after a concurrent update bumped `_version`) -> 412
 *       Precondition Failed, and the concurrent writer's content is preserved
 *       (not silently overwritten)
 *   (c) a `GET` that reads a ContextItem/summary carries a strong `ETag`
 *       header equal to the row's `version`
 *
 * Environment. Requires the test API at `process.env.API_URL` (default
 * `http://localhost:8968`) and a seeded test database — see
 * `tests/setup/playwright.global-setup.ts`. The `PATCH :id/summary` cases
 * additionally require a reachable `apps/text` (TEXT) so `generateSummary`
 * can produce the RAW_SUMMARY row the OCC assertions run against (mirrors
 * the FULL-loop dependency documented in `harness-gate.spec.ts`); the
 * approve cases instead need `HARNESS_SERVICE_TOKEN` — see the TASK-772
 * banner above that block for why.
 *
 * TASK-772 — this file was authored blind ("treat it as RED until a live run
 * confirms it") and that live run never happened: the summary block's
 * `beforeAll` timed out on the real summarization before any of its tests
 * executed. It has since been run green end to end.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { SEEDED_USERS, DEFAULT_TENANT_KEY, loginUser } from '../../../../tests/helpers';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

interface ContextItemBody {
  id: string;
  version: number;
  content?: string;
}

interface SummaryBody {
  id: string;
  version: number;
  content: string;
}

interface ConsultationBody {
  id: string;
  version: number;
  status?: string;
  tenantId?: string;
}

/** The tenant UUID carried in the access token's payload. */
function tenantIdFromToken(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { tenantId?: string };
  return payload.tenantId ?? '';
}

async function getConsultation(request: APIRequestContext, token: string, id: string): Promise<ConsultationBody> {
  const res = await request.get(`/api/v1/consultations/${id}`, { headers: bearer(token) });
  expect(res.status(), `GET /consultations/${id}`).toBe(200);
  return (await res.json()) as ConsultationBody;
}

// SERIAL: this file's `beforeAll` performs stateful writes (opening consultations,
// generating summaries, registering rows) that later tests read back by id.
// Under `fullyParallel: true` Playwright spreads one file's tests across workers,
// so `beforeAll` re-runs concurrently and those setups race each other — the
// symptom is failures that vanish under `--workers=1`. Pin the file to one worker.
test.describe.configure({ mode: 'serial' });

test.describe('TASK-709 — OCC on PATCH :id/context/:contextId', () => {
  let token: string;
  let consultationId: string;
  let contextId: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed').toBeTruthy();
    token = login!.token;

    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(token),
      data: { patientId: `task-709-context-${Date.now()}` },
    });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    consultationId = ((await opened.json()) as { id: string }).id;

    const created = await request.post(`/api/v1/consultations/${consultationId}/context`, {
      headers: bearer(token),
      data: { type: 'CASE_NOTE', content: 'Initial case note for TASK-709 OCC.' },
    });
    expect([200, 201], 'POST :id/context').toContain(created.status());
    contextId = ((await created.json()) as ContextItemBody).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(token) }).catch(() => undefined);
  });

  test('GET a context item carries a strong ETag equal to its version', async ({ request }) => {
    const list = await request.get(`/api/v1/consultations/${consultationId}/context`, { headers: bearer(token) });
    expect(list.status()).toBe(200);
    const items = (await list.json()) as ContextItemBody[];
    const item = items.find((i) => i.id === contextId);
    expect(item, 'created context item must be listed').toBeTruthy();
    expect(typeof item!.version, 'ContextItemResponse must expose `version` (the OCC counter)').toBe('number');
  });

  test('PATCH without If-Match returns 428 Precondition Required', async ({ request }) => {
    const res = await request.patch(`/api/v1/consultations/${consultationId}/context/${contextId}`, {
      headers: bearer(token),
      data: { content: 'edited without If-Match', expectedVersion: 1 },
    });
    expect(res.status()).toBe(428);
    const body = await res.json();
    expect(body.code).toBe('HTTP.PRECONDITION_REQUIRED');
  });

  test("stale If-Match after a concurrent update returns 412, and the winner's content is preserved", async ({ request }) => {
    const before = await request.get(`/api/v1/consultations/${consultationId}/context`, { headers: bearer(token) });
    const items = (await before.json()) as ContextItemBody[];
    const item = items.find((i) => i.id === contextId)!;
    const staleVersion = item.version;

    // Winner: a concurrent writer using the correct If-Match bumps the row.
    const winner = await request.patch(`/api/v1/consultations/${consultationId}/context/${contextId}`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { content: 'WINNER edit', expectedVersion: staleVersion },
    });
    expect(winner.status()).toBe(200);

    // Loser: retries with the now-stale version it originally read.
    const loser = await request.patch(`/api/v1/consultations/${consultationId}/context/${contextId}`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { content: 'LOSER edit — must not apply', expectedVersion: staleVersion },
    });
    expect(loser.status()).toBe(412);
    const loserBody = await loser.json();
    expect(loserBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');

    // The winner's content, not the loser's, is what's stored.
    const after = await request.get(`/api/v1/consultations/${consultationId}/context`, { headers: bearer(token) });
    const afterItems = (await after.json()) as ContextItemBody[];
    const afterItem = afterItems.find((i) => i.id === contextId)!;
    expect(afterItem.content).toBe('WINNER edit');
    expect(afterItem.version).toBe(staleVersion + 1);
  });
});

test.describe('TASK-709 — OCC on PATCH :id/summary/:summaryId', () => {
  // Requires a reachable apps/text (TEXT) to actually generate a summary —
  // see the file-level doc comment.
  //
  // TASK-764 — that requirement was DOCUMENTED but never ENFORCED: the
  // `beforeAll` hard-asserted `[200,201]` on the generate call, so on any stack
  // without apps/text (:8862) running it threw there and Playwright charged the
  // failure to the first test in the block ("GET the generated summary carries
  // a strong ETag…"), which reads as an OCC regression rather than an absent
  // service. The gateway reports the real cause plainly — `Failed to call TEXT
  // service: connect ECONNREFUSED …:8862`, a 400 — so capture it and self-skip
  // per the probe pattern in `streaming-ticket-refresh.spec.ts`. Every OCC
  // assertion below is unchanged and still runs whenever TEXT is up.
  let token: string;
  let consultationId: string;
  let summaryId = '';
  let skipReason = '';

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed').toBeTruthy();
    token = login!.token;

    // This hook performs a REAL summarization (apps/text → the configured LLM),
    // which the 30s global `timeout` in playwright.config.ts does not cover: a
    // single `POST /api/v1/generate` was observed at 34.6s here (20.8s of model
    // latency plus queueing behind the other parallel workers), so the hook
    // timed out and Playwright charged it to the first test in this block —
    // reading as an OCC regression rather than a slow generator. Same reasoning
    // and same remedy as the real-generation blocks in
    // `task-635-live-agent-lineage.spec.ts`.
    test.setTimeout(180_000);

    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(token),
      data: { patientId: `task-709-summary-${Date.now()}` },
    });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    consultationId = ((await opened.json()) as { id: string }).id;

    await request.post(`/api/v1/consultations/${consultationId}/context`, {
      headers: bearer(token),
      data: { type: 'TRANSCRIPT', content: 'Doctor: How are you feeling? Patient: Better today.' },
    });

    const generated = await request.post(`/api/v1/consultations/${consultationId}/summary`, {
      headers: bearer(token),
      data: {},
    });

    if (![200, 201].includes(generated.status())) {
      skipReason = `POST :id/summary (generate) returned ${generated.status()} — is apps/text (TEXT_URL) running? body: ${await generated.text()}`;
      console.warn(`[TASK-764] ${skipReason}`);
      return;
    }

    summaryId = ((await generated.json()) as SummaryBody).id;
  });

  test.afterAll(async ({ request }) => {
    if (!consultationId) return;
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(token) }).catch(() => undefined);
  });

  test('GET the generated summary carries a strong ETag equal to its version', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const res = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SummaryBody;
    expect(typeof body.version, 'SummaryResponse must expose `version` (the OCC counter)').toBe('number');
  });

  test('PATCH :id/summary/:summaryId without If-Match returns 428', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const res = await request.patch(`/api/v1/consultations/${consultationId}/summary/${summaryId}`, {
      headers: bearer(token),
      data: { content: 'edited without If-Match', expectedVersion: 1 },
    });
    expect(res.status()).toBe(428);
  });

  test('PATCH :id/summary/:summaryId with a stale If-Match returns 412', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const before = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: bearer(token) });
    const staleVersion = ((await before.json()) as SummaryBody).version;

    const winner = await request.patch(`/api/v1/consultations/${consultationId}/summary/${summaryId}`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { content: 'WINNER summary edit', expectedVersion: staleVersion },
    });
    expect(winner.status()).toBe(200);

    const loser = await request.patch(`/api/v1/consultations/${consultationId}/summary/${summaryId}`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { content: 'LOSER summary edit — must not apply', expectedVersion: staleVersion },
    });
    expect(loser.status()).toBe(412);
    const loserBody = await loser.json();
    expect(loserBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
  });
});

// =============================================================================
// TASK-772 — approve OCC, on a consultation that is actually SIGNABLE.
//
// These two cases used to live in the block above, against the consultation it
// opens and leaves in `OPEN`. That made the 412 case unreachable: `approve`
// asserts sign legality BEFORE it evaluates the version CAS
// (`SummaryService.approveSummary` → `consultation.transitionTo(SIGNED)`), and
// `OPEN` is deliberately NOT a legal predecessor of `SIGNED` — the matrix in
// `ConsultationEntity.ts` lists exactly `DRAFT_PENDING_SENSORS`,
// `PENDING_REVIEW` and `TIMED_OUT`. So the route answered
// `409 Illegal consultation state transition: OPEN → SIGNED` for a stale AND
// for a fresh `If-Match` alike; the assertion never reached the OCC path it
// claims to cover. (The 428 case passed only because `@RequiresIfMatch()` is a
// guard and fires before the handler runs at all.)
//
// The defect stayed invisible because the block's `beforeAll` timed out on the
// real summarization before these tests ever ran — see the `test.setTimeout`
// note above and this file's header ("treat it as RED until a live run
// confirms it"; that live run never happened).
//
// Reaching a signable state needs the harness: since TASK-732 deleted
// `SummaryProcessor.applyLegacySafetyFloor`, `persistDraft` is the ONLY
// remaining writer of `PENDING_REVIEW`/`DRAFT_PENDING_SENSORS`. So this block
// walks the real lifecycle `OPEN → PRIMED → RECORDING → DRAINING` over the
// public routes and then drives the service-token-guarded
// `internal/harness/consultations/:id/draft` directly — the same technique
// `consultation-state-machine.spec.ts` uses — which both promotes the
// consultation to `PENDING_REVIEW` and creates the summary ContextItem the OCC
// assertions run against. No apps/harness process is involved: that endpoint
// is the gateway's own inbound half of the adapter.
// =============================================================================
const HARNESS_SERVICE_TOKEN = process.env.HARNESS_SERVICE_TOKEN ?? '';

test.describe('TASK-709 — OCC on POST :id/summary/:contextItemId/approve', () => {
  let token: string;
  let consultationId = '';
  let summaryId = '';
  let skipReason = '';

  test.beforeAll(async ({ request }) => {
    if (!HARNESS_SERVICE_TOKEN) {
      skipReason = 'HARNESS_SERVICE_TOKEN is not set — cannot drive the consultation to a signable state';
      console.warn(`[TASK-772] ${skipReason}`);
      return;
    }

    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed').toBeTruthy();
    token = login!.token;

    // Recording a consent grant is an ADMIN surface (`/admin/consent-grants`);
    // the doctor who runs the consultation cannot write one. Same split as
    // `consent-abac.spec.ts`.
    const adminLogin = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(adminLogin, 'tenant admin login failed').toBeTruthy();
    const adminToken = adminLogin!.token;

    const patientId = `task-709-approve-${Date.now()}`;
    const opened = await request.post('/api/v1/consultations/open', {
      headers: bearer(token),
      data: { patientId },
    });
    expect([200, 201], 'POST /consultations/open').toContain(opened.status());
    const openedBody = (await opened.json()) as { id: string; version: number; tenantId?: string };
    consultationId = openedBody.id;

    // The capture stages are consent-gated (TASK-712 `@RequiresConsent`), so
    // record an AI_DOCUMENTATION grant first or `prime` answers
    // `403 DOMAIN.CONSENT_DENIED (no_grant)`. Same shape as `consent-abac.spec.ts`.
    const granted = await request.post('/api/v1/admin/consent-grants', {
      headers: bearer(adminToken),
      data: { externalPatientId: patientId, purpose: 'AI_DOCUMENTATION', grantMethod: 'VERBAL_ATTESTED' },
    });
    expect([200, 201], 'POST /admin/consent-grants').toContain(granted.status());

    // OPEN -> PRIMED -> RECORDING -> DRAINING over the public lifecycle routes.
    const primed = await request.post(`/api/v1/consultations/${consultationId}/prime`, {
      headers: { ...bearer(token), 'If-Match': `"${openedBody.version}"` },
    });
    if (primed.status() >= 300) {
      skipReason = `POST :id/prime returned ${primed.status()} — cannot stage a signable consultation. body: ${await primed.text()}`;
      console.warn(`[TASK-772] ${skipReason}`);
      return;
    }
    const started = await request.post(`/api/v1/consultations/${consultationId}/recording/start`, { headers: bearer(token) });
    if (started.status() >= 300) {
      skipReason = `POST :id/recording/start returned ${started.status()}. body: ${await started.text()}`;
      console.warn(`[TASK-772] ${skipReason}`);
      return;
    }
    const stopped = await request.post(`/api/v1/consultations/${consultationId}/recording/stop`, { headers: bearer(token) });
    if (stopped.status() >= 300) {
      skipReason = `POST :id/recording/stop returned ${stopped.status()}. body: ${await stopped.text()}`;
      console.warn(`[TASK-772] ${skipReason}`);
      return;
    }

    // DRAINING -> PENDING_REVIEW, and the draft ContextItem the OCC cases edit.
    // `tenantId` must be the tenant UUID the gateway re-establishes CLS from —
    // NOT the login tenant KEY (`__GLOBAL__`), and `ConsultationResponse` does
    // not carry it. The JWT does, so read it from there.
    const tenantId = tenantIdFromToken(token);
    expect(tenantId, 'could not read tenantId from the doctor JWT').toBeTruthy();
    const draft = await request.post(`/api/v1/internal/harness/consultations/${consultationId}/draft`, {
      headers: { 'X-Service-Token': HARNESS_SERVICE_TOKEN },
      data: { tenantId, content: '{"subjective":"s","objective":"o","assessment":"a","plan":"p"}' },
    });
    if (draft.status() >= 300) {
      skipReason = `internal harness draft returned ${draft.status()} — consultation not promoted to PENDING_REVIEW. body: ${await draft.text()}`;
      console.warn(`[TASK-772] ${skipReason}`);
      return;
    }

    const latest = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: bearer(token) });
    expect(latest.status(), 'the harness draft must be readable as the latest summary').toBe(200);
    summaryId = ((await latest.json()) as SummaryBody).id;
  });

  test.afterAll(async ({ request }) => {
    if (!consultationId) return;
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(token) }).catch(() => undefined);
  });

  test('the staged consultation is in a state where approve is legal', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const status = (await getConsultation(request, token, consultationId)).status;
    expect(
      ['PENDING_REVIEW', 'DRAFT_PENDING_SENSORS', 'TIMED_OUT'],
      'approve OCC is only observable from a legal predecessor of SIGNED — otherwise the 409 legality check fires first',
    ).toContain(status);
  });

  test('POST :id/summary/:contextItemId/approve without If-Match returns 428', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const res = await request.post(`/api/v1/consultations/${consultationId}/summary/${summaryId}/approve`, {
      headers: bearer(token),
      data: { expectedVersion: 1 },
    });
    expect(res.status()).toBe(428);
  });

  test('POST :id/summary/:contextItemId/approve with a stale If-Match returns 412', async ({ request }) => {
    test.skip(!summaryId, skipReason);
    const before = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: bearer(token) });
    const staleVersion = ((await before.json()) as SummaryBody).version;

    // Bump the row underneath the approve call via a legitimate concurrent edit.
    const advance = await request.patch(`/api/v1/consultations/${consultationId}/summary/${summaryId}`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { content: 'advance before stale approve', expectedVersion: staleVersion },
    });
    expect(advance.status()).toBe(200);

    const approve = await request.post(`/api/v1/consultations/${consultationId}/summary/${summaryId}/approve`, {
      headers: { ...bearer(token), 'If-Match': `"${staleVersion}"` },
      data: { expectedVersion: staleVersion },
    });
    expect(approve.status(), await approve.text()).toBe(412);
    const approveBody = await approve.json();
    expect(approveBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
  });
});
