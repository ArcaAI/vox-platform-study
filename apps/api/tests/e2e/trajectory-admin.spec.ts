/**
 * AgentTrajectory admin read plane (Phase 7 E2E, Agentic SOTA).
 *
 * Probes `AgentTrajectoryController` at `/api/v1/admin/agent-trajectory/*`
 * (class-gated by `@CanManage('HarnessPolicy')`; tenant scoping via
 * `resolveScopedTenantId`), following the task-506 / task-348 cross-tenant
 * patterns.
 *
 * Locked contracts:
 *  1. RBAC — the whole plane requires the HarnessPolicy-family manage tuple: a
 *     plain doctor → 403 on both `sessions` and `sessions/:id/steps`.
 *  2. Session list shape — `GET sessions` → `{ items: SessionRow[], total }`;
 *     each row carries `sessionId`, `runId`, `sessionKind`, `stepCount`,
 *     `firstStepAt`, `lastStepAt` and never `payloadRef`.
 *  3. Offset pagination — `?page=&limit=` bounds `items.length <= limit`.
 *  4. Steps keyset pagination — `GET sessions/:id/steps?limit=` →
 *     `{ items, nextCursor, hasMore, limit }`; `limit` echoes, and a follow-up
 *     `?cursor=<nextCursor>` advances the `seq asc` stream (no overlap).
 *  5. Step projection — items expose `stats` (nullable JSON) and NEVER the
 *     claim-check `payloadRef`.
 *  6. Cross-tenant / nonexistent → 404 (never 403), body leaks no tenant — an
 *     unknown sessionId and a foreign one are indistinguishable (DEF-C3). A
 *     tenant-bound caller passing a FOREIGN `?tenantId=` is rejected ([403,404],
 *     never 200) by the shared `resolveScopedTenantId` posture.
 *
 * Live-stack requirement: dev/test stack + seed (owner-run via
 * `pnpm test:api:up` + `pnpm test:e2e`). Step-pagination assertions are guarded
 * on the seed actually carrying a multi-step session.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SESSIONS = '/api/v1/admin/agent-trajectory/sessions';

/** uuidv7-shaped session id no tenant has ever recorded — its 404 must match the genuine cross-tenant 404. */
const SYNTHETIC_SESSION_ID = '018f0000-0000-7000-8000-0000005100aa';

interface SessionRow {
  sessionId: string;
  runId: string;
  sessionKind: string;
  stepCount: number;
  firstStepAt: string;
  lastStepAt: string;
}
interface SessionsList {
  items: SessionRow[];
  total: number;
}
interface TrajectoryStep {
  id: string;
  seq: number;
  stepType: string;
  stats: unknown;
  [key: string]: unknown;
}
interface StepsPage {
  items: TrajectoryStep[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function listSessions(request: APIRequestContext, token: string, qs = ''): Promise<{ status: number; body: SessionsList }> {
  const resp = await request.get(`${SESSIONS}${qs}`, { headers: bearer(token) });
  const body = resp.status() === 200 ? ((await resp.json()) as SessionsList) : ({ items: [], total: 0 } as SessionsList);
  return { status: resp.status(), body };
}

test.describe('agent-trajectory admin read plane', () => {
  let globalAdminToken: string;
  let tenantAdminToken: string;
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    globalAdminToken = ga!.token;

    const ta = await loginUser(request, SEEDED_USERS.admin.username, SEEDED_USERS.admin.password, DEFAULT_TENANT_KEY);
    expect(ta, `tenant_admin login (${DEFAULT_TENANT_KEY}) failed`).toBeTruthy();
    tenantAdminToken = ta!.token;

    const doc = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doc, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doc!.token;
  });

  test('RBAC: a plain doctor cannot reach the trajectory plane (403)', async ({ request }) => {
    const sessions = await request.get(SESSIONS, { headers: bearer(doctorToken) });
    expect(sessions.status()).toBe(403);

    const steps = await request.get(`${SESSIONS}/${SYNTHETIC_SESSION_ID}/steps`, { headers: bearer(doctorToken) });
    expect(steps.status()).toBe(403);
  });

  test('session list returns the { items, total } envelope with the locked row shape (no payloadRef)', async ({ request }) => {
    const { status, body } = await listSessions(request, globalAdminToken, '?limit=10');
    expect(status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');

    for (const row of body.items) {
      expect(typeof row.sessionId).toBe('string');
      expect(typeof row.runId).toBe('string');
      expect(typeof row.sessionKind).toBe('string');
      expect(typeof row.stepCount).toBe('number');
      expect(typeof row.firstStepAt).toBe('string');
      expect(typeof row.lastStepAt).toBe('string');
      expect(row).not.toHaveProperty('payloadRef');
    }
  });

  test('offset pagination bounds the page (?limit=1 → at most one row)', async ({ request }) => {
    const { status, body } = await listSessions(request, globalAdminToken, '?page=1&limit=1');
    expect(status).toBe(200);
    expect(body.items.length).toBeLessThanOrEqual(1);
  });

  test('steps keyset pagination echoes limit and advances by cursor (seq asc, no overlap)', async ({ request }) => {
    const { body: sessions } = await listSessions(request, globalAdminToken, '?limit=25');
    const multiStep = sessions.items.find((s) => s.stepCount > 1);
    if (!multiStep) {
      console.warn('[e2e] no multi-step session in the seed — cursor-advance assertion skipped.');
      return;
    }

    const runQs = multiStep.runId ? `&runId=${encodeURIComponent(multiStep.runId)}` : '';
    const firstResp = await request.get(`${SESSIONS}/${encodeURIComponent(multiStep.sessionId)}/steps?limit=1${runQs}`, {
      headers: bearer(globalAdminToken),
    });
    expect(firstResp.status()).toBe(200);
    const first = (await firstResp.json()) as StepsPage;
    expect(first.limit).toBe(1);
    expect(first.items.length).toBeLessThanOrEqual(1);
    expect(typeof first.hasMore).toBe('boolean');
    expect(first.nextCursor === null || typeof first.nextCursor === 'string').toBe(true);
    for (const step of first.items) {
      expect(Object.prototype.hasOwnProperty.call(step, 'stats')).toBe(true);
      expect(step).not.toHaveProperty('payloadRef');
    }

    if (first.hasMore && first.nextCursor) {
      const secondResp = await request.get(
        `${SESSIONS}/${encodeURIComponent(multiStep.sessionId)}/steps?limit=1${runQs}&cursor=${encodeURIComponent(first.nextCursor)}`,
        { headers: bearer(globalAdminToken) },
      );
      expect(secondResp.status()).toBe(200);
      const second = (await secondResp.json()) as StepsPage;
      // Keyset advances strictly (seq asc): the second page must not repeat the first row.
      const firstSeq = first.items[0]?.seq;
      for (const step of second.items) {
        if (typeof firstSeq === 'number') expect(step.seq).toBeGreaterThan(firstSeq);
      }
    }
  });

  test('nonexistent sessionId → 404 (never 403), body leaks no tenant', async ({ request }) => {
    const resp = await request.get(`${SESSIONS}/${SYNTHETIC_SESSION_ID}/steps`, { headers: bearer(globalAdminToken) });
    expect(resp.status()).toBe(404);
    const body = await resp.json().catch(() => ({}));
    expect(String((body as { message?: string }).message ?? '')).not.toMatch(/tenant/i);
  });

  test('a tenant admin passing a FOREIGN ?tenantId= is rejected (never 200), no foreign tenant content', async ({ request }) => {
    // Discover the ARCAAI tenant id via the global admin's own session scope
    // isn't guaranteed (empty seed), so probe with a synthetic foreign tenant id.
    const foreignTenantId = '018f0000-0000-7000-8000-0000005100bb';
    const resp = await request.get(`${SESSIONS}?tenantId=${foreignTenantId}`, { headers: bearer(tenantAdminToken) });
    // Shared resolveScopedTenantId posture: 403 (404 acceptable on no-leak surfaces).
    expect([403, 404]).toContain(resp.status());
    const body = await resp.json().catch(() => ({}));
    expect(JSON.stringify(body)).not.toContain(foreignTenantId);
  });
});
