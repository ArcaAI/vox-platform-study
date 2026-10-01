import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { SysEventType } from '@arcaai/domains';
import { openArchive, tableEntryName } from '../../archive';
import { fakeSealing, TENANT_A } from '../../archive/__tests__/helpers';
import { CHECKPOINT_REGISTRY } from '../../registry/registry';
import { CheckpointExportRunner } from '../export-runner';
import { countCsvRecords } from '../csv-record-counter';
import { FakeCheckpointRepo, FakeDb, type FakeDbOptions, FakeStore, fakeBlobs, fakeCls, fakeEvents, fakeSettings } from './fakes';

const NON_EXCLUDED = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED');

async function setup(opts: { db?: FakeDbOptions; objects?: Record<string, Buffer>; dedicated?: string[]; tenantId?: string; includesMedia?: boolean } = {}) {
  const sealing = fakeSealing();
  const { plaintext, platformWrapped } = await sealing.generateDataKey();
  const repo = new FakeCheckpointRepo();
  const row = repo.add({ tenantId: opts.tenantId ?? TENANT_A, includesMedia: opts.includesMedia ?? true, keyEnvelope: { platform: platformWrapped } });
  const db = new FakeDb(opts.db);
  const store = new FakeStore();
  const blobs = fakeBlobs(opts.objects ?? {}, opts.dedicated);
  const events = fakeEvents();
  const runner = new CheckpointExportRunner(repo as any, db, sealing, store, blobs.factory, fakeSettings({ 'tenantCheckpoint.retentionDays': 7 }), events.emitter, fakeCls());
  runner.heartbeatIntervalMs = 60_000;
  return { runner, repo, row, db, store, blobs, events, dataKey: plaintext, sealing };
}

async function readEntries(file: Buffer, dataKey: Buffer) {
  const r = await openArchive(Readable.from([file]), dataKey);
  const entries: { name: string; body: Buffer }[] = [];
  for await (const e of r.entries()) entries.push({ name: e.name, body: Buffer.concat(await e.body.toArray()) });
  return { entries, manifest: r.manifest(), header: r.header };
}

describe('countCsvRecords', () => {
  it('counts a quoted field containing newlines (and escaped quotes) as one record', () => {
    expect(countCsvRecords(Buffer.from('id,note\n1,"line one\nline ""two""\nthree"\n2,plain\n'))).toBe(3);
    expect(countCsvRecords(Buffer.from('id\n'))).toBe(1);
    expect(countCsvRecords(Buffer.from('id\n1'))).toBe(2);
    expect(countCsvRecords(Buffer.alloc(0))).toBe(0);
  });
});

describe('CheckpointExportRunner', () => {
  it('writes tenant.json, one entry per non-EXCLUDED descriptor in registry order, then media and claim checks, then the manifest; row READY', async () => {
    const s = await setup({
      db: {
        csv: { Agent: 'id,notes\n"a1","multi\nline ""quoted"" note"\n"a2",x\n' },
        columns: { Agent: ['id', 'notes'] },
        media: [{ id: 'm1', bucketId: 'b1', uri: 's3://tenant-audio/2026/10/01/rec.wav' }],
        refs: [{ store: 's3', bucket: 'harness-claim-check', key: 'abc123', size: 3 }],
      },
      objects: { 'tenant-audio/2026/10/01/rec.wav': Buffer.from('RIFF'), 'harness-claim-check/abc123': Buffer.from('xyz') },
    });

    await s.runner.run(s.row.id);

    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('READY');
    const file = s.store.objects.get(`${TENANT_A}/${s.row.id}.hcp`)!;
    expect(file).toBeDefined();
    const { entries, manifest, header } = await readEntries(file, s.dataKey);
    const names = entries.map((e) => e.name);
    expect(names[0]).toBe('tenant.json');
    expect(names.slice(1, 1 + NON_EXCLUDED.length)).toEqual(NON_EXCLUDED.map((d) => tableEntryName(d.model)));
    expect(names.slice(1 + NON_EXCLUDED.length)).toEqual(['media/b1/2026/10/01/rec.wav', 'claimcheck/abc123']);

    const agent = manifest.tables.find((t) => t.model === 'Agent')!;
    expect(agent.rowCount).toBe(2);
    expect(agent.columns).toEqual(['id', 'notes']);
    expect(gunzipSync(entries.find((e) => e.name === 'db/Agent.csv.gz')!.body).toString()).toContain('multi\nline');
    expect(manifest.media).toEqual([expect.objectContaining({ entry: 'media/b1/2026/10/01/rec.wav', bucketId: 'b1', key: '2026/10/01/rec.wav', size: 4 })]);
    expect(manifest.claimChecks).toEqual([expect.objectContaining({ entry: 'claimcheck/abc123', contentKey: 'abc123', size: 3 })]);
    expect(manifest.schemaFingerprint).toBe(header.schemaFingerprint);
    expect(header.tenantKey).toBe('acme');

    expect(row.manifestSummary.tables.find((t: { model: string }) => t.model === 'Agent')).toEqual({ model: 'Agent', columns: ['id', 'notes'], rowCount: 2 });
    expect(row.sizeBytes).toBe(file.length);
    expect(row.sourceDeploymentId).toBe('test-deployment');
    expect(row.schemaFingerprint).toBe(header.schemaFingerprint);
    expect(row.expiresAt.getTime() - row.finishedAt.getTime()).toBe(7 * 86_400_000);
    expect(s.events.emitted.at(-1)).toMatchObject({ type: SysEventType.ResourceUpdated, payload: { resourceId: s.row.id } });

    // One REPEATABLE READ snapshot, the tenant id inlined as a literal into COPY, released once.
    expect(s.db.statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(s.db.statements).toContain('COMMIT');
    expect(s.db.copies[0]).toContain(`'${TENANT_A}'`);
    expect(s.db.copies.every((c) => !c.includes('$1'))).toBe(true);
    expect(s.db.released).toBe(1);
  });

  it('refuses a tenant id that is not a UUID before any COPY runs', async () => {
    const s = await setup({ tenantId: "x'; DROP TABLE t; --" });
    await s.runner.run(s.row.id);
    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('EXPORT_FAILED');
    expect(s.db.copies).toHaveLength(0);
  });

  it('stops between tables when a cancel is requested: writer and upload aborted, row CANCELLED', async () => {
    const s = await setup();
    let finds = 0;
    s.repo.onFind = (row) => {
      if (++finds === 6) row.cancelRequestedAt = new Date();
    };
    await s.runner.run(s.row.id);
    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('CANCELLED');
    expect(s.store.aborted).toEqual([`${TENANT_A}/${s.row.id}.hcp`]);
    expect(s.store.objects.size).toBe(0);
    expect(s.db.copies.length).toBeGreaterThan(0);
    expect(s.db.copies.length).toBeLessThan(NON_EXCLUDED.length);
    expect(s.db.statements).toContain('ROLLBACK');
  });

  it('a thrown error marks the row FAILED(EXPORT_FAILED) with no stack and no raw message in failureDetail', async () => {
    const phi = 'invalid input syntax: "Jane Doe, DOB 1970-01-01"';
    const err = Object.assign(new Error(phi), { code: '22P02' });
    const s = await setup({ db: { failOnCopy: { model: NON_EXCLUDED[2].model, error: err } } });
    await s.runner.run(s.row.id);
    const row = s.repo.get(s.row.id);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('EXPORT_FAILED');
    expect(row.failureDetail).not.toContain('Jane');
    expect(row.failureDetail).not.toMatch(/\n\s+at /);
    expect(row.failureDetail).toContain('22P02');
    expect(s.store.aborted).toHaveLength(1);
  });

  it("DEDICATED-bucket media is listed in notCaptured and never read; a missing object is notCaptured too", async () => {
    const s = await setup({
      db: {
        media: [
          { id: 'm-ded', bucketId: 'bd', uri: 's3://byo-bucket/a.wav' },
          { id: 'm-gone', bucketId: 'b1', uri: 's3://tenant-audio/gone.wav' },
        ],
      },
      dedicated: ['byo-bucket'],
    });
    await s.runner.run(s.row.id);
    expect(s.repo.get(s.row.id).status).toBe('READY');
    expect(s.blobs.reads).toEqual(['tenant-audio/gone.wav']);
    const { manifest } = await readEntries(s.store.objects.get(`${TENANT_A}/${s.row.id}.hcp`)!, s.dataKey);
    expect(manifest.notCaptured).toEqual(['media:m-ded:DEDICATED_BUCKET', 'media:m-gone:MISSING']);
    expect(manifest.media).toEqual([]);
  });

  it('is a no-op for a row that is no longer PENDING (re-delivered job)', async () => {
    const s = await setup();
    s.repo.get(s.row.id).status = 'READY';
    await s.runner.run(s.row.id);
    expect(s.repo.writes).toHaveLength(0);
    expect(s.db.statements).toHaveLength(0);
  });
});
