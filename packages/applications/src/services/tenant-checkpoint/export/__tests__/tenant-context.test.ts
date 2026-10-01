/**
 * Round 2 (live worker): every export-side entry point does its repository work inside the job's
 * tenant session, and every cross-tenant scan goes through the sanctioned unscoped reads. The
 * repository here throws like the tenant-scope Prisma extension does without a tenant.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';

import { fakeSealing, TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { CheckpointExportProcessor } from '../export.processor';
import { CheckpointExportRunner } from '../export-runner';
import { CheckpointSweeper } from '../sweeper';
import { FakeCheckpointRepo, FakeDb, FakeStore, fakeBlobs, fakeEvents, fakeRedis, fakeSettings } from './fakes';
import { strictCls, tenantScoped } from './tenant-scope-fakes';

const ANY_TENANT = ['findStale', 'findIdleUploads', 'findReadyAnyTenant'];

async function exportSetup() {
  const cls = strictCls();
  const sealing = fakeSealing();
  const { platformWrapped } = await sealing.generateDataKey();
  const raw = new FakeCheckpointRepo();
  const row = raw.add({ tenantId: TENANT_A, includesMedia: false, keyEnvelope: { platform: platformWrapped } });
  const repo = tenantScoped(raw, cls, 'TenantCheckpoint', ANY_TENANT);
  const runner = new CheckpointExportRunner(
    repo as any,
    new FakeDb(),
    sealing,
    new FakeStore(),
    fakeBlobs({}).factory,
    fakeSettings(),
    fakeEvents().emitter,
    cls as any,
  );
  runner.heartbeatIntervalMs = 60_000;
  return { cls, raw, repo, row, runner };
}

describe('tenant context — export side', () => {
  it('the export processor binds the job tenant before the runner touches a repository (live failure: TenantScope … findUnique)', async () => {
    const s = await exportSetup();
    const verifyRunner = { run: vi.fn(async () => undefined) };
    const processor = new CheckpointExportProcessor(s.runner, verifyRunner, s.cls as any);

    await processor.process({ id: 'j1', queueName: 'TenantCheckpointExport', data: { kind: 'create', checkpointId: s.row.id, tenantId: TENANT_A } } as any);

    expect(s.raw.get(s.row.id).status).toBe('READY');
    expect(s.repo.scopedCalls.length).toBeGreaterThan(0);
    expect(new Set(s.repo.scopedCalls.map((c) => c.tenant))).toEqual(new Set([TENANT_A]));
  });

  it('verify-upload runs in the job tenant session too', async () => {
    const s = await exportSetup();
    let seen: string | undefined;
    const verifyRunner = { run: vi.fn(async () => void (seen = s.cls.tenant())) };
    const processor = new CheckpointExportProcessor(s.runner, verifyRunner, s.cls as any);
    await processor.process({ id: 'j2', data: { kind: 'verify-upload', checkpointId: 'c', tenantId: TENANT_B } } as any);
    expect(seen).toBe(TENANT_B);
  });

  it('a job without a tenant id is unrecoverable — the tenant never comes from the row', async () => {
    const s = await exportSetup();
    const processor = new CheckpointExportProcessor(s.runner, { run: vi.fn() }, s.cls as any);
    await expect(processor.process({ id: 'j3', data: { kind: 'create', checkpointId: s.row.id } } as any)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processor.process({ id: 'j4', data: { kind: 'create', checkpointId: s.row.id, tenantId: 'not-a-uuid' } } as any)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(s.raw.get(s.row.id).status).toBe('PENDING');
  });

  it('the SAFETY export inside a restore runs in the restore tenant and leaves the restore session untouched', async () => {
    const s = await exportSetup();
    const restoreUser = { id: 'restore-user', tenantId: TENANT_A };
    await s.cls.run(async () => {
      s.cls.set('tenantId', TENANT_A);
      s.cls.set('user', restoreUser);
      await s.runner.run(s.row.id);
      expect(s.cls.get('user')).toBe(restoreUser);
    });
    expect(s.raw.get(s.row.id).status).toBe('READY');
    expect(new Set(s.repo.scopedCalls.map((c) => c.tenant))).toEqual(new Set([TENANT_A]));
  });

  describe('sweepers (cron: no context at all)', () => {
    const NOW = new Date('2026-10-01T12:00:00.000Z');
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    function sweeperSetup() {
      const cls = strictCls();
      const raw = new FakeCheckpointRepo();
      const repo = tenantScoped(raw, cls, 'TenantCheckpoint', ANY_TENANT);
      const sweeper = new CheckpointSweeper(repo as any, new FakeStore(), fakeSettings({ 'tenantCheckpoint.maxRetained': 1 }), fakeEvents().emitter, cls as any, fakeRedis().redis);
      sweeper.now = () => NOW;
      return { raw, repo, sweeper };
    }

    it('stale exports: scanned unscoped, each row failed inside its own tenant session', async () => {
      const s = sweeperSetup();
      const a = s.raw.add({ tenantId: TENANT_A, status: 'RUNNING' as never, heartbeatAt: ago(5 * 60_000) });
      const b = s.raw.add({ tenantId: TENANT_B, status: 'RUNNING' as never, heartbeatAt: ago(5 * 60_000) });
      await s.sweeper.sweepStaleExports();
      expect([s.raw.get(a.id).status, s.raw.get(b.id).status]).toEqual(['FAILED', 'FAILED']);
      const writes = s.repo.scopedCalls.filter((c) => !ANY_TENANT.includes(c.method));
      expect(writes.every((c) => c.tenant === TENANT_A || c.tenant === TENANT_B)).toBe(true);
    });

    it('idle uploads: scanned unscoped (findIdleUploads), each row cancelled inside its tenant session', async () => {
      const s = sweeperSetup();
      const idle = s.raw.add({ tenantId: TENANT_B, status: 'UPLOADING' as never, uploadId: 'u', objectKey: 'k', updatedAt: ago(25 * 3_600_000) });
      await s.sweeper.sweepIdleUploads();
      expect(s.raw.get(idle.id).status).toBe('CANCELLED');
      expect(s.repo.scopedCalls.find((c) => c.method === 'findIdleUploads')).toBeDefined();
    });

    it('retention: scanned unscoped (findReadyAnyTenant), deleted inside each tenant session', async () => {
      const s = sweeperSetup();
      s.raw.add({ tenantId: TENANT_A, status: 'READY' as never, createdAt: ago(2_000), objectKey: 'a1' });
      const old = s.raw.add({ tenantId: TENANT_A, status: 'READY' as never, createdAt: ago(9_000), objectKey: 'a2' });
      await s.sweeper.sweepRetention();
      expect(s.raw.softDeleted).toEqual([old.id]);
      expect(s.repo.scopedCalls.find((c) => c.method === 'softDelete')?.tenant).toBe(TENANT_A);
    });
  });
});
