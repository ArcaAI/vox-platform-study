import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createArchiveWriter } from '../../archive';
import { baseHeader, collect, fakeSealing, manifestFor, TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { POST_COMMIT_SETTLE_MS } from '../restore.runner';
import { CheckpointRestoreRunner } from '../restore.runner';
import { CheckpointRestoreSweeper, RESTORE_HEARTBEAT_STALE_MS } from '../restore-sweeper';
import type { ReconcileArgs, ReconcileResult } from '../reconciler';
import type { RestoreClock } from '../restore-row';

const SOURCE_ID = '01900000-0000-7000-8000-0000000000c1';
const RESTORE_ID = '01900000-0000-7000-8000-0000000000r1';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';

class FakeClock implements RestoreClock {
  t = Date.parse('2026-10-01T10:00:00Z');
  sleeps: number[] = [];
  now = () => this.t;
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

/** In-memory repository with compare-and-set on `version`; records every status it writes. */
function rowRepo<T extends { id: string; version: number; status?: string }>(rows: T[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const statuses: string[] = [];
  return {
    store,
    statuses,
    findById: vi.fn(async (id: string) => {
      const r = store.get(id);
      if (!r) throw Object.assign(new Error('not found'), { name: 'DataNotFoundException' });
      return Object.getPrototypeOf(r) === Object.prototype ? { ...r } : r;
    }),
    updateWithVersion: vi.fn(async (id: string, row: T, expected: number) => {
      const cur = store.get(id)!;
      if (cur.version !== expected) throw new Error('version drift');
      if (row.status && row.status !== cur.status) statuses.push(row.status);
      const next = { ...row, version: expected + 1 };
      store.set(id, next);
      return { ...next };
    }),
    create: vi.fn(async (row: T) => {
      // a factory-made entity keeps its fields behind accessors — store it as is
      store.set(row.id, row);
      return row;
    }),
    findAll: vi.fn(async () => [...store.values()].filter((r) => !['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(r.status ?? '')).map((r) => ({ ...r }))),
  };
}

async function archiveFor(tenantId: string, sealing: ReturnType<typeof fakeSealing>) {
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const sink = new PassThrough();
  const done = collect(sink);
  const writer = createArchiveWriter({ header: baseHeader({ tenantId, keys: { platform: platformWrapped } }), dataKey: plaintext, sink, sealing });
  await writer.finish(manifestFor([]));
  return done;
}

const emptyResult = (over: Partial<ReconcileResult> = {}): ReconcileResult => ({
  counts: [{ model: 'Department', inserted: 0, updated: 1, retired: 0 }],
  warnings: [],
  touchedUserIds: [],
  knowledge: { reingest: [], retired: [], chunks: {} },
  retiredConsultationIds: [],
  retiredServiceAccountIds: [],
  ...over,
});

async function setup(opts: { archiveTenant?: string; safety?: 'READY' | 'FAILED'; postCommit?: () => Promise<unknown>; result?: ReconcileResult } = {}) {
  const sealing = fakeSealing();
  const file = await archiveFor(opts.archiveTenant ?? TENANT_A, sealing);
  const clock = new FakeClock();
  const events: string[] = [];
  const restores = rowRepo([
    {
      id: RESTORE_ID,
      version: 1,
      tenantId: TENANT_A,
      checkpointId: SOURCE_ID,
      categories: ['CONFIG_CONTENT'],
      reason: 'roll back a bad agent publish',
      status: 'PENDING',
      requestedBy: ACTOR,
    } as never,
  ]);
  const checkpoints = rowRepo([{ id: SOURCE_ID, version: 1, tenantId: TENANT_A, status: 'READY', objectKey: `${TENANT_A}/${SOURCE_ID}.hcp` } as never]);
  const lock = { state: vi.fn(), publishChange: vi.fn(async () => void events.push(`publish@${clock.now()}`)) };
  const exportRunner = {
    run: vi.fn(async (id: string) => {
      events.push('safety');
      const row = checkpoints.store.get(id)! as { status: string };
      row.status = opts.safety ?? 'READY';
    }),
  };
  const store = { openReadStream: vi.fn(async () => Readable.from([file])) };
  let commitAt = 0;
  const reconciler = {
    reconcile: vi.fn(async (_client: unknown, args: ReconcileArgs) => {
      events.push('reconcile');
      for await (const _ of args.reader.entries()) void _;
      await args.beforeCommit?.();
      commitAt = clock.now();
      return opts.result ?? emptyResult();
    }),
  };
  const postCommit = {
    run: vi.fn(async () => {
      clock.t += 10_000; // post-commit work takes time; the settle wait accounts for it
      return (await opts.postCommit?.()) ?? [];
    }),
  };
  const media = { reupload: vi.fn() };
  const client = { release: vi.fn() };
  const db = { connect: vi.fn(async () => client), query: vi.fn(async () => []) };
  const emitter = { emit: vi.fn() };
  const clsStore = new Map<string, unknown>();
  const cls = { isActive: () => true, run: (fn: () => unknown) => fn(), set: (k: string, v: unknown) => clsStore.set(k, v), get: (k: string) => clsStore.get(k) };

  const runner = new CheckpointRestoreRunner(
    restores as never,
    checkpoints as never,
    lock as never,
    exportRunner,
    sealing,
    store as never,
    reconciler as never,
    postCommit as never,
    media as never,
    db as never,
    emitter as never,
    cls as never,
    clock,
  );
  runner.heartbeatIntervalMs = 60 * 60_000;
  return { runner, restores, checkpoints, lock, exportRunner, reconciler, postCommit, clock, events, emitter, commitAt: () => commitAt, row: () => restores.store.get(RESTORE_ID) as any };
}

describe('CheckpointRestoreRunner', () => {
  it('walks LOCKING → SAFETY_CHECKPOINT → VERIFYING → RECONCILING → POST_COMMIT → COMPLETED, publishing the lock at both ends', async () => {
    const t = await setup();
    await t.runner.run(RESTORE_ID);

    expect(t.restores.statuses).toEqual(['LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT', 'COMPLETED']);
    expect(t.lock.publishChange).toHaveBeenCalledTimes(2);
    expect(t.events[0]).toMatch(/^publish@/);
    expect(t.events.slice(1, 3)).toEqual(['safety', 'reconcile']);
    expect(t.events[3]).toMatch(/^publish@/);
    const row = t.row();
    expect(row.lockAcquiredAt).toBeInstanceOf(Date);
    expect(row.lockReleasedAt).toBeInstanceOf(Date);
    expect(row.counts).toEqual([{ model: 'Department', inserted: 0, updated: 1, retired: 0 }]);
    expect(row.safetyCheckpointId).toBeTruthy();
    const safety = t.checkpoints.store.get(row.safetyCheckpointId) as any;
    expect(safety).toMatchObject({ tenantId: TENANT_A, kind: 'SAFETY', includesMedia: false, status: 'READY' });
    expect(safety.keyEnvelope.platform).toMatch(/^fake:/);
    expect(t.emitter.emit).toHaveBeenCalledWith(
      'SysEvent.ResourceUpdated',
      expect.objectContaining({
        resourceType: 'TenantCheckpointRestore',
        resourceId: RESTORE_ID,
        tenantId: TENANT_A,
        forceAuditLog: true,
        data: expect.objectContaining({ categories: ['CONFIG_CONTENT'], reason: 'roll back a bad agent publish', safetyCheckpointId: row.safetyCheckpointId }),
      }),
    );
  });

  it('holds the lock for POST_COMMIT_SETTLE_MS after the commit before unlocking', async () => {
    const t = await setup();
    await t.runner.run(RESTORE_ID);

    const unlockAt = t.row().lockReleasedAt.getTime();
    expect(unlockAt - t.commitAt()).toBeGreaterThanOrEqual(POST_COMMIT_SETTLE_MS);
    expect(t.clock.sleeps).toContain(POST_COMMIT_SETTLE_MS - 10_000);
    const lastPublish = Number(t.events.at(-1)!.split('@')[1]);
    expect(lastPublish - t.commitAt()).toBeGreaterThanOrEqual(POST_COMMIT_SETTLE_MS);
  });

  it('a verification failure ends FAILED with the gate reason, releases the lock, and never reconciles', async () => {
    const t = await setup({ archiveTenant: TENANT_B });
    await t.runner.run(RESTORE_ID);

    expect(t.restores.statuses).toEqual(['LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'FAILED']);
    expect(t.row()).toMatchObject({ failureReason: 'WRONG_TENANT' });
    expect(t.row().lockReleasedAt).toBeInstanceOf(Date);
    expect(t.reconciler.reconcile).not.toHaveBeenCalled();
    expect(t.lock.publishChange).toHaveBeenCalledTimes(2);
  });

  it('a safety checkpoint that does not reach READY fails the restore before anything is read', async () => {
    const t = await setup({ safety: 'FAILED' });
    await t.runner.run(RESTORE_ID);

    expect(t.row()).toMatchObject({ status: 'FAILED', failureReason: 'RESTORE_FAILED' });
    expect(t.reconciler.reconcile).not.toHaveBeenCalled();
  });

  it('a post-commit failure keeps the restore and ends COMPLETED_WITH_WARNINGS', async () => {
    const t = await setup({ postCommit: async () => Promise.reject(new TypeError('redis down')) });
    await t.runner.run(RESTORE_ID);

    expect(t.restores.statuses.at(-1)).toBe('COMPLETED_WITH_WARNINGS');
    expect(t.row().warnings).toEqual([expect.objectContaining({ code: 'POST_COMMIT_FAILED' })]);
  });

  it('reconcile warnings (IMMUTABLE_DIVERGED) end COMPLETED_WITH_WARNINGS', async () => {
    const t = await setup({ result: emptyResult({ warnings: [{ code: 'IMMUTABLE_DIVERGED', message: 'x', detail: { model: 'Agent', ids: ['a1'] } }] }) });
    await t.runner.run(RESTORE_ID);

    expect(t.row()).toMatchObject({ status: 'COMPLETED_WITH_WARNINGS', warnings: [expect.objectContaining({ code: 'IMMUTABLE_DIVERGED' })] });
  });

  it('refuses to commit once the sweeper has ended the row', async () => {
    const t = await setup();
    let refusal: unknown = null;
    t.reconciler.reconcile.mockImplementationOnce(async (_c: unknown, args: ReconcileArgs) => {
      for await (const _ of args.reader.entries()) void _;
      (t.restores.store.get(RESTORE_ID) as any).status = 'FAILED';
      try {
        await args.beforeCommit!();
      } catch (e) {
        refusal = e;
        throw e;
      }
      return emptyResult();
    });
    await t.runner.run(RESTORE_ID);

    expect(refusal).toMatchObject({ reason: 'RESTORE_FAILED' });
    expect(t.postCommit.run).not.toHaveBeenCalled();
  });

  it('a re-delivered job of a row past PENDING is a no-op', async () => {
    const t = await setup();
    (t.restores.store.get(RESTORE_ID) as any).status = 'RECONCILING';
    await t.runner.run(RESTORE_ID);
    expect(t.lock.publishChange).not.toHaveBeenCalled();
  });
});

describe('CheckpointRestoreSweeper', () => {
  function sweeperWith(rows: Record<string, unknown>[], maxLockMinutes = 60) {
    const clock = new FakeClock();
    const restores = rowRepo(rows.map((r) => ({ version: 1, tenantId: TENANT_A, ...r })) as never);
    const lock = { publishChange: vi.fn(async () => undefined) };
    const settings = { resolve: vi.fn(() => ({ value: maxLockMinutes })) };
    const emitter = { emit: vi.fn() };
    const sweeper = new CheckpointRestoreSweeper(restores as never, lock as never, settings as never, emitter as never, clock);
    return { sweeper, restores, lock, emitter, clock };
  }

  it('fails a restore whose heartbeat is stale (WORKER_LOST), releases its lock and publishes', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([
      { id: 'stale', status: 'RECONCILING', heartbeatAt: new Date(clock.t - RESTORE_HEARTBEAT_STALE_MS - 1), lockAcquiredAt: new Date(clock.t - 5 * 60_000) },
      { id: 'fresh', status: 'RECONCILING', heartbeatAt: new Date(clock.t - 10_000), lockAcquiredAt: new Date(clock.t - 5 * 60_000) },
    ]);
    expect(await t.sweeper.sweep()).toBe(1);

    expect(t.restores.store.get('stale')).toMatchObject({ status: 'FAILED', failureReason: 'WORKER_LOST' });
    expect((t.restores.store.get('stale') as any).lockReleasedAt).toBeInstanceOf(Date);
    expect(t.restores.store.get('fresh')).toMatchObject({ status: 'RECONCILING' });
    expect(t.lock.publishChange).toHaveBeenCalledWith(TENANT_A);
    expect(t.emitter.emit).toHaveBeenCalledWith('SysEvent.ResourceUpdated', expect.objectContaining({ resourceId: 'stale', forceAuditLog: true }));
  });

  it('force-releases a lock held longer than maxLockMinutes (LOCK_TIMEOUT) even with a live heartbeat', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([{ id: 'long', status: 'RECONCILING', heartbeatAt: new Date(clock.t - 1000), lockAcquiredAt: new Date(clock.t - 31 * 60_000) }], 30);
    expect(await t.sweeper.sweep()).toBe(1);
    expect(t.restores.store.get('long')).toMatchObject({ status: 'FAILED', failureReason: 'LOCK_TIMEOUT' });
  });
});
