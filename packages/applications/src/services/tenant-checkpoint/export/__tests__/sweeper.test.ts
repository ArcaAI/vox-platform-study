import { describe, expect, it } from 'vitest';

import { TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { CheckpointSweeper, RETENTION_LOCK_KEY } from '../sweeper';
import { FakeCheckpointRepo, FakeStore, fakeCls, fakeEvents, fakeRedis, fakeSettings } from './fakes';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function setup(opts: { held?: boolean; maxRetained?: number } = {}) {
  const repo = new FakeCheckpointRepo();
  const store = new FakeStore();
  const redis = fakeRedis(opts.held);
  const events = fakeEvents();
  const sweeper = new CheckpointSweeper(repo as any, store, fakeSettings({ 'tenantCheckpoint.maxRetained': opts.maxRetained ?? 10 }), events.emitter, fakeCls(), redis.redis);
  sweeper.now = () => NOW;
  return { repo, store, redis, events, sweeper };
}

describe('CheckpointSweeper', () => {
  it('fails a RUNNING export whose heartbeat is older than 2 minutes with WORKER_LOST; a fresh one is left alone', async () => {
    const s = setup();
    const stale = s.repo.add({ tenantId: TENANT_A, status: 'RUNNING' as never, heartbeatAt: ago(3 * MIN), objectKey: `${TENANT_A}/x.hcp` });
    const fresh = s.repo.add({ tenantId: TENANT_A, status: 'RUNNING' as never, heartbeatAt: ago(30_000) });
    await s.sweeper.sweepStaleExports();
    expect(s.repo.get(stale.id)).toMatchObject({ status: 'FAILED', failureReason: 'WORKER_LOST' });
    expect(s.repo.get(stale.id).failureDetail).toEqual(expect.any(String));
    expect(s.store.deleted).toEqual([`${TENANT_A}/x.hcp`]);
    expect(s.repo.get(fresh.id).status).toBe('RUNNING');
  });

  it('aborts an UPLOADING row idle for more than 24 h and marks it CANCELLED; a recent upload is left alone', async () => {
    const s = setup();
    const idle = s.repo.add({ tenantId: TENANT_A, status: 'UPLOADING' as never, uploadId: 'up-1', objectKey: `${TENANT_A}/idle.hcp`, updatedAt: ago(25 * HOUR) });
    const recent = s.repo.add({ tenantId: TENANT_A, status: 'UPLOADING' as never, uploadId: 'up-2', objectKey: `${TENANT_A}/recent.hcp`, updatedAt: ago(2 * HOUR) });
    await s.sweeper.sweepIdleUploads();
    expect(s.store.abortedUploads).toEqual([{ key: `${TENANT_A}/idle.hcp`, uploadId: 'up-1' }]);
    expect(s.repo.get(idle.id)).toMatchObject({ status: 'CANCELLED', uploadId: null });
    expect(s.repo.get(recent.id).status).toBe('UPLOADING');
  });

  it('retention deletes past-expiresAt and beyond-maxRetained READY rows, never the newest READY row nor a SAFETY row younger than 7 days', async () => {
    const s = setup({ maxRetained: 2 });
    const add = (tenantId: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      s.repo.add({ tenantId, status: 'READY' as never, createdAt, expiresAt: new Date(NOW.getTime() + DAY), objectKey: `${tenantId}/${createdAt.getTime()}.hcp`, ...extra });

    // Tenant A: newest is expired but protected; 2nd kept (within maxRetained); 3rd beyond; 4th beyond but young SAFETY; 5th old SAFETY beyond.
    const newestExpired = add(TENANT_A, ago(1 * HOUR), { expiresAt: ago(1 * MIN) });
    const second = add(TENANT_A, ago(2 * DAY));
    const third = add(TENANT_A, ago(3 * DAY));
    const youngSafety = add(TENANT_A, ago(4 * DAY), { kind: 'SAFETY' });
    const oldSafety = add(TENANT_A, ago(9 * DAY), { kind: 'SAFETY' });
    // Tenant B: one expired non-newest row, one live newest.
    const bNewest = add(TENANT_B, ago(1 * DAY));
    const bExpired = add(TENANT_B, ago(5 * DAY), { expiresAt: ago(HOUR) });
    // Not READY — never touched by retention.
    const failed = s.repo.add({ tenantId: TENANT_A, status: 'FAILED' as never, createdAt: ago(40 * DAY), expiresAt: ago(10 * DAY) });

    await s.sweeper.sweepRetention();

    expect(new Set(s.repo.softDeleted)).toEqual(new Set([third.id, oldSafety.id, bExpired.id]));
    for (const kept of [newestExpired, second, youngSafety, bNewest, failed]) expect(s.repo.softDeleted).not.toContain(kept.id);
    expect(new Set(s.store.deleted)).toEqual(new Set([third.objectKey, oldSafety.objectKey, bExpired.objectKey]));
    expect(s.redis.calls).toEqual(['eval', 'del']);
    expect(s.events.emitted.filter((e) => e.type === 'SysEvent.ResourceDeleted')).toHaveLength(3);
  });

  it('skips retention entirely when another node holds the Redis lock', async () => {
    const s = setup({ held: true });
    s.repo.add({ tenantId: TENANT_A, status: 'READY' as never, createdAt: ago(DAY) });
    s.repo.add({ tenantId: TENANT_A, status: 'READY' as never, createdAt: ago(2 * DAY), expiresAt: ago(HOUR) });
    await s.sweeper.sweepRetention();
    expect(s.repo.softDeleted).toEqual([]);
    expect(s.redis.calls).toEqual(['eval']);
    expect(RETENTION_LOCK_KEY).toBe('tenant-checkpoint-retention:lock');
  });
});
