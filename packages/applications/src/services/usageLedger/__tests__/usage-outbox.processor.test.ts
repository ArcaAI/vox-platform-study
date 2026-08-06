/**
 * The BullMQ tick: processor delegation and scheduler registration.
 *
 * Thin by design — all the money logic lives in the drainer. What is asserted
 * here is the wiring that decides whether the drainer ever runs at all, and the
 * boot posture (an unreachable Redis must not stop the API).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageOutboxProcessor, UsageOutboxScheduler } from '../usage-outbox.processor';
import { DRAIN_DEFAULTS, USAGE_OUTBOX_DRAIN_JOB } from '../usage-ledger.constants';

const mockDrainer = { drainBatch: vi.fn() };
const mockQueue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn() };
const mockAppSettings = { getValueWithDefault: vi.fn() };

function settings(overrides: Record<string, unknown> = {}) {
  mockAppSettings.getValueWithDefault.mockImplementation((key: string, fallback: unknown) => (key in overrides ? overrides[key] : fallback));
}

describe('UsageOutboxProcessor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates the tick to the drainer and returns its report', async () => {
    const report = { rows: 3, inserted: 3, skipped: 0, failed: 0 };
    mockDrainer.drainBatch.mockResolvedValue(report);

    const processor = new UsageOutboxProcessor(mockDrainer as never);
    expect(await processor.process({ id: 'job-1' } as never)).toBe(report);
    // The job carries no payload: each tick claims whatever is due.
    expect(mockDrainer.drainBatch).toHaveBeenCalledWith();
  });
});

describe('UsageOutboxScheduler', () => {
  let scheduler: UsageOutboxScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    settings();
    scheduler = new UsageOutboxScheduler(mockQueue as never, mockAppSettings as never);
  });

  it('drains by default — a ledger nobody drains is worse than no ledger', () => {
    expect(scheduler.getConfig()).toEqual({ enabled: true, intervalSeconds: DRAIN_DEFAULTS.intervalSeconds });
  });

  it('registers ONE repeating scheduler entry so N replicas do not run N sweeps', async () => {
    await scheduler.onModuleInit();

    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      USAGE_OUTBOX_DRAIN_JOB,
      { every: DRAIN_DEFAULTS.intervalSeconds * 1000 },
      expect.objectContaining({ name: USAGE_OUTBOX_DRAIN_JOB }),
    );
  });

  it('does not re-register when the interval has not changed', async () => {
    await scheduler.onModuleInit();
    await scheduler.syncSchedulerFromConfig();
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
  });

  it('re-registers when settings change the interval', async () => {
    await scheduler.onModuleInit();
    settings({ 'metering.outbox.drain.intervalSeconds': 5 });
    await scheduler.syncSchedulerFromConfig();

    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockQueue.upsertJobScheduler.mock.calls[1][1]).toEqual({ every: 5000 });
  });

  it('removes the scheduler when drainage is turned off', async () => {
    settings({ 'metering.outbox.drain.enabled': false });
    await scheduler.onModuleInit();

    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith(USAGE_OUTBOX_DRAIN_JOB);
    expect(mockQueue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('ignores a non-positive interval instead of scheduling a hot loop', async () => {
    settings({ 'metering.outbox.drain.intervalSeconds': 0 });
    await scheduler.onModuleInit();
    expect(mockQueue.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('survives an unreachable Redis at boot — outbox rows drain on a later tick', async () => {
    mockQueue.upsertJobScheduler.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
  });
});
