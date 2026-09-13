/**
 * TASK-959 §3.4 — the durable-function worker's own CPU, per run.
 *
 * ============================================================================
 * THE TWO HALVES, AND WHY ONLY ONE IS PROVABLE HERE
 * ============================================================================
 * A run's worker CPU reaches the ledger in two hops:
 *
 *   1. `ComputeMeteringInterceptor` in `hope-harness-worker` fair-shares
 *      `thread_time` across the activities in flight and buffers a sample per
 *      activity; the buffer is flushed through the existing `report_trajectory`
 *      client as `computeSamples[]` on `POST /internal/harness/trajectory`.
 *   2. `AgentTrajectoryService.recordSteps` turns each sample into one
 *      `WORKFLOW` / `CPU_SECOND` row keyed
 *      `harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>`.
 *
 * Hop 2 is the gateway's, and this file proves it over HTTP by POSTing the
 * frozen §10.2 sample shape, exactly as the worker's flush does. Hop 1 is the
 * worker's own, and proving it means starting a real run.
 *
 * ============================================================================
 * `sessionId` IS THE JOIN — NOT `runId`
 * ============================================================================
 * The two id columns on a sample are not interchangeable, and which one
 * answers "CPU time for THIS workflow" is the single fact this file has to get
 * right.
 *
 *   * `sessionId` is `workflow-interpreter-<HOPE run id>` — Temporal's
 *     `workflow_id`. `WorkflowRun` joins its steps on exactly this string
 *     (`workflow-run.prisma:10-20`), never on `AgentTrajectoryStep.runId`, so
 *     it is the run's identity across the ledger and the gateway's
 *     `getWorkflowRunCpuSeconds` sums on it.
 *   * `runId` is Temporal's per-EXECUTION id, and the worker sending it
 *     (`temporal/compute_metering.py:397`, `str(info.workflow_run_id)`) is
 *     DELIBERATE: it is the fourth member of the trajectory table's dedupe
 *     tuple `(tenantId, sessionId, runId, seq)`, which is what makes a
 *     continue-as-new or a replayed execution bill separately instead of
 *     colliding. It is not the HOPE run id and is not meant to be.
 *
 * So a run's rows are found by `sessionId`, and the run-triggered test below
 * matches on it. An earlier revision of this file matched `requestId === runId`
 * and read the resulting emptiness as a worker defect; that was the test
 * holding the wrong column, and `cpuSeconds: null` on a run that really burned
 * CPU was the gateway summing on `requestId` for the same reason. Both are
 * corrected. Do NOT "restore" a `requestId === runId` predicate here: it can
 * only ever match the hop-2 test's hand-supplied ids, never a real run's.
 *
 * Launching the harness and worker against the TEST stack needs four overrides
 * `.env.test` does not supply — `TEMPORAL_ADDRESS=localhost:7333` (it declares
 * none, so the launchers default to the DEV broker on 7233),
 * `HARNESS_API_BASE_URL=http://localhost:8968` (defaults to the dev gateway on
 * 8868), and `HARNESS_CLAIM_CHECK_STORE=s3` +
 * `HARNESS_CLAIM_CHECK_ENDPOINT_URL=http://localhost:9002` so the worker reads
 * back the claim-check blob the gateway wrote. The test MinIO also needs the
 * `harness-claim-check` bucket; without it the gateway threw `NoSuchBucket`
 * and the route answered a bare 500 long before any harness call.
 *
 * Hop 1 was unprovable when this file was written and is provable now
 * (TASK-957 lane D, 2026-09-13): `POST /workflows/:slug/runs` answers 202, a
 * run executes on the test broker, and `workflow.step` / `CPU_SECOND` rows
 * land with real quantities. The run-triggered test below no longer skips.
 *
 * It asserts the run is BILLED, not that it SUCCEEDS. A run that fails at a
 * node still occupied the worker, so it still owes CPU — and on this stack it
 * does fail, at `core.trigger`, because the payload below is not shaped to the
 * seeded workflow's declared context schema. That is deliberate: making the
 * payload valid would drag an LLM backend into a metering test.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'crypto';

import { SEEDED_USERS, loginUser } from '../../../../tests/helpers';
import { closeLedgerDb, isDecimalString, ledgerRowsSince, waitForLedgerRows, type LedgerRow } from './helpers/usage-ledger.helper';

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';
const WORKFLOW_SLUG = 'platform-default-summarization';

/**
 * The harness's own service token. `HarnessServiceTokenGuard` compares
 * `X-Service-Token` in constant time against `INTERNAL_ACCESS_TOKEN` or
 * `HARNESS_SERVICE_TOKEN` as the GATEWAY resolves them — which is Vault on this
 * stack — so a mismatch is a 401 the spec reports rather than works around.
 */
const SERVICE_TOKEN = process.env.INTERNAL_ACCESS_TOKEN ?? process.env.HARNESS_SERVICE_TOKEN ?? '';

let adminToken: string;
const bearer = () => ({ Authorization: `Bearer ${adminToken}`, 'X-Tenant-Id': TENANT_GLOBAL });

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: process.env.API_URL || 'http://localhost:8968/api/v1' });
  const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  if (!admin) throw new Error('TASK-959 workflow spec could not log in the seeded super admin');
  adminToken = admin.token;
  await request.dispose();
});

test.afterAll(async () => {
  await closeLedgerDb();
});

test.describe('TASK-959 §3.4 — the worker CPU flush becomes WORKFLOW / CPU_SECOND rows', () => {
  test('a computeSamples batch bills one row per activity, keyed on the run', async ({ request }) => {
    test.skip(SERVICE_TOKEN.length === 0, 'no INTERNAL_ACCESS_TOKEN / HARNESS_SERVICE_TOKEN in the environment to authenticate the harness intake');

    const sessionId = `task-959-wf-${randomUUID()}`;
    const runId = randomUUID();
    const since = new Date();

    const response = await request.post('/api/v1/internal/harness/trajectory', {
      headers: { 'X-Service-Token': SERVICE_TOKEN, 'Content-Type': 'application/json' },
      data: {
        // A compute-only POST: the worker legitimately sends one when a flush
        // window contained activities but no trajectory step.
        computeSamples: [
          {
            tenantId: TENANT_GLOBAL,
            sessionId,
            runId,
            activityId: 'activity-1',
            attempt: 1,
            activityType: 'core.agent',
            cpuMs: 1250.5,
            wallMs: 20_000,
            trigger: 'WORKFLOW_RUN',
          },
          {
            // A RETRY of the same activity: a second execution that really
            // burned CPU, so it keys differently and bills separately.
            tenantId: TENANT_GLOBAL,
            sessionId,
            runId,
            activityId: 'activity-1',
            attempt: 2,
            activityType: 'core.agent',
            cpuMs: 400,
            wallMs: 5_000,
            trigger: 'WORKFLOW_RUN',
          },
        ],
      },
    });
    test.skip(
      response.status() === 401 || response.status() === 403,
      `the gateway resolves the harness service token from its own secrets backend and rejected the environment's copy (${response.status()})`,
    );
    expect(response.status(), await response.text()).toBe(202);
    expect(((await response.json()) as { accepted?: number }).accepted).toBe(2);

    const rows = await waitForLedgerRows(since, (row) => row.sessionId === sessionId, {
      label: 'workflow worker CPU',
      minimum: 2,
      tenantId: TENANT_GLOBAL,
    });
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // The capability is what keeps a run's orchestration cost OFF the
      // inference total — it gets its own allowance and its own invoice line.
      expect(row.capability).toBe('WORKFLOW');
      expect(row.operation).toBe('workflow.step');
      expect(row.unit).toBe('CPU_SECOND');
      expect(row.provider, 'the durable worker is a self-hosted provider in its own right').toBe('harness');
      expect(row.deployment).toBe('SELF_HOSTED');
      // The intake stamps `requestId` from whatever the wire's `runId` field
      // carried — it transforms nothing — so this asserts FIDELITY, not that
      // `requestId` is the HOPE run id. It is not: a real worker sends
      // Temporal's execution id there (see the header), and this test can
      // assert equality only because it minted `runId` itself a few lines up.
      // The column a run is actually found by is `sessionId`.
      expect(row.requestId).toBe(runId);
      expect(row.attributesJson?.device).toBe('cpu');
      expect(row.attributesJson?.activityType).toBe('core.agent');
      expect(row.attributesJson?.trigger).toBe('WORKFLOW_RUN');
      expect(isDecimalString(row.quantity)).toBe(true);
    }

    // The attempt is IN the key, which is the whole reason a retry bills and a
    // redelivery of the same attempt does not.
    expect(new Set(rows.map((row) => row.idempotencyKey))).toEqual(
      new Set([`harness:cpu:${sessionId}:${runId}:activity-1:1:CPU_SECOND`, `harness:cpu:${sessionId}:${runId}:activity-1:2:CPU_SECOND`]),
    );
    // Milliseconds in, seconds out, to three decimals.
    expect(rows.map((row) => Number(row.quantity)).sort((a, b) => a - b)).toEqual([0.4, 1.251]);
  });

  test('a sample that burned no measurable CPU bills nothing', async ({ request }) => {
    test.skip(SERVICE_TOKEN.length === 0, 'no INTERNAL_ACCESS_TOKEN / HARNESS_SERVICE_TOKEN in the environment to authenticate the harness intake');

    const sessionId = `task-959-wf-zero-${randomUUID()}`;
    const since = new Date();

    const response = await request.post('/api/v1/internal/harness/trajectory', {
      headers: { 'X-Service-Token': SERVICE_TOKEN, 'Content-Type': 'application/json' },
      data: {
        computeSamples: [
          {
            tenantId: TENANT_GLOBAL,
            sessionId,
            runId: randomUUID(),
            activityId: 'activity-0',
            attempt: 1,
            activityType: 'core.noop',
            cpuMs: 0,
            wallMs: 12,
            trigger: 'WORKFLOW_RUN',
          },
        ],
      },
    });
    test.skip(
      response.status() === 401 || response.status() === 403,
      `the harness intake rejected the environment's service token (${response.status()})`,
    );
    expect(response.status()).toBe(202);

    // Zero CPU is "nothing happened", not "zero seconds of something": a row
    // saying nothing happened on every sub-millisecond activity would swamp the
    // figure it belongs to.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const rows = await ledgerRowsSince(since, { tenantId: TENANT_GLOBAL });
    expect(rows.filter((row: LedgerRow) => row.sessionId === sessionId)).toHaveLength(0);
  });
});

test.describe('TASK-959 §3.4 — an API-triggered run bills its own worker CPU', () => {
  test('a real run produces workflow.step rows under its run id', async ({ request }) => {
    test.setTimeout(180_000);
    const since = new Date();

    const start = await request.post(`/api/v1/workflows/${WORKFLOW_SLUG}/runs`, {
      headers: bearer(),
      data: { input: { text: 'Summarise: patient reports a mild headache.' } },
    });

    // A run the gateway cannot dispatch, or one no worker will ever pick up,
    // proves nothing about metering. Both are the same skip, and it no longer
    // fires: the route answered a bare 500 only while the test MinIO lacked the
    // `harness-claim-check` bucket, so the gateway's claim-check upload threw
    // `NoSuchBucket` before any harness call. With the bucket present it answers
    // a typed 503 while the harness is down, so a >=500 here now means a
    // genuinely unreachable dispatcher.
    test.skip(start.status() >= 500, `the gateway could not start the run (${start.status()}) — the harness dispatcher is unreachable`);
    expect(start.status(), await start.text()).toBe(202);
    const { runId } = (await start.json()) as { runId: string };

    // `sessionId`, not `requestId` — see the header. This is the same string
    // `WorkflowRun` joins its steps on and the same one the gateway sums
    // `cpuSeconds` over, so matching it here asserts the run's CPU is reachable
    // by the identity an operator actually holds. A `requestId === runId`
    // predicate would match only the hop-2 test's hand-supplied ids.
    const sessionId = `workflow-interpreter-${runId}`;
    const rows = await waitForLedgerRows(since, (row) => row.sessionId === sessionId && row.capability === 'WORKFLOW', {
      label: 'run worker CPU',
      timeoutMs: 120_000,
      tenantId: TENANT_GLOBAL,
    });
    for (const row of rows) {
      expect(row.operation).toBe('workflow.step');
      expect(row.unit).toBe('CPU_SECOND');
      expect(row.attributesJson?.trigger).toBe('WORKFLOW_RUN');
      // Pins the EXECUTION-id semantics: `requestId` carries Temporal's
      // per-execution id, which is the fourth member of the trajectory dedupe
      // tuple. It must be present — a sample with no execution id cannot
      // deduplicate — and must NOT be the HOPE run id, or a continue-as-new
      // would collide with the execution it replaced.
      expect(typeof row.requestId === 'string' && row.requestId.length > 0).toBe(true);
      expect(row.requestId).not.toBe(runId);
    }

    // And the figure surfaces on the run detail, which is where an operator
    // asks the question.
    const detail = await request.get(`/api/v1/admin/workflow-runs/${runId}`, { headers: bearer() });
    expect(detail.status()).toBe(200);
    const { cpuSeconds } = (await detail.json()) as { cpuSeconds: number | null };
    expect(typeof cpuSeconds).toBe('number');
    expect(cpuSeconds).toBeGreaterThan(0);
  });
});
