/**
 * TASK-959 §7 wave 1.8 / 2.5 / 3.4 — the consumption surface carries the new
 * measures.
 *
 * ============================================================================
 * WHAT THIS FILE PROVES
 * ============================================================================
 * "A metered unit nobody can see is not a fast win" (§7). Every wave of this
 * ticket ends at `GET admin/usage/{summary,timeseries}`, so this file checks
 * the three things that could each break silently:
 *
 *   1. the FIGURES EXIST and are typed as the contract says — fixed-point
 *      strings at six decimals, never JSON numbers, with `storage` null-able
 *      distinctly from zeroed (null = "no snapshot", zero = "stores nothing",
 *      and a consumer must be able to tell those apart);
 *   2. the SEPARATIONS hold — the durable worker's CPU is its own figure and is
 *      never added to the inference total, and only CLOUD/BYOK bytes count as
 *      third-party;
 *   3. the CHAIN actually carries a number from the wire to the screen. That is
 *      the one assertion that cannot be faked by a well-typed zero, so this
 *      file bills a known quantity through the real intake and watches the
 *      surface move by exactly that much.
 *
 * ============================================================================
 * HOW (3) IS MADE EXACT ON A SHARED DATABASE
 * ============================================================================
 * The suite runs fully parallel against one tenant, so "the total went up by
 * 4.257" is only true if nobody else billed in the meantime. The rollups are
 * keyed by UTC DAY, so this file bills into a day three weeks in the past —
 * a bucket no other spec can write to, because every other spec bills now — and
 * asserts the DELTA across its own post. Delta rather than absolute value, so a
 * re-run on the same day accumulates without turning the assertion red.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'crypto';

import { SEEDED_API_KEY_SERVICE_ACCOUNT, SEEDED_USERS, loginUser } from '../../../../tests/helpers';
import { closeLedgerDb, isDecimalString, waitForLedgerRows } from './helpers/usage-ledger.helper';

const TENANT_GLOBAL = '50000000-0000-0000-0000-000000000000';

/** Fixed-point, six decimals — the `Decimal(24,6)` the ledger columns are. */
const SIX_DP = /^-?\d+\.\d{6}$/;

let adminToken: string;
const bearer = () => ({ Authorization: `Bearer ${adminToken}` });

const currentPeriod = () => new Date().toISOString().slice(0, 7);

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({ baseURL: process.env.API_URL || 'http://localhost:8968/api/v1' });
  const admin = await loginUser(request, SEEDED_USERS.superAdmin.username, SEEDED_USERS.superAdmin.password);
  if (!admin) throw new Error('TASK-959 usage-surface spec could not log in the seeded super admin');
  adminToken = admin.token;
  await request.dispose();
});

test.afterAll(async () => {
  await closeLedgerDb();
});

interface ComputeSeconds {
  gpuSeconds: string;
  cpuSeconds: string;
}
interface ThirdPartyBytes {
  egressBytes: string;
  ingressBytes: string;
}
interface StorageSummary {
  mediaGb: string;
  textGb: string;
  claimCheckGb: string;
  totalGb: string;
  asOf: string;
}
interface UsageSummary {
  period: string;
  lines: Array<{ capability: string; unit: string; quantity: string; costMicros: string }>;
  computeSeconds: ComputeSeconds;
  workflowCpuSeconds: string;
  thirdPartyBytes: ThirdPartyBytes;
  storage: StorageSummary | null;
}
interface TimeseriesPoint {
  bucketStart: string;
  quantity: string;
  costMicros: string;
  computeSeconds: ComputeSeconds;
  workflowCpuSeconds: string;
  thirdPartyBytes: ThirdPartyBytes;
  storageGb: string | null;
}

test.describe('TASK-959 §1.8/2.5 — `admin/usage/summary` carries compute, bytes and storage', () => {
  test('the four figures are present and fixed-point', async ({ request }) => {
    const response = await request.get(`/api/v1/admin/usage/summary?period=${currentPeriod()}&tenantId=${TENANT_GLOBAL}`, { headers: bearer() });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as UsageSummary;

    expect(body.computeSeconds.gpuSeconds, 'GPU occupancy, 6 dp').toMatch(SIX_DP);
    expect(body.computeSeconds.cpuSeconds, 'CPU occupancy, 6 dp').toMatch(SIX_DP);
    expect(body.workflowCpuSeconds, "the durable worker's own CPU, its own figure").toMatch(SIX_DP);
    expect(body.thirdPartyBytes.egressBytes).toMatch(SIX_DP);
    expect(body.thirdPartyBytes.ingressBytes).toMatch(SIX_DP);

    // A JSON number would be an IEEE double, and at terabyte-second scale it
    // stops representing these exactly — which is why every one of them is a
    // string even though they all look like numbers.
    for (const value of [body.computeSeconds.gpuSeconds, body.workflowCpuSeconds, body.thirdPartyBytes.egressBytes]) {
      expect(typeof value).toBe('string');
    }
  });

  test('`storage` is a LEVEL or null — never a zeroed object standing in for "no snapshot"', async ({ request }) => {
    const response = await request.get(`/api/v1/admin/usage/summary?period=${currentPeriod()}&tenantId=${TENANT_GLOBAL}`, { headers: bearer() });
    expect(response.status()).toBe(200);
    const { storage } = (await response.json()) as UsageSummary;

    if (storage === null) {
      // The honest state on a stack whose nightly job has not run: "nobody
      // measured" is a reason to look at the job, and "the tenant stores
      // nothing" is not. Reported, not asserted away.
      test.info().annotations.push({
        type: 'note',
        description:
          'storage is null — no `storage.snapshot` rows in this period (the job is cron-scheduled at 02:15 UTC and this gateway restarts often).',
      });
      return;
    }

    for (const key of ['mediaGb', 'textGb', 'claimCheckGb', 'totalGb'] as const) {
      expect(storage[key], `${key} is fixed-point GB`).toMatch(SIX_DP);
    }
    expect(Number(storage.totalGb), 'the total is the sum of the three classes').toBeCloseTo(
      Number(storage.mediaGb) + Number(storage.textGb) + Number(storage.claimCheckGb),
      6,
    );
    expect(new Date(storage.asOf).toString()).not.toBe('Invalid Date');
  });

  test('the WORKFLOW capability is excluded from `computeSeconds` — it is never billed twice', async ({ request }) => {
    const response = await request.get(`/api/v1/admin/usage/summary?period=${currentPeriod()}&tenantId=${TENANT_GLOBAL}`, { headers: bearer() });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as UsageSummary;

    // Derived from `lines[]`, which is the same rollup the figures come from,
    // so the two cannot disagree without one of them being wrong.
    const inferenceCompute = body.lines
      .filter((line) => line.capability !== 'WORKFLOW' && ['GPU_SECOND', 'CPU_SECOND'].includes(line.unit))
      .reduce((sum, line) => sum + Number(line.quantity), 0);
    const workflowCompute = body.lines
      .filter((line) => line.capability === 'WORKFLOW' && line.unit === 'CPU_SECOND')
      .reduce((sum, line) => sum + Number(line.quantity), 0);

    expect(Number(body.computeSeconds.gpuSeconds) + Number(body.computeSeconds.cpuSeconds)).toBeCloseTo(inferenceCompute, 5);
    expect(Number(body.workflowCpuSeconds)).toBeCloseTo(workflowCompute, 5);
  });
});

test.describe('TASK-959 §1.8/2.5 — `admin/usage/timeseries` carries the same figures per bucket', () => {
  test('every point carries compute, worker CPU, third-party bytes and storage', async ({ request }) => {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 3_600_000);
    const response = await request.get(
      `/api/v1/admin/usage/timeseries?capability=STT&unit=AUDIO_SECOND&granularity=day&from=${from.toISOString()}&to=${to.toISOString()}&tenantId=${TENANT_GLOBAL}`,
      { headers: bearer() },
    );
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { points: TimeseriesPoint[] };

    test.skip(body.points.length === 0, 'no usage buckets in the last 7 days for STT/AUDIO_SECOND on this tenant');
    for (const point of body.points) {
      expect(point.computeSeconds.gpuSeconds).toMatch(SIX_DP);
      expect(point.computeSeconds.cpuSeconds).toMatch(SIX_DP);
      expect(point.workflowCpuSeconds).toMatch(SIX_DP);
      expect(point.thirdPartyBytes.egressBytes).toMatch(SIX_DP);
      expect(point.thirdPartyBytes.ingressBytes).toMatch(SIX_DP);
      // Null is its own answer here and means the bucket carries no snapshot
      // at all — for hourly granularity that is every hour but the one the job
      // ran in, so it must not be flattened to "0".
      if (point.storageGb !== null) expect(isDecimalString(point.storageGb)).toBe(true);
    }
  });
});

/**
 * The chain, end to end: intake → emitter → outbox → drainer → rollup →
 * the consumption surface.
 *
 * Everything else in this file would pass against a surface that reports a
 * well-typed zero forever. This is the test that would not.
 */
test.describe('TASK-959 — a billed second reaches the screen', () => {
  test('the day bucket moves by exactly what was billed into it', async ({ request }) => {
    // The drain is a 30s scheduled tick, plus the rollup write. Budget for two
    // ticks rather than tune the loop to one.
    test.setTimeout(180_000);

    const drain = await request.get('/api/v1/admin/settings/registry/metering.outbox.drain.enabled', { headers: bearer() });
    const drainEnabled = drain.status() === 200 && ((await drain.json()) as { value?: unknown }).value === true;
    test.skip(!drainEnabled, 'the usage-outbox drainer is disabled on this gateway — the rollups cannot move, so the surface cannot');

    // Three weeks back: a bucket every other spec bills far away from.
    const day = new Date(Date.now() - 21 * 24 * 3_600_000);
    day.setUTCHours(12, 0, 0, 0);
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

    const GPU_SECONDS = 4.257;
    const CLOUD_CPU_SECONDS = 2.5;
    const BYOK_CPU_SECONDS = 1.5;
    const EGRESS = 1024 + 512;
    const INGRESS = 2048 + 256;

    const bucket = async (): Promise<TimeseriesPoint | undefined> => {
      const response = await request.get(
        `/api/v1/admin/usage/timeseries?capability=STT&unit=GPU_SECOND&granularity=day&from=${dayStart.toISOString()}&to=${dayEnd.toISOString()}&tenantId=${TENANT_GLOBAL}`,
        { headers: bearer() },
      );
      expect(response.status(), await response.text()).toBe(200);
      return ((await response.json()) as { points: TimeseriesPoint[] }).points[0];
    };

    const before = await bucket();
    const beforeGpu = Number(before?.computeSeconds.gpuSeconds ?? 0);
    const beforeCpu = Number(before?.computeSeconds.cpuSeconds ?? 0);
    const beforeEgress = Number(before?.thirdPartyBytes.egressBytes ?? 0);
    const beforeIngress = Number(before?.thirdPartyBytes.ingressBytes ?? 0);

    const sessionId = `task-959-surface-${randomUUID()}`;
    const since = new Date();
    const post = await request.post('/api/v1/internal/stt/streaming/usage', {
      headers: { 'X-API-Key': SEEDED_API_KEY_SERVICE_ACCOUNT, 'Content-Type': 'application/json' },
      data: {
        session_id: sessionId,
        tenant_id: TENANT_GLOBAL,
        pipeline_id: 'task-959-surface',
        // `closed_at` IS the ledger event's `occurredAt`, which is what the
        // drainer buckets on — so this is what puts the rows in a quiet day.
        closed_at: day.toISOString(),
        audio_seconds: 30,
        session_seconds: 45,
        interrupted: false,
        segments: [
          {
            engine: 'faster_whisper',
            deployment: 'SELF_HOSTED',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: GPU_SECONDS,
            device: 'cuda',
          },
          {
            engine: 'azure-speech',
            deployment: 'CLOUD',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: CLOUD_CPU_SECONDS,
            device: 'cpu',
            request_bytes: 1024,
            response_bytes: 2048,
            byte_source: 'wire',
          },
          {
            engine: 'openai',
            deployment: 'BYOK',
            audio_seconds: 10,
            session_seconds: 15,
            processing_seconds: BYOK_CPU_SECONDS,
            device: 'cpu',
            request_bytes: 512,
            response_bytes: 256,
            byte_source: 'app',
          },
        ],
      },
    });
    expect(post.status(), await post.text()).toBe(201);
    // The rows exist in the outbox before there is any point waiting on a drain.
    await waitForLedgerRows(since, (row) => row.sessionId === sessionId, {
      label: 'surface teardown',
      minimum: 13,
      tenantId: TENANT_GLOBAL,
    });

    const deadline = Date.now() + 150_000;
    let point: TimeseriesPoint | undefined;
    for (;;) {
      point = await bucket();
      if (point && Number(point.computeSeconds.gpuSeconds) - beforeGpu >= GPU_SECONDS) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `the drained rollup never reached the usage surface: gpuSeconds went ${beforeGpu} → ${point?.computeSeconds.gpuSeconds ?? '(no bucket)'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    // EXACTLY the billed amounts, because this bucket is three weeks old and
    // nothing else writes to it.
    expect(Number(point.computeSeconds.gpuSeconds) - beforeGpu).toBeCloseTo(GPU_SECONDS, 5);
    expect(Number(point.computeSeconds.cpuSeconds) - beforeCpu).toBeCloseTo(CLOUD_CPU_SECONDS + BYOK_CPU_SECONDS, 5);
    expect(Number(point.thirdPartyBytes.egressBytes) - beforeEgress).toBeCloseTo(EGRESS, 5);
    expect(Number(point.thirdPartyBytes.ingressBytes) - beforeIngress).toBeCloseTo(INGRESS, 5);
    // The selected series is the GPU_SECOND one, and it must agree with the
    // companion figure computed from the same bucket.
    expect(Number(point.quantity)).toBeCloseTo(Number(point.computeSeconds.gpuSeconds), 5);
  });
});

test.describe('TASK-959 §3.4 — a run detail carries the worker CPU it consumed', () => {
  test('`cpuSeconds` is on the run detail, as a positive number', async ({ request }) => {
    const list = await request.get('/api/v1/admin/workflow-runs?limit=1', { headers: { ...bearer(), 'X-Tenant-Id': TENANT_GLOBAL } });
    expect(list.status(), await list.text()).toBe(200);
    const listed = (await list.json()) as { data?: Array<{ id?: string; runId?: string }> };
    const run = listed.data?.[0];
    test.skip(!run, 'no workflow run exists in this database to read — start one, or run task-959-workflow.spec.ts first');

    const runId = run!.runId ?? run!.id;
    const detail = await request.get(`/api/v1/admin/workflow-runs/${runId}`, { headers: { ...bearer(), 'X-Tenant-Id': TENANT_GLOBAL } });
    expect(detail.status(), await detail.text()).toBe(200);
    const body = (await detail.json()) as { cpuSeconds?: number | null };

    // STRICT ON PURPOSE: a real number, strictly positive. `cpuSeconds` is a
    // sum over the ledger rather than a column on the run, so a `null` here
    // does NOT mean "this run was free" — it means the sum found nothing, and
    // every run that reached a worker burned some CPU. Accepting `null` is what
    // let this pass for runs whose ledger held 0.001 / 0.037 / 0.4 / 1.251
    // CPU-seconds each (measured 2026-09-13, while the sum still filtered
    // `requestId`; it filters the run's `sessionId` now, which is the column
    // `WorkflowRun` actually joins on).
    expect(body).toHaveProperty('cpuSeconds');
    expect(typeof body.cpuSeconds).toBe('number');
    expect(body.cpuSeconds).toBeGreaterThan(0);
  });
});
