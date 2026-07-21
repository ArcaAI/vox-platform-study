/**
 * Close residual security gaps in the legacy end-user
 * StorageController. Three findings, all scoped to this controller:
 *
 *  - F-1  (HIGH, cross-tenant leak): `GET /storage/buckets` (`listBuckets`)
 *         must return ONLY the caller's tenant-owned buckets via the
 *         tenant-scoped `tenantBucketService.listBuckets()`, never the global
 *         `s3Service.listAllBuckets()`.
 *  - F-8  (MED, name/slug inconsistency): `uploadFile` must not resolve the
 *         bucket by slug nor fall back to the raw `:name` param. The route is
 *         `@TenantOwnedResource`-guarded on `:name`, so `:name` is already a
 *         validated tenant-owned physical bucket — use it directly and 404 via
 *         `getBucketByName` when the record is absent.
 *  - F-18 (MED, path traversal): `getFileInfo` and `deleteFile` must reject a
 *         `:key` containing `..`, `/` or `\`, mirroring the existing check in
 *         `uploadFile`/`createBucket`.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageController } from '../storage.controller';

const mockBlobStorage = {
  createBucket: vi.fn(),
  deleteBucket: vi.fn(),
  listObjects: vi.fn(),
  putObject: vi.fn(),
  presignGet: vi.fn(),
  deleteObject: vi.fn(),
};

// Retained only for the F-1 assertion (the global listAllBuckets must never be
// called) and the S3-only `updateBucket` metadata-tag path.
const mockS3Service = {
  listAllBuckets: vi.fn(),
  updateBucket: vi.fn(),
};

const mockMediaService = {
  create: vi.fn(),
};

const mockTenantBucketService = {
  listBuckets: vi.fn(),
  getBucketByName: vi.fn(),
  getBucketBySlug: vi.fn(),
  registerBucket: vi.fn(),
};

const mockS3HealthService = {
  checkHealth: vi.fn(),
};

// StorageController now also generates image derivatives
// on upload; these cases all upload non-images, so it is never invoked.
const mockImageThumbnailService = {
  generateWebpThumbnail: vi.fn(),
};

const createMockBucketResponse = (
  overrides: Partial<{ id: string; tenantId: string; name: string; slug: string; createdAt: string }> = {},
) => ({
  id: overrides.id ?? 'bucket-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  name: overrides.name ?? 'arcaai-audio-recordings',
  slug: overrides.slug ?? 'audio_recordings',
  description: 'Audio recordings',
  bucketType: 'SYSTEM',
  pathPattern: '{yyyy}/{MM}/{dd}',
  isSystemBucket: true,
  resourceStatus: 'ENABLED',
  createdAt: overrides.createdAt ?? '2026-03-08T00:00:00.000Z',
  updatedAt: '2026-03-08T00:00:00.000Z',
});

const createMockFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'recording.wav',
    encoding: '7bit',
    mimetype: 'audio/wav',
    size: 1024,
    buffer: Buffer.from('audio-bytes'),
    ...overrides,
  }) as unknown as Express.Multer.File;

// Keys that must be rejected as path-traversal attempts.
const TRAVERSAL_KEYS = ['../', '/etc/passwd', '..\\'] as const;

describe('TASK-318 W2 — StorageController tenant scoping & traversal hardening', () => {
  let controller: StorageController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new StorageController(
      mockBlobStorage as any,
      mockS3Service as any,
      mockMediaService as any,
      mockTenantBucketService as any,
      mockS3HealthService as any,
      mockImageThumbnailService as any,
    );
  });

  // F-1 ---------------------------------------------------------------------
  describe('F-1 listBuckets — returns only tenant-owned buckets', () => {
    it('maps tenant-scoped buckets and never calls the global listAllBuckets', async () => {
      mockTenantBucketService.listBuckets.mockResolvedValue([
        createMockBucketResponse({ name: 'arcaai-audio', createdAt: '2026-01-01T00:00:00.000Z' }),
        createMockBucketResponse({ name: 'arcaai-uploads', createdAt: '2026-02-02T00:00:00.000Z' }),
      ]);

      const result = await controller.listBuckets();

      expect(mockTenantBucketService.listBuckets).toHaveBeenCalledTimes(1);
      expect(mockS3Service.listAllBuckets).not.toHaveBeenCalled();
      expect(result).toEqual([
        { name: 'arcaai-audio', creationDate: '2026-01-01T00:00:00.000Z' },
        { name: 'arcaai-uploads', creationDate: '2026-02-02T00:00:00.000Z' },
      ]);
    });
  });

  // F-8 ---------------------------------------------------------------------
  describe('F-8 uploadFile — no slug resolution / no raw fallback', () => {
    it('uses the validated :name as the physical bucket and never resolves by slug', async () => {
      const bucket = createMockBucketResponse({ name: 'arcaai-custom-bucket' });
      mockTenantBucketService.getBucketByName.mockResolvedValue(bucket);
      mockMediaService.create.mockResolvedValue({ id: 'media-123' });
      mockBlobStorage.putObject.mockResolvedValue(undefined);

      const file = createMockFile({ originalname: 'note.txt', mimetype: 'text/plain', size: 10, buffer: Buffer.from('hi') });

      const result = await controller.uploadFile('arcaai-custom-bucket', file, 'note.txt');

      expect(mockBlobStorage.putObject).toHaveBeenCalledWith({
        bucket: 'arcaai-custom-bucket',
        key: 'note.txt',
        body: file.buffer,
        contentType: 'text/plain',
      });
      expect(mockTenantBucketService.getBucketByName).toHaveBeenCalledWith('arcaai-custom-bucket');
      expect(mockTenantBucketService.getBucketBySlug).not.toHaveBeenCalled();
      expect(result.key).toBe('note.txt');
      expect(result.mediaId).toBe('media-123');
      expect(mockMediaService.create).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 's3://arcaai-custom-bucket/note.txt' }),
      );
    });

    it('throws NotFoundException when the bucket record is absent (no raw fallback)', async () => {
      mockTenantBucketService.getBucketByName.mockResolvedValue(null);

      await expect(controller.uploadFile('ghost-bucket', createMockFile(), 'note.txt')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(mockBlobStorage.putObject).not.toHaveBeenCalled();
      expect(mockTenantBucketService.getBucketBySlug).not.toHaveBeenCalled();
    });

    it('still rejects a traversal file key', async () => {
      await expect(controller.uploadFile('arcaai-bucket', createMockFile(), '../escape.txt')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockBlobStorage.putObject).not.toHaveBeenCalled();
    });
  });

  // F-18 --------------------------------------------------------------------
  describe('F-18 getFileInfo — rejects traversal keys', () => {
    it.each(TRAVERSAL_KEYS)('rejects key %j with BadRequestException', async (key) => {
      await expect(controller.getFileInfo('arcaai-bucket', key)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockBlobStorage.presignGet).not.toHaveBeenCalled();
    });

    it('returns a presigned url for a safe key', async () => {
      mockBlobStorage.presignGet.mockResolvedValue('https://signed.example/url');

      const result = await controller.getFileInfo('arcaai-bucket', 'recording.wav');

      expect(result).toEqual({ key: 'recording.wav', url: 'https://signed.example/url' });
      expect(mockBlobStorage.presignGet).toHaveBeenCalledWith({
        bucket: 'arcaai-bucket',
        key: 'recording.wav',
        expiresInSeconds: 3600,
      });
    });
  });

  describe('F-18 deleteFile — rejects traversal keys', () => {
    it.each(TRAVERSAL_KEYS)('rejects key %j with BadRequestException', async (key) => {
      await expect(controller.deleteFile('arcaai-bucket', key)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockBlobStorage.deleteObject).not.toHaveBeenCalled();
    });

    it('deletes a safe key', async () => {
      mockBlobStorage.deleteObject.mockResolvedValue(undefined);

      const result = await controller.deleteFile('arcaai-bucket', 'recording.wav');

      expect(result).toEqual({ deleted: true, key: 'recording.wav' });
      expect(mockBlobStorage.deleteObject).toHaveBeenCalledWith({ bucket: 'arcaai-bucket', key: 'recording.wav' });
    });
  });
});
