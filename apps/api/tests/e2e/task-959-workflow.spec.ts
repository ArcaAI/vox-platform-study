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
 *      `harness:cpu:<sessionId>:<runId>:<activityId>:<attempt>`, whose
 *      `requestId` IS the run id — which is what makes "CPU time for this
 *      workflow" a single ledger query.
 *
 * Hop 2 is the gateway's, and this file proves it over HTTP by POSTing the
 * frozen §10.2 sample shape, exactly as the worker's flush does. Hop 1 is the
 * worker's own, and it is NOT provable on this stack: proving it means starting
 * a real run, which needs `apps/harness` serving the gateway AND a Temporal
 * worker on the TEST Temporal. Measured on this box: no service listens on the
 * harness port, the test Temporal (`hope-temporal-test`, host port 7333) has no
 * worker attached, and the one `python -m harness.temporal.worker` process
 * running belongs to the DEV stack — its cwd is the primary checkout and it
 * carries no `TEMPORAL_ADDRESS`, so it connects to `localhost:7233`, the dev
 * broker. A run started here would be accepted and never executed.
 *
 * So the run-triggered test SKIPS with that reason rather than asserting
 * something this environment cannot produce, and it is written so it runs
 * unchanged the day a worker is attached.
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
      // `requestId` IS the run id: "CPU time for this workflow" has to be one
      // query, and this is the column it runs on.
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
    // proves nothing about metering. Both are the same skip.
    test.skip(
      start.status() >= 500,
      `the harness dispatcher is unreachable from the gateway (${start.status()}) — no apps/harness on this stack, and the only Temporal worker running is the DEV stack's (cwd = the primary checkout, no TEMPORAL_ADDRESS, so it serves localhost:7233 and not the test broker on 7333)`,
    );
    expect(start.status(), await start.text()).toBe(202);
    const { runId } = (await start.json()) as { runId: string };

    const rows = await waitForLedgerRows(since, (row) => row.requestId === runId && row.capability === 'WORKFLOW', {
      label: 'run worker CPU',
      timeoutMs: 120_000,
      tenantId: TENANT_GLOBAL,
    });
    for (const row of rows) {
      expect(row.operation).toBe('workflow.step');
      expect(row.unit).toBe('CPU_SECOND');
      expect(row.attributesJson?.trigger).toBe('WORKFLOW_RUN');
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
