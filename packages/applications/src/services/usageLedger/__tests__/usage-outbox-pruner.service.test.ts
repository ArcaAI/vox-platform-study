/**
 * UsageOutboxPrunerService.
 *
 * Mirrors `audit-retention.service.test.ts`'s coverage shape:
 *   - `pruneDispatched` only targets `status: DISPATCHED` rows older than the
 *     cutoff, batches deletes, and refuses to run with a non-positive
 *     retention window.
 *   - Config/scheduling is OFF by default and re-syncs from
 *     `IAppSettingsService`, same as `AuditRetentionService` / `MeteringService`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiUsageOutboxStatus } from '@arcaai/domains';
import { UsageOutboxPrunerService } from '../usage-outbox-pruner.service';
import { PRUNE_BATCH_SIZE, PRUNE_DEFAULTS } from '../usage-ledger.constants';

function makeOutboxDelegate(overrides: Record<string, unknown> = {}) {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    ...overrides,
  };
}

function makeService(outbox: ReturnType<typeof makeOutboxDelegate>, settingsOverrides: Record<string, unknown> = {}) {
  const appSettingsService = {
    getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in settingsOverrides ? settingsOverrides[key] : fallback)),
  } as never;
  const schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as never;
  const databaseService = { baseClient: { aiUsageOutbox: outbox } } as never;
  return new UsageOutboxPrunerService(appSettingsService, schedulerRegistry, databaseService);
}

describe('UsageOutboxPrunerService.pruneDispatched', () => {
  let outbox: ReturnType<typeof makeOutboxDelegate>;

  beforeEach(() => {
    outbox = makeOutboxDelegate();
  });

  it('queries only DISPATCHED rows older than the retention cutoff, oldest first', async () => {
    const service = makeService(outbox);

    await service.pruneDispatched();

    expect(outbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: AiUsageOutboxStatus.DISPATCHED, updatedAt: { lt: expect.any(Date) } },
        orderBy: { updatedAt: 'asc' },
        take: PRUNE_BATCH_SIZE,
      }),
    );
  });

  it('deletes the matched rows by id and reports the count', async () => {
    outbox.findMany.mockResolvedValueOnce([{ id: 'row-1' }, { id: 'row-2' }]).mockResolvedValueOnce([]);
    outbox.deleteMany.mockResolvedValueOnce({ count: 2 });

    const service = makeService(outbox);
    const result = await service.pruneDispatched();

    expect(outbox.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['row-1', 'row-2'] } } });
    expect(result.totalDeleted).toBe(2);
    expect(result.batches).toBe(1);
  });

  it('paginates across multiple full-sized batches until a short page ends the sweep', async () => {
    const fullBatch = Array.from({ length: PRUNE_BATCH_SIZE }, (_, i) => ({ id: `row-${i}` }));
    outbox.findMany.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([{ id: 'row-last' }]).mockResolvedValueOnce([]);
    outbox.deleteMany.mockResolvedValueOnce({ count: PRUNE_BATCH_SIZE }).mockResolvedValueOnce({ count: 1 });

    const service = makeService(outbox);
    const result = await service.pruneDispatched();

    expect(result.batches).toBe(2);
    expect(result.totalDeleted).toBe(PRUNE_BATCH_SIZE + 1);
  });

  it('refuses to prune and deletes nothing when retentionDays is non-positive', async () => {
    const service = makeService(outbox, { 'metering.outbox.prune.retentionDays': 0 });

    const result = await service.pruneDispatched();

    expect(outbox.findMany).not.toHaveBeenCalled();
    expect(result.totalDeleted).toBe(0);
  });

  it('computes the cutoff from the configured retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));

    const service = makeService(outbox, { 'metering.outbox.prune.retentionDays': 7 });
    const result = await service.pruneDispatched();

    expect(result.cutoff.toISOString()).toBe('2026-08-08T00:00:00.000Z');
    vi.useRealTimers();
  });
});

describe('UsageOutboxPrunerService config', () => {
  it('defaults to disabled', () => {
    const service = makeService(makeOutboxDelegate());
    expect(service.isEnabled).toBe(false);
    expect(service.getConfig()).toEqual({ enabled: false, cron: PRUNE_DEFAULTS.cron, retentionDays: PRUNE_DEFAULTS.retentionDays });
  });

  it('reads enabled/cron/retentionDays from settings when overridden', () => {
    const service = makeService(makeOutboxDelegate(), {
      'metering.outbox.prune.enabled': true,
      'metering.outbox.prune.cron': '0 5 * * *',
      'metering.outbox.prune.retentionDays': 14,
    });

    expect(service.getConfig()).toEqual({ enabled: true, cron: '0 5 * * *', retentionDays: 14 });
  });
});

describe('UsageOutboxPrunerService.handleScheduledPrune', () => {
  it('is a no-op when disabled', async () => {
    const outbox = makeOutboxDelegate();
    const service = makeService(outbox);

    await service.handleScheduledPrune();

    expect(outbox.findMany).not.toHaveBeenCalled();
  });

  it('runs pruneDispatched when enabled', async () => {
    const outbox = makeOutboxDelegate();
    const service = makeService(outbox, { 'metering.outbox.prune.enabled': true });

    await service.handleScheduledPrune();

    expect(outbox.findMany).toHaveBeenCalled();
  });
});
