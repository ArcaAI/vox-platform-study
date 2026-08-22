import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { StorageAccessKeyService } from '../storage-access-key.service';

// Hoisted so the `vi.mock` factory below can reference the same fixed raw
// secret the test bodies assert against.
const { RAW_SECRET } = vi.hoisted(() => ({ RAW_SECRET: 'RAW_PLAINTEXT_STORAGE_SECRET_FOR_TESTS' }));

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

const createMockKeyEntity = (
  overrides: Partial<{
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
  }> = {},
) => ({
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
      // TASK-786: raw-secret generation moved OUT of the factory and into the
      // SERVICE, so it can honour the `security.secret.*` policy (a domain
      // factory is DI-free and can never reach the settings cache). The tests
      // below stub the service's own generator instead of this one.
      CreateKey: vi.fn((props) => ({
        id: 'new-key-id',
        tenantId: props.tenantId,
        name: props.name,
        accessKeyId: 'HOPENEWKEY123',
        // Reflect whatever the service passed in so tests can assert the
        // persisted value is the HASH, not the plaintext.
        secretAccessKey: props.secretAccessKey,
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
        case 'user':
          return { id: 'user-id-1' };
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
      const keys = [createMockKeyEntity({ id: 'k1', name: 'Key 1' }), createMockKeyEntity({ id: 'k2', name: 'Key 2' })];
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

      await expect(service.generateKey({ name: 'New Key' })).rejects.toThrow(BadRequestException);
    });

    it('should validate bucket IDs belong to tenant', async () => {
      mockTenantBucketRepository.findById.mockResolvedValue(null);

      await expect(
        service.generateKey({
          name: 'New Key',
          bucketIds: ['non-existent-bucket'],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should persist only a HASH and return the plaintext secret exactly once', async () => {
      let createdEntity: any;
      mockStorageAccessKeyRepository.create.mockImplementation((entity: any) => {
        createdEntity = entity;
        return entity;
      });

      // Pin the generated plaintext so the hash assertion below is exact.
      vi.spyOn(service, 'generateRawSecret').mockReturnValue(RAW_SECRET);

      const result = await service.generateKey({
        name: 'Production Key',
        permissions: ['read', 'write'],
      });

      // No SecretsService is injected in this test, so the service falls
      // back to plain SHA-256 (matching ApiKeyService's legacy fallback).
      const expectedHash = createHash('sha256').update(RAW_SECRET).digest('hex');

      // The caller receives the raw plaintext exactly once on creation.
      expect(result.secretAccessKey).toBe(RAW_SECRET);

      // What we persisted is the HASH — never the plaintext.
      expect(createdEntity.secretAccessKey).toBe(expectedHash);
      expect(createdEntity.secretAccessKey).not.toBe(RAW_SECRET);

      expect(result.name).toBe('Production Key');
      expect(result.accessKeyId).toBeDefined();
    });
  });

  describe('revokeKey', () => {
    it('should throw NotFoundException when key not found', async () => {
      mockStorageAccessKeyRepository.findById.mockResolvedValue(null);

      await expect(service.revokeKey('non-existent')).rejects.toThrow(NotFoundException);
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
      mockStorageAccessKeyRepository.update.mockResolvedValue(validKey);

      const result = await service.validateKey('HOPEABC123');

      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('tenant-1');
      expect(result!.permissions).toEqual(['read']);
    });

    it('should record lastUsedAt and lastUsedIp on successful validation', async () => {
      const validKey = createMockKeyEntity({ id: 'key-77', isExpired: false });
      mockStorageAccessKeyRepository.findByAccessKeyId.mockResolvedValue(validKey);
      mockStorageAccessKeyRepository.update.mockResolvedValue(validKey);

      const result = await service.validateKey('HOPEABC123', '203.0.113.7');

      expect(result).not.toBeNull();
      // last-used metadata is recorded via a repository update.
      expect(mockStorageAccessKeyRepository.update).toHaveBeenCalledTimes(1);
      const [idArg, entityArg] = mockStorageAccessKeyRepository.update.mock.calls[0];
      expect(idArg).toBe('key-77');
      expect(entityArg.lastUsedAt).toBeInstanceOf(Date);
      expect(entityArg.lastUsedIp).toBe('203.0.113.7');
    });

    it('should not record usage when the key is invalid', async () => {
      mockStorageAccessKeyRepository.findByAccessKeyId.mockResolvedValue(null);

      await service.validateKey('INVALID', '203.0.113.7');

      expect(mockStorageAccessKeyRepository.update).not.toHaveBeenCalled();
    });
  });
});
