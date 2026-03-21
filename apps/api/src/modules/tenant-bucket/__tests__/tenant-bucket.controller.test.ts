import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantBucketController } from '../tenant-bucket.controller';

const BUCKET_TYPE_SYSTEM = 'SYSTEM';
const BUCKET_TYPE_CUSTOM = 'CUSTOM';

const mockTenantBucketService = {
    listBuckets: vi.fn(),
    getBucketById: vi.fn(),
    getBucketTree: vi.fn(),
    getBucketBySlug: vi.fn(),
    createCustomBucket: vi.fn(),
    deleteBucket: vi.fn(),
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
});
