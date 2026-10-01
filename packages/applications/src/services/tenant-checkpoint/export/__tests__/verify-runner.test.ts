import { describe, expect, it } from 'vitest';

import { fakeSealing, TENANT_A, TENANT_B } from '../../archive/__tests__/helpers';
import { CheckpointExportRunner } from '../export-runner';
import { CheckpointVerifyRunner } from '../verify-runner';
import { FakeCheckpointRepo, FakeDb, FakeStore, fakeBlobs, fakeCls, fakeEvents, fakeSettings } from './fakes';

/** Produce a real sealed archive for `tenantId` with the export runner, returning its bytes and source id. */
async function exportedArchive(tenantId: string) {
  const sealing = fakeSealing();
  const { platformWrapped } = await sealing.generateDataKey();
  const repo = new FakeCheckpointRepo();
  const row = repo.add({ tenantId, includesMedia: false, keyEnvelope: { platform: platformWrapped } });
  const store = new FakeStore();
  const runner = new CheckpointExportRunner(repo as any, new FakeDb({ csv: { Agent: 'id\n"a1"\n' } }), sealing, store, fakeBlobs({}).factory, fakeSettings(), fakeEvents().emitter, fakeCls());
  await runner.run(row.id);
  expect(repo.get(row.id).status).toBe('READY');
  return { bytes: store.objects.get(`${tenantId}/${row.id}.hcp`)!, sourceId: row.id };
}

async function uploadedRow(bytes: Buffer, targetTenant: string) {
  const repo = new FakeCheckpointRepo();
  const store = new FakeStore();
  const row = repo.add({ tenantId: targetTenant, label: 'from laptop', status: 'UPLOADING' as never, uploadId: 'u1' });
  const key = `${targetTenant}/${row.id}.hcp`;
  repo.get(row.id).objectKey = key;
  store.objects.set(key, bytes);
  const events = fakeEvents();
  const runner = new CheckpointVerifyRunner(repo as any, fakeSealing(), store, fakeSettings({ 'tenantCheckpoint.retentionDays': 30 }), events.emitter, fakeCls());
  return { repo, store, row, runner, events, key };
}

describe('CheckpointVerifyRunner', () => {
  it('a valid uploaded archive → READY, origin UPLOADED, header-derived fields and manifestSummary filled, label kept', async () => {
    const { bytes, sourceId } = await exportedArchive(TENANT_A);
    const s = await uploadedRow(bytes, TENANT_A);
    await s.runner.run(s.row.id);
    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('READY');
    expect(row.origin).toBe('UPLOADED');
    expect(row.kind).toBe('MANUAL');
    expect(row.label).toBe('from laptop');
    expect(row.uploadId).toBeNull();
    expect(row.sizeBytes).toBe(bytes.length);
    expect(row.keyEnvelope).toEqual({ platform: expect.stringMatching(/^fake:/) });
    expect(row.schemaFingerprint).toEqual(expect.any(String));
    expect(row.sourceDeploymentId).toBe('test-deployment');
    expect(row.includesMedia).toBe(false);
    expect(row.manifestSummary.tables.find((t: { model: string }) => t.model === 'Agent')).toEqual({ model: 'Agent', columns: ['id'], rowCount: 1 });
    expect(row.metaData).toMatchObject({ sourceCheckpointId: sourceId });
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it('a WRONG_TENANT archive → FAILED with failureReason WRONG_TENANT and nothing else written', async () => {
    const { bytes } = await exportedArchive(TENANT_B);
    const s = await uploadedRow(bytes, TENANT_A);
    await s.runner.run(s.row.id);
    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('WRONG_TENANT');
    expect(row.keyEnvelope).toBeNull();
    expect(row.manifestSummary).toBeNull();
    expect(row.schemaFingerprint).toBeNull();
    expect(row.sourceDeploymentId).toBeNull();
    expect(row.sizeBytes).toBeNull();
    expect(row.origin).toBe('CREATED'); // untouched
  });

  it('refuses a duplicate of a checkpoint the tenant already holds', async () => {
    const { bytes, sourceId } = await exportedArchive(TENANT_A);
    const s = await uploadedRow(bytes, TENANT_A);
    s.repo.add({ id: sourceId, tenantId: TENANT_A, status: 'READY' as never });
    await s.runner.run(s.row.id);
    expect(s.repo.get(s.row.id)).toMatchObject({ status: 'FAILED', failureReason: 'DUPLICATE' });
  });

  it('is a no-op for a row that is not awaiting verification', async () => {
    const { bytes } = await exportedArchive(TENANT_A);
    const s = await uploadedRow(bytes, TENANT_A);
    s.repo.get(s.row.id).status = 'CANCELLED';
    await s.runner.run(s.row.id);
    expect(s.repo.writes).toHaveLength(0);
  });
});
