/**
 * S3BlobProvider Unit Tests
 *
 * Strategy: mock the AWS SDK (external boundary) exactly like the existing
 * s3.service.test.ts. Verify each IBlobStorageProvider method constructs the
 * right command and that listObjects performs real token-based pagination.
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { StorageProvider } from '@arcaai/types';

// Shared send spy — reassigned per test. `mock`-prefixed so vitest allows it
// inside the hoisted vi.mock factory.
let mockSend: Mock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    send = (...args: unknown[]) => mockSend(...args);
  }
  // Plain vi.fn() (no arrow impl) so each command is constructable via `new`
  // and records its constructor args for assertions.
  return {
    S3Client: MockS3Client,
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
    ListObjectsV2Command: vi.fn(),
    CreateBucketCommand: vi.fn(),
    DeleteBucketCommand: vi.fn(),
    HeadBucketCommand: vi.fn(),
    ListBucketsCommand: vi.fn(),
    PutBucketLifecycleConfigurationCommand: vi.fn(),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example.com/url'),
}));

import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3BlobProvider } from '../s3-blob.provider';

function makeProvider(overrides: Record<string, unknown> = {}): S3BlobProvider {
  return new S3BlobProvider({
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
    provider: StorageProvider.MINIO,
    ...overrides,
  });
}

/** Build a readable-stream-like object matching the s3.service test pattern. */
function mockBodyStream(content: string) {
  const stream: { on: Mock } = {
    on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from(content));
      if (event === 'end') cb();
      return stream;
    }),
  };
  return stream;
}

describe('S3BlobProvider', () => {
  let provider: S3BlobProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend = vi.fn();
    provider = makeProvider();
  });

  it('exposes the configured provider id', () => {
    expect(provider.provider).toBe(StorageProvider.MINIO);
    expect(makeProvider({ provider: StorageProvider.AWS_S3 }).provider).toBe(StorageProvider.AWS_S3);
  });

  describe('putObject', () => {
    it('constructs PutObjectCommand with body, content type and metadata', async () => {
      mockSend.mockResolvedValue({});
      const body = Buffer.from('hello');

      await provider.putObject({
        bucket: 'b',
        key: 'k.txt',
        body,
        contentType: 'text/plain',
        metadata: { owner: 'tenant-1' },
      });

      expect(PutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'b',
        Key: 'k.txt',
        Body: body,
        ContentType: 'text/plain',
        Metadata: { owner: 'tenant-1' },
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('propagates SDK errors', async () => {
      mockSend.mockRejectedValue(new Error('AccessDenied'));
      await expect(provider.putObject({ bucket: 'b', key: 'k', body: Buffer.from('x') })).rejects.toThrow('AccessDenied');
    });
  });

  describe('getObject', () => {
    it('returns a Buffer assembled from the body stream', async () => {
      mockSend.mockResolvedValue({ Body: mockBodyStream('file-bytes') });

      const result = await provider.getObject({ bucket: 'b', key: 'k' });

      expect(result).toBeInstanceOf(Buffer);
      expect(result.toString()).toBe('file-bytes');
      expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k' });
    });

    it('throws when the object has no body', async () => {
      mockSend.mockResolvedValue({ Body: undefined });
      await expect(provider.getObject({ bucket: 'b', key: 'missing' })).rejects.toThrow();
    });
  });

  describe('getObjectStream', () => {
    it('returns the raw body stream', async () => {
      const body = mockBodyStream('streamed');
      mockSend.mockResolvedValue({ Body: body });

      const stream = await provider.getObjectStream({ bucket: 'b', key: 'k' });

      expect(stream).toBe(body);
      expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k' });
    });
  });

  describe('deleteObject', () => {
    it('constructs DeleteObjectCommand', async () => {
      mockSend.mockResolvedValue({});
      await provider.deleteObject({ bucket: 'b', key: 'k' });
      expect(DeleteObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k' });
    });
  });

  describe('listObjects', () => {
    it('passes prefix, continuation token and maxKeys and returns a normalized page', async () => {
      const lastModified = new Date('2026-01-01T00:00:00Z');
      mockSend.mockResolvedValue({
        Contents: [
          { Key: 'a.txt', Size: 10, LastModified: lastModified },
          { Key: 'b.txt', Size: 20, LastModified: lastModified },
        ],
        IsTruncated: true,
        NextContinuationToken: 'TOKEN-2',
      });

      const page = await provider.listObjects({ bucket: 'b', prefix: 'p/', continuationToken: 'TOKEN-1', maxKeys: 2 });

      expect(ListObjectsV2Command).toHaveBeenCalledWith({
        Bucket: 'b',
        Prefix: 'p/',
        ContinuationToken: 'TOKEN-1',
        MaxKeys: 2,
      });
      expect(page.objects).toEqual([
        { key: 'a.txt', size: 10, lastModified },
        { key: 'b.txt', size: 20, lastModified },
      ]);
      expect(page.isTruncated).toBe(true);
      expect(page.nextContinuationToken).toBe('TOKEN-2');
    });

    it('returns an empty, non-truncated page when there are no contents', async () => {
      mockSend.mockResolvedValue({ Contents: undefined, IsTruncated: false });

      const page = await provider.listObjects({ bucket: 'b' });

      expect(page.objects).toEqual([]);
      expect(page.isTruncated).toBe(false);
      expect(page.nextContinuationToken).toBeUndefined();
    });
  });

  describe('presign', () => {
    it('presignGet signs a GetObjectCommand with the requested expiry', async () => {
      const url = await provider.presignGet({ bucket: 'b', key: 'k', expiresInSeconds: 120 });

      expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k' });
      expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 120 });
      expect(url).toBe('https://signed.example.com/url');
    });

    it('presignPut signs a PutObjectCommand including content type', async () => {
      const url = await provider.presignPut({ bucket: 'b', key: 'k', expiresInSeconds: 60, contentType: 'image/png' });

      expect(PutObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'k', ContentType: 'image/png' });
      expect(getSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 60 });
      expect(url).toBe('https://signed.example.com/url');
    });
  });

  describe('bucket operations', () => {
    it('createBucket constructs CreateBucketCommand', async () => {
      mockSend.mockResolvedValue({});
      await provider.createBucket('new-bucket');
      expect(CreateBucketCommand).toHaveBeenCalledWith({ Bucket: 'new-bucket' });
    });

    it('deleteBucket constructs DeleteBucketCommand', async () => {
      mockSend.mockResolvedValue({});
      await provider.deleteBucket('old-bucket');
      expect(DeleteBucketCommand).toHaveBeenCalledWith({ Bucket: 'old-bucket' });
    });

    it('bucketExists returns true when HeadBucket succeeds', async () => {
      mockSend.mockResolvedValue({});
      await expect(provider.bucketExists('b')).resolves.toBe(true);
      expect(HeadBucketCommand).toHaveBeenCalledWith({ Bucket: 'b' });
    });

    it('bucketExists returns false on a 404 / NotFound', async () => {
      mockSend.mockRejectedValue({ name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      await expect(provider.bucketExists('missing')).resolves.toBe(false);
    });

    it('bucketExists rethrows non-404 errors', async () => {
      mockSend.mockRejectedValue({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      await expect(provider.bucketExists('forbidden')).rejects.toBeDefined();
    });
  });

  describe('setLifecycle', () => {
    it('maps rules to a PutBucketLifecycleConfigurationCommand', async () => {
      mockSend.mockResolvedValue({});

      await provider.setLifecycle('b', [
        { id: 'expire-tmp', prefix: 'tmp/', enabled: true, expirationDays: 7 },
        { id: 'disabled-rule', enabled: false },
      ]);

      expect(PutBucketLifecycleConfigurationCommand).toHaveBeenCalledWith({
        Bucket: 'b',
        LifecycleConfiguration: {
          Rules: [
            { ID: 'expire-tmp', Filter: { Prefix: 'tmp/' }, Status: 'Enabled', Expiration: { Days: 7 } },
            { ID: 'disabled-rule', Filter: { Prefix: '' }, Status: 'Disabled' },
          ],
        },
      });
    });
  });

  describe('healthCheck', () => {
    it('returns true when the probe succeeds', async () => {
      mockSend.mockResolvedValue({ Buckets: [] });
      await expect(provider.healthCheck()).resolves.toBe(true);
    });

    it('returns false when the probe fails', async () => {
      mockSend.mockRejectedValue(new Error('network down'));
      await expect(provider.healthCheck()).resolves.toBe(false);
    });
  });
});
