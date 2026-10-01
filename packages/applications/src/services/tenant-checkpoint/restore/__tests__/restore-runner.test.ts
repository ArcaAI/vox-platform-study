import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createArchiveWriter } from '../../archive';
import { baseHeader, collect, fakeSealing, manifestFor, TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { strictCls } from '../../export/__tests__/tenant-scope-fakes';
import { POST_COMMIT_SETTLE_MS } from '../restore.runner';
import { CheckpointRestoreRunner } from '../restore.runner';
import { CheckpointRestoreSweeper, RESTORE_HEARTBEAT_STALE_MS, RESTORE_PENDING_STALE_MS } from '../restore-sweeper';
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
    findActiveAnyTenant: vi.fn(async () =>
      [...store.values()].filter((r) => !['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(r.status ?? '')).map((r) => ({ ...r })),
    ),
  };
}

async function archiveFor(tenantId: string, sealing: ReturnType<typeof fakeSealing>, withMedia = false): Promise<Buffer> {
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const sink = new PassThrough();
  const done = collect(sink);
  const writer = createArchiveWriter({ header: baseHeader({ tenantId, keys: { platform: platformWrapped } }), dataKey: plaintext, sink, sealing });
  const media = [];
  if (withMedia) {
    const r = await writer.writeEntry('media/b1/k.wav', Buffer.from('x'));
    media.push({ entry: 'media/b1/k.wav', size: r.bytes, sha256: r.sha256, bucketId: 'b1', key: 'k.wav' });
  }
  await writer.finish(manifestFor([], { media }));
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

const SNAPSHOT = '00000003-0000001B-1';

async function setup(
  opts: {
    media?: unknown;
    archiveTenant?: string;
    safety?: 'READY' | 'FAILED';
    postCommit?: () => Promise<unknown>;
    result?: ReconcileResult;
    metaData?: Record<string, unknown>;
    /** Bytes served from the third open on (the reconcile read), after the gate's two passes. */
    swapAfterVerify?: (file: Buffer) => Buffer;
  } = {},
) {
  const sealing = fakeSealing();
  const file = await archiveFor(opts.archiveTenant ?? TENANT_A, sealing, !!opts.media);
  const clock = new FakeClock();
  const events: string[] = [];
  const restores = rowRepo([
    {
      id: RESTORE_ID,
      version: 1,
      tenantId: TENANT_A,
      checkpointId: SOURCE_ID,
      categories: opts.media ? ['CLINICAL'] : ['CONFIG_CONTENT'],
      reason: 'roll back a bad agent publish',
      status: 'PENDING',
      requestedBy: ACTOR,
      metaData: opts.metaData,
    } as never,
  ]);
  const checkpoints = rowRepo([{ id: SOURCE_ID, version: 1, tenantId: TENANT_A, status: 'READY', objectKey: `${TENANT_A}/${SOURCE_ID}.hcp` } as never]);
  const lock = { state: vi.fn(), publishChange: vi.fn(async () => void events.push(`publish@${clock.now()}`)) };
  const exportRunner = {
    run: vi.fn(async (id: string, _options?: { snapshotId?: string }) => {
      events.push('safety');
      const row = checkpoints.store.get(id)! as { status: string };
      row.status = opts.safety ?? 'READY';
    }),
  };
  let opens = 0;
  const store = {
    openReadStream: vi.fn(async () => Readable.from([++opens > 2 && opts.swapAfterVerify ? opts.swapAfterVerify(file) : file])),
  };
  let commitAt = 0;
  /** The reconcile connection: the snapshot export and the compare-and-set of the restore row. */
  const txQueries: string[] = [];
  const txQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
    txQueries.push(sql);
    if (/pg_export_snapshot/.test(sql)) return [{ id: SNAPSHOT }];
    if (/UPDATE core\."TenantCheckpointRestore"/.test(sql)) {
      const row = restores.store.get(params[0] as string) as any;
      if (row?.status !== 'RECONCILING') return [];
      row.status = 'POST_COMMIT';
      row.safetyCheckpointId = params[1];
      row.version += 1;
      restores.statuses.push('POST_COMMIT');
      return [{ id: row.id }];
    }
    return [];
  });
  const reconciler = {
    reconcile: vi.fn(async (_client: unknown, args: ReconcileArgs) => {
      events.push('reconcile');
      await args.onBegin?.(txQuery as never);
      for await (const _ of args.reader.entries()) void _;
      await args.beforeCommit?.(txQuery as never);
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
  const media = { reupload: vi.fn(async () => opts.media ?? { uploaded: 0, present: 0, warnings: [] }) };
  const client = { release: vi.fn(), query: vi.fn(async () => ({ rows: [] })) };
  const db = { connect: vi.fn(async () => client), query: vi.fn(async () => []) };
  const emitter = { emit: vi.fn() };
  const clsStore = new Map<string, unknown>();
  const cls = {
    isActive: () => true,
    run: (a: unknown, b?: unknown) => ((typeof a === 'function' ? a : b) as () => unknown)(),
    set: (k: string, v: unknown) => clsStore.set(k, v),
    get: (k: string) => clsStore.get(k),
  };

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
  return {
    runner,
    restores,
    checkpoints,
    lock,
    exportRunner,
    reconciler,
    postCommit,
    clock,
    events,
    emitter,
    client,
    txQueries,
    commitAt: () => commitAt,
    row: () => restores.store.get(RESTORE_ID) as any,
  };
}

describe('CheckpointRestoreRunner', () => {
  it('walks LOCKING → VERIFYING → RECONCILING → POST_COMMIT (written by the commit) → COMPLETED, publishing the lock at both ends', async () => {
    const t = await setup();
    await t.runner.run(RESTORE_ID);

    expect(t.restores.statuses).toEqual(['LOCKING', 'VERIFYING', 'RECONCILING', 'POST_COMMIT', 'COMPLETED']);
    expect(t.lock.publishChange).toHaveBeenCalledTimes(2);
    expect(t.events[0]).toMatch(/^publish@/);
    // R2 I-3: the SAFETY checkpoint runs inside the reconcile transaction, from its exported snapshot
    expect(t.events.slice(1, 3)).toEqual(['reconcile', 'safety']);
    expect(t.exportRunner.run).toHaveBeenCalledWith(expect.any(String), { snapshotId: SNAPSHOT });
    expect(t.txQueries[0]).toBe('SELECT pg_export_snapshot() AS id');
    expect(t.client.query).toHaveBeenCalledWith(`SELECT set_config('application_name', $1, false)`, [`hope-restore:${RESTORE_ID}`]);
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

    expect(t.restores.statuses).toEqual(['LOCKING', 'VERIFYING', 'FAILED']);
    expect(t.row()).toMatchObject({ failureReason: 'WRONG_TENANT' });
    expect(t.row().lockReleasedAt).toBeInstanceOf(Date);
    expect(t.reconciler.reconcile).not.toHaveBeenCalled();
    expect(t.lock.publishChange).toHaveBeenCalledTimes(2);
  });

  it('a safety checkpoint that does not reach READY fails the restore before anything is written', async () => {
    const t = await setup({ safety: 'FAILED' });
    await t.runner.run(RESTORE_ID);

    expect(t.row()).toMatchObject({ status: 'FAILED', failureReason: 'RESTORE_FAILED' });
    expect(t.txQueries.some((q) => /UPDATE core/.test(q))).toBe(false);
    expect(t.postCommit.run).not.toHaveBeenCalled();
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

  it('R2 I-5 — refuses to commit once the sweeper has ended the row: the compare-and-set inside the transaction updates nothing', async () => {
    const t = await setup();
    let refusal: unknown = null;
    const reconcile = t.reconciler.reconcile.getMockImplementation()!;
    t.reconciler.reconcile.mockImplementationOnce(async (client: unknown, args: ReconcileArgs) =>
      reconcile(client, {
        ...args,
        beforeCommit: async (q) => {
          (t.restores.store.get(RESTORE_ID) as any).status = 'FAILED';
          try {
            await args.beforeCommit!(q);
          } catch (e) {
            refusal = e;
            throw e;
          }
        },
      }),
    );
    await t.runner.run(RESTORE_ID);

    expect(refusal).toMatchObject({ reason: 'RESTORE_FAILED' });
    expect(t.txQueries.at(-1)).toMatch(/UPDATE core\."TenantCheckpointRestore" SET "status" = 'POST_COMMIT'.* WHERE "id" = \$1 AND "status" = 'RECONCILING'/);
    expect(t.postCommit.run).not.toHaveBeenCalled();
  });

  it('R2 I-5 — a committed restore the sweeper released during post-commit stays COMPLETED_WITH_WARNINGS, with this run\'s counts and warnings merged', async () => {
    const t = await setup({
      postCommit: async () => {
        Object.assign(t.restores.store.get(RESTORE_ID) as any, {
          status: 'COMPLETED_WITH_WARNINGS',
          warnings: [{ code: 'LOCK_TIMEOUT_POST_COMMIT', message: 'x' }],
          lockReleasedAt: new Date(t.clock.now()),
        });
        return [{ code: 'SESSIONS_REVOKE_FAILED', message: 'y' }];
      },
    });
    await t.runner.run(RESTORE_ID);

    expect(t.restores.statuses).not.toContain('FAILED');
    expect(t.row()).toMatchObject({
      status: 'COMPLETED_WITH_WARNINGS',
      counts: [{ model: 'Department', inserted: 0, updated: 1, retired: 0 }],
      warnings: [expect.objectContaining({ code: 'LOCK_TIMEOUT_POST_COMMIT' }), expect.objectContaining({ code: 'SESSIONS_REVOKE_FAILED' })],
    });
  });

  it('R1 M-1 — bytes swapped after verification (signature no longer verifies) are never committed', async () => {
    const t = await setup({
      swapAfterVerify: (file) => {
        // the trailer signature (base64 text at the very end): the digest still matches, the signature does not
        const copy = Buffer.from(file);
        const i = copy.length - 10;
        copy[i] = copy[i] === 0x41 ? 0x42 : 0x41;
        return copy;
      },
    });
    await t.runner.run(RESTORE_ID);

    expect(t.row()).toMatchObject({ status: 'FAILED', failureReason: 'SIGNATURE_INVALID' });
    expect(t.txQueries.some((q) => /UPDATE core/.test(q))).toBe(false);
    expect(t.postCommit.run).not.toHaveBeenCalled();
  });

  it('R1 I-2 — passes requestedByPlatformAdmin from the restore row to the reconcile', async () => {
    const tenant = await setup();
    await tenant.runner.run(RESTORE_ID);
    expect(tenant.reconciler.reconcile.mock.calls[0][1]).toMatchObject({ platformAdmin: false });

    const admin = await setup({ metaData: { requestedByPlatformAdmin: true } });
    await admin.runner.run(RESTORE_ID);
    expect(admin.reconciler.reconcile.mock.calls[0][1]).toMatchObject({ platformAdmin: true });
  });

  it('a media warning (MEDIA_BUCKET_UNRESOLVED) does not stop the restore and ends COMPLETED_WITH_WARNINGS', async () => {
    const t = await setup({ media: { uploaded: 0, present: 0, warnings: [{ code: 'MEDIA_BUCKET_UNRESOLVED', message: 'x', detail: { mediaIds: ['m1'] } }] } });
    await t.runner.run(RESTORE_ID);

    expect(t.reconciler.reconcile).toHaveBeenCalled();
    expect(t.row()).toMatchObject({ status: 'COMPLETED_WITH_WARNINGS', warnings: [expect.objectContaining({ code: 'MEDIA_BUCKET_UNRESOLVED' })] });
  });

  it('a re-delivered job of a row past PENDING is a no-op', async () => {
    const t = await setup();
    (t.restores.store.get(RESTORE_ID) as any).status = 'RECONCILING';
    await t.runner.run(RESTORE_ID);
    expect(t.lock.publishChange).not.toHaveBeenCalled();
  });
});

describe('CheckpointRestoreSweeper', () => {
  function sweeperWith(rows: Record<string, unknown>[], maxLockMinutes = 60, liveBackends: string[] = []) {
    const clock = new FakeClock();
    const sweeperCls = strictCls();
    const restores = rowRepo(rows.map((r) => ({ version: 1, tenantId: TENANT_A, ...r })) as never);
    const lock = { publishChange: vi.fn(async () => undefined) };
    const settings = { resolve: vi.fn(() => ({ value: maxLockMinutes })) };
    const emitter = { emit: vi.fn() };
    const db = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, params: unknown[] = []) => (/count\(\*\)/.test(sql) ? [{ n: liveBackends.includes(params[0] as string) ? 1 : 0 }] : [])),
    };
    const sweeper = new CheckpointRestoreSweeper(restores as never, lock as never, settings as never, emitter as never, sweeperCls as never, clock, db as never);
    return { sweeper, restores, lock, emitter, clock, db };
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

  it('R2 I-5 — never marks a POST_COMMIT row FAILED: past the lock limit it is released COMPLETED_WITH_WARNINGS(LOCK_TIMEOUT_POST_COMMIT)', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([{ id: 'pc', status: 'POST_COMMIT', heartbeatAt: new Date(clock.t - 1000), lockAcquiredAt: new Date(clock.t - 61 * 60_000), warnings: [] }]);
    expect(await t.sweeper.sweep()).toBe(1);
    const row = t.restores.store.get('pc') as any;
    expect(row).toMatchObject({ status: 'COMPLETED_WITH_WARNINGS', warnings: [expect.objectContaining({ code: 'LOCK_TIMEOUT_POST_COMMIT' })] });
    expect(row.failureReason).toBeUndefined();
    expect(row.lockReleasedAt).toBeInstanceOf(Date);
    expect(t.lock.publishChange).toHaveBeenCalledWith(TENANT_A);
  });

  it('R2 I-5 — a POST_COMMIT row whose worker died is released COMPLETED_WITH_WARNINGS(WORKER_LOST_POST_COMMIT)', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([{ id: 'pc', status: 'POST_COMMIT', heartbeatAt: new Date(clock.t - RESTORE_HEARTBEAT_STALE_MS - 1), lockAcquiredAt: new Date(clock.t - 5 * 60_000) }]);
    expect(await t.sweeper.sweep()).toBe(1);
    expect(t.restores.store.get('pc')).toMatchObject({ status: 'COMPLETED_WITH_WARNINGS', warnings: [expect.objectContaining({ code: 'WORKER_LOST_POST_COMMIT' })] });
  });

  it('R2 I-3 — a RECONCILING row with a paused heartbeat but a live reconcile connection is not WORKER_LOST', async () => {
    const clock = new FakeClock();
    const t = sweeperWith(
      [{ id: 'busy', status: 'RECONCILING', heartbeatAt: new Date(clock.t - RESTORE_HEARTBEAT_STALE_MS - 60_000), lockAcquiredAt: new Date(clock.t - 10 * 60_000) }],
      60,
      ['hope-restore:busy'],
    );
    expect(await t.sweeper.sweep()).toBe(0);
    expect(t.restores.store.get('busy')).toMatchObject({ status: 'RECONCILING' });
  });

  it('LOCK_TIMEOUT on a live reconcile cancels its connection (its compare-and-set would fail anyway)', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([{ id: 'long', status: 'RECONCILING', heartbeatAt: new Date(clock.t - 1000), lockAcquiredAt: new Date(clock.t - 61 * 60_000) }], 60, ['hope-restore:long']);
    expect(await t.sweeper.sweep()).toBe(1);
    expect(t.restores.store.get('long')).toMatchObject({ status: 'FAILED', failureReason: 'LOCK_TIMEOUT' });
    expect(t.db.query).toHaveBeenCalledWith(expect.stringContaining('pg_cancel_backend'), ['hope-restore:long']);
  });

  it('R2 M-7 — a PENDING restore no worker picked up within 15 minutes is FAILED(WORKER_LOST); a younger one is left alone', async () => {
    const clock = new FakeClock();
    const t = sweeperWith([
      { id: 'lost', status: 'PENDING', heartbeatAt: null, lockAcquiredAt: null, createdAt: new Date(clock.t - RESTORE_PENDING_STALE_MS - 1) },
      { id: 'queued', status: 'PENDING', heartbeatAt: null, lockAcquiredAt: null, createdAt: new Date(clock.t - 60_000) },
    ]);
    expect(await t.sweeper.sweep()).toBe(1);
    expect(t.restores.store.get('lost')).toMatchObject({ status: 'FAILED', failureReason: 'WORKER_LOST' });
    expect(t.restores.store.get('queued')).toMatchObject({ status: 'PENDING' });
  });

  it('R3 N-3 — right after the commit: a POST_COMMIT row whose claim stamped the heartbeat at COMMIT time is left alone, though the reconcile outlasted the stale window', async () => {
    const clock = new FakeClock();
    // the reconcile transaction ran 10 minutes (heartbeat paused); the claim wrote heartbeatAt with clock_timestamp() 20 s ago
    const t = sweeperWith([{ id: 'pc', status: 'POST_COMMIT', heartbeatAt: new Date(clock.t - 20_000), lockAcquiredAt: new Date(clock.t - 11 * 60_000) }]);
    expect(await t.sweeper.sweep()).toBe(0);
    expect(t.restores.store.get('pc')).toMatchObject({ status: 'POST_COMMIT' });
    expect(t.lock.publishChange).not.toHaveBeenCalled();
  });
});
