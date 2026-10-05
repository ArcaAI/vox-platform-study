import { describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SysEventType, TenantCheckpointStatus } from '@arcaai/domains';
import { CHECKPOINT_UPLOAD_PART_BYTES } from '../contracts';
import { buildService, checkpointEntity, SYSTEM, TENANT_A, TENANT_B } from './service-fixture';

const emittedTypes = (emit: { mock: { calls: unknown[][] } }) => emit.mock.calls.map((c) => c[0]);

describe('TenantCheckpointService — create', () => {
  it('stores the platform wrap, adds the passphrase wrap, and never persists the passphrase', async () => {
    const f = buildService();
    await f.service.create(TENANT_A, { label: ' before upgrade ', includesMedia: true, passphrase: 'correct horse battery' });

    const saved = f.checkpoints.create.mock.calls[0][0] as { keyEnvelope: Record<string, unknown>; passphraseProtected: boolean; label: string };
    expect(saved.keyEnvelope.platform).toBe('vault:v1:WRAPPED');
    expect(saved.keyEnvelope.passphrase).toBeDefined();
    expect(saved.passphraseProtected).toBe(true);
    expect(saved.label).toBe('before upgrade');
    expect(JSON.stringify(saved)).not.toContain('correct horse battery');
    expect(f.dataKey.every((b) => b === 0)).toBe(true); // plaintext key wiped after wrapping
  });

  it('without a passphrase stores only the platform wrap', async () => {
    const f = buildService();
    await f.service.create(TENANT_A, { label: 'x', includesMedia: false });
    const saved = f.checkpoints.create.mock.calls[0][0] as { keyEnvelope: Record<string, unknown>; passphraseProtected: boolean };
    expect(Object.keys(saved.keyEnvelope)).toEqual(['platform']);
    expect(saved.passphraseProtected).toBe(false);
    expect(f.sealing.wrapWithPassphrase).not.toHaveBeenCalled();
  });

  it('queues a job that carries ids only, with the checkpoint id as the job id, and answers PENDING', async () => {
    const f = buildService();
    const out = await f.service.create(TENANT_A, { label: 'x', includesMedia: true, passphrase: 'correct horse battery' });

    const [, payload, opts] = f.exportQueue.add.mock.calls[0];
    expect(payload).toEqual({ kind: 'create', checkpointId: out.id, tenantId: TENANT_A });
    expect(JSON.stringify(payload)).not.toContain('correct horse');
    // A finished export must stay visible on the queue board, not vanish on completion.
    expect(opts).toMatchObject({ jobId: out.id, removeOnComplete: 100 });
    expect(out.status).toBe('PENDING');
    expect(out).not.toHaveProperty('keyEnvelope');
  });

  it('refuses the SYSTEM tenant with 403 SYSTEM_TENANT_NOT_CHECKPOINTABLE on every method', async () => {
    const f = buildService();
    const calls: Array<() => Promise<unknown>> = [
      () => f.service.create(SYSTEM, { label: 'x', includesMedia: true }),
      () => f.service.list(SYSTEM, {}),
      () => f.service.get(SYSTEM, 'id'),
      () => f.service.cancel(SYSTEM, 'id'),
      () => f.service.downloadUrl(SYSTEM, 'id'),
      () => f.service.delete(SYSTEM, 'id'),
      () => f.service.initUpload(SYSTEM, { filename: 'a.hcp', sizeBytes: 1 }),
      () => f.service.completeUpload(SYSTEM, 'u', { parts: [{ partNumber: 1, etag: 'e' }] }),
      () => f.service.abortUpload(SYSTEM, 'u'),
      () => f.service.restore(SYSTEM, 'id', { categories: ['CONFIG_CONTENT'], reason: 'long enough reason' }),
      () => f.service.listRestores(SYSTEM, {}),
      () => f.service.getRestore(SYSTEM, 'id'),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ response: { code: 'SYSTEM_TENANT_NOT_CHECKPOINTABLE' } });
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(f.checkpoints.create).not.toHaveBeenCalled();
  });

  it('a running export for the tenant → 409 TENANT_CHECKPOINT_BUSY', async () => {
    const f = buildService();
    f.checkpoints.findRunningByTenant.mockResolvedValue([checkpointEntity({ status: TenantCheckpointStatus.RUNNING })]);
    await expect(f.service.create(TENANT_A, { label: 'x', includesMedia: true })).rejects.toMatchObject({ response: { code: 'TENANT_CHECKPOINT_BUSY' } });
    expect(f.checkpoints.create).not.toHaveBeenCalled();
  });

  it('an active restore for the tenant → 409 TENANT_CHECKPOINT_BUSY; an idle upload does not block', async () => {
    const f = buildService();
    f.checkpoints.findRunningByTenant.mockResolvedValue([checkpointEntity({ status: TenantCheckpointStatus.UPLOADING })]);
    await expect(f.service.create(TENANT_A, { label: 'x', includesMedia: true })).resolves.toBeDefined();

    f.restores.findActiveByTenant.mockResolvedValue({ id: 'r1' });
    await expect(f.service.create(TENANT_A, { label: 'y', includesMedia: true })).rejects.toMatchObject({ response: { code: 'TENANT_CHECKPOINT_BUSY' } });
  });
});

describe('TenantCheckpointService — tenant pinning', () => {
  it("a checkpoint of another tenant is 404 on get, cancel, download and delete", async () => {
    const f = buildService();
    f.checkpoints.findByIdOrNull.mockResolvedValue(checkpointEntity({ tenantId: TENANT_B }));
    for (const call of [
      () => f.service.get(TENANT_A, 'x'),
      () => f.service.cancel(TENANT_A, 'x'),
      () => f.service.downloadUrl(TENANT_A, 'x'),
      () => f.service.delete(TENANT_A, 'x'),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(f.store.presignDownload).not.toHaveBeenCalled();
    expect(f.store.delete).not.toHaveBeenCalled();
  });

  it('a restore of another tenant is 404', async () => {
    const f = buildService();
    f.restores.findByIdOrNull.mockResolvedValue({ tenantId: TENANT_B, isDeleted: false });
    await expect(f.service.getRestore(TENANT_A, 'r')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TenantCheckpointService — download', () => {
  it('a RUNNING checkpoint → 409 CHECKPOINT_NOT_READY', async () => {
    const f = buildService();
    f.checkpoints.findByIdOrNull.mockResolvedValue(checkpointEntity({ status: TenantCheckpointStatus.RUNNING }));
    await expect(f.service.downloadUrl(TENANT_A, 'x')).rejects.toMatchObject({ response: { code: 'CHECKPOINT_NOT_READY' } });
    expect(f.store.presignDownload).not.toHaveBeenCalled();
  });

  it('issues a 900 s URL with the tenant-key filename and force-audits it', async () => {
    const f = buildService();
    const row = checkpointEntity({ createdAt: new Date('2026-10-01T12:34:56Z') });
    f.checkpoints.findByIdOrNull.mockResolvedValue(row);
    const out = await f.service.downloadUrl(TENANT_A, row.id);

    expect(out.filename).toBe(`ACME-20261001-1234-${row.id.slice(0, 8)}.hcp`);
    expect(f.store.presignDownload).toHaveBeenCalledWith(row.objectKey, out.filename, 900);
    expect(out.url).toBe('https://minio/presigned');
    const event = f.eventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceViewed)?.[1];
    expect(event).toMatchObject({ forceAuditLog: true, resourceId: row.id });
  });
});

describe('TenantCheckpointService — uploads', () => {
  it('over the size limit → 413 CHECKPOINT_TOO_LARGE, nothing created', async () => {
    const f = buildService();
    f.settings.resolve.mockReturnValue({ value: 1 });
    await expect(f.service.initUpload(TENANT_A, { filename: 'big.hcp', sizeBytes: 1024 ** 3 + 1 })).rejects.toMatchObject({
      response: { code: 'CHECKPOINT_TOO_LARGE' },
      status: 413,
    });
    expect(f.store.createUpload).not.toHaveBeenCalled();
    expect(f.checkpoints.create).not.toHaveBeenCalled();
  });

  it('computes ceil(size / part size) parts, presigns for 6 h, and answers the console contract', async () => {
    const f = buildService();
    const size = CHECKPOINT_UPLOAD_PART_BYTES * 2 + 1;
    const out = await f.service.initUpload(TENANT_A, { filename: 'a.hcp', sizeBytes: size });

    expect(out.parts).toHaveLength(3);
    expect(out.partSizeBytes).toBe(CHECKPOINT_UPLOAD_PART_BYTES);
    expect(out.uploadId).toBe('S3-UPLOAD-1');
    expect(f.store.presignUploadParts).toHaveBeenCalledWith(expect.any(String), 'S3-UPLOAD-1', 3, 6 * 60 * 60, {
      sizeBytes: size,
      partSizeBytes: CHECKPOINT_UPLOAD_PART_BYTES,
    });
    expect(out.checkpoint).toMatchObject({ status: 'UPLOADING', origin: 'UPLOADED', label: 'a.hcp', sizeBytes: size });
  });

  it('completing with an invalid part list → 400 UPLOAD_PARTS_INVALID and the upload stays open', async () => {
    const { CheckpointError } = await import('../contracts');
    const f = buildService();
    const row = checkpointEntity({ status: TenantCheckpointStatus.UPLOADING, origin: 'UPLOADED' as never, uploadId: 'S3-UPLOAD-1' });
    f.checkpoints.findByIdOrNull.mockResolvedValue(null);
    f.checkpoints.findFirst.mockResolvedValue(row);
    f.store.completeUpload.mockRejectedValue(new CheckpointError('UPLOAD_PARTS_INVALID', 'parts out of order'));

    await expect(f.service.completeUpload(TENANT_A, 'S3-UPLOAD-1', { parts: [{ partNumber: 2, etag: 'e' }] })).rejects.toMatchObject({
      response: { code: 'UPLOAD_PARTS_INVALID' },
    });
    expect(f.checkpoints.updateWithVersion).not.toHaveBeenCalled();
    expect(f.exportQueue.add).not.toHaveBeenCalled();
  });

  it('completing queues the verification job (id verify-<id>) and leaves the row UPLOADING for the runner', async () => {
    const f = buildService();
    const row = checkpointEntity({ status: TenantCheckpointStatus.UPLOADING, origin: 'UPLOADED' as never, uploadId: 'S3-UPLOAD-1', sizeBytes: 123 });
    f.checkpoints.findByIdOrNull.mockResolvedValue(row);
    const out = await f.service.completeUpload(TENANT_A, row.id, { parts: [{ partNumber: 1, etag: 'e' }] });

    expect(out.status).toBe('UPLOADING');
    const [, payload, opts] = f.exportQueue.add.mock.calls[0];
    expect(payload).toEqual({ kind: 'verify-upload', checkpointId: row.id, tenantId: TENANT_A });
    expect(opts).toMatchObject({ jobId: `verify-${row.id}` });
    expect(opts.jobId).not.toContain(':'); // BullMQ rejects custom ids containing ':'
    const saved = f.checkpoints.updateWithVersion.mock.calls[0][1] as { uploadId: string | null; sizeBytes: number };
    expect(saved.uploadId).toBeNull();
    expect(saved.sizeBytes).toBe(123);
  });
});

describe('TenantCheckpointService — completed upload size enforcement', () => {
  const uploading = () => checkpointEntity({ status: TenantCheckpointStatus.UPLOADING, origin: 'UPLOADED' as never, uploadId: 'S3-UPLOAD-1', sizeBytes: 123 });

  it('an object whose size differs from the declaration → 400 UPLOAD_SIZE_MISMATCH, object deleted, row CANCELLED, nothing queued', async () => {
    const f = buildService();
    const row = uploading();
    f.checkpoints.findByIdOrNull.mockResolvedValue(row);
    f.store.completeUpload.mockResolvedValue({ sizeBytes: 124 });
    await expect(f.service.completeUpload(TENANT_A, row.id, { parts: [{ partNumber: 1, etag: 'e' }] })).rejects.toMatchObject({
      response: { code: 'UPLOAD_SIZE_MISMATCH' },
      status: 400,
    });
    expect(f.store.delete).toHaveBeenCalledWith(row.objectKey);
    const saved = f.checkpoints.updateWithVersion.mock.calls[0][1] as { status: string };
    expect(saved.status).toBe(TenantCheckpointStatus.CANCELLED);
    expect(f.exportQueue.add).not.toHaveBeenCalled();
  });

  it('an object over maxUploadSizeGb → 413 CHECKPOINT_TOO_LARGE, object deleted, row CANCELLED', async () => {
    const f = buildService();
    f.settings.resolve.mockReturnValue({ value: 1 });
    const row = uploading();
    f.checkpoints.findByIdOrNull.mockResolvedValue(row);
    f.store.completeUpload.mockResolvedValue({ sizeBytes: 1024 ** 3 + 1 });
    await expect(f.service.completeUpload(TENANT_A, row.id, { parts: [{ partNumber: 1, etag: 'e' }] })).rejects.toMatchObject({
      response: { code: 'CHECKPOINT_TOO_LARGE' },
      status: 413,
    });
    expect(f.store.delete).toHaveBeenCalledWith(row.objectKey);
    expect((f.checkpoints.updateWithVersion.mock.calls[0][1] as { status: string }).status).toBe(TenantCheckpointStatus.CANCELLED);
    expect(f.exportQueue.add).not.toHaveBeenCalled();
  });
});

describe('TenantCheckpointService — sys-events', () => {
  it('every mutation broadcasts one', async () => {
    const f = buildService();
    await f.service.create(TENANT_A, { label: 'x', includesMedia: true });
    expect(emittedTypes(f.eventEmitter.emit)).toEqual([SysEventType.ResourceCreated]);

    f.eventEmitter.emit.mockClear();
    const running = checkpointEntity({ status: TenantCheckpointStatus.RUNNING });
    f.checkpoints.findByIdOrNull.mockResolvedValue(running);
    await f.service.cancel(TENANT_A, running.id);
    expect(emittedTypes(f.eventEmitter.emit)).toEqual([SysEventType.ResourceUpdated]);

    f.eventEmitter.emit.mockClear();
    const ready = checkpointEntity();
    f.checkpoints.findByIdOrNull.mockResolvedValue(ready);
    await f.service.delete(TENANT_A, ready.id);
    expect(emittedTypes(f.eventEmitter.emit)).toEqual([SysEventType.ResourceDeleted]);
    expect(f.store.delete).toHaveBeenCalledWith(ready.objectKey);
    expect(f.checkpoints.softDelete).toHaveBeenCalledWith(ready.id, 'user-1');

    f.eventEmitter.emit.mockClear();
    await f.service.initUpload(TENANT_A, { filename: 'a.hcp', sizeBytes: 10 });
    expect(emittedTypes(f.eventEmitter.emit)).toEqual([SysEventType.ResourceCreated]);

    f.eventEmitter.emit.mockClear();
    const uploading = checkpointEntity({ status: TenantCheckpointStatus.UPLOADING, origin: 'UPLOADED' as never, uploadId: 'U' });
    f.checkpoints.findByIdOrNull.mockResolvedValue(uploading);
    await f.service.abortUpload(TENANT_A, uploading.id);
    expect(emittedTypes(f.eventEmitter.emit)).toEqual([SysEventType.ResourceUpdated]);
  });

  it('a checkpoint still being written cannot be deleted', async () => {
    const f = buildService();
    f.checkpoints.findByIdOrNull.mockResolvedValue(checkpointEntity({ status: TenantCheckpointStatus.RUNNING }));
    await expect(f.service.delete(TENANT_A, 'x')).rejects.toMatchObject({ response: { code: 'CHECKPOINT_IN_PROGRESS' } });
  });

  it('searching narrows by label and paginates one-based', async () => {
    const f = buildService();
    await f.service.list(TENANT_A, { page: 2, limit: 5, kind: 'SAFETY', search: 'nightly' });
    const props = f.checkpoints.findAll.mock.calls[0][0];
    expect(props).toMatchObject({ page: 2, limit: 5, search: 'nightly', searchFields: ['label'], where: { tenantId: TENANT_A, kind: 'SAFETY' } });
  });
});

describe('TenantCheckpointService — audit attribution', () => {
  it('a super admin with no CLS tenant downloading for tenant B is audited against tenant B, force-audited', async () => {
    const f = buildService({ roles: ['SUPER_ADMIN'] });
    f.cls.get.mockImplementation((key: string) => (key === 'user' ? { id: 'sa-1', roles: ['SUPER_ADMIN'] } : undefined));
    const row = checkpointEntity({ tenantId: TENANT_B, objectKey: `${TENANT_B}/o.hcp` });
    f.checkpoints.findByIdOrNull.mockResolvedValue(row);
    await f.service.downloadUrl(TENANT_B, row.id);
    const event = f.eventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceViewed)?.[1];
    expect(event).toMatchObject({ tenantId: TENANT_B, forceAuditLog: true, resourceId: row.id, responsibleEntityId: 'sa-1' });
  });

  it('every mutation event carries the target tenant, whatever the CLS tenant is', async () => {
    const f = buildService({ roles: ['SUPER_ADMIN'] });
    f.cls.get.mockImplementation((key: string) => (key === 'user' ? { id: 'sa-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? TENANT_B : undefined));
    await f.service.create(TENANT_A, { label: 'x', includesMedia: false });
    expect(f.eventEmitter.emit.mock.calls.every((c) => (c[1] as { tenantId: string }).tenantId === TENANT_A)).toBe(true);
  });
});
