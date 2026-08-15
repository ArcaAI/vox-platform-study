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

import { ApiKeyStatus, ApiKeyType, AuditAction, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
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

// UserRoleAssignment repository is required for the
// `assertUserBelongsToTenant` guard run during `create`.
const mockUserRoleAssignmentRepository = {
  findFirst: vi.fn(),
};

// Membership guard now also reads the UserDepartment join
// table and the User table (service-account exemption).
const mockUserDepartmentRepository = {
  findFirst: vi.fn(),
};

const mockUserRepository = {
  findFirst: vi.fn(),
};

// Helper to create mock API key entity
const createMockApiKeyEntity = (
  overrides: Partial<{
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
  }> = {},
) => ({
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
    // The "should not throw when event emission fails" test installs a
    // throwing implementation on `emit`. `clearAllMocks` only resets call
    // history, so we explicitly reset the impl here to keep tests isolated.
    mockEventEmitter.emit.mockReset();

    // Default: return valid user from CLS. The default caller is a
    // tenant-admin — the api-key admin surface's original persona — so the
    // pre-existing by-id happy-paths (fetchById/update/delete/revoke/rotate)
    // keep their tenant-scoped intent. `userAbility.can('manage','ApiKey')`
    // returns true, so the owner-scope gate is bypassed
    // for these tenant-admin cases. Owner-only callers are exercised in the
    // dedicated "Owner-scope enforcement" block below.
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'current-user-id' };
        case 'tenantId':
          return 'tenant-1';
        case 'userAbility':
          return { can: () => true };
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    // Default to a permissive in-tenant role-assignment so
    // legacy create-tests (which don't care about the new guard) keep
    // passing.
    mockUserRoleAssignmentRepository.findFirst.mockResolvedValue({
      id: 'ura-1',
      userId: 'current-user-id',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    // Default to a present in-tenant department so the
    // role+department membership guard passes for the happy path.
    mockUserDepartmentRepository.findFirst.mockResolvedValue({
      id: 'ud-1',
      userId: 'current-user-id',
      tenantId: 'tenant-1',
      resourceStatus: ResourceStatusType.ENABLED,
    });
    mockUserRepository.findFirst.mockResolvedValue({ id: 'current-user-id', isServiceAccount: false });

    // Create service instance with mocks
    service = new ApiKeyService(
      mockApiKeyRepository as any,
      mockUserRoleAssignmentRepository as any,
      mockUserDepartmentRepository as any,
      mockUserRepository as any,
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

        const expectedChecksum = createHash('sha256').update(randomPart).digest('hex').substring(0, 6);

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
        expect(result).toBe(createHmac('sha256', 'test-pepper-secret').update(rawKey).digest('hex'));
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: 'new-key-id' }));
    });

    it('should throw when repository create fails', async () => {
      mockApiKeyRepository.create.mockResolvedValue(null);

      await expect(service.create({ keyName: 'Bad Key' } as any)).rejects.toThrow('Failed to create API key');
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
          case 'user':
            return null;
          case 'tenantId':
            return 'tenant-1';
          default:
            return null;
        }
      });

      const svc = new ApiKeyService(
        mockApiKeyRepository as any,
        mockUserRoleAssignmentRepository as any,
        mockUserDepartmentRepository as any,
        mockUserRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
      );

      await expect(
        svc.create({
          keyName: 'No User Key',
          keyType: 'SDK',
          scopes: ['stt:transcription:read'],
        } as any),
      ).rejects.toThrow('linked to the creating user');
    });

    it('should throw when userId is missing for WEBHOOK key type', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return null;
          case 'tenantId':
            return 'tenant-1';
          default:
            return null;
        }
      });

      const svc = new ApiKeyService(
        mockApiKeyRepository as any,
        mockUserRoleAssignmentRepository as any,
        mockUserDepartmentRepository as any,
        mockUserRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
      );

      await expect(
        svc.create({
          keyName: 'No User Webhook',
          keyType: 'WEBHOOK',
          scopes: ['webhook:event:read'],
        } as any),
      ).rejects.toThrow('linked to the creating user');
    });

    it('should allow SERVICE_ACCOUNT key creation without userId', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return null;
          case 'tenantId':
            return 'tenant-1';
          default:
            return null;
        }
      });

      const svc = new ApiKeyService(
        mockApiKeyRepository as any,
        mockUserRoleAssignmentRepository as any,
        mockUserDepartmentRepository as any,
        mockUserRepository as any,
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
          case 'user':
            return { id: 'current-user-id' };
          case 'tenantId':
            return null;
          default:
            return null;
        }
      });

      const svc = new ApiKeyService(
        mockApiKeyRepository as any,
        mockUserRoleAssignmentRepository as any,
        mockUserDepartmentRepository as any,
        mockUserRepository as any,
        mockEventEmitter as any,
        mockClsService as any,
      );

      await expect(
        svc.create({
          keyName: 'No Tenant Key',
          keyType: 'SDK',
          scopes: ['stt:transcription:read'],
        } as any),
      ).rejects.toThrow('tenant context');
    });

    it('should allow SERVICE_ACCOUNT key creation without tenant context', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: 'current-user-id' };
          case 'tenantId':
            return null;
          default:
            return null;
        }
      });

      const svc = new ApiKeyService(
        mockApiKeyRepository as any,
        mockUserRoleAssignmentRepository as any,
        mockUserDepartmentRepository as any,
        mockUserRepository as any,
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
      const keys = [createMockApiKeyEntity({ id: 'key-1' }), createMockApiKeyEntity({ id: 'key-2' })];
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should filter by tenantId', async () => {
      // `fetchAllByTenantId` now refuses cross-tenant
      // reads driven by the DTO. Align the existing "happy-path" probe
      // with the CLS default (`tenant-1`) so the new guard does not
      // short-circuit. Cross-tenant + SUPER_ADMIN coverage lives in the
      // dedicated tenant-scoped block below.
      const keys = [createMockApiKeyEntity({ tenantId: 'tenant-1' })];
      mockApiKeyRepository.findAll.mockResolvedValue(keys);
      mockApiKeyRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllByTenantId({
        tenantId: 'tenant-1',
        page: 1,
        limit: 10,
      } as any);

      expect(result.data).toHaveLength(1);
      expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1' } }));
    });
  });

  /**
   * `ApiKeyService.fetchAllByTenantId`
   * previously trusted the caller-supplied DTO `tenantId` without
   * comparing it to CLS. A Tenant-A admin could enumerate Tenant-B API
   * keys by passing a foreign `tenantId`. The new guard short-circuits
   * with `NotFoundException` on a non-super-admin mismatch; SUPER_ADMIN
   * retains the cross-tenant bypass for admin tooling.
   */
  describe('fetchAllByTenantId tenant-scoped', () => {
    const setRequestUserRoles = (roles: string[] | undefined) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: 'current-user-id', roles };
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
    };

    it('returns rows when the DTO tenantId matches the caller CLS tenant', async () => {
      const keys = [createMockApiKeyEntity({ tenantId: 'tenant-1' })];
      mockApiKeyRepository.findAll.mockResolvedValue(keys);
      mockApiKeyRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllByTenantId({
        tenantId: 'tenant-1',
        page: 1,
        limit: 10,
      } as any);

      expect(result.data).toHaveLength(1);
    });

    it('throws NotFoundException for cross-tenant non-admin reads', async () => {
      const { NotFoundException } = await import('@nestjs/common');

      await expect(
        service.fetchAllByTenantId({
          tenantId: 'tenant-B',
          page: 1,
          limit: 10,
        } as any),
      ).rejects.toThrow(NotFoundException);
      // Guard short-circuits BEFORE hitting the repository.
      expect(mockApiKeyRepository.findAll).not.toHaveBeenCalled();
    });

    it('returns rows for a cross-tenant SUPER_ADMIN read (bypass)', async () => {
      setRequestUserRoles(['SUPER_ADMIN']);
      const keys = [createMockApiKeyEntity({ tenantId: 'tenant-B' })];
      mockApiKeyRepository.findAll.mockResolvedValue(keys);
      mockApiKeyRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllByTenantId({
        tenantId: 'tenant-B',
        page: 1,
        limit: 10,
      } as any);

      expect(result.data).toHaveLength(1);
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
        // `where` now also carries the caller's CLS tenantId.
        expect.objectContaining({ where: { userId: 'user-abc', tenantId: 'tenant-1' } }),
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
        // Count `where` also carries the caller's CLS tenantId.
        expect.objectContaining({ where: { userId: 'user-abc', tenantId: 'tenant-1' } }),
      );
    });

    it('should return paginated response with correct metadata', async () => {
      const keys = [createMockApiKeyEntity({ id: 'key-1', userId: 'user-abc' }), createMockApiKeyEntity({ id: 'key-2', userId: 'user-abc' })];
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'key-42' }));
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: 'key-1' }));
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

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: 'key-to-delete' }));
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

      await expect(service.revokeKey('already-revoked')).rejects.toThrow('API key is already revoked');
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

    // The registry advertises category wildcards (`consultation:*`, `stt:*`, …) as
    // assignable "full access" scopes and `isValidScope` accepts them, so the console will issue
    // such keys. Before scope enforcement was wired up (no decorator set the metadata key) this
    // was inert. Now that routes declare `@RequiredScopes`, a category wildcard that does not
    // match is a live 403 on a key the UI described as granting full access.
    it('should support category wildcard scope granting every child scope', () => {
      const apiKey = createMockApiKeyEntity({ scopes: ['consultation:*'] });

      expect(service.hasScope(apiKey as any, 'consultation:report:write')).toBe(true);
      expect(service.hasScope(apiKey as any, 'consultation:session:read')).toBe(true);
      expect(service.hasScope(apiKey as any, 'consultation:*')).toBe(true);
    });

    it('should not let a category wildcard leak across categories', () => {
      const apiKey = createMockApiKeyEntity({ scopes: ['consultation:*'] });

      expect(service.hasScope(apiKey as any, 'stt:transcription:read')).toBe(false);
      // Prefix must break on the delimiter, not on the raw string.
      expect(service.hasScope(apiKey as any, 'consultationother:read')).toBe(false);
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

      await expect(service.rotateKey('revoked-key')).rejects.toThrow();
    });

    it('should throw if key is not found', async () => {
      mockApiKeyRepository.findById.mockResolvedValue(null);

      await expect(service.rotateKey('nonexistent')).rejects.toThrow();
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

      await expect(
        service.create({
          keyName: 'Too Long Key',
          keyType: 'SDK',
          scopes: ['stt:transcription:read'],
          expiresAt: farFuture.toISOString(),
        } as any),
      ).rejects.toThrow('exceeds maximum');
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

      await service.logKeyEvent(apiKey as any, AuditAction.CREATE, { customField: 'value' }, '192.168.1.1');

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

      await expect(service.logKeyEvent(apiKey as any, AuditAction.CREATE, {})).resolves.not.toThrow();
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

      await expect(service.authenticateByRawKey('hope_sk_unknown_123456')).rejects.toThrow(UnauthorizedException);
      await expect(service.authenticateByRawKey('hope_sk_unknown_123456')).rejects.toThrow('Invalid API key');
    });

    it('should throw UnauthorizedException when key status is not ACTIVE', async () => {
      const entity = createMockApiKeyEntity({
        keyStatus: ApiKeyStatus.REVOKED,
      });
      mockApiKeyRepository.findFirst.mockResolvedValue(entity);

      await expect(service.authenticateByRawKey('hope_sk_revoked_123456')).rejects.toThrow(UnauthorizedException);
      await expect(service.authenticateByRawKey('hope_sk_revoked_123456')).rejects.toThrow('revoked');
    });

    it('should throw UnauthorizedException when key is expired', async () => {
      const entity = createMockApiKeyEntity({
        keyStatus: ApiKeyStatus.ACTIVE,
        expiresAt: new Date('2020-01-01'),
      });
      mockApiKeyRepository.findFirst.mockResolvedValue(entity);

      await expect(service.authenticateByRawKey('hope_sk_expired_123456')).rejects.toThrow(UnauthorizedException);
      await expect(service.authenticateByRawKey('hope_sk_expired_123456')).rejects.toThrow('expired');
    });

    it('should throw ForbiddenException when IP is not in allowlist', async () => {
      const entity = createMockApiKeyEntity({
        keyStatus: ApiKeyStatus.ACTIVE,
        allowedIps: ['10.0.0.1'],
      });
      mockApiKeyRepository.findFirst.mockResolvedValue(entity);

      await expect(service.authenticateByRawKey('hope_sk_ipfail_123456', '192.168.1.99')).rejects.toThrow(ForbiddenException);
      await expect(service.authenticateByRawKey('hope_sk_ipfail_123456', '192.168.1.99')).rejects.toThrow('IP address is not allowed');
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

      await expect(service.authenticateByRawKey('hope_sk_usagefail_123456')).resolves.toBeDefined();
    });
  });

  // ─── extractApiKeyFromRequest ────────────────────────────────────────

  describe('extractApiKeyFromRequest', () => {
    it('should return key from apikey header', () => {
      const request = { headers: { apikey: 'my-api-key' }, query: {} };
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
          headers: { apikey: 'header-key' },
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
    // v1-compatibility
    it('should return key from the legacy URL query param key', () => {
      const request = { headers: {}, url: '/ws?key=legacy-key' };
      expect(service.extractApiKeyFromWebSocket(request)).toBe('legacy-key');
    });

    it('should return null when no key present', () => {
      const request = { headers: {} };
      expect(service.extractApiKeyFromWebSocket(request)).toBeNull();
    });

    it('should prefer header over URL query param', () => {
      const request = { headers: { apikey: 'header-ws-key' }, url: '/ws?apiKey=url-key' };
      expect(service.extractApiKeyFromWebSocket(request)).toBe('header-ws-key');
    });

    it('should return null when URL has no query params', () => {
      const request = { headers: {}, url: '/ws' };
      expect(service.extractApiKeyFromWebSocket(request)).toBeNull();
    });
  });

  /**
   * Multi-tenant isolation for ApiKeyService.
   *
   * ApiKey carries `userId` (FK to User, no tenantId on
   * User) and `tenantId` directly. Without service-layer guards:
   *  - A Tenant-A admin could pass `request.tenantId = 'tenant-B'` and
   *    create a key that authenticates against another tenant's data.
   *  - A Tenant-A admin could read/update/revoke/rotate any key id (the
   *    base `findById` carries no tenant predicate).
   *  - The caller's `userId` may not actually be a member of the tenant
   *    that they're scoping the key to (D.7-pattern privilege escalation).
   *
   * Mirrors the D.7 (UserRoleAssignment) write-side and D.8 (AuditLog)
   * read-side patterns. SUPER_ADMIN bypasses both DTO-pin and user-membership
   * guards on writes (legitimate cross-tenant support flow), and bypasses
   * read-side scoping.
   */
  describe('Multi-tenant scoping', () => {
    describe('create', () => {
      it('rejects when DTO tenantId differs from CLS and caller is not SUPER_ADMIN', async () => {
        await expect(
          service.create({
            keyName: 'Cross-tenant attempt',
            keyType: ApiKeyType.SDK,
            tenantId: 'tenant-other',
          } as any),
        ).rejects.toThrow(ForbiddenException);
        expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
      });

      it('rejects when caller userId has no enabled assignment in the effective tenant', async () => {
        mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null);

        await expect(
          service.create({
            keyName: 'No assignment',
            keyType: ApiKeyType.SDK,
          } as any),
        ).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
      });

      it('SERVICE_ACCOUNT keys do not require a UserRoleAssignment lookup', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { id: 'current-user-id' };
          if (key === 'tenantId') return null;
          return null;
        });
        const svc = new ApiKeyService(
          mockApiKeyRepository as any,
          mockUserRoleAssignmentRepository as any,
          mockUserDepartmentRepository as any,
          mockUserRepository as any,
          mockEventEmitter as any,
          mockClsService as any,
        );
        const createdEntity = createMockApiKeyEntity({ id: 'sa-key' });
        mockApiKeyRepository.create.mockResolvedValue(createdEntity);

        await svc.create({
          keyName: 'Service Account',
          keyType: ApiKeyType.SERVICE_ACCOUNT,
          scopes: ['stt:transcription:read'],
        } as any);

        expect(mockUserRoleAssignmentRepository.findFirst).not.toHaveBeenCalled();
      });

      it('SUPER_ADMIN can override DTO tenantId and bypass the user-membership check', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { id: 'super-admin-id', roles: ['SUPER_ADMIN'] };
          if (key === 'tenantId') return 'tenant-1';
          return null;
        });
        const svc = new ApiKeyService(
          mockApiKeyRepository as any,
          mockUserRoleAssignmentRepository as any,
          mockUserDepartmentRepository as any,
          mockUserRepository as any,
          mockEventEmitter as any,
          mockClsService as any,
        );
        mockUserRoleAssignmentRepository.findFirst.mockResolvedValue(null); // No assignment in tenant-other.
        const createdEntity = createMockApiKeyEntity({
          id: 'super-admin-key',
          tenantId: 'tenant-other',
        });
        mockApiKeyRepository.create.mockResolvedValue(createdEntity);

        await svc.create({
          keyName: 'Cross-tenant by super admin',
          keyType: ApiKeyType.SDK,
          tenantId: 'tenant-other',
        } as any);

        const factoryArgs = mockApiKeyRepository.create.mock.calls[0][0];
        expect(factoryArgs.tenantId).toBe('tenant-other');
      });

      it('uses CLS tenantId when DTO omits tenantId', async () => {
        const createdEntity = createMockApiKeyEntity();
        mockApiKeyRepository.create.mockResolvedValue(createdEntity);

        await service.create({ keyName: 'Pinned via CLS' } as any);

        const factoryArgs = mockApiKeyRepository.create.mock.calls[0][0];
        expect(factoryArgs.tenantId).toBe('tenant-1');
      });
    });

    describe('fetchAll', () => {
      it('injects caller tenantId into repository where clause', async () => {
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAll({ limit: 10, page: 1 });

        expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ tenantId: 'tenant-1' }),
          }),
        );
      });

      it('does NOT inject tenantId for SUPER_ADMIN caller', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { id: 'super-admin', roles: ['SUPER_ADMIN'] };
          if (key === 'tenantId') return 'tenant-1';
          return null;
        });
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAll({ limit: 10, page: 1 });

        const findAllArgs = mockApiKeyRepository.findAll.mock.calls[0][0];
        expect(findAllArgs.where?.tenantId).toBeUndefined();
      });
    });

    describe('fetchAllByUserId', () => {
      it('merges caller tenantId with the userId filter', async () => {
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAllByUserId({ limit: 10, page: 1, userId: 'user-x' });

        expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { userId: 'user-x', tenantId: 'tenant-1' },
          }),
        );
      });
    });

    describe('fetchById', () => {
      it('throws NotFoundException when key belongs to a different tenant', async () => {
        const foreign = createMockApiKeyEntity({ id: 'foreign-key', tenantId: 'tenant-2' });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        await expect(service.fetchById('foreign-key')).rejects.toThrow(NotFoundException);
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('returns the entity for SUPER_ADMIN reading a cross-tenant row', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { id: 'super-admin', roles: ['SUPER_ADMIN'] };
          if (key === 'tenantId') return 'tenant-1';
          return null;
        });
        const foreign = createMockApiKeyEntity({ id: 'foreign-key', tenantId: 'tenant-2' });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        const result = await service.fetchById('foreign-key');

        expect(result.id).toBe('foreign-key');
      });
    });

    describe('update', () => {
      it('throws NotFoundException for a cross-tenant key id', async () => {
        const foreign = createMockApiKeyEntity({ id: 'foreign-key', tenantId: 'tenant-2' });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        await expect(service.update('foreign-key', { keyName: 'Renamed' } as any)).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
      });
    });

    describe('deleteById', () => {
      it('throws NotFoundException for a cross-tenant key id', async () => {
        const foreign = createMockApiKeyEntity({ id: 'foreign-key', tenantId: 'tenant-2' });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        await expect(service.deleteById('foreign-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.softDelete).not.toHaveBeenCalled();
      });
    });

    describe('revokeKey', () => {
      it('throws NotFoundException for a cross-tenant key id', async () => {
        const foreign = createMockApiKeyEntity({
          id: 'foreign-key',
          tenantId: 'tenant-2',
          keyStatus: ApiKeyStatus.ACTIVE,
        });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        await expect(service.revokeKey('foreign-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
      });
    });

    describe('rotateKey', () => {
      it('throws NotFoundException for a cross-tenant key id', async () => {
        const foreign = createMockApiKeyEntity({
          id: 'foreign-key',
          tenantId: 'tenant-2',
          keyStatus: ApiKeyStatus.ACTIVE,
        });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        await expect(service.rotateKey('foreign-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * (owner-scope hardening).
   *
   * The api-key admin surface's by-id operations (fetch/update/delete/revoke/
   * rotate) share `assertKeyAccess`, which layers an OWNER-scope check on top
   * of the tenant gate. A caller WITHOUT the tenant-wide `manage:ApiKey` grant
   * — i.e. one holding only the seeded `api-key-own-manage` policy (read/
   * update/delete conditioned on `userId`) — may act ONLY on keys they own.
   * Cross-owner access (even same-tenant) is refused with `NotFoundException`
   * (never Forbidden), matching the module's existing not-authorized
   * convention so a key's existence is never leaked. Tenant-admins
   * (`manage:ApiKey`) retain tenant-scope; SUPER_ADMIN retains its broad
   * cross-tenant scope.
   */
  describe('Owner-scope enforcement (follow-up)', () => {
    // Owner-only caller: authenticated + in-tenant, but WITHOUT manage:ApiKey.
    const setOwnerOnlyCaller = (userId: string) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: userId };
          case 'tenantId':
            return 'tenant-1';
          case 'userAbility':
            return { can: () => false }; // no manage:ApiKey
          case 'correlationId':
            return 'corr-owner';
          case 'requestIp':
            return '10.0.0.9';
          default:
            return null;
        }
      });
    };

    // Tenant-admin caller: holds the tenant-wide manage:ApiKey grant.
    const setTenantAdminCaller = (userId: string) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: userId };
          case 'tenantId':
            return 'tenant-1';
          case 'userAbility':
            return { can: (a: string, s: string) => a === 'manage' && s === 'ApiKey' };
          case 'correlationId':
            return 'corr-admin';
          case 'requestIp':
            return '10.0.0.10';
          default:
            return null;
        }
      });
    };

    // SUPER_ADMIN caller: manage:all, cross-tenant.
    const setSuperAdminCaller = (userId: string) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: userId, roles: ['SUPER_ADMIN'] };
          case 'tenantId':
            return 'tenant-1';
          case 'userAbility':
            return { can: () => true };
          case 'correlationId':
            return 'corr-sa';
          case 'requestIp':
            return '10.0.0.11';
          default:
            return null;
        }
      });
    };

    const otherUsersKey = (overrides: Parameters<typeof createMockApiKeyEntity>[0] = {}) =>
      createMockApiKeyEntity({ id: 'peer-key', tenantId: 'tenant-1', userId: 'other-user', ...overrides });

    describe('owner-only caller acting on their OWN key succeeds', () => {
      beforeEach(() => setOwnerOnlyCaller('owner-1'));

      it("fetchById returns the caller's own key", async () => {
        const own = createMockApiKeyEntity({ id: 'own-key', tenantId: 'tenant-1', userId: 'owner-1' });
        mockApiKeyRepository.findById.mockResolvedValue(own);

        const result = await service.fetchById('own-key');

        expect(result.id).toBe('own-key');
      });

      it("update mutates the caller's own key", async () => {
        const own = createMockApiKeyEntity({ id: 'own-key', tenantId: 'tenant-1', userId: 'owner-1' });
        own.hasChanges = true;
        own.changes = { keyName: 'Renamed' };
        mockApiKeyRepository.findById.mockResolvedValue(own);
        mockApiKeyRepository.update.mockResolvedValue(own);

        await service.update('own-key', { keyName: 'Renamed' } as any);

        expect(mockApiKeyRepository.update).toHaveBeenCalledWith('own-key', own);
      });

      it("deleteById soft-deletes the caller's own key", async () => {
        const own = createMockApiKeyEntity({ id: 'own-key', tenantId: 'tenant-1', userId: 'owner-1' });
        mockApiKeyRepository.findById.mockResolvedValue(own);
        mockApiKeyRepository.softDelete.mockResolvedValue(own);

        const result = await service.deleteById('own-key');

        expect(result.id).toBe('own-key');
        expect(mockApiKeyRepository.softDelete).toHaveBeenCalledWith('own-key');
      });

      it("revokeKey revokes the caller's own key", async () => {
        const own = createMockApiKeyEntity({ id: 'own-key', tenantId: 'tenant-1', userId: 'owner-1', keyStatus: ApiKeyStatus.ACTIVE });
        mockApiKeyRepository.findById.mockResolvedValue(own);
        mockApiKeyRepository.update.mockResolvedValue(own);

        await service.revokeKey('own-key');

        expect(mockApiKeyRepository.update).toHaveBeenCalledWith('own-key', own);
      });

      it("rotateKey rotates the caller's own key", async () => {
        const own = createMockApiKeyEntity({ id: 'own-key', tenantId: 'tenant-1', userId: 'owner-1', keyStatus: ApiKeyStatus.ACTIVE });
        const rotated = createMockApiKeyEntity({ id: 'own-key-rotated', userId: 'owner-1' });
        mockApiKeyRepository.findById.mockResolvedValue(own);
        mockApiKeyRepository.create.mockResolvedValue(rotated);
        mockApiKeyRepository.update.mockResolvedValue(own);

        const result = await service.rotateKey('own-key');

        expect(result.newApiKey.id).toBe('own-key-rotated');
      });
    });

    describe("owner-only caller acting on ANOTHER user's key (same tenant) is refused → 404", () => {
      beforeEach(() => setOwnerOnlyCaller('owner-1'));

      it('fetchById throws NotFoundException and emits no ResourceViewed event', async () => {
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey());

        await expect(service.fetchById('peer-key')).rejects.toThrow(NotFoundException);
        expect(mockEventEmitter.emit).not.toHaveBeenCalled();
      });

      it('update throws NotFoundException and does not persist', async () => {
        const peer = otherUsersKey();
        peer.hasChanges = true;
        peer.changes = { keyName: 'Hijack' };
        mockApiKeyRepository.findById.mockResolvedValue(peer);

        await expect(service.update('peer-key', { keyName: 'Hijack' } as any)).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
      });

      it('deleteById throws NotFoundException and does not soft-delete', async () => {
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey());

        await expect(service.deleteById('peer-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.softDelete).not.toHaveBeenCalled();
      });

      it('revokeKey throws NotFoundException and does not persist', async () => {
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey({ keyStatus: ApiKeyStatus.ACTIVE }));

        await expect(service.revokeKey('peer-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
      });

      it('rotateKey throws NotFoundException and does not create', async () => {
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey({ keyStatus: ApiKeyStatus.ACTIVE }));

        await expect(service.rotateKey('peer-key')).rejects.toThrow(NotFoundException);
        expect(mockApiKeyRepository.create).not.toHaveBeenCalled();
      });
    });

    describe("tenant-admin (manage:ApiKey) retains tenant-scope over another user's key", () => {
      beforeEach(() => setTenantAdminCaller('admin-1'));

      it("fetchById returns another user's key in-tenant", async () => {
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey());

        const result = await service.fetchById('peer-key');

        expect(result.id).toBe('peer-key');
      });

      it("rotateKey rotates another user's key in-tenant", async () => {
        const rotated = createMockApiKeyEntity({ id: 'peer-key-rotated', userId: 'other-user' });
        mockApiKeyRepository.findById.mockResolvedValue(otherUsersKey({ keyStatus: ApiKeyStatus.ACTIVE }));
        mockApiKeyRepository.create.mockResolvedValue(rotated);
        mockApiKeyRepository.update.mockResolvedValue(otherUsersKey({ keyStatus: ApiKeyStatus.ACTIVE }));

        const result = await service.rotateKey('peer-key');

        expect(result.newApiKey.id).toBe('peer-key-rotated');
      });
    });

    describe('SUPER_ADMIN retains broad (cross-owner, cross-tenant) scope', () => {
      beforeEach(() => setSuperAdminCaller('sa-1'));

      it("fetchById returns another user's key in another tenant", async () => {
        const foreign = createMockApiKeyEntity({ id: 'foreign-key', tenantId: 'tenant-2', userId: 'other-user' });
        mockApiKeyRepository.findById.mockResolvedValue(foreign);

        const result = await service.fetchById('foreign-key');

        expect(result.id).toBe('foreign-key');
      });
    });

    /**
     * The LIST endpoints (`fetchAll`/`fetchAllByTenantId`)
     * previously filtered by tenantId only, so an owner-only caller (e.g. a
     * real end-user, or an operator impersonating one) saw every key in the
     * tenant instead of just their own. Mirrors the by-id `assertKeyAccess`
     * owner gate above.
     */
    describe("fetchAll / fetchAllByTenantId narrow to the caller's own keys for owner-only callers", () => {
      it('fetchAll adds userId to the where clause for an owner-only caller', async () => {
        setOwnerOnlyCaller('owner-1');
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAll({ page: 1, limit: 10 } as any);

        expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', userId: 'owner-1' } }));
      });

      it('fetchAll does NOT add userId for a tenant-admin (manage:ApiKey) caller', async () => {
        setTenantAdminCaller('admin-1');
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAll({ page: 1, limit: 10 } as any);

        const findAllArgs = mockApiKeyRepository.findAll.mock.calls[0][0];
        expect(findAllArgs.where?.userId).toBeUndefined();
        expect(findAllArgs.where?.tenantId).toBe('tenant-1');
      });

      it('fetchAllByTenantId adds userId to the where clause for an owner-only caller', async () => {
        setOwnerOnlyCaller('owner-1');
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAllByTenantId({ tenantId: 'tenant-1', page: 1, limit: 10 } as any);

        expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', userId: 'owner-1' } }));
      });

      it('fetchAllByTenantId does NOT add userId for a SUPER_ADMIN cross-tenant caller', async () => {
        setSuperAdminCaller('sa-1');
        mockApiKeyRepository.findAll.mockResolvedValue([]);
        mockApiKeyRepository.count.mockResolvedValue(0);

        await service.fetchAllByTenantId({ tenantId: 'tenant-2', page: 1, limit: 10 } as any);

        expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-2' } }));
      });
    });
  });
});
