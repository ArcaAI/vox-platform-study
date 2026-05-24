/**
 * ApiKeyService Unit Tests
 *
 * Tests for the ApiKeyService that handles API key management operations.
 * Covers:
 * - Key generation and SHA-256 hashing
 * - Key format validation
 * - Checksum extraction and validation
 * - Full CRUD: create, fetchAll, fetchAllByTenantId, fetchById, update, deleteById, revokeKey
 * - Authentication support: getByKeyHash, updateUsage, isKeyValid
 * - IP allowlist enforcement
 * - Scope checking
 * - Audit event logging
 */

import { ApiKeyStatus, ApiKeyType, AuditAction, SysEventType } from '@arcaai/domains';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyService } from '../apikey.service';

// Mock ClsService
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock Prisma model delegate (for atomic operations that bypass the repository layer)
const mockPrismaDelegate = {
    update: vi.fn(),
};

// Mock ApiKeyRepository
const mockApiKeyRepository = {
    findFirst: vi.fn(),
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    db: mockPrismaDelegate,
};

// Helper to create mock API key entity
const createMockApiKeyEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    userId: string;
    keyName: string;
    keyHash: string;
    keyPrefix: string;
    keyChecksum: string | null;
    keyType: ApiKeyType;
    keyStatus: ApiKeyStatus;
    scopes: string[] | null;
    allowedIps: string[] | null;
    rateLimit: number | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    usageCount: number;
    rotatedFromKeyId: string | null;
    rotatedToKeyId: string | null;
    rotationExpiresAt: Date | null;
    originalCreatorId: string | null;
    description: string | null;
    environment: string | null;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string | null;
    updatedBy: string | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
}> = {}) => ({
    id: overrides.id ?? 'apikey-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    userId: overrides.userId ?? 'user-1',
    keyName: overrides.keyName ?? 'Test API Key',
    keyHash: overrides.keyHash ?? 'hashed-key-value',
    keyPrefix: overrides.keyPrefix ?? 'hope_sk_test',
    keyChecksum: overrides.keyChecksum ?? '631238',
    keyType: overrides.keyType ?? ApiKeyType.SDK,
    keyStatus: overrides.keyStatus ?? ApiKeyStatus.ACTIVE,
    scopes: overrides.scopes ?? null,
    allowedIps: overrides.allowedIps ?? null,
    rateLimit: overrides.rateLimit ?? 0,
    expiresAt: overrides.expiresAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    usageCount: overrides.usageCount ?? 0,
    rotatedFromKeyId: overrides.rotatedFromKeyId ?? null,
    rotatedToKeyId: overrides.rotatedToKeyId ?? null,
    rotationExpiresAt: overrides.rotationExpiresAt ?? null,
    originalCreatorId: overrides.originalCreatorId ?? null,
    description: overrides.description ?? null,
    environment: overrides.environment ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
    createdBy: overrides.createdBy ?? 'user-1',
    updatedBy: overrides.updatedBy ?? null,
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    toObject: vi.fn().mockReturnValue({
        id: overrides.id ?? 'apikey-id-1',
        keyName: overrides.keyName ?? 'Test API Key',
        keyPrefix: overrides.keyPrefix ?? 'hope_sk_test',
        keyType: overrides.keyType ?? ApiKeyType.SDK,
    }),
});

describe('ApiKeyService', () => {
    let service: ApiKeyService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: return valid user from CLS
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return { id: 'current-user-id' };
                case 'tenantId':
                    return 'tenant-1';
                case 'correlationId':
                    return 'corr-123';
                case 'requestIp':
                    return '192.168.1.1';
                default:
                    return null;
            }
        });

        // Create service instance with mocks
        service = new ApiKeyService(
            mockApiKeyRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    // ─── Static Methods ─────────────────────────────────────────────────

    describe('Static Methods', () => {
        describe('generateRawKey', () => {
            it('should generate a key with correct format', () => {
                const rawKey = ApiKeyService.generateRawKey(ApiKeyType.SDK);

                expect(rawKey).toMatch(/^hope_sk_[a-f0-9]{64}_[a-f0-9]{6}$/);
            });

            it('should use correct type prefix for each key type', () => {
                expect(ApiKeyService.generateRawKey(ApiKeyType.SDK)).toMatch(/^hope_sk_/);
                expect(ApiKeyService.generateRawKey(ApiKeyType.WEBHOOK)).toMatch(/^hope_wh_/);
                expect(ApiKeyService.generateRawKey(ApiKeyType.INTEGRATION)).toMatch(/^hope_int_/);
                expect(ApiKeyService.generateRawKey(ApiKeyType.SERVICE_ACCOUNT)).toMatch(/^hope_sa_/);
            });

            it('should generate unique keys', () => {
                const key1 = ApiKeyService.generateRawKey();
                const key2 = ApiKeyService.generateRawKey();

                expect(key1).not.toBe(key2);
            });

            it('should default to SDK type', () => {
                const rawKey = ApiKeyService.generateRawKey();

                expect(rawKey).toMatch(/^hope_sk_/);
            });

            it('should include a valid checksum', () => {
                const rawKey = ApiKeyService.generateRawKey();
                const parts = rawKey.split('_');
                const randomPart = parts[2];
                const checksum = parts[3];

                const expectedChecksum = createHash('sha256')
                    .update(randomPart)
                    .digest('hex')
                    .substring(0, 6);

                expect(checksum).toBe(expectedChecksum);
            });
        });

        describe('hashKey', () => {
            const originalPepper = process.env.API_KEY_PEPPER;

            afterEach(() => {
                if (originalPepper !== undefined) {
                    process.env.API_KEY_PEPPER = originalPepper;
                } else {
                    delete process.env.API_KEY_PEPPER;
                }
            });

            it('should hash a key using plain SHA-256 when no pepper is supplied', () => {
                const rawKey = 'hope_sk_a5c5e56x54c4437fbd6ce7dee9xxxx_631238';
                const expectedHash = createHash('sha256').update(rawKey).digest('hex');

                const result = ApiKeyService.hashKey(rawKey);

                expect(result).toBe(expectedHash);
                expect(result).toHaveLength(64);
            });

            it('should produce consistent hashes for the same input', () => {
                const rawKey = 'hope_sk_test_consistent_key_123456';

                expect(ApiKeyService.hashKey(rawKey)).toBe(ApiKeyService.hashKey(rawKey));
            });

            it('should produce different hashes for different inputs', () => {
                expect(ApiKeyService.hashKey('key1')).not.toBe(ApiKeyService.hashKey('key2'));
            });

            it('should handle empty string', () => {
                expect(ApiKeyService.hashKey('')).toHaveLength(64);
            });

            it('should handle special characters', () => {
                expect(ApiKeyService.hashKey('hope_sk_test_äöü_emoji_🔑_123456')).toHaveLength(64);
            });
        });

        describe('hashKey with HMAC-pepper', () => {
            const originalEnv = process.env.API_KEY_PEPPER;

            afterEach(() => {
                if (originalEnv !== undefined) {
                    process.env.API_KEY_PEPPER = originalEnv;
                } else {
                    delete process.env.API_KEY_PEPPER;
                }
            });

            it('should use HMAC-SHA256 when a pepper is passed', () => {
                const rawKey = 'hope_sk_testkey_123456';

                const result = ApiKeyService.hashKey(rawKey, 'test-pepper-secret');

                const plainHash = createHash('sha256').update(rawKey).digest('hex');
                expect(result).not.toBe(plainHash);
                expect(result).toHaveLength(64);
                expect(result).toBe(
                    createHmac('sha256', 'test-pepper-secret').update(rawKey).digest('hex'),
                );
            });

            it('should fall back to plain SHA-256 when pepper is undefined', () => {
                const rawKey = 'hope_sk_testkey_123456';

                const result = ApiKeyService.hashKey(rawKey);
                const expectedPlainHash = createHash('sha256').update(rawKey).digest('hex');

                expect(result).toBe(expectedPlainHash);
            });

            it('should produce consistent HMAC hashes with same pepper', () => {
                const rawKey = 'hope_sk_testkey_123456';

                const hash1 = ApiKeyService.hashKey(rawKey, 'consistent-pepper');
                const hash2 = ApiKeyService.hashKey(rawKey, 'consistent-pepper');

                expect(hash1).toBe(hash2);
            });

            it('should produce different hashes with different peppers', () => {
                const rawKey = 'hope_sk_testkey_123456';

                const hash1 = ApiKeyService.hashKey(rawKey, 'pepper-one');
                const hash2 = ApiKeyService.hashKey(rawKey, 'pepper-two');

                expect(hash1).not.toBe(hash2);
            });
        });

        describe('extractPrefix', () => {
            it('should extract first 12 characters', () => {
                const rawKey = 'hope_sk_a5c5e56x54c4437fbd6ce7dee9xxxx_631238';

                expect(ApiKeyService.extractPrefix(rawKey)).toBe('hope_sk_a5c5');
            });
        });

        describe('extractChecksum', () => {
            it('should extract checksum from valid key format', () => {
                expect(ApiKeyService.extractChecksum('hope_sk_random_631238')).toBe('631238');
            });

            it('should return null for keys without underscores', () => {
                expect(ApiKeyService.extractChecksum('invalidkeyformat')).toBeNull();
            });

            it('should return last segment for multiple underscores', () => {
                expect(ApiKeyService.extractChecksum('a_b_c_d_checksum')).toBe('checksum');
            });

            it('should handle empty string', () => {
                expect(ApiKeyService.extractChecksum('')).toBeNull();
            });
        });

        describe('isValidKeyFormat', () => {
            it('should return true for a properly generated key', () => {
                const rawKey = ApiKeyService.generateRawKey(ApiKeyType.SDK);

                expect(ApiKeyService.isValidKeyFormat(rawKey)).toBe(true);
            });

            it('should return false for empty string', () => {
                expect(ApiKeyService.isValidKeyFormat('')).toBe(false);
            });

            it('should return false for short keys', () => {
                expect(ApiKeyService.isValidKeyFormat('short_key')).toBe(false);
            });

            it('should return false for null/undefined', () => {
                expect(ApiKeyService.isValidKeyFormat(null as any)).toBe(false);
                expect(ApiKeyService.isValidKeyFormat(undefined as any)).toBe(false);
            });

            it('should return false for keys without proper segment count', () => {
                // Only 2 segments instead of 4
                expect(ApiKeyService.isValidKeyFormat('hope_something_long_enough_but_wrong')).toBe(false);
            });

            it('should return false for keys with uppercase', () => {
                expect(ApiKeyService.isValidKeyFormat('HOPE_SK_abcdef01234567890123456789012345_abcdef')).toBe(false);
            });
        });
    });

    // ─── CRUD Operations ────────────────────────────────────────────────

    describe('create', () => {
        it('should generate a raw key, hash it, and persist the entity', async () => {
            const createdEntity = createMockApiKeyEntity({ id: 'new-key-id' });
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            const result = await service.create({
                keyName: 'My SDK Key',
                keyType: ApiKeyType.SDK,
            } as any);

            expect(result.rawKey).toBeDefined();
            expect(result.rawKey).toMatch(/^hope_sk_/);
            expect(result.apiKey.id).toBe('new-key-id');
            expect(mockApiKeyRepository.create).toHaveBeenCalledTimes(1);

            // Verify the factory was called with a hashed key, not the raw key
            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.keyHash).toBeDefined();
            expect(createArg.keyHash).toHaveLength(64);
            expect(createArg.keyHash).not.toBe(result.rawKey);
        });

        it('should set userId and tenantId from CLS context', async () => {
            const createdEntity = createMockApiKeyEntity();
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            await service.create({ keyName: 'Test Key' } as any);

            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.userId).toBe('current-user-id');
            expect(createArg.tenantId).toBe('tenant-1');
        });

        it('should broadcast ResourceCreated event', async () => {
            const createdEntity = createMockApiKeyEntity({ id: 'new-key-id' });
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            await service.create({ keyName: 'Test Key' } as any);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({ resourceId: 'new-key-id' }),
            );
        });

        it('should throw when repository create fails', async () => {
            mockApiKeyRepository.create.mockResolvedValue(null);

            await expect(service.create({ keyName: 'Bad Key' } as any))
                .rejects.toThrow('Failed to create API key');
        });

        it('should default keyType to SDK when not provided', async () => {
            const createdEntity = createMockApiKeyEntity();
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            const result = await service.create({ keyName: 'Default Type' } as any);

            expect(result.rawKey).toMatch(/^hope_sk_/);
        });

        it('should set initial usageCount to 0', async () => {
            const createdEntity = createMockApiKeyEntity();
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            await service.create({ keyName: 'Test Key' } as any);

            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.usageCount).toBe(0);
        });

        it('should throw when userId is missing for SDK key type', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user': return null;
                    case 'tenantId': return 'tenant-1';
                    default: return null;
                }
            });

            const svc = new ApiKeyService(
                mockApiKeyRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            await expect(svc.create({
                keyName: 'No User Key',
                keyType: 'SDK',
                scopes: ['stt:transcription:read'],
            } as any)).rejects.toThrow('linked to the creating user');
        });

        it('should throw when userId is missing for WEBHOOK key type', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user': return null;
                    case 'tenantId': return 'tenant-1';
                    default: return null;
                }
            });

            const svc = new ApiKeyService(
                mockApiKeyRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            await expect(svc.create({
                keyName: 'No User Webhook',
                keyType: 'WEBHOOK',
                scopes: ['webhook:event:read'],
            } as any)).rejects.toThrow('linked to the creating user');
        });

        it('should allow SERVICE_ACCOUNT key creation without userId', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user': return null;
                    case 'tenantId': return 'tenant-1';
                    default: return null;
                }
            });

            const svc = new ApiKeyService(
                mockApiKeyRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            const createdEntity = createMockApiKeyEntity({ id: 'sa-key-no-user' });
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            const result = await svc.create({
                keyName: 'Service Account',
                keyType: 'SERVICE_ACCOUNT',
                scopes: ['stt:transcription:read'],
            } as any);

            expect(result.apiKey.id).toBe('sa-key-no-user');
        });

        it('should parse expiresAt string to Date', async () => {
            const createdEntity = createMockApiKeyEntity();
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 30);

            await service.create({
                keyName: 'Expiring Key',
                expiresAt: futureDate.toISOString(),
            } as any);

            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.expiresAt).toBeInstanceOf(Date);
        });

        it('should throw when tenantId is missing for SDK key type', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user': return { id: 'current-user-id' };
                    case 'tenantId': return null;
                    default: return null;
                }
            });

            const svc = new ApiKeyService(
                mockApiKeyRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            await expect(svc.create({
                keyName: 'No Tenant Key',
                keyType: 'SDK',
                scopes: ['stt:transcription:read'],
            } as any)).rejects.toThrow('tenant context');
        });

        it('should allow SERVICE_ACCOUNT key creation without tenant context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user': return { id: 'current-user-id' };
                    case 'tenantId': return null;
                    default: return null;
                }
            });

            const svc = new ApiKeyService(
                mockApiKeyRepository as any,
                mockEventEmitter as any,
                mockClsService as any,
            );

            const createdEntity = createMockApiKeyEntity({ id: 'sa-key' });
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            const result = await svc.create({
                keyName: 'Service Account Key',
                keyType: 'SERVICE_ACCOUNT',
                scopes: ['stt:transcription:read'],
            } as any);

            expect(result.apiKey.id).toBe('sa-key');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated API keys', async () => {
            const keys = [
                createMockApiKeyEntity({ id: 'key-1' }),
                createMockApiKeyEntity({ id: 'key-2' }),
            ];
            mockApiKeyRepository.findAll.mockResolvedValue(keys);
            mockApiKeyRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ page: 1, limit: 10 } as any);

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(10);
        });

        it('should broadcast ResourceViewed event', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([]);
            mockApiKeyRepository.count.mockResolvedValue(0);

            await service.fetchAll({ page: 1, limit: 10 } as any);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.anything(),
            );
        });
    });

    describe('fetchAllByTenantId', () => {
        it('should filter by tenantId', async () => {
            const keys = [createMockApiKeyEntity({ tenantId: 'tenant-abc' })];
            mockApiKeyRepository.findAll.mockResolvedValue(keys);
            mockApiKeyRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantId({
                tenantId: 'tenant-abc',
                page: 1,
                limit: 10,
            } as any);

            expect(result.data).toHaveLength(1);
            expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ where: { tenantId: 'tenant-abc' } }),
            );
        });
    });

    describe('fetchAllByUserId', () => {
        it('should filter by userId', async () => {
            const keys = [createMockApiKeyEntity({ userId: 'user-abc' })];
            mockApiKeyRepository.findAll.mockResolvedValue(keys);
            mockApiKeyRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByUserId({
                userId: 'user-abc',
                page: 1,
                limit: 10,
            } as any);

            expect(result.data).toHaveLength(1);
            expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'user-abc' } }),
            );
        });

        it('should pass userId to count query', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([]);
            mockApiKeyRepository.count.mockResolvedValue(0);

            await service.fetchAllByUserId({
                userId: 'user-abc',
                page: 1,
                limit: 10,
            } as any);

            expect(mockApiKeyRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'user-abc' } }),
            );
        });

        it('should return paginated response with correct metadata', async () => {
            const keys = [
                createMockApiKeyEntity({ id: 'key-1', userId: 'user-abc' }),
                createMockApiKeyEntity({ id: 'key-2', userId: 'user-abc' }),
            ];
            mockApiKeyRepository.findAll.mockResolvedValue(keys);
            mockApiKeyRepository.count.mockResolvedValue(2);

            const result = await service.fetchAllByUserId({
                userId: 'user-abc',
                page: 1,
                limit: 10,
            } as any);

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(10);
        });

        it('should broadcast ResourceViewed event with userId', async () => {
            const keys = [createMockApiKeyEntity({ id: 'key-1', userId: 'user-abc' })];
            mockApiKeyRepository.findAll.mockResolvedValue(keys);
            mockApiKeyRepository.count.mockResolvedValue(1);

            await service.fetchAllByUserId({
                userId: 'user-abc',
                page: 1,
                limit: 10,
            } as any);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: expect.objectContaining({ userId: 'user-abc' }),
                }),
            );
        });

        it('should return empty data when no keys exist for user', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([]);
            mockApiKeyRepository.count.mockResolvedValue(0);

            const result = await service.fetchAllByUserId({
                userId: 'user-no-keys',
                page: 1,
                limit: 10,
            } as any);

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });
    });

    describe('fetchById', () => {
        it('should return a single API key', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-42' });
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);

            const result = await service.fetchById('key-42');

            expect(result.id).toBe('key-42');
            expect(mockApiKeyRepository.findById).toHaveBeenCalledWith('key-42');
        });

        it('should broadcast ResourceViewed event', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-42' });
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);

            await service.fetchById('key-42');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({ resourceId: 'key-42' }),
            );
        });
    });

    describe('update', () => {
        it('should apply changes and persist', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-1', keyName: 'Old Name' });
            apiKey.hasChanges = true;
            apiKey.changes = { keyName: 'New Name' };
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);
            mockApiKeyRepository.update.mockResolvedValue({ ...apiKey, keyName: 'New Name' });

            const result = await service.update('key-1', { keyName: 'New Name' } as any);

            expect(mockApiKeyRepository.update).toHaveBeenCalledWith('key-1', apiKey);
        });

        it('should broadcast ResourceUpdated event', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-1' });
            apiKey.hasChanges = true;
            apiKey.changes = { keyName: 'Updated' };
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);
            mockApiKeyRepository.update.mockResolvedValue(apiKey);

            await service.update('key-1', { keyName: 'Updated' } as any);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({ resourceId: 'key-1' }),
            );
        });
    });

    describe('deleteById', () => {
        it('should soft-delete the API key', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-to-delete' });
            mockApiKeyRepository.softDelete.mockResolvedValue(apiKey);

            const result = await service.deleteById('key-to-delete');

            expect(result.id).toBe('key-to-delete');
            expect(mockApiKeyRepository.softDelete).toHaveBeenCalledWith('key-to-delete');
        });

        it('should broadcast ResourceDeleted event', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'key-to-delete' });
            mockApiKeyRepository.softDelete.mockResolvedValue(apiKey);

            await service.deleteById('key-to-delete');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({ resourceId: 'key-to-delete' }),
            );
        });
    });

    describe('revokeKey', () => {
        it('should set status to REVOKED', async () => {
            const apiKey = createMockApiKeyEntity({
                id: 'key-to-revoke',
                keyStatus: ApiKeyStatus.ACTIVE,
            });
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);
            mockApiKeyRepository.update.mockResolvedValue({
                ...apiKey,
                keyStatus: ApiKeyStatus.REVOKED,
            });

            const result = await service.revokeKey('key-to-revoke');

            expect(mockApiKeyRepository.update).toHaveBeenCalledWith('key-to-revoke', apiKey);
        });

        it('should throw if already revoked', async () => {
            const apiKey = createMockApiKeyEntity({
                id: 'already-revoked',
                keyStatus: ApiKeyStatus.REVOKED,
            });
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);

            await expect(service.revokeKey('already-revoked'))
                .rejects.toThrow('API key is already revoked');
        });

        it('should broadcast ResourceUpdated event with revoke action', async () => {
            const apiKey = createMockApiKeyEntity({
                id: 'key-to-revoke',
                keyStatus: ApiKeyStatus.ACTIVE,
            });
            mockApiKeyRepository.findById.mockResolvedValue(apiKey);
            mockApiKeyRepository.update.mockResolvedValue(apiKey);

            await service.revokeKey('key-to-revoke');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'key-to-revoke',
                    data: expect.objectContaining({
                        action: 'revoke',
                        newStatus: ApiKeyStatus.REVOKED,
                    }),
                }),
            );
        });
    });

    // ─── Authentication Support ─────────────────────────────────────────

    describe('getByKeyHash', () => {
        it('should hash the raw key and look up by hash', async () => {
            const rawKey = 'hope_sk_a5c5e56x54c4437fbd6ce7dee9xxxx_631238';
            const expectedHash = ApiKeyService.hashKey(rawKey);
            const apiKey = createMockApiKeyEntity({ id: 'apikey-123', keyHash: expectedHash });
            mockApiKeyRepository.findFirst.mockResolvedValue(apiKey);

            const result = await service.getByKeyHash(rawKey);

            expect(result.id).toBe('apikey-123');
            expect(mockApiKeyRepository.findFirst).toHaveBeenCalledWith({
                where: { keyHash: expectedHash },
            });
        });

        it('should return null when API key not found', async () => {
            mockApiKeyRepository.findFirst.mockResolvedValue(null);

            const result = await service.getByKeyHash('non-existent-raw-key');

            expect(result).toBeNull();
        });
    });

    describe('isKeyValid', () => {
        it('should return valid for active key without expiration', () => {
            const apiKey = createMockApiKeyEntity({ keyStatus: ApiKeyStatus.ACTIVE, expiresAt: null });

            expect(service.isKeyValid(apiKey as any)).toEqual({ valid: true });
        });

        it('should return invalid for inactive key', () => {
            const apiKey = createMockApiKeyEntity({ keyStatus: ApiKeyStatus.INACTIVE });
            const result = service.isKeyValid(apiKey as any);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('inactive');
        });

        it('should return invalid for revoked key', () => {
            const apiKey = createMockApiKeyEntity({ keyStatus: ApiKeyStatus.REVOKED });
            const result = service.isKeyValid(apiKey as any);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('revoked');
        });

        it('should return invalid for expired key', () => {
            const apiKey = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                expiresAt: new Date('2020-01-01'),
            });
            const result = service.isKeyValid(apiKey as any);

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('API key has expired');
        });

        it('should return valid for key with future expiration', () => {
            const apiKey = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                expiresAt: new Date('2099-12-31'),
            });

            expect(service.isKeyValid(apiKey as any).valid).toBe(true);
        });

        it('should prioritize status check over expiration check', () => {
            const apiKey = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.INACTIVE,
                expiresAt: new Date('2099-12-31'),
            });
            const result = service.isKeyValid(apiKey as any);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('inactive');
        });
    });

    describe('updateUsage', () => {
        it('should use atomic increment to avoid race conditions', async () => {
            mockPrismaDelegate.update.mockResolvedValue({});

            await service.updateUsage('apikey-123', '192.168.1.1');

            expect(mockPrismaDelegate.update).toHaveBeenCalledWith({
                where: { id: 'apikey-123' },
                data: {
                    usageCount: { increment: 1 },
                    lastUsedAt: expect.any(Date),
                },
            });
        });

        it('should not call findById or repository update (bypasses entity layer)', async () => {
            mockPrismaDelegate.update.mockResolvedValue({});

            await service.updateUsage('apikey-123', '192.168.1.1');

            expect(mockApiKeyRepository.findById).not.toHaveBeenCalled();
            expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
        });

        it('should broadcast ResourceUpdated event with ipAddress', async () => {
            mockPrismaDelegate.update.mockResolvedValue({});

            await service.updateUsage('apikey-123', '10.0.0.1');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'apikey-123',
                    disableAuditLog: true,
                    data: { ipAddress: '10.0.0.1' },
                }),
            );
        });

        it('should not throw when atomic update fails', async () => {
            mockPrismaDelegate.update.mockRejectedValue(new Error('DB error'));

            await expect(service.updateUsage('apikey-123')).resolves.not.toThrow();
        });

        it('should not throw when API key does not exist', async () => {
            mockPrismaDelegate.update.mockRejectedValue(new Error('Record not found'));

            await expect(service.updateUsage('non-existent', '192.168.1.1')).resolves.not.toThrow();
        });
    });

    // ─── IP Allowlist ───────────────────────────────────────────────────

    describe('isIpAllowed', () => {
        it('should return true when no allowedIps configured', () => {
            const apiKey = createMockApiKeyEntity({ allowedIps: null });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.1')).toBe(true);
        });

        it('should return true when allowedIps is empty array', () => {
            const apiKey = createMockApiKeyEntity({ allowedIps: [] });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.1')).toBe(true);
        });

        it('should return true for exact IP match', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: ['192.168.1.1', '10.0.0.1'],
            });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.1')).toBe(true);
        });

        it('should return false for IP not in list', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: ['192.168.1.1', '10.0.0.1'],
            });

            expect(service.isIpAllowed(apiKey as any, '172.16.0.1')).toBe(false);
        });

        it('should support wildcard patterns', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: ['192.168.1.*'],
            });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.100')).toBe(true);
            expect(service.isIpAllowed(apiKey as any, '192.168.2.1')).toBe(false);
        });

        it('should support CIDR notation', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: ['192.168.1.0/24'],
            });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.100')).toBe(true);
            expect(service.isIpAllowed(apiKey as any, '192.168.1.255')).toBe(true);
            expect(service.isIpAllowed(apiKey as any, '192.168.2.1')).toBe(false);
        });

        it('should handle CIDR /32 (exact match)', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: ['10.0.0.5/32'],
            });

            expect(service.isIpAllowed(apiKey as any, '10.0.0.5')).toBe(true);
            expect(service.isIpAllowed(apiKey as any, '10.0.0.6')).toBe(false);
        });

        it('should handle whitespace in IPs', () => {
            const apiKey = createMockApiKeyEntity({
                allowedIps: [' 192.168.1.1 '],
            });

            expect(service.isIpAllowed(apiKey as any, '192.168.1.1')).toBe(true);
        });
    });

    // ─── Scope Checking ─────────────────────────────────────────────────

    describe('hasScope', () => {
        it('should return false when no scopes configured (deny by default)', () => {
            const apiKey = createMockApiKeyEntity({ scopes: null });

            expect(service.hasScope(apiKey as any, 'stt:transcribe')).toBe(false);
        });

        it('should return false when scopes is empty array (deny by default)', () => {
            const apiKey = createMockApiKeyEntity({ scopes: [] });

            expect(service.hasScope(apiKey as any, 'stt:transcribe')).toBe(false);
        });

        it('should return true for wildcard scope', () => {
            const apiKey = createMockApiKeyEntity({ scopes: ['*'] });

            expect(service.hasScope(apiKey as any, 'anything:here')).toBe(true);
        });

        it('should return true for exact scope match', () => {
            const apiKey = createMockApiKeyEntity({
                scopes: ['stt:transcribe', 'tts:synthesize'],
            });

            expect(service.hasScope(apiKey as any, 'stt:transcribe')).toBe(true);
        });

        it('should return false for unmatched scope', () => {
            const apiKey = createMockApiKeyEntity({
                scopes: ['stt:transcribe'],
            });

            expect(service.hasScope(apiKey as any, 'tts:synthesize')).toBe(false);
        });

        it('should support parent scope granting child access', () => {
            const apiKey = createMockApiKeyEntity({
                scopes: ['stt'],
            });

            expect(service.hasScope(apiKey as any, 'stt:transcribe')).toBe(true);
            expect(service.hasScope(apiKey as any, 'stt:manage')).toBe(true);
            expect(service.hasScope(apiKey as any, 'tts:synthesize')).toBe(false);
        });

        it('should not grant parent scope from child scope', () => {
            const apiKey = createMockApiKeyEntity({
                scopes: ['stt:transcribe'],
            });

            // Having stt:transcribe should NOT grant stt (the parent)
            expect(service.hasScope(apiKey as any, 'stt')).toBe(false);
        });

        it('should require explicit wildcard for unrestricted access', () => {
            const apiKeyNoScopes = createMockApiKeyEntity({ scopes: null });
            const apiKeyWildcard = createMockApiKeyEntity({ scopes: ['*'] });

            expect(service.hasScope(apiKeyNoScopes as any, 'anything')).toBe(false);
            expect(service.hasScope(apiKeyWildcard as any, 'anything')).toBe(true);
        });
    });

    // ─── Checksum Validation ────────────────────────────────────────────

    describe('validateChecksum', () => {
        it('should return true when checksums match', () => {
            expect(service.validateChecksum('hope_sk_test_random_631238', '631238')).toBe(true);
        });

        it('should return false when checksums do not match', () => {
            expect(service.validateChecksum('hope_sk_test_random_631238', '999999')).toBe(false);
        });

        it('should return true when stored checksum is null (backward compatibility)', () => {
            expect(service.validateChecksum('hope_sk_test_random_631238', null)).toBe(true);
        });

        it('should be case-sensitive', () => {
            expect(service.validateChecksum('hope_sk_test_random_ABC123', 'ABC123')).toBe(true);
            expect(service.validateChecksum('hope_sk_test_random_ABC123', 'abc123')).toBe(false);
        });

        it('should handle key without underscore', () => {
            expect(service.validateChecksum('invalidkeyformat', '123456')).toBe(false);
        });
    });

    // ─── Key Rotation ────────────────────────────────────────────────────

    describe('rotateKey', () => {
        it('should create a new key and link it to the old key', async () => {
            const oldKey = createMockApiKeyEntity({
                id: 'old-key-id',
                keyStatus: ApiKeyStatus.ACTIVE,
                scopes: ['stt:transcription:read'],
                tenantId: 'tenant-1',
                userId: 'user-1',
            });
            const newKeyEntity = createMockApiKeyEntity({
                id: 'new-key-id',
                rotatedFromKeyId: 'old-key-id',
            });

            mockApiKeyRepository.findById.mockResolvedValue(oldKey);
            mockApiKeyRepository.create.mockResolvedValue(newKeyEntity);
            mockApiKeyRepository.update.mockResolvedValue(oldKey);

            const result = await service.rotateKey('old-key-id');

            expect(result.newRawKey).toBeDefined();
            expect(result.newRawKey).toMatch(/^hope_sk_/);
            expect(result.newApiKey.id).toBe('new-key-id');
            expect(mockApiKeyRepository.create).toHaveBeenCalledTimes(1);
        });

        it('should set rotatedToKeyId on the old key', async () => {
            const oldKey = createMockApiKeyEntity({
                id: 'old-key-id',
                keyStatus: ApiKeyStatus.ACTIVE,
                scopes: ['stt:transcription:read'],
                tenantId: 'tenant-1',
                userId: 'user-1',
            });
            const newKeyEntity = createMockApiKeyEntity({ id: 'new-key-id' });

            mockApiKeyRepository.findById.mockResolvedValue(oldKey);
            mockApiKeyRepository.create.mockResolvedValue(newKeyEntity);
            mockApiKeyRepository.update.mockResolvedValue(oldKey);

            await service.rotateKey('old-key-id');

            expect(mockApiKeyRepository.update).toHaveBeenCalledWith('old-key-id', expect.anything());
        });

        it('should throw if key is already revoked', async () => {
            const revokedKey = createMockApiKeyEntity({
                id: 'revoked-key',
                keyStatus: ApiKeyStatus.REVOKED,
            });
            mockApiKeyRepository.findById.mockResolvedValue(revokedKey);

            await expect(service.rotateKey('revoked-key'))
                .rejects.toThrow();
        });

        it('should throw if key is not found', async () => {
            mockApiKeyRepository.findById.mockResolvedValue(null);

            await expect(service.rotateKey('nonexistent'))
                .rejects.toThrow();
        });

        it('should inherit scopes from old key', async () => {
            const oldKey = createMockApiKeyEntity({
                id: 'old-key-id',
                keyStatus: ApiKeyStatus.ACTIVE,
                scopes: ['stt:transcription:read', 'consultation:session:read'],
                tenantId: 'tenant-1',
                userId: 'user-1',
            });
            const newKeyEntity = createMockApiKeyEntity({ id: 'new-key-id' });

            mockApiKeyRepository.findById.mockResolvedValue(oldKey);
            mockApiKeyRepository.create.mockResolvedValue(newKeyEntity);
            mockApiKeyRepository.update.mockResolvedValue(oldKey);

            await service.rotateKey('old-key-id');

            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.scopes).toEqual(['stt:transcription:read', 'consultation:session:read']);
        });

        it('should broadcast rotation event', async () => {
            const oldKey = createMockApiKeyEntity({
                id: 'old-key-id',
                keyStatus: ApiKeyStatus.ACTIVE,
                scopes: ['stt:transcription:read'],
                tenantId: 'tenant-1',
                userId: 'user-1',
            });
            const newKeyEntity = createMockApiKeyEntity({ id: 'new-key-id' });

            mockApiKeyRepository.findById.mockResolvedValue(oldKey);
            mockApiKeyRepository.create.mockResolvedValue(newKeyEntity);
            mockApiKeyRepository.update.mockResolvedValue(oldKey);

            await service.rotateKey('old-key-id');

            expect(mockEventEmitter.emit).toHaveBeenCalled();
        });
    });

    // ─── Mandatory Expiration Validation ─────────────────────────────────

    describe('mandatory expiration validation', () => {
        const originalMaxLifetime = process.env.API_KEY_MAX_LIFETIME_DAYS;

        afterEach(() => {
            if (originalMaxLifetime !== undefined) {
                process.env.API_KEY_MAX_LIFETIME_DAYS = originalMaxLifetime;
            } else {
                delete process.env.API_KEY_MAX_LIFETIME_DAYS;
            }
        });

        it('should auto-set expiration when MAX_KEY_LIFETIME_DAYS is set and no expiresAt provided', async () => {
            process.env.API_KEY_MAX_LIFETIME_DAYS = '365';
            const createdEntity = createMockApiKeyEntity();
            mockApiKeyRepository.create.mockResolvedValue(createdEntity);

            await service.create({
                keyName: 'Auto-Expiry Key',
                keyType: 'SDK',
                scopes: ['stt:transcription:read'],
            } as any);

            const createArg = mockApiKeyRepository.create.mock.calls[0][0];
            expect(createArg.expiresAt).toBeInstanceOf(Date);
        });

        it('should reject expiresAt beyond MAX_KEY_LIFETIME_DAYS', async () => {
            process.env.API_KEY_MAX_LIFETIME_DAYS = '90';

            const farFuture = new Date();
            farFuture.setDate(farFuture.getDate() + 365);

            await expect(service.create({
                keyName: 'Too Long Key',
                keyType: 'SDK',
                scopes: ['stt:transcription:read'],
                expiresAt: farFuture.toISOString(),
            } as any)).rejects.toThrow('exceeds maximum');
        });
    });

    // ─── Audit Logging ──────────────────────────────────────────────────

    describe('logKeyEvent', () => {
        it('should emit event with correct SysEventType for CREATE action', async () => {
            const apiKey = createMockApiKeyEntity({
                id: 'apikey-123',
                keyPrefix: 'hope_sk_test',
                tenantId: 'tenant-1',
            });

            await service.logKeyEvent(
                apiKey as any,
                AuditAction.CREATE,
                { customField: 'value' },
                '192.168.1.1',
            );

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'apikey-123',
                    data: expect.objectContaining({
                        customField: 'value',
                        keyPrefix: 'hope_sk_test',
                        tenantId: 'tenant-1',
                        ipAddress: '192.168.1.1',
                    }),
                }),
            );
        });

        it('should map all AuditAction types correctly', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'apikey-123' });

            const actionMap = [
                [AuditAction.CREATE, SysEventType.ResourceCreated],
                [AuditAction.READ, SysEventType.ResourceViewed],
                [AuditAction.UPDATE, SysEventType.ResourceUpdated],
                [AuditAction.DELETE, SysEventType.ResourceDeleted],
                [AuditAction.ARCHIVE, SysEventType.ResourceArchived],
            ] as const;

            for (const [action, expectedEvent] of actionMap) {
                mockEventEmitter.emit.mockClear();
                await service.logKeyEvent(apiKey as any, action, {});
                expect(mockEventEmitter.emit).toHaveBeenCalledWith(expectedEvent, expect.anything());
            }
        });

        it('should not throw when event emission fails', async () => {
            const apiKey = createMockApiKeyEntity({ id: 'apikey-123' });
            mockEventEmitter.emit.mockImplementation(() => {
                throw new Error('Event emission failed');
            });

            await expect(
                service.logKeyEvent(apiKey as any, AuditAction.CREATE, {}),
            ).resolves.not.toThrow();
        });
    });

    // ─── authenticateByRawKey ────────────────────────────────────────────

    describe('authenticateByRawKey', () => {
        it('should return entity for a valid active key', async () => {
            const entity = createMockApiKeyEntity({
                id: 'valid-key-id',
                keyStatus: ApiKeyStatus.ACTIVE,
                expiresAt: null,
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);
            mockPrismaDelegate.update.mockResolvedValue({});

            const result = await service.authenticateByRawKey('hope_sk_validkey_123456');

            expect(result.id).toBe('valid-key-id');
        });

        it('should throw UnauthorizedException for empty raw key', async () => {
            await expect(service.authenticateByRawKey('')).rejects.toThrow(UnauthorizedException);
            await expect(service.authenticateByRawKey('')).rejects.toThrow('API key is required');
        });

        it('should throw UnauthorizedException for null raw key', async () => {
            await expect(service.authenticateByRawKey(null as any)).rejects.toThrow(UnauthorizedException);
        });

        it('should throw UnauthorizedException when key hash not found', async () => {
            mockApiKeyRepository.findFirst.mockResolvedValue(null);

            await expect(service.authenticateByRawKey('hope_sk_unknown_123456'))
                .rejects.toThrow(UnauthorizedException);
            await expect(service.authenticateByRawKey('hope_sk_unknown_123456'))
                .rejects.toThrow('Invalid API key');
        });

        it('should throw UnauthorizedException when key status is not ACTIVE', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.REVOKED,
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);

            await expect(service.authenticateByRawKey('hope_sk_revoked_123456'))
                .rejects.toThrow(UnauthorizedException);
            await expect(service.authenticateByRawKey('hope_sk_revoked_123456'))
                .rejects.toThrow('revoked');
        });

        it('should throw UnauthorizedException when key is expired', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                expiresAt: new Date('2020-01-01'),
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);

            await expect(service.authenticateByRawKey('hope_sk_expired_123456'))
                .rejects.toThrow(UnauthorizedException);
            await expect(service.authenticateByRawKey('hope_sk_expired_123456'))
                .rejects.toThrow('expired');
        });

        it('should throw ForbiddenException when IP is not in allowlist', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                allowedIps: ['10.0.0.1'],
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);

            await expect(service.authenticateByRawKey('hope_sk_ipfail_123456', '192.168.1.99'))
                .rejects.toThrow(ForbiddenException);
            await expect(service.authenticateByRawKey('hope_sk_ipfail_123456', '192.168.1.99'))
                .rejects.toThrow('IP address is not allowed');
        });

        it('should not throw when IP is allowed', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                allowedIps: ['10.0.0.1', '192.168.1.99'],
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);
            mockPrismaDelegate.update.mockResolvedValue({});

            const result = await service.authenticateByRawKey('hope_sk_ipok_123456', '192.168.1.99');
            expect(result.id).toBe('apikey-id-1');
        });

        it('should skip IP check when no ipAddress provided', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
                allowedIps: ['10.0.0.1'],
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);
            mockPrismaDelegate.update.mockResolvedValue({});

            const result = await service.authenticateByRawKey('hope_sk_noip_123456');
            expect(result.id).toBe('apikey-id-1');
        });

        it('should call updateUsage asynchronously (fire-and-forget)', async () => {
            const entity = createMockApiKeyEntity({
                id: 'usage-key',
                keyStatus: ApiKeyStatus.ACTIVE,
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);
            mockPrismaDelegate.update.mockResolvedValue({});

            await service.authenticateByRawKey('hope_sk_usage_123456', '10.0.0.1');

            expect(mockPrismaDelegate.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 'usage-key' },
                    data: expect.objectContaining({
                        usageCount: { increment: 1 },
                    }),
                }),
            );
        });

        it('should not throw when updateUsage fails', async () => {
            const entity = createMockApiKeyEntity({
                keyStatus: ApiKeyStatus.ACTIVE,
            });
            mockApiKeyRepository.findFirst.mockResolvedValue(entity);
            mockPrismaDelegate.update.mockRejectedValue(new Error('DB down'));

            await expect(service.authenticateByRawKey('hope_sk_usagefail_123456'))
                .resolves.toBeDefined();
        });
    });

    // ─── extractApiKeyFromRequest ────────────────────────────────────────

    describe('extractApiKeyFromRequest', () => {
        it('should return key from apikey header', () => {
            const request = { headers: { 'apikey': 'my-api-key' }, query: {} };
            expect(service.extractApiKeyFromRequest(request)).toBe('my-api-key');
        });

        it('should return key from api-key header', () => {
            const request = { headers: { 'api-key': 'my-api-key-2' }, query: {} };
            expect(service.extractApiKeyFromRequest(request)).toBe('my-api-key-2');
        });

        it('should return key from x-api-key header', () => {
            const request = { headers: { 'x-api-key': 'my-api-key-3' }, query: {} };
            expect(service.extractApiKeyFromRequest(request)).toBe('my-api-key-3');
        });

        it('should return key from x-internal-service-key header', () => {
            const request = { headers: { 'x-internal-service-key': 'my-api-key-4' }, query: {} };
            expect(service.extractApiKeyFromRequest(request)).toBe('my-api-key-4');
        });

        it('should return null when no key present', () => {
            const request = { headers: {}, query: {} };
            expect(service.extractApiKeyFromRequest(request)).toBeNull();
        });

        it('should return key from query param when API_KEY_ALLOW_QUERY_PARAM=true', () => {
            const originalEnv = process.env.API_KEY_ALLOW_QUERY_PARAM;
            process.env.API_KEY_ALLOW_QUERY_PARAM = 'true';

            try {
                const request = { headers: {}, query: { apiKey: 'query-key' }, url: '/test' };
                expect(service.extractApiKeyFromRequest(request)).toBe('query-key');
            } finally {
                if (originalEnv !== undefined) {
                    process.env.API_KEY_ALLOW_QUERY_PARAM = originalEnv;
                } else {
                    delete process.env.API_KEY_ALLOW_QUERY_PARAM;
                }
            }
        });

        it('should return null for query param when API_KEY_ALLOW_QUERY_PARAM is not true', () => {
            const originalEnv = process.env.API_KEY_ALLOW_QUERY_PARAM;
            delete process.env.API_KEY_ALLOW_QUERY_PARAM;

            try {
                const request = { headers: {}, query: { apiKey: 'query-key' }, url: '/test' };
                expect(service.extractApiKeyFromRequest(request)).toBeNull();
            } finally {
                if (originalEnv !== undefined) {
                    process.env.API_KEY_ALLOW_QUERY_PARAM = originalEnv;
                }
            }
        });

        it('should prefer header over query param', () => {
            const originalEnv = process.env.API_KEY_ALLOW_QUERY_PARAM;
            process.env.API_KEY_ALLOW_QUERY_PARAM = 'true';

            try {
                const request = {
                    headers: { 'apikey': 'header-key' },
                    query: { apiKey: 'query-key' },
                };
                expect(service.extractApiKeyFromRequest(request)).toBe('header-key');
            } finally {
                if (originalEnv !== undefined) {
                    process.env.API_KEY_ALLOW_QUERY_PARAM = originalEnv;
                } else {
                    delete process.env.API_KEY_ALLOW_QUERY_PARAM;
                }
            }
        });
    });

    // ─── extractApiKeyFromWebSocket ──────────────────────────────────────

    describe('extractApiKeyFromWebSocket', () => {
        it('should return key from headers', () => {
            const request = { headers: { 'x-api-key': 'ws-key' } };
            expect(service.extractApiKeyFromWebSocket(request)).toBe('ws-key');
        });

        it('should return key from x-internal-service-key header', () => {
            const request = { headers: { 'x-internal-service-key': 'ws-key-2' } };
            expect(service.extractApiKeyFromWebSocket(request)).toBe('ws-key-2');
        });

        it('should return key from URL query param apiKey', () => {
            const request = { headers: {}, url: '/ws?apiKey=url-key' };
            expect(service.extractApiKeyFromWebSocket(request)).toBe('url-key');
        });

        it('should return key from URL query param api-key', () => {
            const request = { headers: {}, url: '/ws?api-key=url-key-2' };
            expect(service.extractApiKeyFromWebSocket(request)).toBe('url-key-2');
        });

        it('should return null when no key present', () => {
            const request = { headers: {} };
            expect(service.extractApiKeyFromWebSocket(request)).toBeNull();
        });

        it('should prefer header over URL query param', () => {
            const request = { headers: { 'apikey': 'header-ws-key' }, url: '/ws?apiKey=url-key' };
            expect(service.extractApiKeyFromWebSocket(request)).toBe('header-ws-key');
        });

        it('should return null when URL has no query params', () => {
            const request = { headers: {}, url: '/ws' };
            expect(service.extractApiKeyFromWebSocket(request)).toBeNull();
        });
    });
});
