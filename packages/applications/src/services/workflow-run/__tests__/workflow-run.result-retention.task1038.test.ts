/**
 * TASK-1038 (OD-25) — the daily result purge.
 *
 * A finished run's delivered result is kept `workflowRuns.resultRetentionDays` (30 by default,
 * tenant-overridable); after that the stored result is replaced by an `expired` tombstone. The
 * run row itself — status, counts, timings — stays: retention removes the OUTPUT, not the audit
 * trail. Follows the `ComposedPromptRecord` purge (TASK-1035): one node at a time behind a Redis
 * lock, every step idempotent, per-tenant windows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY } from '../../settings-registry/descriptors/workflow-runs.descriptors';
import { WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY, WorkflowRunResultRetentionService } from '../workflow-run-result-retention.service';

const NOW = new Date('2026-10-04T04:45:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function row(id: string, tenantId: string, endedDaysAgo: number, resultRef: Record<string, unknown> = { kind: 'inline', value: { note: 'x' } }) {
  return { id, tenantId, endedAt: new Date(NOW.getTime() - endedDaysAgo * DAY), resultRef, version: 3 };
}

function build(rows: ReturnType<typeof row>[], lock: 'OK' | null = 'OK') {
  const repository = {
    findAll: vi.fn(async (props: { limit?: number }) => rows.splice(0, props.limit ?? rows.length)),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const settings = {
    resolve: vi.fn((key: string, tenantId: string) => ({
      key,
      value: key === WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY && tenantId === 'tenant-b' ? 7 : undefined,
    })),
  };
  const redis = { eval: vi.fn(async () => lock), del: vi.fn(async () => 1) };
  const service = new WorkflowRunResultRetentionService(repository as never, settings as never, redis as never);
  service.now = () => NOW;
  return { service, repository, redis };
}

beforeEach(() => vi.clearAllMocks());

describe('WorkflowRunResultRetentionService.purgeExpired', () => {
  it('tombstones results past each tenant`s window and keeps the rest — the run row stays', async () => {
    const rows = [row('a-old', 'tenant-a', 40), row('a-recent', 'tenant-a', 10), row('b-old', 'tenant-b', 10), row('b-recent', 'tenant-b', 3)];
    const { service, repository } = build([...rows]);

    const outcome = await service.purgeExpired();

    expect(outcome).toEqual({ scanned: 4, expired: 2 });
    const expiredIds = repository.updateWithVersion.mock.calls.map((call) => call[0]);
    expect(expiredIds).toEqual(['a-old', 'b-old']);
    const [, entity, version] = repository.updateWithVersion.mock.calls[0];
    expect((entity as { resultRef: unknown }).resultRef).toEqual({ kind: 'expired', expiredAt: NOW.toISOString() });
    expect(version).toBe(3);
  });

  it('only ever selects stored RESULTS that ended more than a day ago (the shortest window)', async () => {
    const { service, repository } = build([]);
    await service.purgeExpired();
    const [props] = repository.findAll.mock.calls[0] as [{ where: { AND: Record<string, unknown>[] }; sort: unknown }];
    expect(props.where.AND).toEqual(
      expect.arrayContaining([
        { endedAt: { lt: new Date(NOW.getTime() - DAY) } },
        { OR: [{ resultRef: { path: ['kind'], equals: 'inline' } }, { resultRef: { path: ['kind'], equals: 'ref' } }] },
      ]),
    );
    expect(props.sort).toEqual([{ endedAt: 'asc' }, { id: 'asc' }]);
  });

  it('pages with a keyset cursor until a short page', async () => {
    const many = Array.from({ length: 501 }, (_, i) => row(`r-${String(i).padStart(4, '0')}`, 'tenant-a', 40));
    const { service, repository } = build([...many]);
    const outcome = await service.purgeExpired();
    expect(outcome.expired).toBe(501);
    expect(repository.findAll).toHaveBeenCalledTimes(2);
    const [second] = repository.findAll.mock.calls[1] as [{ where: { AND: Record<string, unknown>[] } }];
    expect(second.where.AND).toContainEqual({
      OR: [{ endedAt: { gt: many[499].endedAt } }, { endedAt: many[499].endedAt, id: { gt: 'r-0499' } }],
    });
  });

  it('a row the completion watcher rewrote meanwhile (OCC) is skipped, not fatal', async () => {
    const { service, repository } = build([row('a', 'tenant-a', 40), row('b', 'tenant-a', 40)]);
    repository.updateWithVersion.mockRejectedValueOnce(
      new OptimisticConcurrencyException('WorkflowRun', 'a', { expectedVersion: 3, currentVersion: 4 } as never),
    );
    const outcome = await service.purgeExpired();
    expect(outcome.expired).toBe(1);
    expect(repository.updateWithVersion).toHaveBeenCalledTimes(2);
  });

  it('does nothing when another node holds the purge lock, and releases its own', async () => {
    const held = build([row('a', 'tenant-a', 40)], null);
    expect(await held.service.purgeExpired()).toEqual({ scanned: 0, expired: 0 });
    expect(held.repository.findAll).not.toHaveBeenCalled();

    const free = build([]);
    await free.service.purgeExpired();
    expect(free.redis.eval).toHaveBeenCalledWith(expect.any(String), 1, WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY, 'held', expect.any(Number));
    expect(free.redis.del).toHaveBeenCalledWith(WORKFLOW_RUN_RESULT_PURGE_LOCK_KEY);
  });
});
