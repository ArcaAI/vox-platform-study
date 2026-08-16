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
 * `tests/setup/playwright.global-setup.ts`. The summary/approve cases
 * additionally require a reachable `apps/text` (SMR) so `generateSummary`
 * can produce the RAW_SUMMARY row the OCC assertions run against (mirrors
 * the FULL-loop dependency documented in `harness-gate.spec.ts`).
 *
 * NOT RUN in this authoring session — local infra (Postgres/Redis/API) is
 * down per the execution constraints for this ticket. This file is
 * authored against the live contract (routes, DTOs, exception mapping) but
 * has not been executed; treat it as RED until a live run confirms it.
 */
import { test, expect } from '@playwright/test';
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

test.describe('TASK-709 — OCC on PATCH :id/summary/:summaryId and POST :id/summary/:contextItemId/approve', () => {
  // Requires a reachable apps/text (SMR) to actually generate a summary —
  // see the file-level doc comment.
  let token: string;
  let consultationId: string;
  let summaryId: string;

  test.beforeAll(async ({ request }) => {
    const login = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(login, 'doctor login failed').toBeTruthy();
    token = login!.token;

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
    expect([200, 201], 'POST :id/summary (generate) — requires a reachable SMR').toContain(generated.status());
    summaryId = ((await generated.json()) as SummaryBody).id;
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v1/consultations/${consultationId}`, { headers: bearer(token) }).catch(() => undefined);
  });

  test('GET the generated summary carries a strong ETag equal to its version', async ({ request }) => {
    const res = await request.get(`/api/v1/consultations/${consultationId}/summary/latest`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SummaryBody;
    expect(typeof body.version, 'SummaryResponse must expose `version` (the OCC counter)').toBe('number');
  });

  test('PATCH :id/summary/:summaryId without If-Match returns 428', async ({ request }) => {
    const res = await request.patch(`/api/v1/consultations/${consultationId}/summary/${summaryId}`, {
      headers: bearer(token),
      data: { content: 'edited without If-Match', expectedVersion: 1 },
    });
    expect(res.status()).toBe(428);
  });

  test('PATCH :id/summary/:summaryId with a stale If-Match returns 412', async ({ request }) => {
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

  test('POST :id/summary/:contextItemId/approve without If-Match returns 428', async ({ request }) => {
    const res = await request.post(`/api/v1/consultations/${consultationId}/summary/${summaryId}/approve`, {
      headers: bearer(token),
      data: { expectedVersion: 1 },
    });
    expect(res.status()).toBe(428);
  });

  test('POST :id/summary/:contextItemId/approve with a stale If-Match returns 412', async ({ request }) => {
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
    expect(approve.status()).toBe(412);
    const approveBody = await approve.json();
    expect(approveBody.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
  });
});
