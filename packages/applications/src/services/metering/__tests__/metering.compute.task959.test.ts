/**
 * TASK-959 — the four new meters.
 *
 * `MeterUsage` is what the consumption screen and the entitlement checks read,
 * so a figure that is subtly wrong here is a figure a tenant is shown and a
 * platform admin plans capacity against.
 *
 * The two that are easy to get wrong, and are therefore pinned hardest:
 *
 *  - **`computeSeconds` and `workflowCpuSeconds` must not overlap.** The
 *    inference capabilities and `WORKFLOW` are disjoint by construction, so a
 *    workflow run's LLM seconds count once (under LLM) and its worker CPU
 *    counts once (under WORKFLOW).
 *  - **`storageGb` is a LEVEL, not a sum.** `STORAGE_GB_DAY` rows accumulate one
 *    per day; adding a month of them answers "GB-days consumed", which is what
 *    the INVOICE wants. "How much am I storing" is the latest snapshot alone,
 *    and summing the month would report roughly thirty times the truth.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCapability, AiUsageUnit, UsageMeterMetric } from '@arcaai/domains';

import { MeteringService } from '../metering.service';
import { currentMonthWindow } from '../metering-window';

const FIXED_NOW = new Date('2026-09-12T09:41:23.456Z');
const WINDOW = currentMonthWindow(FIXED_NOW);

const decimalLike = (value: number) => ({ toNumber: () => value });

/** Answer each rollup aggregate from a predicate over its own `where`, so the test reads as the query does. */
function rollupAnswering(answer: (where: Record<string, never>) => number) {
  return vi.fn((args: { where: Record<string, never> }) => Promise.resolve({ _sum: { quantitySum: decimalLike(answer(args.where)) } }));
}

function makeService(rollupAggregate: ReturnType<typeof rollupAnswering>, findFirst = vi.fn().mockResolvedValue(null)) {
  const baseClient = {
    consultation: { count: vi.fn().mockResolvedValue(0) },
    audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: 0 } }) },
    summaryMeta: { count: vi.fn().mockResolvedValue(0) },
    workflowRun: { count: vi.fn().mockResolvedValue(0) },
    aiUsageRollupDaily: { aggregate: rollupAggregate, findFirst },
    aiUsageEvent: { findMany: vi.fn().mockResolvedValue([]) },
    tenant: { findMany: vi.fn().mockResolvedValue([]) },
    tenantUsageMeter: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const appSettings = { getValueWithDefault: vi.fn((_k: string, fallback: unknown) => fallback) } as never;
  const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  return { service: new MeteringService(appSettings, scheduler, { baseClient } as never), baseClient };
}

/** True for the aggregate that asks for occupancy seconds over the inference capabilities. */
const isComputeQuery = (where: Record<string, never>) =>
  Array.isArray((where.unit as { in?: unknown[] })?.in) &&
  ((where.unit as { in: unknown[] }).in as unknown[]).includes(AiUsageUnit.GPU_SECOND) &&
  Array.isArray((where.capability as { in?: unknown[] })?.in);

const isWorkflowQuery = (where: Record<string, never>) => where.capability === AiCapability.WORKFLOW;

const isByteQuery = (where: Record<string, never>) =>
  Array.isArray((where.unit as { in?: unknown[] })?.in) && ((where.unit as { in: unknown[] }).in as unknown[]).includes(AiUsageUnit.EGRESS_BYTE);

const isStorageQuery = (where: Record<string, never>) => where.capability === AiCapability.STORAGE;

let aggregate: ReturnType<typeof rollupAnswering>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MeterUsage — compute seconds', () => {
  it('sums GPU and CPU seconds over the inference capabilities, excluding guardrail', async () => {
    aggregate = rollupAnswering((where) => (isComputeQuery(where) ? 4321.5 : 0));
    const { service } = makeService(aggregate);

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage.computeSeconds).toBe(4322);

    const where = aggregate.mock.calls.map(([args]) => args.where).find(isComputeQuery)!;
    expect(where.capability).toEqual({
      in: [AiCapability.STT, AiCapability.LLM, AiCapability.NLP, AiCapability.TTS, AiCapability.EMBEDDING],
    });
    expect(where.unit).toEqual({ in: [AiUsageUnit.GPU_SECOND, AiUsageUnit.CPU_SECOND] });
    expect(where.operation).toEqual({ notIn: ['guardrail.validate'] });
    expect(where.bucketStart).toEqual({ gte: WINDOW.periodStart, lt: WINDOW.periodEnd });
  });

  it('counts the durable worker’s CPU separately, under its own capability', async () => {
    aggregate = rollupAnswering((where) => (isWorkflowQuery(where) ? 89.4 : 0));
    const { service } = makeService(aggregate);

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage.workflowCpuSeconds).toBe(89);
    // Disjoint by construction: the inference sum never names WORKFLOW, so a
    // workflow run's LLM seconds and its worker CPU each count exactly once.
    expect(usage.computeSeconds).toBe(0);
    const workflowWhere = aggregate.mock.calls.map(([args]) => args.where).find(isWorkflowQuery)!;
    expect(workflowWhere.unit).toEqual({ in: [AiUsageUnit.CPU_SECOND] });
  });
});

describe('MeterUsage — third-party bytes', () => {
  it('sums both directions for cloud and BYOK legs only', async () => {
    aggregate = rollupAnswering((where) => (isByteQuery(where) ? 1_500_000 : 0));
    const { service } = makeService(aggregate);

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage.thirdPartyBytes).toBe(1_500_000);
    const where = aggregate.mock.calls.map(([args]) => args.where).find(isByteQuery)!;
    expect(where.unit).toEqual({ in: [AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE] });
    // A self-hosted server on the same byte-counting transport is counted in the
    // ledger and must NOT be counted here: LAN traffic to HOPE's own LM Studio
    // is not third-party consumption.
    expect(where.deployment).toEqual({ in: ['CLOUD', 'BYOK'] });
    expect(where.capability).toBeUndefined();
  });
});

describe('MeterUsage — storage is a level, not a sum', () => {
  it('reads the LATEST snapshot day and sums its classes', async () => {
    const latestDay = new Date('2026-09-11T00:00:00.000Z');
    const findFirst = vi.fn().mockResolvedValue({ bucketStart: latestDay });
    aggregate = rollupAnswering((where) => (isStorageQuery(where) ? 12.75 : 0));
    const { service } = makeService(aggregate, findFirst);

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    // Fractional on purpose: rounding to a whole GB would report 0 for every
    // tenant holding less than a gigabyte.
    expect(usage.storageGb).toBe(12.75);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', capability: AiCapability.STORAGE, unit: AiUsageUnit.STORAGE_GB_DAY }),
        orderBy: { bucketStart: 'desc' },
      }),
    );
    const where = aggregate.mock.calls.map(([args]) => args.where).find(isStorageQuery)!;
    expect(where.bucketStart).toEqual(latestDay);
  });

  it('answers 0 — and asks for no sum — when the snapshot job has never run in this window', async () => {
    aggregate = rollupAnswering(() => 999);
    const { service } = makeService(aggregate, vi.fn().mockResolvedValue(null));

    const usage = await service.getCurrentUsage('tenant-1', FIXED_NOW);

    expect(usage.storageGb).toBe(0);
    expect(aggregate.mock.calls.map(([args]) => args.where).find(isStorageQuery)).toBeUndefined();
  });
});

describe('reconcileTenant — the three new snapshots', () => {
  it('persists compute, workflow CPU and storage BYTES', async () => {
    aggregate = rollupAnswering((where) => {
      if (isComputeQuery(where)) return 4322;
      if (isWorkflowQuery(where)) return 89;
      if (isStorageQuery(where)) return 12.75;
      return 0;
    });
    const { service, baseClient } = makeService(aggregate, vi.fn().mockResolvedValue({ bucketStart: new Date('2026-09-11T00:00:00.000Z') }));

    await service.reconcileTenant('tenant-1', FIXED_NOW);

    const persisted = new Map(
      baseClient.tenantUsageMeter.upsert.mock.calls.map(([args]: [{ create: { metric: UsageMeterMetric; usedCount: bigint } }]) => [
        args.create.metric,
        args.create.usedCount,
      ]),
    );

    expect(persisted.get(UsageMeterMetric.COMPUTE_SECONDS)).toBe(4322n);
    expect(persisted.get(UsageMeterMetric.WORKFLOW_CPU_SECONDS)).toBe(89n);
    // The METER is bytes even though the UNIT is GB-days: a byte count is the
    // integer a BigInt column can hold exactly, and 12.75 GB is 12.75e9 bytes.
    expect(persisted.get(UsageMeterMetric.STORAGE_BYTES)).toBe(12_750_000_000n);
  });
});
