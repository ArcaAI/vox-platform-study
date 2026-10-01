/**
 * Round 2 (live worker): the restore job and the stale-restore sweeper do their repository work
 * inside a tenant session; the sweeper's cross-tenant scan is the sanctioned unscoped read.
 * The repository throws like the tenant-scope Prisma extension does without a tenant.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';

import { TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { strictCls, tenantScoped } from '../../export/__tests__/tenant-scope-fakes';
import { CheckpointRestoreProcessor } from '../restore.processor';
import { CheckpointRestoreSweeper } from '../restore-sweeper';

const RESTORE_ID = '01900000-0000-7000-8000-0000000000e1';

function restoreRepo(rows: Record<string, any>[]) {
  const store = new Map(rows.map((r) => [r.id, { version: 1, resourceStatus: 'ENABLED', ...r }]));
  return {
    store,
    findById: async (id: string) => ({ ...store.get(id)! }),
    updateWithVersion: async (id: string, row: Record<string, unknown>, expected: number) => {
      const cur = store.get(id)!;
      if (cur.version !== expected) throw new Error('version drift');
      store.set(id, { ...row, version: expected + 1 });
      return { ...store.get(id)! };
    },
    findAll: async () => [...store.values()],
    findActiveAnyTenant: async () => [...store.values()].filter((r) => !['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(r.status)),
  };
}

describe('tenant context — restore side', () => {
  it('the restore processor binds the job tenant before the runner reads the restore row', async () => {
    const cls = strictCls();
    const repo = tenantScoped(restoreRepo([{ id: RESTORE_ID, tenantId: TENANT_A, status: 'PENDING' }]), cls, 'TenantCheckpointRestore');
    let seen: string | undefined;
    const runner = { run: vi.fn(async (id: string) => void ((await repo.findById(id)) && (seen = cls.tenant()))) };
    const processor = new CheckpointRestoreProcessor(runner as never, cls as never);

    await processor.process({ id: 'j1', data: { restoreId: RESTORE_ID, tenantId: TENANT_A } } as never);

    expect(seen).toBe(TENANT_A);
    expect((cls.get('user') as unknown) ?? null).toBeNull(); // nothing leaks out of the job context
  });

  it('a restore job without a valid tenant id is unrecoverable', async () => {
    const cls = strictCls();
    const processor = new CheckpointRestoreProcessor({ run: vi.fn() } as never, cls as never);
    await expect(processor.process({ id: 'j2', data: { restoreId: RESTORE_ID } } as never)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('the stale-restore sweeper scans unscoped and ends each row inside its own tenant session', async () => {
    const cls = strictCls();
    const now = Date.parse('2026-10-01T10:00:00Z');
    const repo = tenantScoped(
      restoreRepo([
        { id: 'a', tenantId: TENANT_A, status: 'RECONCILING', heartbeatAt: new Date(now - 10 * 60_000), lockAcquiredAt: new Date(now - 10 * 60_000) },
        { id: 'b', tenantId: TENANT_B, status: 'VERIFYING', heartbeatAt: new Date(now - 10 * 60_000), lockAcquiredAt: new Date(now - 10 * 60_000) },
      ]),
      cls,
      'TenantCheckpointRestore',
      ['findActiveAnyTenant'],
    );
    const lock = { publishChange: vi.fn(async () => undefined) };
    const settings = { resolve: vi.fn(() => ({ value: 60 })) };
    const clock = { now: () => now, sleep: async () => undefined };
    const sweeper = new CheckpointRestoreSweeper(repo as never, lock as never, settings as never, { emit: vi.fn() } as never, cls as never, clock);

    expect(await sweeper.sweep()).toBe(2);
    expect([repo.store.get('a')!.status, repo.store.get('b')!.status]).toEqual(['FAILED', 'FAILED']);
    const writes = repo.scopedCalls.filter((c) => c.method === 'updateWithVersion');
    expect(writes.map((c) => c.tenant).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });
});
