/**
 * BlobStorageService Unit Tests
 *
 * The service is a thin delegate over the factory-selected provider, so the
 * factory + a provider are faked. Each test asserts (a) the provider is resolved
 * via the factory and (b) the call is forwarded verbatim and its result returned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';
import { StorageProvider } from '@arcaai/types';

import { BlobStorageService } from '../blob-storage.service';
import type { IBlobStorageProvider } from '../providers/IBlobStorageProvider';
import type { BlobStorageProviderFactory } from '../providers/blob-storage.provider.factory';

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
    createBucket: vi.fn().mockResolvedValue(undefined),
    deleteBucket: vi.fn().mockResolvedValue(undefined),
    bucketExists: vi.fn().mockResolvedValue(true),
    setLifecycle: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

describe('BlobStorageService', () => {
  let provider: ReturnType<typeof makeProvider>;
  let factory: { getProvider: ReturnType<typeof vi.fn>; getProviderForBucket: ReturnType<typeof vi.fn> };
  let service: BlobStorageService;

  beforeEach(() => {
    provider = makeProvider();
    factory = {
      // Data-plane calls resolve per tenant + bucket; health uses the global provider.
      getProvider: vi.fn().mockResolvedValue(provider),
      getProviderForBucket: vi.fn().mockResolvedValue(provider),
    };
    service = new BlobStorageService(factory as unknown as BlobStorageProviderFactory);
  });

  it('resolves the provider through the factory before delegating', async () => {
    await service.putObject({ bucket: 'b', key: 'k', body: Buffer.from('data') });
    expect(factory.getProviderForBucket).toHaveBeenCalledTimes(1);
  });

  it('resolves the provider for the request bucket (no tenant context → undefined tenant)', async () => {
    await service.getObject({ bucket: 'audio', key: 'k' });
    expect(factory.getProviderForBucket).toHaveBeenCalledWith(undefined, 'audio');
  });

  it('delegates putObject verbatim', async () => {
    const params = { bucket: 'b', key: 'k', body: Buffer.from('data'), contentType: 'text/plain', metadata: { a: '1' } };
    await service.putObject(params);
    expect(provider.putObject).toHaveBeenCalledWith(params);
  });

  it('delegates getObject and returns the buffer', async () => {
    const buf = Buffer.from('hello');
    provider.getObject.mockResolvedValue(buf);
    await expect(service.getObject({ bucket: 'b', key: 'k' })).resolves.toBe(buf);
    expect(provider.getObject).toHaveBeenCalledWith({ bucket: 'b', key: 'k' });
  });

  it('delegates getObjectStream and returns the stream', async () => {
    const stream = Readable.from(['chunk']);
    provider.getObjectStream.mockResolvedValue(stream);
    await expect(service.getObjectStream({ bucket: 'b', key: 'k' })).resolves.toBe(stream);
  });

  it('delegates deleteObject', async () => {
    await service.deleteObject({ bucket: 'b', key: 'k' });
    expect(provider.deleteObject).toHaveBeenCalledWith({ bucket: 'b', key: 'k' });
  });

  it('delegates listObjects with pagination params and returns the page', async () => {
    const page = { objects: [{ key: 'a', size: 1 }], nextContinuationToken: 'tok', isTruncated: true };
    provider.listObjects.mockResolvedValue(page);
    const params = { bucket: 'b', prefix: 'p/', continuationToken: 'c', maxKeys: 10 };
    await expect(service.listObjects(params)).resolves.toBe(page);
    expect(provider.listObjects).toHaveBeenCalledWith(params);
  });

  it('delegates presignGet and returns the URL', async () => {
    await expect(service.presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 60 })).resolves.toBe('https://signed/get');
    expect(provider.presignGet).toHaveBeenCalledWith({ bucket: 'b', key: 'k', expiresInSeconds: 60 });
  });

  it('delegates presignPut and returns the URL', async () => {
    const params = { bucket: 'b', key: 'k', expiresInSeconds: 60, contentType: 'image/png' };
    await expect(service.presignPut(params)).resolves.toBe('https://signed/put');
    expect(provider.presignPut).toHaveBeenCalledWith(params);
  });

  it('delegates createBucket', async () => {
    await service.createBucket('bucket-1');
    expect(provider.createBucket).toHaveBeenCalledWith('bucket-1');
  });

  it('delegates deleteBucket', async () => {
    await service.deleteBucket('bucket-1');
    expect(provider.deleteBucket).toHaveBeenCalledWith('bucket-1');
  });

  it('delegates bucketExists and returns the boolean', async () => {
    provider.bucketExists.mockResolvedValue(false);
    await expect(service.bucketExists('bucket-1')).resolves.toBe(false);
    expect(provider.bucketExists).toHaveBeenCalledWith('bucket-1');
  });

  it('delegates setLifecycle', async () => {
    const rules = [{ id: 'r1', enabled: true, expirationDays: 30 }];
    await service.setLifecycle('bucket-1', rules);
    expect(provider.setLifecycle).toHaveBeenCalledWith('bucket-1', rules);
  });

  describe('healthCheck', () => {
    it('delegates to the provider and returns its result', async () => {
      provider.healthCheck.mockResolvedValue(true);
      await expect(service.healthCheck()).resolves.toBe(true);
    });

    it('returns false when the provider cannot be resolved (misconfiguration)', async () => {
      factory.getProvider.mockRejectedValue(new Error('no storage configuration'));
      await expect(service.healthCheck()).resolves.toBe(false);
    });
  });
});
