import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { TenantBucketService } from '../tenant-bucket.service';

const BUCKET_TYPE_SYSTEM = 'SYSTEM';
const BUCKET_TYPE_CUSTOM = 'CUSTOM';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockTenantBucketRepository = {
    findAllByTenant: vi.fn(),
    findBySlug: vi.fn(),
    findByName: vi.fn(),
    findById: vi.fn(),
    findSystemBuckets: vi.fn(),
    findCustomBuckets: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

const mockTenantRepository = {
    findById: vi.fn(),
};

const mockS3Service = {
    createBucket: vi.fn(),
    deleteBucket: vi.fn(),
    listAllBuckets: vi.fn(),
    listFiles: vi.fn(),
};

const createMockBucketEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    description: string | null;
    bucketType: string;
    pathPattern: string;
    resourceStatus: string;
    isSystemBucket: boolean;
    createdAt: Date;
    updatedAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'bucket-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'arcaai-audio-recordings',
    slug: overrides.slug ?? 'audio_recordings',
    description: overrides.description ?? 'Audio recordings',
    bucketType: overrides.bucketType ?? BUCKET_TYPE_SYSTEM,
    pathPattern: overrides.pathPattern ?? '{yyyy}/{MM}/{dd}/{user_name}',
    resourceStatus: overrides.resourceStatus ?? 'ENABLED',
    isSystemBucket: overrides.isSystemBucket ?? true,
    createdAt: overrides.createdAt ?? new Date('2026-03-08'),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-08'),
});

vi.mock('@arcaai/domains', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        TenantBucketFactory: {
            CreateSystemBucket: vi.fn((tenantId, tenantKey, slug, desc) => ({
                id: `new-system-${slug}`,
                tenantId,
                name: `${tenantKey}-${slug.replace(/_/g, '-')}`,
                slug,
                description: desc ?? `System bucket: ${slug}`,
                bucketType: BUCKET_TYPE_SYSTEM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
                isSystemBucket: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            CreateCustomBucket: vi.fn((tenantId, tenantKey, slug, desc, createdBy) => ({
                id: `new-custom-${slug}`,
                tenantId,
                name: `${tenantKey}-${slug}`,
                slug,
                description: desc ?? null,
                bucketType: BUCKET_TYPE_CUSTOM,
                pathPattern: '{yyyy}/{MM}/{dd}/{user_name}',
                isSystemBucket: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
            CreateDefaultSystemBuckets: vi.fn((tenantId, tenantKey) => [
                {
                    id: 'new-system-audio-recordings',
                    tenantId,
                    name: `${tenantKey}-audio-recordings`,
                    slug: 'audio_recordings',
                    bucketType: BUCKET_TYPE_SYSTEM,
                    isSystemBucket: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
                {
                    id: 'new-system-uploaded-recordings',
                    tenantId,
                    name: `${tenantKey}-uploaded-recordings`,
                    slug: 'uploaded_recordings',
                    bucketType: BUCKET_TYPE_SYSTEM,
                    isSystemBucket: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
            ]),
        },
    };
});

describe('TenantBucketService', () => {
    let service: TenantBucketService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user': return { id: 'user-id-1' };
                case 'tenantId': return 'tenant-1';
                case 'correlationId': return 'corr-123';
                case 'requestIp': return '192.168.1.1';
                default: return null;
            }
        });

        service = new TenantBucketService(
            mockTenantBucketRepository as any,
            mockTenantRepository as any,
            mockS3Service as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('listBuckets', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(service.listBuckets()).rejects.toThrow(BadRequestException);
        });

        it('should return all buckets for tenant', async () => {
            const buckets = [
                createMockBucketEntity({ id: 'b1', slug: 'audio_recordings' }),
                createMockBucketEntity({ id: 'b2', slug: 'uploaded_recordings' }),
            ];
            mockTenantBucketRepository.findAllByTenant.mockResolvedValue(buckets);

            const result = await service.listBuckets();

            expect(result).toHaveLength(2);
            expect(result[0].slug).toBe('audio_recordings');
            expect(mockTenantBucketRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', undefined);
        });

        it('should return empty array when no buckets exist', async () => {
            mockTenantBucketRepository.findAllByTenant.mockResolvedValue([]);

            const result = await service.listBuckets();

            expect(result).toEqual([]);
        });
    });

    describe('provisionSystemBuckets', () => {
        it('should create both system buckets for a new tenant', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([]);
            mockTenantBucketRepository.create.mockImplementation((entity: any) => entity);
            mockS3Service.createBucket.mockResolvedValue(undefined);

            const result = await service.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(2);
            expect(mockTenantBucketRepository.create).toHaveBeenCalledTimes(2);
            expect(mockS3Service.createBucket).toHaveBeenCalledTimes(2);
        });

        it('should skip provisioning if system buckets already exist', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([
                createMockBucketEntity({ slug: 'audio_recordings' }),
                createMockBucketEntity({ slug: 'uploaded_recordings' }),
            ]);

            const result = await service.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(0);
            expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
            expect(mockS3Service.createBucket).not.toHaveBeenCalled();
        });

        it('should throw NotFoundException when tenant not found', async () => {
            mockTenantRepository.findById.mockResolvedValue(null);

            await expect(service.provisionSystemBuckets('non-existent'))
                .rejects.toThrow(NotFoundException);
        });
    });

    describe('createCustomBucket', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(service.createCustomBucket({ slug: 'reports' }))
                .rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when slug already exists', async () => {
            const existing = createMockBucketEntity({ slug: 'reports' });
            mockTenantBucketRepository.findBySlug.mockResolvedValue(existing);

            await expect(service.createCustomBucket({ slug: 'reports' }))
                .rejects.toThrow(BadRequestException);
        });

        it('should create custom bucket and S3 bucket', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findBySlug.mockResolvedValue(null);
            const newBucket = createMockBucketEntity({
                id: 'new-custom-reports',
                slug: 'reports',
                bucketType: BUCKET_TYPE_CUSTOM,
                isSystemBucket: false,
            });
            mockTenantBucketRepository.create.mockResolvedValue(newBucket);
            mockS3Service.createBucket.mockResolvedValue(undefined);

            const result = await service.createCustomBucket({
                slug: 'reports',
                description: 'Business reports',
            });

            expect(result.slug).toBe('reports');
            expect(result.bucketType).toBe(BUCKET_TYPE_CUSTOM);
            expect(mockS3Service.createBucket).toHaveBeenCalled();
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceCreated',
                expect.objectContaining({
                    resourceId: 'new-custom-reports',
                }),
            );
        });
    });

    describe('deleteBucket', () => {
        it('should throw NotFoundException when bucket not found', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.deleteBucket('non-existent'))
                .rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when trying to delete a SYSTEM bucket', async () => {
            const systemBucket = createMockBucketEntity({
                bucketType: BUCKET_TYPE_SYSTEM,
                isSystemBucket: true,
            });
            mockTenantBucketRepository.findById.mockResolvedValue(systemBucket);

            await expect(service.deleteBucket('bucket-1'))
                .rejects.toThrow(ForbiddenException);
        });

        it('should soft delete a CUSTOM bucket', async () => {
            const customBucket = createMockBucketEntity({
                id: 'custom-1',
                bucketType: BUCKET_TYPE_CUSTOM,
                isSystemBucket: false,
            });
            mockTenantBucketRepository.findById.mockResolvedValue(customBucket);
            mockTenantBucketRepository.softDelete.mockResolvedValue(customBucket);

            const result = await service.deleteBucket('custom-1');

            expect(result.id).toBe('custom-1');
            expect(mockTenantBucketRepository.softDelete).toHaveBeenCalledWith('custom-1');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceDeleted',
                expect.objectContaining({
                    resourceId: 'custom-1',
                }),
            );
        });
    });

    describe('getBucketBySlug', () => {
        it('should return bucket when found', async () => {
            const bucket = createMockBucketEntity({ slug: 'audio_recordings' });
            mockTenantBucketRepository.findBySlug.mockResolvedValue(bucket);

            const result = await service.getBucketBySlug('audio_recordings');

            expect(result).not.toBeNull();
            expect(result!.slug).toBe('audio_recordings');
        });

        it('should return null when bucket not found', async () => {
            mockTenantBucketRepository.findBySlug.mockResolvedValue(null);

            const result = await service.getBucketBySlug('non_existent');

            expect(result).toBeNull();
        });
    });

    describe('getBucketTree', () => {
        it('should throw NotFoundException when bucket does not exist', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.getBucketTree('missing-bucket')).rejects.toThrow(
                NotFoundException,
            );
        });

        it('should build a folder tree from object keys', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(
                createMockBucketEntity({
                    id: 'bucket-1',
                    name: 'arcaai-audio-recordings',
                }),
            );
            mockS3Service.listFiles.mockResolvedValue([
                { key: 'patients/2026/report-1.txt', size: 1200 },
                { key: 'patients/2026/report-2.txt', size: 2400 },
                { key: 'patients/2025/summary.pdf', size: 3800 },
                { key: 'root-file.txt', size: 512 },
            ]);

            const result = await service.getBucketTree('bucket-1', '');

            expect(result.bucketId).toBe('bucket-1');
            expect(result.bucketName).toBe('arcaai-audio-recordings');
            expect(result.rootPath).toBe('');

            const patientsFolder = result.nodes.find(
                (node) => node.type === 'folder' && node.path === 'patients/',
            );
            expect(patientsFolder).toBeDefined();
            expect(patientsFolder?.children.length).toBeGreaterThan(0);

            const rootFile = result.nodes.find(
                (node) => node.type === 'file' && node.path === 'root-file.txt',
            );
            expect(rootFile).toBeDefined();
            expect(rootFile?.size).toBe(512);
        });
    });
});
