/**
 * GenerationStats surface probe (E2E, Agentic SOTA).
 *
 * AD-1 GenerationStats headline fields — `stopReason`, `ttftMs`,
 * `tokensPerSecond` — are parsed off the SMR response and PERSISTED onto
 * `SummaryMeta` (migration
 * `20260719000000_task_509_summary_meta_generation_stats`).
 *
 * ROUTE PROBE (why this spec asserts the trajectory contract, not a summary one):
 *  - `GET /consultations/:id/summary/:contextItemId/provenance`
 *    (`SummaryProvenanceResponse`) is the only summary-read plane that surfaces
 *    `SummaryMeta`, and it DELIBERATELY exposes only `modelName` + the sensor
 *    scores + `citationsMap` — it does NOT carry `stopReason`/`ttftMs`/
 *    `tokensPerSecond` as first-class fields (verified against the DTO).
 *  - NO dedicated gateway route returns the generation-stats headline fields
 *    directly, so this spec does NOT fabricate one.
 *  - The REAL, existing gateway contract that carries GenerationStats is the
 * trajectory read plane: `AgentTrajectoryStepResponse.stats`
 *    (`JsonValue | null`, documented "AD-1 GenerationStats on LLM_CALL steps")
 *    via `GET /admin/agent-trajectory/sessions/:sessionId/steps`. The console's
 *    AI-Operations Metrics screen composes exactly this (sessions → steps with
 *    GenerationStats — see apps/admin-console/.../ai-operations-metrics/api/client.ts).
 *
 * Locked contracts this spec probes:
 *  1. The trajectory step read plane exposes an optional, nullable `stats` JSON
 *     blob on step items — the gateway surface for AD-1 GenerationStats — and
 *     NEVER the claim-check `payloadRef`.
 *  2. When a populated LLM_CALL step exists, its `stats` is an object; any of
 *     the AD-1 headline keys present (`stopReason`/`ttftMs`/`tokensPerSecond`)
 *     carry their locked primitive types.
 *  3. `@CanManage('HarnessPolicy')` gates the plane: a plain doctor → 403.
 *
 * Live-stack requirement: dev/test stack + seed. This is an owner-run artifact
 * (`pnpm test:api:up` + `pnpm test:e2e`); the seed may or may not carry recorded
 * LLM_CALL steps, so the populated-stats assertions are guarded on presence.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { DEFAULT_TENANT_KEY, SEEDED_USERS, loginUser } from '../../../../tests/helpers';

const SESSIONS = '/api/v1/admin/agent-trajectory/sessions';

interface TrajectoryStep {
  id: string;
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
interface SessionRow {
  sessionId: string;
  runId: string;
  sessionKind: string;
}
interface SessionsList {
  items: SessionRow[];
  total: number;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function firstStepsPage(request: APIRequestContext, token: string, sessionId: string, runId: string): Promise<StepsPage> {
  const qs = `?limit=5${runId ? `&runId=${encodeURIComponent(runId)}` : ''}`;
  const resp = await request.get(`${SESSIONS}/${encodeURIComponent(sessionId)}/steps${qs}`, { headers: bearer(token) });
  expect(resp.status(), `list steps for ${sessionId}`).toBe(200);
  return (await resp.json()) as StepsPage;
}

test.describe('GenerationStats surfaces via the trajectory step `stats` blob', () => {
  let globalAdminToken: string;
  let doctorToken: string;

  test.beforeAll(async ({ request }) => {
    const ga = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password, 'ARCAAI');
    expect(ga, 'global admin login (ARCAAI) failed — is the stack seeded?').toBeTruthy();
    globalAdminToken = ga!.token;

    const doc = await loginUser(request, SEEDED_USERS.doctor.username, SEEDED_USERS.doctor.password, DEFAULT_TENANT_KEY);
    expect(doc, 'doctor login (__GLOBAL__) failed').toBeTruthy();
    doctorToken = doc!.token;
  });

  test('the trajectory read plane is HarnessPolicy-gated (a plain doctor → 403)', async ({ request }) => {
    const resp = await request.get(SESSIONS, { headers: bearer(doctorToken) });
    expect(resp.status()).toBe(403);
  });

  test('step items expose an optional nullable `stats` blob (AD-1 GenerationStats surface) and never `payloadRef`', async ({ request }) => {
    const sessionsResp = await request.get(`${SESSIONS}?limit=10`, { headers: bearer(globalAdminToken) });
    expect(sessionsResp.status(), 'list sessions').toBe(200);
    const sessions = (await sessionsResp.json()) as SessionsList;
    expect(Array.isArray(sessions.items), 'sessions envelope carries items[]').toBe(true);

    let inspectedStep = false;
    let inspectedGenerationStats = false;

    for (const session of sessions.items) {
      const page = await firstStepsPage(request, globalAdminToken, session.sessionId, session.runId);
      expect(Array.isArray(page.items)).toBe(true);

      for (const step of page.items) {
        inspectedStep = true;
        // Contract 1: `stats` is always a declared property on the projection
        // (nullable JSON), and the encrypted `payloadRef` is never surfaced.
        expect(Object.prototype.hasOwnProperty.call(step, 'stats'), 'step projection declares `stats`').toBe(true);
        expect(step).not.toHaveProperty('payloadRef');

        // Contract 2: when an LLM_CALL step carries populated stats, it is the
        // AD-1 GenerationStats object; assert the headline field types when present.
        if (step.stepType === 'LLM_CALL' && step.stats !== null && step.stats !== undefined) {
          inspectedGenerationStats = true;
          expect(typeof step.stats, 'GenerationStats is a JSON object').toBe('object');
          const stats = step.stats as Record<string, unknown>;
          if ('stopReason' in stats && stats.stopReason !== null) expect(typeof stats.stopReason).toBe('string');
          if ('ttftMs' in stats && stats.ttftMs !== null) expect(typeof stats.ttftMs).toBe('number');
          if ('tokensPerSecond' in stats && stats.tokensPerSecond !== null) expect(typeof stats.tokensPerSecond).toBe('number');
        }
      }
      if (inspectedGenerationStats) break;
    }

    if (!inspectedStep) {
      // Owner-run note: an empty trajectory seed still proves the envelope
      // contract above; there are simply no step rows to inspect.
      console.warn('[e2e] no trajectory steps in the seed — populated GenerationStats assertions skipped.');
    }
  });
});
