/**
 * TASK-1025 G2 — `BlobStorageService` is the one chokepoint every name-addressed
 * read, write and presign goes through (the storage controller, transcription
 * uploads, the tenant-bucket service). A bucket whose row was retained after
 * its tenant was deleted (ARCHIVED) or that the purge is working on
 * (SUSPENDED) must be refused THERE, not only in the one service that happens
 * to look rows up by id.
 */
import { NotFoundException } from '@nestjs/common';
import { Readable } from 'stream';
import { ResourceStatusType } from '@arcaai/domains';
import { StorageProvider } from '@arcaai/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobStorageService } from '../blob-storage.service';
import { TenantBucketStorageGate } from '../tenant-bucket-storage.gate';

function makeProvider() {
  return {
    provider: StorageProvider.MINIO,
    putObject: vi.fn().mockResolvedValue(undefined),
    getObject: vi.fn().mockResolvedValue(Buffer.from('x')),
    getObjectStream: vi.fn().mockResolvedValue(Readable.from(['x'])),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    listObjects: vi.fn().mockResolvedValue({ objects: [], isTruncated: false }),
    presignGet: vi.fn().mockResolvedValue('https://signed/get'),
    presignPut: vi.fn().mockResolvedValue('https://signed/put'),
  };
}

describe('BlobStorageService + TenantBucketStorageGate — TASK-1025 G2 access cut', () => {
  let provider: ReturnType<typeof makeProvider>;
  const bucketRepo = { findAll: vi.fn() };
  const factory = { getProviderForBucket: vi.fn() };
  const cls = { get: vi.fn(() => 'tenant-1') };
  let service: BlobStorageService;

  const calls = (s: BlobStorageService) => [
    () => s.putObject({ bucket: 'hope-recordings-acme', key: 'a.wav', body: Buffer.from('x') }),
    () => s.getObject({ bucket: 'hope-recordings-acme', key: 'a.wav' }),
    () => s.getObjectStream({ bucket: 'hope-recordings-acme', key: 'a.wav' }),
    () => s.deleteObject({ bucket: 'hope-recordings-acme', key: 'a.wav' }),
    () => s.listObjects({ bucket: 'hope-recordings-acme' }),
    () => s.presignGet({ bucket: 'hope-recordings-acme', key: 'a.wav', expiresInSeconds: 60 }),
    () => s.presignPut({ bucket: 'hope-recordings-acme', key: 'a.wav', expiresInSeconds: 60 }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    provider = makeProvider();
    factory.getProviderForBucket.mockResolvedValue(provider);
    service = new BlobStorageService(factory as never, cls as never, new TenantBucketStorageGate(bucketRepo as never));
  });

  for (const status of [ResourceStatusType.ARCHIVED, ResourceStatusType.SUSPENDED]) {
    it(`refuses every object operation on a ${status} bucket with a 404, before reaching the provider`, async () => {
      bucketRepo.findAll.mockResolvedValue([{ name: 'hope-recordings-acme', tenantId: 'tenant-1', resourceStatus: status }]);

      for (const call of calls(service)) {
        await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(factory.getProviderForBucket).not.toHaveBeenCalled();
    });
  }

  it('looks the bucket up by name across every live status (the default ENABLED-only lookup would miss it)', async () => {
    bucketRepo.findAll.mockResolvedValue([]);

    await service.listObjects({ bucket: 'hope-recordings-acme' });

    expect(bucketRepo.findAll).toHaveBeenCalledWith({ filters: { name: 'hope-recordings-acme' } });
  });

  it('lets an ENABLED bucket and an unregistered bucket through untouched', async () => {
    bucketRepo.findAll.mockResolvedValueOnce([{ name: 'hope-recordings-acme', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }]);
    await expect(service.getObject({ bucket: 'hope-recordings-acme', key: 'a.wav' })).resolves.toEqual(Buffer.from('x'));

    bucketRepo.findAll.mockResolvedValueOnce([]);
    await expect(service.getObject({ bucket: 'hope-audio', key: 'a.wav' })).resolves.toEqual(Buffer.from('x'));
  });

  it('does not gate when the lookup itself fails (tenant-less worker context) — it logs and lets the call through', async () => {
    bucketRepo.findAll.mockRejectedValue(new Error('TenantScope: tenant context required'));

    await expect(service.listObjects({ bucket: 'hope-recordings-acme' })).resolves.toEqual({ objects: [], isTruncated: false });
  });

  it('keeps working without a gate (direct construction, no DB)', async () => {
    const ungated = new BlobStorageService(factory as never, cls as never);
    await expect(ungated.listObjects({ bucket: 'x' })).resolves.toEqual({ objects: [], isTruncated: false });
  });
});
