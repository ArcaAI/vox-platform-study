/**
 * TASK-932 Lane T — storage browser "All tenants" view for an unscoped
 * platform admin: `GET /storage/buckets?includePhysical=true`.
 *
 * `listBuckets()` (no flag) is unchanged and stays covered by
 * `storage.controller.task318-w2.test.ts` (F-1: tenant-scoped only, never
 * calls `s3Service.listAllBuckets()`). This file covers the NEW branch: the
 * flag delegates to `ITenantBucketService.listBucketsCrossTenantWithPhysical`
 * and maps its richer rows onto `BucketInfoResponse`.
 */
import { BadRequestException } from '@nestjs/common';
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

const mockS3Service = {
  listAllBuckets: vi.fn(),
  updateBucket: vi.fn(),
};

const mockMediaService = {
  create: vi.fn(),
};

const mockTenantBucketService = {
  listBuckets: vi.fn(),
  listBucketsCrossTenantWithPhysical: vi.fn(),
  getBucketByName: vi.fn(),
  getBucketBySlug: vi.fn(),
  registerBucket: vi.fn(),
};

const mockS3HealthService = {
  checkHealth: vi.fn(),
};

const mockImageThumbnailService = {
  generateWebpThumbnail: vi.fn(),
};

describe('StorageController — includePhysical (TASK-932)', () => {
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

  it('delegates to listBucketsCrossTenantWithPhysical and maps its rows onto BucketInfoResponse when includePhysical=true', async () => {
    mockTenantBucketService.listBucketsCrossTenantWithPhysical.mockResolvedValue([
      {
        name: 'hope-audio-arcaai',
        creationDate: '2026-01-01T00:00:00.000Z',
        tenantId: 'tenant-1',
        tenantName: 'ArcaAI',
        registered: true,
        physicalMissing: false,
        platform: false,
      },
      {
        name: 'orphan-bucket',
        creationDate: '2026-01-03T00:00:00.000Z',
        tenantId: null,
        tenantName: null,
        registered: false,
        physicalMissing: false,
        platform: false,
      },
      {
        name: 'hope-models',
        creationDate: '2026-01-04T00:00:00.000Z',
        tenantId: null,
        tenantName: null,
        registered: false,
        physicalMissing: false,
        platform: true,
      },
    ]);

    const result = await controller.listBuckets('true');

    expect(mockTenantBucketService.listBucketsCrossTenantWithPhysical).toHaveBeenCalledTimes(1);
    expect(mockTenantBucketService.listBuckets).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        name: 'hope-audio-arcaai',
        creationDate: '2026-01-01T00:00:00.000Z',
        tenantId: 'tenant-1',
        tenantName: 'ArcaAI',
        registered: true,
        physicalMissing: false,
        platform: false,
      },
      {
        name: 'orphan-bucket',
        creationDate: '2026-01-03T00:00:00.000Z',
        tenantId: null,
        tenantName: null,
        registered: false,
        physicalMissing: false,
        platform: false,
      },
      // The console keys its "Platform" badge (and the absence of a register
      // action) off this flag, so the mapping must carry it through.
      {
        name: 'hope-models',
        creationDate: '2026-01-04T00:00:00.000Z',
        tenantId: null,
        tenantName: null,
        registered: false,
        physicalMissing: false,
        platform: true,
      },
    ]);
  });

  it('propagates the 400 a tenant-bound (or non-elevated) caller gets from the service', async () => {
    mockTenantBucketService.listBucketsCrossTenantWithPhysical.mockRejectedValue(
      new BadRequestException('includePhysical is only available to a platform admin with no tenant context'),
    );

    await expect(controller.listBuckets('true')).rejects.toThrow(BadRequestException);
  });

  describe('POST /storage/buckets — platform bucket names are reserved', () => {
    it('rejects a platform bucket name BEFORE creating anything, so no untracked bucket is left behind', async () => {
      await expect(controller.createBucket({ name: 'hope-models' } as any)).rejects.toThrow(BadRequestException);

      expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
      expect(mockTenantBucketService.registerBucket).not.toHaveBeenCalled();
    });

    it('rejects regardless of casing or surrounding whitespace', async () => {
      await expect(controller.createBucket({ name: '  Hope-Models ' } as any)).rejects.toThrow(BadRequestException);

      expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
    });

    it('still creates and registers an ordinary bucket', async () => {
      mockBlobStorage.createBucket.mockResolvedValue(undefined);
      mockTenantBucketService.registerBucket.mockResolvedValue(null);

      const result = await controller.createBucket({ name: 'legacy-exports' } as any);

      expect(mockBlobStorage.createBucket).toHaveBeenCalledWith('legacy-exports');
      expect(mockTenantBucketService.registerBucket).toHaveBeenCalledWith('legacy-exports');
      expect(result).toEqual({ name: 'legacy-exports', created: true });
    });
  });

  it('falls through to the existing tenant-scoped listing when includePhysical is absent or not "true"', async () => {
    mockTenantBucketService.listBuckets.mockResolvedValue([
      { id: 'b1', tenantId: 'tenant-1', name: 'arcaai-audio', slug: 'audio', createdAt: '2026-01-01T00:00:00.000Z' } as any,
    ]);

    const withoutFlag = await controller.listBuckets();
    const withFalse = await controller.listBuckets('false');

    expect(mockTenantBucketService.listBucketsCrossTenantWithPhysical).not.toHaveBeenCalled();
    expect(withoutFlag).toEqual([{ name: 'arcaai-audio', creationDate: '2026-01-01T00:00:00.000Z' }]);
    expect(withFalse).toEqual([{ name: 'arcaai-audio', creationDate: '2026-01-01T00:00:00.000Z' }]);
  });
});
