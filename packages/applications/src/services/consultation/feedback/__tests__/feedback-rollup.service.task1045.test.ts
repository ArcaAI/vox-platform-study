/**
 * Daily feedback rollup — recompute the trailing window of days from feedback
 * EVENTS, replace each day per tenant in one transaction, behind a Redis lock,
 * with the tenant bound in CLS (a separate worker process has none).
 */
import { Logger } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackRollupService } from '../feedback-rollup.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-05T01:30:00Z');
const TODAY = new Date(Date.UTC(2026, 9, 5));

function aggregate(day: Date, over: Record<string, unknown> = {}) {
  return {
    day,
    targetKind: 'NOTE',
    agentSlug: 'soap',
    agentVersion: 3,
    modelName: 'm',
    promptVersion: 'p1',
    sectionKey: '',
    entityLabel: '',
    reasonCode: '',
    upCount: 1,
    downCount: 2,
    clearedCount: 0,
    commentCount: 1,
    correctionCount: 0,
    reasonedCount: 0,
    ...over,
  };
}

describe('FeedbackRollupService', () => {
  const settings: Record<string, unknown> = {};
  const appSettings = { getValueWithDefault: vi.fn((key: string, def: unknown) => (key in settings ? settings[key] : def)) };
  const scheduler = { addCronJob: vi.fn(), deleteCronJob: vi.fn(), getCronJob: vi.fn(() => undefined) };
  const tenantRepo = { findAll: vi.fn() };
  const feedbackRepo = { aggregateEvents: vi.fn() };
  const rollupRepo = { replaceDay: vi.fn() };
  const tx = { marker: 'tx' };
  const database = { baseClient: { $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) } };
  const clsStore = new Map<string, unknown>();
  const cls = {
    get: vi.fn((k: string) => clsStore.get(k)),
    set: vi.fn((k: string, v: unknown) => void clsStore.set(k, v)),
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
  const redis = { eval: vi.fn(), del: vi.fn() };
  let service: FeedbackRollupService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const key of Object.keys(settings)) delete settings[key];
    clsStore.clear();
    tenantRepo.findAll.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    feedbackRepo.aggregateEvents.mockResolvedValue([]);
    rollupRepo.replaceDay.mockResolvedValue({ deleted: 0, inserted: 0 });
    redis.eval.mockResolvedValue('OK');
    redis.del.mockResolvedValue(undefined);
    for (const level of ['log', 'warn', 'error', 'debug'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    service = new FeedbackRollupService(
      appSettings as never,
      scheduler as never,
      tenantRepo as never,
      feedbackRepo as never,
      rollupRepo as never,
      database as never,
      { emit: vi.fn() } as never,
      cls as never,
      redis as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recomputes the default 2-day lookback ending at today, per enabled tenant', async () => {
    await service.rollupAll();

    expect(tenantRepo.findAll).toHaveBeenCalledWith({ filters: { resourceStatus: ResourceStatusType.ENABLED } });
    const from = new Date(TODAY.getTime() - 1 * DAY);
    const to = new Date(TODAY.getTime() + DAY);
    expect(feedbackRepo.aggregateEvents).toHaveBeenCalledWith('t1', from, to);
    expect(feedbackRepo.aggregateEvents).toHaveBeenCalledWith('t2', from, to);
  });

  it('honours the governed lookback days', async () => {
    settings['consultation.feedback.rollupLookbackDays'] = 5;
    await service.rollupAll();
    expect(feedbackRepo.aggregateEvents).toHaveBeenCalledWith('t1', new Date(TODAY.getTime() - 4 * DAY), new Date(TODAY.getTime() + DAY));
  });

  it('replaces EVERY day of the window in a transaction, including days with no events (clears stale rows)', async () => {
    const yesterday = new Date(TODAY.getTime() - DAY);
    feedbackRepo.aggregateEvents.mockImplementation(async (tenantId: string) => (tenantId === 't1' ? [aggregate(yesterday)] : []));

    await service.rollupAll();

    // 2 tenants x 2 days
    expect(rollupRepo.replaceDay).toHaveBeenCalledTimes(4);
    const t1Yesterday = rollupRepo.replaceDay.mock.calls.find((c) => c[0] === 't1' && c[1].getTime() === yesterday.getTime())!;
    expect(t1Yesterday[2]).toHaveLength(1);
    expect(t1Yesterday[2][0]).toMatchObject({ tenantId: 't1', targetKind: 'NOTE', agentSlug: 'soap', agentVersion: 3, upCount: 1, downCount: 2, commentCount: 1 });
    expect(t1Yesterday[3]).toBe(tx);
    const t1Today = rollupRepo.replaceDay.mock.calls.find((c) => c[0] === 't1' && c[1].getTime() === TODAY.getTime())!;
    expect(t1Today[2]).toEqual([]);
    expect(database.baseClient.$transaction).toHaveBeenCalledTimes(4);
  });

  it('is PHI-free: rollup rows carry dimensions and counts only', async () => {
    feedbackRepo.aggregateEvents.mockResolvedValue([aggregate(TODAY, { reasonCode: 'too_long', reasonedCount: 2, upCount: 0, downCount: 0 })]);
    await service.rollupAll();
    const row = rollupRepo.replaceDay.mock.calls.find((c) => c[2].length > 0)![2][0];
    const keys = Object.keys(JSON.parse(JSON.stringify(row)));
    for (const forbidden of ['comment', 'encryptedComment', 'consultationId', 'actorUserId', 'targetContextItemId', 'content']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(row).toMatchObject({ reasonCode: 'too_long', reasonedCount: 2 });
  });

  it('binds the tenant in CLS with a worker session before touching its data', async () => {
    const seen: Array<unknown> = [];
    feedbackRepo.aggregateEvents.mockImplementation(async () => {
      seen.push(clsStore.get('tenantId'));
      return [];
    });
    await service.rollupAll();
    expect(seen).toEqual(['t1', 't2']);
    expect(clsStore.get('user')).toMatchObject({ tenantId: 't2' });
  });

  it('skips the run when another replica holds the lock, and releases it otherwise', async () => {
    redis.eval.mockResolvedValueOnce(null);
    const skipped = await service.rollupAll();
    expect(skipped).toMatchObject({ skipped: 'locked' });
    expect(tenantRepo.findAll).not.toHaveBeenCalled();

    await service.rollupAll();
    expect(redis.del).toHaveBeenCalled();
  });

  it('isolates a failing tenant: the other tenant still rolls up', async () => {
    feedbackRepo.aggregateEvents.mockImplementation(async (tenantId: string) => {
      if (tenantId === 't1') throw new Error('boom');
      return [];
    });
    const result = await service.rollupAll();
    expect(result).toMatchObject({ tenants: 2, tenantsFailed: 1 });
    expect(rollupRepo.replaceDay.mock.calls.some((c) => c[0] === 't2')).toBe(true);
  });

  it('schedules from the governed cron setting', () => {
    settings['consultation.feedback.rollupCron'] = '0 3 * * *';
    service.syncSchedulerFromConfig();
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
  });
});
