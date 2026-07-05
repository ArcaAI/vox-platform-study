import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const mockBlobStorage = {
    createBucket: vi.fn(),
    deleteBucket: vi.fn(),
    putObject: vi.fn(),
    deleteObject: vi.fn(),
    listObjects: vi.fn(),
    presignGet: vi.fn(),
    bucketExists: vi.fn(),
};

// Retained only for the best-effort S3/MinIO setBucketPolicy hardening.
const mockS3Service = {
    setBucketPolicy: vi.fn(),
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
    name: overrides.name ?? 'hope-audio-arcaai',
    slug: overrides.slug ?? 'audio',
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
                    id: 'new-system-attachments',
                    tenantId,
                    name: `hope-attachments-${tenantKey}`,
                    slug: 'attachments',
                    bucketType: BUCKET_TYPE_SYSTEM,
                    isSystemBucket: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                },
                {
                    id: 'new-system-recordings',
                    tenantId,
                    name: `hope-recordings-${tenantKey}`,
                    slug: 'recordings',
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

        // Default: the physical bucket already exists, so data-plane ops do
        // not trigger the on-demand provisioning path (TASK-426).
        mockBlobStorage.bucketExists.mockResolvedValue(true);

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
            mockBlobStorage as any,
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
                createMockBucketEntity({ id: 'b1', slug: 'audio' }),
            ];
            mockTenantBucketRepository.findAllByTenant.mockResolvedValue(buckets);

            const result = await service.listBuckets();

            expect(result).toHaveLength(1);
            expect(result[0].slug).toBe('audio');
            expect(mockTenantBucketRepository.findAllByTenant).toHaveBeenCalledWith('tenant-1', undefined);
        });

        it('should return empty array when no buckets exist', async () => {
            mockTenantBucketRepository.findAllByTenant.mockResolvedValue([]);

            const result = await service.listBuckets();

            expect(result).toEqual([]);
        });
    });

    describe('provisionSystemBuckets', () => {
        it('should create all default system buckets for a new tenant', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([]);
            mockTenantBucketRepository.create.mockImplementation((entity: any) => entity);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);

            const result = await service.provisionSystemBuckets('tenant-1');

            // TenantBucketFactory.CreateDefaultSystemBuckets returns
            // [attachments, recordings] — keep the assertion in lock-step with
            // that list (rather than hard-coding 2) so adding a future system
            // slug only requires updating the factory, not this test.
            expect(result).toHaveLength(2);
            expect(result.map((b) => b.slug).sort()).toEqual(['attachments', 'recordings']);
            expect(mockTenantBucketRepository.create).toHaveBeenCalledTimes(2);
            expect(mockBlobStorage.createBucket).toHaveBeenCalledTimes(2);
        });

        it('should only provision missing system buckets when some already exist', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            // `recordings` is already provisioned — only `attachments` should be created.
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([
                createMockBucketEntity({ slug: 'recordings' }),
            ]);
            mockTenantBucketRepository.create.mockImplementation((entity: any) => entity);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);

            const result = await service.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(1);
            expect(result[0].slug).toBe('attachments');
            expect(mockTenantBucketRepository.create).toHaveBeenCalledTimes(1);
            expect(mockBlobStorage.createBucket).toHaveBeenCalledTimes(1);
        });

        it('should skip provisioning when all system buckets already exist', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([
                createMockBucketEntity({ slug: 'recordings' }),
                createMockBucketEntity({ slug: 'attachments' }),
            ]);

            const result = await service.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(0);
            expect(mockTenantBucketRepository.create).not.toHaveBeenCalled();
            expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
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
            mockBlobStorage.createBucket.mockResolvedValue(undefined);

            const result = await service.createCustomBucket({
                slug: 'reports',
                description: 'Business reports',
            });

            expect(result.slug).toBe('reports');
            expect(result.bucketType).toBe(BUCKET_TYPE_CUSTOM);
            expect(mockBlobStorage.createBucket).toHaveBeenCalled();
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

        it('should remove the physical bucket via the storage provider before soft-deleting the row', async () => {
            const customBucket = createMockBucketEntity({
                id: 'custom-1',
                name: 'hope-reports-arcaai',
                bucketType: BUCKET_TYPE_CUSTOM,
                isSystemBucket: false,
            });
            mockTenantBucketRepository.findById.mockResolvedValue(customBucket);
            mockTenantBucketRepository.softDelete.mockResolvedValue(customBucket);
            mockBlobStorage.deleteBucket.mockResolvedValue(undefined);

            await service.deleteBucket('custom-1');

            expect(mockBlobStorage.deleteBucket).toHaveBeenCalledWith('hope-reports-arcaai');
            expect(mockTenantBucketRepository.softDelete).toHaveBeenCalledWith('custom-1');
        });

        it('should still soft-delete the row when the provider bucket removal fails', async () => {
            const customBucket = createMockBucketEntity({
                id: 'custom-1',
                name: 'hope-reports-arcaai',
                bucketType: BUCKET_TYPE_CUSTOM,
                isSystemBucket: false,
            });
            mockTenantBucketRepository.findById.mockResolvedValue(customBucket);
            mockTenantBucketRepository.softDelete.mockResolvedValue(customBucket);
            mockBlobStorage.deleteBucket.mockRejectedValue(new Error('provider unavailable'));

            const result = await service.deleteBucket('custom-1');

            expect(result.id).toBe('custom-1');
            expect(mockTenantBucketRepository.softDelete).toHaveBeenCalledWith('custom-1');
        });
    });

    describe('deleteObject', () => {
        it('should delete the object via the storage provider and broadcast ResourceDeleted', async () => {
            const bucket = createMockBucketEntity({
                id: 'bucket-1',
                name: 'hope-audio-arcaai',
            });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.deleteObject.mockResolvedValue(undefined);

            const result = await service.deleteObject('bucket-1', '2026/04/08/test.wav');

            expect(result).toEqual({ key: '2026/04/08/test.wav', deleted: true });
            expect(mockBlobStorage.deleteObject).toHaveBeenCalledWith({
                bucket: 'hope-audio-arcaai',
                key: '2026/04/08/test.wav',
            });
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceDeleted',
                expect.objectContaining({ resourceId: 'bucket-1' }),
            );
        });

        it('should throw NotFoundException when bucket not found', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.deleteObject('missing', 'file.wav'))
                .rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when bucket belongs to a different tenant', async () => {
            const bucket = createMockBucketEntity({ tenantId: 'other-tenant' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);

            await expect(service.deleteObject('bucket-1', 'file.wav'))
                .rejects.toThrow(ForbiddenException);
            expect(mockBlobStorage.deleteObject).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException for a path-traversal key', async () => {
            const bucket = createMockBucketEntity();
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);

            await expect(service.deleteObject('bucket-1', '../../etc/passwd'))
                .rejects.toThrow(BadRequestException);
            expect(mockBlobStorage.deleteObject).not.toHaveBeenCalled();
        });
    });

    // TASK-331 doc-03 F7 — object LIST on the admin plane (by bucket id).
    describe('listObjects', () => {
        it('should list provider objects for a tenant-owned bucket', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-audio-arcaai' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.listObjects.mockResolvedValue({
                objects: [{ key: 'patients/2026/report-1.txt', size: 1200, lastModified: new Date('2026-04-08') }],
                isTruncated: false,
            });

            const result = await service.listObjects('bucket-1', 'patients/');

            expect(mockBlobStorage.listObjects).toHaveBeenCalledWith({ bucket: 'hope-audio-arcaai', prefix: 'patients/' });
            expect(result).toEqual([
                { key: 'patients/2026/report-1.txt', size: 1200, lastModified: '2026-04-08T00:00:00.000Z' },
            ]);
        });

        it('should throw NotFoundException when bucket not found', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.listObjects('missing')).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when bucket belongs to a different tenant', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(createMockBucketEntity({ tenantId: 'other-tenant' }));

            await expect(service.listObjects('bucket-1')).rejects.toThrow(ForbiddenException);
            expect(mockBlobStorage.listObjects).not.toHaveBeenCalled();
        });
    });

    // TASK-426 — seeded bucket rows may predate the physical bucket (the seed
    // creates DB rows only). Data-plane ops must provision the provider bucket
    // on demand instead of failing with NoSuchBucket.
    describe('on-demand provider bucket provisioning (TASK-426)', () => {
        it('listObjects creates the missing physical bucket and then lists (empty)', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(false);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockBlobStorage.listObjects.mockResolvedValue({ objects: [], isTruncated: false });

            const result = await service.listObjects('bucket-1');

            expect(mockBlobStorage.bucketExists).toHaveBeenCalledWith('hope-attachments-global');
            expect(mockBlobStorage.createBucket).toHaveBeenCalledWith('hope-attachments-global');
            expect(result).toEqual([]);
        });

        it('listObjects does NOT create the bucket when it already exists', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(true);
            mockBlobStorage.listObjects.mockResolvedValue({ objects: [], isTruncated: false });

            await service.listObjects('bucket-1');

            expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
        });

        it('listObjects still lists when the concurrent create races ("already exists")', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(false);
            mockBlobStorage.createBucket.mockRejectedValue(new Error('BucketAlreadyOwnedByYou'));
            mockBlobStorage.listObjects.mockResolvedValue({ objects: [], isTruncated: false });

            const result = await service.listObjects('bucket-1');

            expect(result).toEqual([]);
        });

        it('getBucketTree creates the missing physical bucket before listing', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-recordings-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(false);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockBlobStorage.listObjects.mockResolvedValue({ objects: [], isTruncated: false });

            const result = await service.getBucketTree('bucket-1');

            expect(mockBlobStorage.createBucket).toHaveBeenCalledWith('hope-recordings-global');
            expect(result.nodes).toEqual([]);
        });

        it('uploadObject creates the missing physical bucket before putting', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(false);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockBlobStorage.putObject.mockResolvedValue(undefined);

            await service.uploadObject('bucket-1', '2026/07/05/file.pdf', Buffer.from('x'), 'application/pdf');

            expect(mockBlobStorage.createBucket).toHaveBeenCalledWith('hope-attachments-global');
            expect(mockBlobStorage.putObject).toHaveBeenCalled();
        });

        it('deleteObject creates the missing physical bucket before deleting (no-op delete)', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockResolvedValue(false);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockBlobStorage.deleteObject.mockResolvedValue(undefined);

            const result = await service.deleteObject('bucket-1', '2026/07/05/file.pdf');

            expect(mockBlobStorage.createBucket).toHaveBeenCalledWith('hope-attachments-global');
            expect(result.deleted).toBe(true);
        });

        it('lets the data-plane error surface when the existence check itself fails', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-attachments-global' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.bucketExists.mockRejectedValue(new Error('storage unreachable'));
            mockBlobStorage.listObjects.mockRejectedValue(new Error('storage unreachable'));

            await expect(service.listObjects('bucket-1')).rejects.toThrow('storage unreachable');
            // The provisioning path must not mask the real failure by creating.
            expect(mockBlobStorage.createBucket).not.toHaveBeenCalled();
        });
    });

    // TASK-331 doc-03 F7 — object UPLOAD on the admin plane (by bucket id).
    describe('uploadObject', () => {
        it('should upload the object via the provider and broadcast ResourceCreated', async () => {
            const bucket = createMockBucketEntity({ id: 'bucket-1', name: 'hope-audio-arcaai' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.putObject.mockResolvedValue(undefined);
            const body = Buffer.from('hello world');

            const result = await service.uploadObject('bucket-1', '2026/04/08/test.wav', body, 'audio/wav');

            expect(mockBlobStorage.putObject).toHaveBeenCalledWith({
                bucket: 'hope-audio-arcaai',
                key: '2026/04/08/test.wav',
                body,
                contentType: 'audio/wav',
            });
            expect(result.key).toBe('2026/04/08/test.wav');
            expect(result.size).toBe(body.length);
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                'SysEvent.ResourceCreated',
                expect.objectContaining({ resourceId: 'bucket-1' }),
            );
        });

        it('should throw NotFoundException when bucket not found', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.uploadObject('missing', 'file.wav', Buffer.from('x'))).rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when bucket belongs to a different tenant', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(createMockBucketEntity({ tenantId: 'other-tenant' }));

            await expect(service.uploadObject('bucket-1', 'file.wav', Buffer.from('x'))).rejects.toThrow(ForbiddenException);
            expect(mockBlobStorage.putObject).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException for a path-traversal key', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(createMockBucketEntity());

            await expect(service.uploadObject('bucket-1', '../../etc/passwd', Buffer.from('x'))).rejects.toThrow(BadRequestException);
            expect(mockBlobStorage.putObject).not.toHaveBeenCalled();
        });
    });

    describe('getBucketBySlug', () => {
        it('should return bucket when found', async () => {
            const bucket = createMockBucketEntity({ slug: 'audio' });
            mockTenantBucketRepository.findBySlug.mockResolvedValue(bucket);

            const result = await service.getBucketBySlug('audio');

            expect(result).not.toBeNull();
            expect(result!.slug).toBe('audio');
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
                    name: 'hope-audio-arcaai',
                }),
            );
            mockBlobStorage.listObjects.mockResolvedValue({
                objects: [
                    { key: 'patients/2026/report-1.txt', size: 1200 },
                    { key: 'patients/2026/report-2.txt', size: 2400 },
                    { key: 'patients/2025/summary.pdf', size: 3800 },
                    { key: 'root-file.txt', size: 512 },
                ],
                isTruncated: false,
            });

            const result = await service.getBucketTree('bucket-1', '');

            expect(result.bucketId).toBe('bucket-1');
            expect(result.bucketName).toBe('hope-audio-arcaai');
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

    describe('getBucketByName', () => {
        it('should return bucket when found and tenant matches', async () => {
            const bucket = createMockBucketEntity({ name: 'hope-audio-arcaai' });
            mockTenantBucketRepository.findByName.mockResolvedValue(bucket);

            const result = await service.getBucketByName('hope-audio-arcaai');

            expect(result).not.toBeNull();
            expect(result!.name).toBe('hope-audio-arcaai');
        });

        it('should return null when bucket not found', async () => {
            mockTenantBucketRepository.findByName.mockResolvedValue(null);

            const result = await service.getBucketByName('non-existent');

            expect(result).toBeNull();
        });

        it('should return null when bucket belongs to different tenant', async () => {
            const bucket = createMockBucketEntity({ tenantId: 'other-tenant' });
            mockTenantBucketRepository.findByName.mockResolvedValue(bucket);

            const result = await service.getBucketByName('hope-audio-arcaai');

            expect(result).toBeNull();
        });
    });

    describe('getPresignedUrl', () => {
        it('should return presigned URL for a valid bucket and file', async () => {
            const bucket = createMockBucketEntity({
                id: 'bucket-1',
                name: 'hope-audio-arcaai',
            });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);
            mockBlobStorage.presignGet.mockResolvedValue('https://minio.local/presigned-url');

            const result = await service.getPresignedUrl('bucket-1', '2026/04/08/test.wav');

            expect(result.url).toBe('https://minio.local/presigned-url');
            expect(mockBlobStorage.presignGet).toHaveBeenCalledWith({
                bucket: 'hope-audio-arcaai',
                key: '2026/04/08/test.wav',
                expiresInSeconds: 3600,
            });
        });

        it('should throw NotFoundException when bucket not found', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.getPresignedUrl('missing', 'file.wav'))
                .rejects.toThrow(NotFoundException);
        });

        it('should throw ForbiddenException when bucket belongs to different tenant', async () => {
            const bucket = createMockBucketEntity({ tenantId: 'other-tenant' });
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);

            await expect(service.getPresignedUrl('bucket-1', 'file.wav'))
                .rejects.toThrow(ForbiddenException);
        });

        it('should throw BadRequestException for path traversal', async () => {
            const bucket = createMockBucketEntity();
            mockTenantBucketRepository.findById.mockResolvedValue(bucket);

            await expect(service.getPresignedUrl('bucket-1', '../../../etc/passwd'))
                .rejects.toThrow(BadRequestException);
        });
    });

    describe('provisionSystemBuckets - bucket policy', () => {
        it('should call setBucketPolicy after creating each bucket', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([]);
            mockTenantBucketRepository.create.mockImplementation((entity: any) => entity);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockS3Service.setBucketPolicy.mockResolvedValue(undefined);

            await service.provisionSystemBuckets('tenant-1');

            // One setBucketPolicy call per system bucket (currently 2: audio + attachments).
            expect(mockS3Service.setBucketPolicy).toHaveBeenCalledTimes(2);
            expect(mockS3Service.setBucketPolicy).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    Version: '2012-10-17',
                    Statement: expect.any(Array),
                }),
            );
        });

        it('should continue provisioning even if setBucketPolicy fails', async () => {
            const mockTenant = { id: 'tenant-1', key: 'arcaai', name: 'ArcaAI' };
            mockTenantRepository.findById.mockResolvedValue(mockTenant);
            mockTenantBucketRepository.findSystemBuckets.mockResolvedValue([]);
            mockTenantBucketRepository.create.mockImplementation((entity: any) => entity);
            mockBlobStorage.createBucket.mockResolvedValue(undefined);
            mockS3Service.setBucketPolicy.mockRejectedValue(new Error('Policy error'));

            const result = await service.provisionSystemBuckets('tenant-1');

            expect(result).toHaveLength(2);
            expect(mockTenantBucketRepository.create).toHaveBeenCalledTimes(2);
        });
    });
});
