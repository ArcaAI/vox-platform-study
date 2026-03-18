import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageAccessKeyService } from '../storage-access-key.service';

const BUCKET_TYPE_SYSTEM = 'SYSTEM';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockStorageAccessKeyRepository = {
    findAllByTenant: vi.fn(),
    findByAccessKeyId: vi.fn(),
    findActiveByTenant: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
};

const mockTenantBucketRepository = {
    findById: vi.fn(),
    findAllByTenant: vi.fn(),
};

const createMockKeyEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    accessKeyId: string;
    secretAccessKey: string;
    permissions: string[];
    bucketIds: string[];
    isExpired: boolean;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}> = {}) => ({
    id: overrides.id ?? 'key-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'Test Key',
    accessKeyId: overrides.accessKeyId ?? 'HOPEABC123',
    secretAccessKey: overrides.secretAccessKey ?? 'secret-key-value',
    permissions: overrides.permissions ?? ['read'],
    bucketIds: overrides.bucketIds ?? [],
    isExpired: overrides.isExpired ?? false,
    expiresAt: overrides.expiresAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-03-08'),
    updatedAt: overrides.updatedAt ?? new Date('2026-03-08'),
});

vi.mock('@arcaai/domains', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        StorageAccessKeyFactory: {
            CreateKey: vi.fn((props) => ({
                id: 'new-key-id',
                tenantId: props.tenantId,
                name: props.name,
                accessKeyId: 'HOPENEWKEY123',
                secretAccessKey: 'new-secret-key',
                permissions: props.permissions ?? ['read'],
                bucketIds: props.bucketIds ?? [],
                isExpired: false,
                expiresAt: props.expiresAt ?? null,
                createdAt: new Date(),
                updatedAt: new Date(),
            })),
        },
    };
});

describe('StorageAccessKeyService', () => {
    let service: StorageAccessKeyService;

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

        service = new StorageAccessKeyService(
            mockStorageAccessKeyRepository as any,
            mockTenantBucketRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('listKeys', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(service.listKeys()).rejects.toThrow(BadRequestException);
        });

        it('should return all keys for tenant (without exposing secret)', async () => {
            const keys = [
                createMockKeyEntity({ id: 'k1', name: 'Key 1' }),
                createMockKeyEntity({ id: 'k2', name: 'Key 2' }),
            ];
            mockStorageAccessKeyRepository.findAllByTenant.mockResolvedValue(keys);

            const result = await service.listKeys();

            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Key 1');
            expect(result[0]).not.toHaveProperty('secretAccessKey');
        });
    });

    describe('generateKey', () => {
        it('should throw BadRequestException when tenant ID is not available', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                if (key === 'user') return { id: 'user-id-1' };
                return null;
            });

            await expect(service.generateKey({ name: 'New Key' }))
                .rejects.toThrow(BadRequestException);
        });

        it('should validate bucket IDs belong to tenant', async () => {
            mockTenantBucketRepository.findById.mockResolvedValue(null);

            await expect(service.generateKey({
                name: 'New Key',
                bucketIds: ['non-existent-bucket'],
            })).rejects.toThrow(NotFoundException);
        });

        it('should create key and return it with secret (only on creation)', async () => {
            mockStorageAccessKeyRepository.create.mockImplementation((entity: any) => entity);

            const result = await service.generateKey({
                name: 'Production Key',
                permissions: ['read', 'write'],
            });

            expect(result.name).toBe('Production Key');
            expect(result.accessKeyId).toBeDefined();
            expect(result.secretAccessKey).toBeDefined();
        });
    });

    describe('revokeKey', () => {
        it('should throw NotFoundException when key not found', async () => {
            mockStorageAccessKeyRepository.findById.mockResolvedValue(null);

            await expect(service.revokeKey('non-existent'))
                .rejects.toThrow(NotFoundException);
        });

        it('should soft delete the key', async () => {
            const key = createMockKeyEntity({ id: 'key-1' });
            mockStorageAccessKeyRepository.findById.mockResolvedValue(key);
            mockStorageAccessKeyRepository.softDelete.mockResolvedValue(key);

            const result = await service.revokeKey('key-1');

            expect(result.id).toBe('key-1');
            expect(mockStorageAccessKeyRepository.softDelete).toHaveBeenCalledWith('key-1');
        });
    });

    describe('validateKey', () => {
        it('should return null when key not found', async () => {
            mockStorageAccessKeyRepository.findByAccessKeyId.mockResolvedValue(null);

            const result = await service.validateKey('INVALID');

            expect(result).toBeNull();
        });

        it('should return null when key is expired', async () => {
            const expiredKey = createMockKeyEntity({ isExpired: true });
            mockStorageAccessKeyRepository.findByAccessKeyId.mockResolvedValue(expiredKey);

            const result = await service.validateKey('HOPEABC123');

            expect(result).toBeNull();
        });

        it('should return key info when valid', async () => {
            const validKey = createMockKeyEntity({ isExpired: false });
            mockStorageAccessKeyRepository.findByAccessKeyId.mockResolvedValue(validKey);

            const result = await service.validateKey('HOPEABC123');

            expect(result).not.toBeNull();
            expect(result!.tenantId).toBe('tenant-1');
            expect(result!.permissions).toEqual(['read']);
        });
    });
});
