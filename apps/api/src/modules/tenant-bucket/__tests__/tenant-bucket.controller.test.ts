import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantBucketController } from '../tenant-bucket.controller';
import {
    TENANT_OWNED_RESOURCE_KEY,
    type TenantOwnedResourceOptions,
} from '../../../common/tenant-owned-resource.decorator';

const BUCKET_TYPE_SYSTEM = 'SYSTEM';
const BUCKET_TYPE_CUSTOM = 'CUSTOM';

const mockTenantBucketService = {
    listBuckets: vi.fn(),
    getBucketById: vi.fn(),
    getBucketTree: vi.fn(),
    getBucketBySlug: vi.fn(),
    createCustomBucket: vi.fn(),
    deleteBucket: vi.fn(),
    listObjects: vi.fn(),
    uploadObject: vi.fn(),
    deleteObject: vi.fn(),
    provisionSystemBuckets: vi.fn(),
};

const createMockBucketResponse = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    bucketType: string;
    isSystemBucket: boolean;
}> = {}) => ({
    id: overrides.id ?? 'bucket-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'arcaai-audio-recordings',
    slug: overrides.slug ?? 'audio_recordings',
    description: 'Audio recordings',
    bucketType: overrides.bucketType ?? BUCKET_TYPE_SYSTEM,
    pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
    isSystemBucket: overrides.isSystemBucket ?? true,
    createdAt: '2026-03-08T00:00:00.000Z',
    updatedAt: '2026-03-08T00:00:00.000Z',
});

describe('TenantBucketController', () => {
    let controller: TenantBucketController;

    beforeEach(() => {
        vi.clearAllMocks();
        controller = new TenantBucketController(mockTenantBucketService as any);
    });

    describe('listBuckets', () => {
        it('should return all buckets for tenant', async () => {
            const buckets = [
                createMockBucketResponse({ slug: 'audio_recordings' }),
                createMockBucketResponse({ slug: 'uploaded_recordings' }),
            ];
            mockTenantBucketService.listBuckets.mockResolvedValue(buckets);

            const result = await controller.listBuckets();

            expect(result).toHaveLength(2);
            expect(mockTenantBucketService.listBuckets).toHaveBeenCalled();
        });
    });

    describe('getBucket', () => {
        it('should return bucket by ID', async () => {
            const bucket = createMockBucketResponse();
            mockTenantBucketService.getBucketById.mockResolvedValue(bucket);

            const result = await controller.getBucket('bucket-1');

            expect(result).toEqual(bucket);
            expect(mockTenantBucketService.getBucketById).toHaveBeenCalledWith('bucket-1');
        });
    });

    describe('getBucketTree', () => {
        it('should return folder tree for bucket', async () => {
            const tree = {
                bucketId: 'bucket-1',
                bucketName: 'arcaai-audio-recordings',
                rootPath: '',
                nodes: [
                    {
                        id: 'folder:2026/',
                        name: '2026',
                        type: 'folder',
                        path: '2026/',
                        children: [],
                    },
                ],
            };
            mockTenantBucketService.getBucketTree.mockResolvedValue(tree);

            const result = await controller.getBucketTree('bucket-1', '');

            expect(result).toEqual(tree);
            expect(mockTenantBucketService.getBucketTree).toHaveBeenCalledWith('bucket-1', '');
        });
    });

    describe('createBucket', () => {
        it('should create custom bucket', async () => {
            const newBucket = createMockBucketResponse({
                slug: 'reports',
                bucketType: BUCKET_TYPE_CUSTOM,
                isSystemBucket: false,
            });
            mockTenantBucketService.createCustomBucket.mockResolvedValue(newBucket);

            const result = await controller.createBucket({
                slug: 'reports',
                description: 'Business reports',
            });

            expect(result.slug).toBe('reports');
            expect(mockTenantBucketService.createCustomBucket).toHaveBeenCalledWith({
                slug: 'reports',
                description: 'Business reports',
            });
        });
    });

    describe('deleteBucket', () => {
        it('should delete bucket by ID', async () => {
            const bucket = createMockBucketResponse({
                id: 'custom-1',
                bucketType: BUCKET_TYPE_CUSTOM,
            });
            mockTenantBucketService.deleteBucket.mockResolvedValue(bucket);

            const result = await controller.deleteBucket('custom-1');

            expect(result.id).toBe('custom-1');
            expect(mockTenantBucketService.deleteBucket).toHaveBeenCalledWith('custom-1');
        });
    });

    // ------------------------------------------------------------------------
    // TASK-331 doc-03 F7 — object LIST + UPLOAD on the admin plane (by bucket id).
    // ------------------------------------------------------------------------
    describe('listObjects', () => {
        it('should list objects via the service with the bucket id and prefix', async () => {
            const objects = [
                { key: 'patients/2026/report-1.txt', size: 1200, lastModified: '2026-04-08T00:00:00.000Z' },
            ];
            mockTenantBucketService.listObjects.mockResolvedValue(objects);

            const result = await controller.listObjects('bucket-1', 'patients/');

            expect(result).toEqual(objects);
            expect(mockTenantBucketService.listObjects).toHaveBeenCalledWith('bucket-1', 'patients/');
        });

        it('should default the prefix to an empty string', async () => {
            mockTenantBucketService.listObjects.mockResolvedValue([]);

            await controller.listObjects('bucket-1', undefined);

            expect(mockTenantBucketService.listObjects).toHaveBeenCalledWith('bucket-1', '');
        });
    });

    describe('uploadObject', () => {
        it('should upload the file buffer via the service using the provided key', async () => {
            const uploaded = { key: '2026/04/08/test.wav', size: 5 };
            mockTenantBucketService.uploadObject.mockResolvedValue(uploaded);
            const file = { buffer: Buffer.from('hello'), mimetype: 'audio/wav', originalname: 'test.wav' } as any;

            const result = await controller.uploadObject('bucket-1', file, '2026/04/08/test.wav');

            expect(result).toEqual(uploaded);
            expect(mockTenantBucketService.uploadObject).toHaveBeenCalledWith('bucket-1', '2026/04/08/test.wav', file.buffer, 'audio/wav');
        });

        it('should fall back to the uploaded file name when no key is provided', async () => {
            mockTenantBucketService.uploadObject.mockResolvedValue({ key: 'test.wav', size: 2 });
            const file = { buffer: Buffer.from('hi'), mimetype: 'audio/wav', originalname: 'test.wav' } as any;

            await controller.uploadObject('bucket-1', file, undefined);

            expect(mockTenantBucketService.uploadObject).toHaveBeenCalledWith('bucket-1', 'test.wav', file.buffer, 'audio/wav');
        });
    });

    describe('deleteObject', () => {
        it('should delete an object via the service with the bucket id and key', async () => {
            mockTenantBucketService.deleteObject.mockResolvedValue({ key: '2026/04/08/test.wav', deleted: true });

            const result = await controller.deleteObject('bucket-1', '2026/04/08/test.wav');

            expect(result).toEqual({ key: '2026/04/08/test.wav', deleted: true });
            expect(mockTenantBucketService.deleteObject).toHaveBeenCalledWith('bucket-1', '2026/04/08/test.wav');
        });
    });

    describe('provisionSystemBuckets', () => {
        it('should provision system buckets for tenant', async () => {
            const buckets = [
                createMockBucketResponse({ slug: 'audio_recordings' }),
                createMockBucketResponse({ slug: 'uploaded_recordings' }),
            ];
            mockTenantBucketService.provisionSystemBuckets.mockResolvedValue(buckets);

            const result = await controller.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(2);
            expect(mockTenantBucketService.provisionSystemBuckets).toHaveBeenCalledWith('tenant-1');
        });
    });

    // ------------------------------------------------------------------------
    // TASK-307 W3.5 — every bucket-by-id handler must carry @TenantOwnedResource
    // (AC-8). Closes audit C-4 (TenantBucketController cross-tenant — BLOCKER).
    // ------------------------------------------------------------------------
    describe('TASK-307 W3.5 — @TenantOwnedResource metadata', () => {
        const meta = (m: keyof TenantBucketController): TenantOwnedResourceOptions | undefined =>
            Reflect.getMetadata(
                TENANT_OWNED_RESOURCE_KEY,
                TenantBucketController.prototype[m] as object,
            ) as TenantOwnedResourceOptions | undefined;

        it('getBucket is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('getBucket')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('getBucketTree is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('getBucketTree')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('getPresignedUrl is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('getPresignedUrl')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('deleteBucket is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('deleteBucket')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('deleteObject is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('deleteObject')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('listObjects is annotated with modelName TenantBucket + paramName id and global-admin scope', () => {
            expect(meta('listObjects')).toEqual({ modelName: 'TenantBucket', paramName: 'id', scope: 'global-admin' });
        });

        it('uploadObject is annotated with modelName TenantBucket + paramName id', () => {
            expect(meta('uploadObject')).toEqual({ modelName: 'TenantBucket', paramName: 'id' });
        });

        it('listBuckets and createBucket and provisionSystemBuckets are NOT annotated (no :id route param)', () => {
            expect(meta('listBuckets')).toBeUndefined();
            expect(meta('createBucket')).toBeUndefined();
            expect(meta('provisionSystemBuckets')).toBeUndefined();
        });
    });
});
