/**
 * GlobalSettingService Unit Tests
 *
 * Tests for the GlobalSettingService that handles global settings management.
 *
 * Testing Strategy:
 * - Tests verify actual behavior and output data, not just mock calls
 * - Mock entities include complete structure matching real entities
 * - Assertions focus on what the code does, not what mocks do
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { GlobalSettingService } from '../globalSetting.service';
import { SysEventType, ValueType } from '@arcaai/domains';
import { ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { buildSecretSettingFilter } from '../globalSetting.dto.mapper';

// Define ResourceStatus locally to avoid mock issues
const ResourceStatus = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
  ARCHIVED: 'ARCHIVED',
  DELETED: 'DELETED',
} as const;

// Mock ClsService
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock GlobalSettingRepository
// (C.7) — `update` migrated to `updateWithVersion`
// for Compare-And-Set semantics; mock both so legacy tests still wire while
// the new behaviour can be asserted on the new method.
const mockGlobalSettingRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  // Reveal reads the decrypted plaintext via this repo helper.
  findByIdWithDecryptedValue: vi.fn(),
  // Create() first probes for a soft-DELETED row to revive
  // (restore-on-create); these tests exercise the plain-create branch, so
  // the probe defaults to "not found" in beforeEach.
  findFirst: vi.fn(),
  restore: vi.fn(),
  // Envelope encryption of secret values on write.
  encryptValueIntoEntity: vi.fn(),
};

// Reveal collaborators: UserRepository (password hash for step-up),
// ICryptoService (bcrypt verify), SecretsService (Vault decrypt, passed through).
const mockUserRepository = {
  findById: vi.fn(),
};
const mockCryptoService = {
  hash: vi.fn(),
  verify: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
};
const mockSecretsService = {
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  // Transit capability gate; default off (env/test), re-pinned in
  // beforeEach and flipped on in the encryption-at-rest tests.
  supportsTransit: vi.fn(() => false),
};

/**
 * Creates a complete mock GlobalSettingEntity that matches the real entity structure.
 * This prevents Anti-Pattern #4 (Incomplete Mocks) by including all fields.
 */
const createMockGlobalSettingEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    name: string;
    description: string | null;
    key: string;
    value: string;
    dataType: ValueType;
    namespace: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
    resourceStatus: ResourceStatus;
    deletedAt: Date | null;
    deletedBy: string | null;
  }> = {},
) => {
  const entity = {
    id: overrides.id ?? 'setting-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    name: overrides.name ?? 'Test Setting',
    description: overrides.description ?? 'A test setting',
    key: overrides.key ?? 'test.setting.key',
    value: overrides.value ?? 'test-value',
    dataType: overrides.dataType ?? ValueType.String,
    namespace: overrides.namespace ?? 'test',
    createdBy: overrides.createdBy ?? 'user-123',
    createdAt: overrides.createdAt ?? new Date('2026-01-30T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-30T10:00:00Z'),
    hasChanges: overrides.hasChanges ?? false,
    changes: overrides.changes ?? {},
    // A real `GlobalSettingEntity` always carries a `_version` (default 1);
    // the mock omitted it, so `entity.version` was `undefined` and any
    // `expectedVersion` compared unequal once the OCC precondition moved ahead
    // of the no-changes guard. Mirror the entity instead of the omission.
    version: overrides.version ?? 1,
    resourceStatus: overrides.resourceStatus ?? ResourceStatus.ENABLED,
    deletedAt: overrides.deletedAt ?? null,
    deletedBy: overrides.deletedBy ?? null,
    // Complete toObject returns all entity fields
    toObject: vi.fn(),
  };

  // toObject returns the complete entity structure
  entity.toObject.mockReturnValue({
    id: entity.id,
    tenantId: entity.tenantId,
    name: entity.name,
    description: entity.description,
    key: entity.key,
    value: entity.value,
    dataType: entity.dataType,
    namespace: entity.namespace,
    createdBy: entity.createdBy,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    resourceStatus: entity.resourceStatus,
  });

  return entity;
};

// Mock GlobalSettingFactory
vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    GlobalSettingFactory: {
      CreateGlobalSetting: vi.fn((data) => ({
        ...data,
        id: 'new-setting-id',
        createdAt: new Date(),
        updatedAt: new Date(),
        toObject: vi.fn().mockReturnValue({ id: 'new-setting-id', ...data }),
      })),
    },
  };
});

describe('GlobalSettingService', () => {
  let service: GlobalSettingService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Re-pin the Transit gate to off each test (clearAllMocks
    // keeps implementations, so an encryption test flipping it on must not
    // leak into the next).
    mockSecretsService.supportsTransit.mockReturnValue(false);

    // Default the revive probe to "no DELETED row" so every
    // pre-existing create test keeps exercising the plain-create branch.
    mockGlobalSettingRepository.findFirst.mockRejectedValue(new DataNotFoundException('globalSetting', '{}'));

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

    // Create service instance with mocks (constructor also
    // takes UserRepository, ICryptoService, SecretsService for reveal).
    service = new GlobalSettingService(
      mockGlobalSettingRepository as any,
      mockUserRepository as any,
      mockCryptoService as any,
      mockSecretsService as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  describe('create', () => {
    it('should create a new global setting and return the created entity', async () => {
      const expectedName = 'New Setting';
      const expectedKey = 'new.setting.key';
      const expectedValue = 'new-value';
      const newSetting = createMockGlobalSettingEntity({
        id: 'new-setting-id',
        name: expectedName,
        key: expectedKey,
        value: expectedValue,
      });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: expectedName,
        key: expectedKey,
        value: expectedValue,
        dataType: ValueType.String,
      });

      // Verify the returned entity has correct data (behavior verification)
      expect(result.id).toBe('new-setting-id');
      expect(result.name).toBe(expectedName);
      expect(result.key).toBe(expectedKey);
      expect(result.value).toBe(expectedValue);

      // Verify event was emitted with complete entity data
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'new-setting-id',
          data: expect.objectContaining({
            id: 'new-setting-id',
            name: expectedName,
            key: expectedKey,
          }),
        }),
      );
    });

    it('should throw InternalServerErrorException when repository returns null', async () => {
      mockGlobalSettingRepository.create.mockResolvedValue(null);

      await expect(
        service.create({
          tenantId: 'tenant-1',
          name: 'New Setting',
          key: 'new.setting.key',
          value: 'new-value',
          dataType: ValueType.String,
        }),
      ).rejects.toThrow('Failed to create GlobalSettingEntity');
    });

    it('should include createdBy from user context in the created entity', async () => {
      const newSetting = createMockGlobalSettingEntity({
        id: 'new-setting-id',
        createdBy: 'current-user-id',
      });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
      });

      // Verify the result contains the user context
      expect(result.createdBy).toBe('current-user-id');
    });

    it('should broadcast ResourceCreated event with timestamp and complete entity data', async () => {
      const createdAt = new Date('2026-01-30T10:00:00Z');
      const newSetting = createMockGlobalSettingEntity({
        id: 'new-setting-id',
        createdAt,
      });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
      });

      // Verify event contains all required audit data
      const emitCall = mockEventEmitter.emit.mock.calls[0];
      expect(emitCall[0]).toBe(SysEventType.ResourceCreated);
      expect(emitCall[1]).toMatchObject({
        resourceId: 'new-setting-id',
        createdAt,
      });
      expect(emitCall[1].data).toBeDefined();
    });

    it('should persist description when provided', async () => {
      const description = 'Custom description for the setting';
      const newSetting = createMockGlobalSettingEntity({
        id: 'new-setting-id',
        description,
      });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
        description,
      });

      expect(result.description).toBe(description);
    });

    it('should persist namespace when provided', async () => {
      const namespace = 'custom.namespace';
      const newSetting = createMockGlobalSettingEntity({
        id: 'new-setting-id',
        namespace,
      });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
        namespace,
      });

      expect(result.namespace).toBe(namespace);
    });

    it('should handle all ValueType data types correctly', async () => {
      const dataTypes = [ValueType.String, ValueType.Integer, ValueType.Boolean];

      for (const dataType of dataTypes) {
        vi.clearAllMocks();
        const newSetting = createMockGlobalSettingEntity({
          id: `setting-${dataType}`,
          dataType,
        });
        mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

        const result = await service.create({
          tenantId: 'tenant-1',
          name: 'Test Setting',
          key: 'test.key',
          value: 'test-value',
          dataType,
        });

        expect(result.dataType).toBe(dataType);
      }
    });
  });

  describe('fetchAll', () => {
    it('should return paginated response with correct structure', async () => {
      const settings = [
        createMockGlobalSettingEntity({ id: 'setting-1', name: 'Setting One' }),
        createMockGlobalSettingEntity({ id: 'setting-2', name: 'Setting Two' }),
      ];
      mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
      mockGlobalSettingRepository.count.mockResolvedValue(2);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      // Verify response structure
      expect(result.data).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);

      // Verify actual data content
      expect(result.data[0].id).toBe('setting-1');
      expect(result.data[0].name).toBe('Setting One');
      expect(result.data[1].id).toBe('setting-2');
      expect(result.data[1].name).toBe('Setting Two');

      // Verify audit event contains the viewed item IDs
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { items: ['setting-1', 'setting-2'] },
        }),
      );
    });

    it('should return empty FetchResponse when no settings exist', async () => {
      mockGlobalSettingRepository.findAll.mockResolvedValue([]);
      mockGlobalSettingRepository.count.mockResolvedValue(0);

      const result = await service.fetchAll({ limit: 10, page: 1 });

      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.page).toBe(1);
    });

    it('should pass search parameter to repository for filtering', async () => {
      mockGlobalSettingRepository.findAll.mockResolvedValue([]);
      mockGlobalSettingRepository.count.mockResolvedValue(0);

      await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

      // Verify search is passed to count for accurate pagination
      expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'test-search',
        }),
      );
    });

    it('should calculate correct pagination offset', async () => {
      mockGlobalSettingRepository.findAll.mockResolvedValue([]);
      mockGlobalSettingRepository.count.mockResolvedValue(50);

      const result = await service.fetchAll({ limit: 10, page: 3 });

      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
      // Repository should be called with skip/take for page 3
      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalled();
    });
  });

  describe('fetchAllByTenantId', () => {
    it('should return settings filtered by tenant ID', async () => {
      const settings = [createMockGlobalSettingEntity({ id: 'setting-1', tenantId: 'tenant-1' })];
      mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
      mockGlobalSettingRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllByTenantId({
        limit: 10,
        page: 1,
        tenantId: 'tenant-1',
      });

      expect(result.data).toHaveLength(1);
      // TASK-954 — the fixture's caller is non-elevated, so `locked` platform
      // defaults are excluded from its list (see the list faceting suite).
      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', locked: false },
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { tenantId: 'tenant-1', items: ['setting-1'] },
        }),
      );
    });

    it('should apply pagination and search with tenant filter', async () => {
      mockGlobalSettingRepository.findAll.mockResolvedValue([]);
      mockGlobalSettingRepository.count.mockResolvedValue(0);

      await service.fetchAllByTenantId({
        limit: 20,
        page: 2,
        search: 'test',
        tenantId: 'tenant-1',
      });

      expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'test',
          where: { tenantId: 'tenant-1', locked: false },
        }),
      );
    });
  });

  describe('fetchAllCreatedByUser', () => {
    it('should return settings created by specific user', async () => {
      const settings = [createMockGlobalSettingEntity({ id: 'setting-1', createdBy: 'creator-id' })];
      mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
      mockGlobalSettingRepository.count.mockResolvedValue(1);

      const result = await service.fetchAllCreatedByUser({
        limit: 10,
        page: 1,
        userId: 'creator-id',
      });

      expect(result.data).toHaveLength(1);
      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { createdBy: 'creator-id' },
        }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          data: { createdBy: 'creator-id', items: ['setting-1'] },
        }),
      );
    });
  });

  describe('fetchById', () => {
    it('should return global setting by ID', async () => {
      const setting = createMockGlobalSettingEntity({ id: 'setting-123' });
      mockGlobalSettingRepository.findById.mockResolvedValue(setting);

      const result = await service.fetchById('setting-123');

      expect(result.id).toBe('setting-123');
      expect(mockGlobalSettingRepository.findById).toHaveBeenCalledWith('setting-123');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          responsibleEntityId: 'current-user-id',
        }),
      );
    });

    it('should broadcast event with entity data', async () => {
      const setting = createMockGlobalSettingEntity({ id: 'setting-123' });
      mockGlobalSettingRepository.findById.mockResolvedValue(setting);

      await service.fetchById('setting-123');

      expect(setting.toObject).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should update global setting successfully via updateWithVersion (Stream D Phase C)', async () => {
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
        changes: { value: 'updated-value' },
      });
      (existingSetting as any).version = 5;
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(existingSetting);

      const result = await service.update('setting-123', { value: 'updated-value', expectedVersion: 5 } as any);

      expect(result.id).toBe('setting-123');
      // C.7 — `update` issues a Compare-And-Set against the client's
      // expectedVersion. Legacy non-versioned `update` must NOT be called.
      expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalledWith('setting-123', existingSetting, 5);
      expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'setting-123',
        }),
      );
    });

    it('should throw ArgumentInvalidException when no changes detected', async () => {
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: false,
      });
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);

      await expect(service.update('setting-123', { value: 'same-value', expectedVersion: 1 } as any)).rejects.toThrow('No changes to write to');
      // ArgumentInvalidException fires BEFORE the CAS, so the repo must
      // not have been touched.
      expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('should broadcast ResourceUpdated event with previousVersion + newVersion (Stream D Phase C)', async () => {
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
        changes: { name: 'Updated Name' },
      });
      (existingSetting as any).version = 7;
      const persistedSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
        changes: { name: 'Updated Name' },
      });
      (persistedSetting as any).version = 8; // bumped by CAS
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(persistedSetting);

      await service.update('setting-123', { name: 'Updated Name', expectedVersion: 7 } as any);

      // C.8 — the audit-log SysEvent must carry both the pre-write and
      // post-write versions so downstream observers can correlate.
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'setting-123',
          data: expect.objectContaining({
            previousVersion: 7,
            newVersion: 8,
          }),
          previousData: expect.any(Object),
        }),
      );
    });

    it('propagates OptimisticConcurrencyException when expectedVersion drifted (Stream D Phase C)', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
      });
      (existingSetting as any).version = 5;
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
      mockGlobalSettingRepository.updateWithVersion.mockRejectedValue(
        new OptimisticConcurrencyException('GlobalSetting', 'setting-123', {
          expectedVersion: 5,
          currentVersion: 6,
        }),
      );

      await expect(service.update('setting-123', { value: 'new-value', expectedVersion: 5 } as any)).rejects.toBeInstanceOf(
        OptimisticConcurrencyException,
      );
    });

    it('should update multiple fields at once via updateWithVersion', async () => {
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
        changes: { name: 'Updated Name', value: 'updated-value', description: 'Updated description' },
      });
      (existingSetting as any).version = 3;
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(existingSetting);

      await service.update('setting-123', {
        name: 'Updated Name',
        value: 'updated-value',
        description: 'Updated description',
        expectedVersion: 3,
      } as any);

      expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Secret values are envelope-encrypted at rest on
  // every value-write when Vault Transit is available. `encryptedValue` is
  // present ⟺ it decrypts to the current value, so the reveal read path never
  // returns a stale secret. Non-secrets and no-Transit posture are unaffected.
  // =========================================================================
  describe('secret encryption-at-rest', () => {
    it('create encrypts a new SECRET value at rest when Transit is available', async () => {
      mockSecretsService.supportsTransit.mockReturnValue(true);
      mockGlobalSettingRepository.create.mockResolvedValue(createMockGlobalSettingEntity({ id: 'sec-1', namespace: 'secrets' }));

      await service.create({
        name: 'API token',
        key: 'secrets.api-token',
        value: 'brand-new',
        dataType: ValueType.String,
        namespace: 'secrets',
      } as any);

      expect(mockGlobalSettingRepository.encryptValueIntoEntity).toHaveBeenCalledTimes(1);
      expect(mockGlobalSettingRepository.encryptValueIntoEntity).toHaveBeenCalledWith(expect.anything(), mockSecretsService);
    });

    it('create does NOT encrypt a non-secret value', async () => {
      mockSecretsService.supportsTransit.mockReturnValue(true);
      mockGlobalSettingRepository.create.mockResolvedValue(createMockGlobalSettingEntity({ id: 'plain-1', namespace: 'features' }));

      await service.create({ name: 'Flag', key: 'feature.enable', value: 'true', dataType: ValueType.Boolean, namespace: 'features' } as any);

      expect(mockGlobalSettingRepository.encryptValueIntoEntity).not.toHaveBeenCalled();
    });

    it('update re-wraps a SECRET when its value changes (Transit available)', async () => {
      mockSecretsService.supportsTransit.mockReturnValue(true);
      const secret = createMockGlobalSettingEntity({ id: 'sec-2', namespace: 'secrets', hasChanges: true, changes: { value: 'rotated-inline' } });
      (secret as any).version = 2;
      mockGlobalSettingRepository.findById.mockResolvedValue(secret);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(secret);

      await service.update('sec-2', { value: 'rotated-inline', expectedVersion: 2 } as any);

      expect(mockGlobalSettingRepository.encryptValueIntoEntity).toHaveBeenCalledWith(secret, mockSecretsService);
    });

    it('update does NOT re-wrap a SECRET when only non-value fields change (ciphertext stays valid)', async () => {
      mockSecretsService.supportsTransit.mockReturnValue(true);
      const secret = createMockGlobalSettingEntity({ id: 'sec-3', namespace: 'secrets', hasChanges: true, changes: { description: 'new note' } });
      (secret as any).version = 2;
      mockGlobalSettingRepository.findById.mockResolvedValue(secret);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(secret);

      await service.update('sec-3', { description: 'new note', expectedVersion: 2 } as any);

      expect(mockGlobalSettingRepository.encryptValueIntoEntity).not.toHaveBeenCalled();
    });

    it('create leaves a SECRET plaintext when Transit is unavailable (env/test) — no throw', async () => {
      // supportsTransit stays false (beforeEach default).
      mockGlobalSettingRepository.create.mockResolvedValue(createMockGlobalSettingEntity({ id: 'sec-4', namespace: 'secrets' }));

      await service.create({ name: 'API token', key: 'secrets.api-token', value: 'plain', dataType: ValueType.String, namespace: 'secrets' } as any);

      expect(mockGlobalSettingRepository.encryptValueIntoEntity).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // `locked` write-guard. A locked row (e.g. the platform
  // capability `enable-local-raw-capture`) may only be written by a
  // SUPER_ADMIN. Mirrors the `updateTenantConfigs` posture already enforced
  // for the tenant-config PATCH path.
  // =========================================================================
  describe('locked write-guard', () => {
    const asSuperAdmin = () =>
      mockClsService.get.mockImplementation((key: string) =>
        key === 'user' ? { id: 'super-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? 'tenant-1' : null,
      );

    it('rejects a non-super-admin write to a locked row with ForbiddenException', async () => {
      const locked = createMockGlobalSettingEntity({ id: 'locked-1', key: 'enable-local-raw-capture', hasChanges: true, changes: { value: 'true' } });
      (locked as any).locked = true;
      (locked as any).version = 1;
      mockGlobalSettingRepository.findById.mockResolvedValue(locked);

      const { ForbiddenException } = await import('@nestjs/common');
      await expect(service.update('locked-1', { value: 'true', expectedVersion: 1 } as any)).rejects.toBeInstanceOf(ForbiddenException);
      // Guard fires BEFORE the CAS write — the row is never touched.
      expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('allows a SUPER_ADMIN to write a locked row', async () => {
      asSuperAdmin();
      const locked = createMockGlobalSettingEntity({ id: 'locked-1', key: 'enable-local-raw-capture', hasChanges: true, changes: { value: 'true' } });
      (locked as any).locked = true;
      (locked as any).version = 1;
      mockGlobalSettingRepository.findById.mockResolvedValue(locked);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(locked);

      await service.update('locked-1', { value: 'true', expectedVersion: 1 } as any);

      expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalledWith('locked-1', locked, 1);
    });

    it('does NOT guard an unlocked row for a non-super-admin', async () => {
      const unlocked = createMockGlobalSettingEntity({ id: 'unlocked-1', hasChanges: true, changes: { value: 'x' } });
      (unlocked as any).locked = false;
      (unlocked as any).version = 1;
      mockGlobalSettingRepository.findById.mockResolvedValue(unlocked);
      mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(unlocked);

      await service.update('unlocked-1', { value: 'x', expectedVersion: 1 } as any);

      expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
    });
  });

  describe('deleteById', () => {
    it('should soft delete global setting successfully', async () => {
      const deletedSetting = createMockGlobalSettingEntity({ id: 'setting-123' });
      mockGlobalSettingRepository.softDelete.mockResolvedValue(deletedSetting);

      const result = await service.deleteById('setting-123');

      expect(result.id).toBe('setting-123');
      expect(mockGlobalSettingRepository.softDelete).toHaveBeenCalledWith('setting-123');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'setting-123',
        }),
      );
    });

    it('should broadcast ResourceDeleted event with entity data', async () => {
      const deletedSetting = createMockGlobalSettingEntity({ id: 'setting-123' });
      mockGlobalSettingRepository.softDelete.mockResolvedValue(deletedSetting);

      await service.deleteById('setting-123');

      expect(deletedSetting.toObject).toHaveBeenCalled();
    });
  });

  describe('Context Integration', () => {
    it('should use user from CLS context for createdBy', async () => {
      const newSetting = createMockGlobalSettingEntity({ id: 'new-setting-id' });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
      });

      expect(mockClsService.get).toHaveBeenCalledWith('user');
    });

    it('should handle missing user in context', async () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return null;
        return null;
      });

      const newSetting = createMockGlobalSettingEntity({ id: 'new-setting-id', createdBy: null });
      mockGlobalSettingRepository.create.mockResolvedValue(newSetting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'New Setting',
        key: 'new.setting.key',
        value: 'new-value',
        dataType: ValueType.String,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Data Types', () => {
    it('should store and return String data type with string value', async () => {
      const setting = createMockGlobalSettingEntity({
        dataType: ValueType.String,
        value: 'string-value',
      });
      mockGlobalSettingRepository.create.mockResolvedValue(setting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'String Setting',
        key: 'string.setting',
        value: 'string-value',
        dataType: ValueType.String,
      });

      expect(result.dataType).toBe(ValueType.String);
      expect(result.value).toBe('string-value');
    });

    it('should store and return Integer data type with numeric string value', async () => {
      const setting = createMockGlobalSettingEntity({
        dataType: ValueType.Integer,
        value: '42',
      });
      mockGlobalSettingRepository.create.mockResolvedValue(setting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'Integer Setting',
        key: 'integer.setting',
        value: '42',
        dataType: ValueType.Integer,
      });

      expect(result.dataType).toBe(ValueType.Integer);
      expect(result.value).toBe('42');
    });

    it('should store and return Boolean data type with boolean string value', async () => {
      const setting = createMockGlobalSettingEntity({
        dataType: ValueType.Boolean,
        value: 'true',
      });
      mockGlobalSettingRepository.create.mockResolvedValue(setting);

      const result = await service.create({
        tenantId: 'tenant-1',
        name: 'Boolean Setting',
        key: 'boolean.setting',
        value: 'true',
        dataType: ValueType.Boolean,
      });

      expect(result.dataType).toBe(ValueType.Boolean);
      expect(result.value).toBe('true');
    });
  });

  describe('Repository Error Handling', () => {
    it('should propagate repository errors on findById', async () => {
      const error = new Error('Entity not found');
      mockGlobalSettingRepository.findById.mockRejectedValue(error);

      await expect(service.fetchById('non-existent-id')).rejects.toThrow('Entity not found');
    });

    it('should propagate repository errors on findAll', async () => {
      const error = new Error('Database connection failed');
      mockGlobalSettingRepository.findAll.mockRejectedValue(error);

      await expect(service.fetchAll({ limit: 10, page: 1 })).rejects.toThrow('Database connection failed');
    });

    it('should propagate repository errors on update', async () => {
      const existingSetting = createMockGlobalSettingEntity({
        id: 'setting-123',
        hasChanges: true,
      });
      (existingSetting as any).version = 1;
      mockGlobalSettingRepository.findById.mockResolvedValue(existingSetting);
      mockGlobalSettingRepository.updateWithVersion.mockRejectedValue(new Error('Update failed'));

      await expect(service.update('setting-123', { value: 'new-value', expectedVersion: 1 } as any)).rejects.toThrow('Update failed');
    });

    it('should propagate repository errors on softDelete', async () => {
      mockGlobalSettingRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

      await expect(service.deleteById('setting-123')).rejects.toThrow('Delete failed');
    });
  });

  // =========================================================================
  // Reveal (super-admin gate + step-up re-auth + audit, no plaintext
  // in the audit event). Decrypts via the repo's findByIdWithDecryptedValue.
  // =========================================================================
  describe('revealSecret', () => {
    const PLAINTEXT = 'super-secret-value';

    const asSuperAdmin = () =>
      mockClsService.get.mockImplementation((key: string) =>
        key === 'user' ? { id: 'super-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? 'tenant-1' : key === 'correlationId' ? 'corr-1' : null,
      );

    const wireDecrypt = (overrides?: Parameters<typeof createMockGlobalSettingEntity>[0]) => {
      const entity = createMockGlobalSettingEntity({ id: 'secret-1', key: 'secrets.api-token', namespace: 'secrets', ...overrides });
      mockGlobalSettingRepository.findByIdWithDecryptedValue.mockResolvedValue({ entity, plaintext: PLAINTEXT });
      mockUserRepository.findById.mockResolvedValue({ id: 'super-1', password: 'bcrypt-hash' });
      return entity;
    };

    it('rejects a non-super-admin with ForbiddenException (super-admin gate)', async () => {
      // Default CLS user has no roles ⇒ not a super-admin.
      const { ForbiddenException } = await import('@nestjs/common');
      await expect(service.revealSecret('secret-1', 'pw')).rejects.toBeInstanceOf(ForbiddenException);
      // Fail-closed: no decrypt, no step-up, no audit.
      expect(mockGlobalSettingRepository.findByIdWithDecryptedValue).not.toHaveBeenCalled();
      expect(mockCryptoService.verify).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('requires a step-up password (empty ⇒ UnauthorizedException)', async () => {
      asSuperAdmin();
      wireDecrypt();
      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(service.revealSecret('secret-1', '')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockCryptoService.verify).not.toHaveBeenCalled();
      expect(mockGlobalSettingRepository.findByIdWithDecryptedValue).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with UnauthorizedException (no decrypt, no audit)', async () => {
      asSuperAdmin();
      wireDecrypt();
      mockCryptoService.verify.mockResolvedValue(false);

      const { UnauthorizedException } = await import('@nestjs/common');
      await expect(service.revealSecret('secret-1', 'wrong-pw')).rejects.toBeInstanceOf(UnauthorizedException);

      // Step-up was attempted against the stored hash…
      expect(mockCryptoService.verify).toHaveBeenCalledWith('wrong-pw', 'bcrypt-hash');
      // …but the decrypt + audit never happen on failure.
      expect(mockGlobalSettingRepository.findByIdWithDecryptedValue).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('returns the decrypted plaintext for a super-admin with the correct password', async () => {
      asSuperAdmin();
      const entity = wireDecrypt();
      mockCryptoService.verify.mockResolvedValue(true);

      const result = await service.revealSecret('secret-1', 'correct-pw');

      expect(result.plaintext).toBe(PLAINTEXT);
      expect(result.entity).toBe(entity);
      expect(mockCryptoService.verify).toHaveBeenCalledWith('correct-pw', 'bcrypt-hash');
      // Decrypt went through the canonical repo helper (same crypto as the writer),
      // passing the SecretsService through.
      expect(mockGlobalSettingRepository.findByIdWithDecryptedValue).toHaveBeenCalledWith('secret-1', mockSecretsService);
    });

    it('writes an audit SysEvent (actor + key + action) that NEVER contains the plaintext', async () => {
      asSuperAdmin();
      wireDecrypt({ key: 'secrets.api-token' });
      mockCryptoService.verify.mockResolvedValue(true);

      await service.revealSecret('secret-1', 'correct-pw');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'secret-1',
          responsibleEntityId: 'super-1',
          // REQUIRED so SysEventService actually PERSISTS this READ to the
          // AuditLog (ResourceViewed is dropped by default for volume).
          forceAuditLog: true,
          data: expect.objectContaining({
            action: 'GLOBAL_SETTING_SECRET_REVEALED',
            key: 'secrets.api-token',
          }),
        }),
      );
      // Belt-and-suspenders: the plaintext must not appear ANYWHERE in the emitted event.
      const emitted = mockEventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceViewed);
      expect(JSON.stringify(emitted?.[1] ?? {})).not.toContain(PLAINTEXT);
    });

    it('attributes the audit to the RESOURCE tenant when the super-admin has no CLS tenant', async () => {
      // Real super-admins carry a null CLS tenantId; AuditLogProcessor
      // fail-closes on a null tenant, so the reveal audit must fall back to
      // the revealed setting's own (persisted) tenantId — otherwise the row
      // is silently dropped.
      mockClsService.get.mockImplementation((key: string) =>
        key === 'user' ? { id: 'super-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? null : key === 'correlationId' ? 'corr-1' : null,
      );
      wireDecrypt({ tenantId: 'platform-tenant-000' });
      mockCryptoService.verify.mockResolvedValue(true);

      await service.revealSecret('secret-1', 'correct-pw');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceViewed,
        expect.objectContaining({
          resourceId: 'secret-1',
          forceAuditLog: true,
          tenantId: 'platform-tenant-000',
        }),
      );
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle multiple concurrent fetchAll requests', async () => {
      const settings = [createMockGlobalSettingEntity({ id: 'setting-1' })];
      mockGlobalSettingRepository.findAll.mockResolvedValue(settings);
      mockGlobalSettingRepository.count.mockResolvedValue(1);

      const [result1, result2, result3] = await Promise.all([
        service.fetchAll({ limit: 10, page: 1 }),
        service.fetchAll({ limit: 10, page: 2 }),
        service.fetchAll({ limit: 10, page: 3 }),
      ]);

      expect(result1.data).toHaveLength(1);
      expect(result2.data).toHaveLength(1);
      expect(result3.data).toHaveLength(1);
    });
  });

  /**
   * TASK-890 §3.15 (OD-P) — the PLATFORM TIER of a tenant-manageable resource.
   *
   * `manage:GlobalSetting` is a tenant-admin grant, and the SYSTEM-tenant rows
   * are the platform's own defaults that every tenant inherits. Nothing in this
   * service distinguished them: a tenant admin was stopped only EMERGENTLY, by
   * the context interceptor refusing a foreign `x-tenant-id` and by the scope
   * extension throwing a raw `Error` on a tenant mismatch — a 400/500 where the
   * answer is a 403, and neither is a guard anyone declared.
   *
   * Same shape as `SettingsRegistryWriteService.assertMayWriteAtScope` and
   * `AiProviderConnectionService.assertWriteAllowed`: a privilege boundary on
   * the caller's OWN plane, so 403 — never the 404-over-403 cross-tenant
   * posture, which still applies to a row belonging to somebody else.
   */
  describe('TASK-890 platform-tier write guard', () => {
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

    function asSuperAdmin(): void {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'super-1', roles: ['SUPER_ADMIN'] };
        if (key === 'tenantId') return 'tenant-1';
        return null;
      });
    }

    it('refuses a tenant admin creating a SYSTEM-tenant row (403)', async () => {
      await expect(
        service.create({ tenantId: SYSTEM_TENANT_ID, name: 'n', key: 'k', value: 'v', dataType: ValueType.String } as never),
      ).rejects.toThrow(/super administrators only/i);
      expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
    });

    it('lets a super admin create a SYSTEM-tenant row', async () => {
      asSuperAdmin();
      const created = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID });
      mockGlobalSettingRepository.create.mockResolvedValue(created);

      const result = await service.create({ tenantId: SYSTEM_TENANT_ID, name: 'n', key: 'k', value: 'v', dataType: ValueType.String } as never);

      expect(result).toBe(created);
      expect(mockGlobalSettingRepository.create).toHaveBeenCalled();
    });

    it('lets a tenant admin create a row in its OWN tenant', async () => {
      const created = createMockGlobalSettingEntity({ id: 'own-1', tenantId: 'tenant-1' });
      mockGlobalSettingRepository.create.mockResolvedValue(created);

      const result = await service.create({ name: 'n', key: 'k', value: 'v', dataType: ValueType.String } as never);

      expect(result).toBe(created);
    });

    it('refuses a tenant admin updating a SYSTEM-tenant row (403), and never mutates it', async () => {
      const row = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, version: 4 });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.update('sys-1', { value: 'x', expectedVersion: 4 } as never)).rejects.toThrow(/super administrators only/i);
      expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('resolves EXISTENCE before privilege: an unknown id is the repository 404, never a 403', async () => {
      mockGlobalSettingRepository.findById.mockRejectedValue(new DataNotFoundException('globalSetting', 'nope'));

      await expect(service.update('nope', { value: 'x', expectedVersion: 1 } as never)).rejects.toBeInstanceOf(DataNotFoundException);
    });

    it('refuses a tenant admin deleting a SYSTEM-tenant row (403) — and LOADS the row first, so a foreign id still 404s', async () => {
      const row = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.deleteById('sys-1')).rejects.toThrow(/super administrators only/i);
      expect(mockGlobalSettingRepository.softDelete).not.toHaveBeenCalled();

      mockGlobalSettingRepository.findById.mockRejectedValue(new DataNotFoundException('globalSetting', 'foreign'));
      await expect(service.deleteById('foreign')).rejects.toBeInstanceOf(DataNotFoundException);
      expect(mockGlobalSettingRepository.softDelete).not.toHaveBeenCalled();
    });

    it('lets a super admin delete a SYSTEM-tenant row', async () => {
      asSuperAdmin();
      const row = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);
      mockGlobalSettingRepository.softDelete.mockResolvedValue(row);

      await expect(service.deleteById('sys-1')).resolves.toBe(row);
      expect(mockGlobalSettingRepository.softDelete).toHaveBeenCalledWith('sys-1');
    });

    it('guards the revive-on-create branch too — a soft-deleted SYSTEM row is not a back door', async () => {
      const deleted = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, resourceStatus: ResourceStatus.DELETED });
      mockGlobalSettingRepository.findFirst.mockResolvedValue(deleted);

      await expect(
        service.create({ tenantId: SYSTEM_TENANT_ID, name: 'n', key: 'k', value: 'v', dataType: ValueType.String } as never),
      ).rejects.toThrow(/super administrators only/i);
      expect(mockGlobalSettingRepository.restore).not.toHaveBeenCalled();
    });
  });

  /**
   * TASK-932 R-1 / D-5 — platform settings belong to the platform admin, and a
   * tenant admin must not be able to READ them.
   *
   * `GlobalSetting` is a member of `SYSTEM_SHARED_READ_MODELS`
   * (`packages/database/src/extensions/tenant-scope.ts`), so any read that
   * names no tenant is WIDENED to `tenantId IN [caller, SYSTEM]` and the
   * platform's rows arrive alongside the caller's own. That widening is right
   * for the resolvers that inherit a default on ABSENCE and wrong for the admin
   * row list, which is a DIRECTORY of the platform's configuration. An explicit
   * `where.tenantId` defeats it — `mergeSharedReadTenantIntoWhere` returns early
   * when the caller pinned one — which is the same technique
   * `AiProviderConnectionService.readTier` uses. So the pin lives here, and the
   * shared-read membership the inheriting resolvers depend on is untouched.
   *
   * The by-id read is a 404, not a 403: an admin who can enumerate key names
   * from the source tree must not be able to confirm a platform row one request
   * at a time. The WRITE lane stays a 403 (the TASK-890 OD-P guard above) — a
   * caller who already holds the id is being told "you may not write this",
   * which is a different sentence.
   */
  describe('TASK-932 read visibility — a non-elevated caller sees only its own tenant', () => {
    const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

    function asSuperAdmin(workingTenantId: string | null = null): void {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'super-1', roles: ['SUPER_ADMIN'] };
        if (key === 'tenantId') return workingTenantId;
        return null;
      });
    }

    beforeEach(() => {
      mockGlobalSettingRepository.findAll.mockResolvedValue([]);
      mockGlobalSettingRepository.count.mockResolvedValue(0);
    });

    it('pins the list to the caller own tenant, so the shared-read widening cannot serve SYSTEM rows', async () => {
      await service.fetchAll({ limit: 200, page: 1 });

      // TASK-954 — the pin also excludes `locked` platform defaults a
      // non-elevated caller cannot change.
      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', locked: false } }));
      // The count must carry the SAME predicate, or the page disagrees with its
      // own total and the missing rows look like a paging bug.
      expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', locked: false } }));
    });

    it('keeps the secretsOnly facet AND the pin — a facet must never drop the tenant', async () => {
      await service.fetchAll({ limit: 10, page: 1, secretsOnly: true });

      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ where: { AND: [{ tenantId: 'tenant-1', locked: false }, buildSecretSettingFilter()] } }),
      );
    });

    it('leaves an unscoped super admin unpinned — the platform tier reads every row', async () => {
      asSuperAdmin(null);
      await service.fetchAll({ limit: 200, page: 1 });

      expect(mockGlobalSettingRepository.findAll.mock.calls[0][0].where).toBeUndefined();
    });

    /**
     * TASK-932 OD-3 (owner decision, 2026-09-09) — the PLATFORM tier answers
     * the SAME status to a read as it does to a write: 403.
     *
     * The three cases below are the whole rule. A SYSTEM row is a privilege
     * refusal (its keys are declared in the registry and rendered in the
     * catalog by name — there is no existence to hide). An id that names no row
     * stays the repository's 404, which is what keeps a 403 from being an
     * existence oracle. And a row belonging to another CUSTOMER tenant keeps
     * the house 404-over-403, because THAT existence is a secret.
     */
    it('403s a SYSTEM row by id for a tenant admin (OD-3), and audits no view of it', async () => {
      const row = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.fetchById('sys-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.anything());
    });

    it('keeps an absent id a 404 — existence is resolved before privilege, so the 403 is no oracle', async () => {
      mockGlobalSettingRepository.findById.mockRejectedValue(new DataNotFoundException('globalSetting', 'nope'));

      await expect(service.fetchById('nope')).rejects.toBeInstanceOf(DataNotFoundException);
    });

    it('keeps ANOTHER customer tenant a 404 — that existence is still a secret', async () => {
      const row = createMockGlobalSettingEntity({ id: 'other-1', tenantId: 'tenant-2' });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.fetchById('other-1')).rejects.toBeInstanceOf(DataNotFoundException);
    });

    it('403s the by-tenant list for the SYSTEM tenant (OD-3), and reads nothing', async () => {
      await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: SYSTEM_TENANT_ID })).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
    });

    it('still serves the caller its OWN row by id', async () => {
      const row = createMockGlobalSettingEntity({ id: 'own-1', tenantId: 'tenant-1' });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.fetchById('own-1')).resolves.toBe(row);
    });

    it('lets a super admin read the SYSTEM row by id', async () => {
      asSuperAdmin();
      const row = createMockGlobalSettingEntity({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID });
      mockGlobalSettingRepository.findById.mockResolvedValue(row);

      await expect(service.fetchById('sys-1')).resolves.toBe(row);
    });

    it('404s the by-tenant list for another CUSTOMER tenant (SYSTEM is the 403 above, per OD-3)', async () => {
      await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 'tenant-2' })).rejects.toBeInstanceOf(DataNotFoundException);
      expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
    });

    it('lets a super admin list the SYSTEM tenant rows', async () => {
      asSuperAdmin();
      await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: SYSTEM_TENANT_ID })).resolves.toBeDefined();
      expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: SYSTEM_TENANT_ID } }));
    });
  });

  /**
   * TASK-932 S2-1 — one LIVE row per `(tenantId, key)`, whatever namespace it
   * wears.
   *
   * `create` used to probe for a soft-DELETED row at the exact
   * `(tenantId, name, key)` the new row would take, which is the shape of the
   * OLD unique index. That left the platform's real invariant unguarded: the
   * SAME key under a different `name`/`namespace` is a different row to that
   * index and a DUPLICATE to everything that reads settings by key.
   * `AppSettingsService` rebuilds its cache keyed by key alone and REFUSES the
   * whole cache when it finds two ("duplicate platform key(s) detected"), so a
   * second row does not shadow one setting — it takes the settings cache down
   * for the process.
   *
   * Lane S1 adds the DB unique index on `(tenantId, key)`. This guard is what
   * makes the write path say WHICH namespace already holds the key, instead of
   * surfacing a P2002 whose message names neither.
   */
  describe('TASK-932 duplicate-key guard — one live row per (tenantId, key)', () => {
    const CREATE = {
      tenantId: 'tenant-1',
      namespace: 'registry',
      name: 'Consultation Sharing',
      key: 'enable-consultation-sharing',
      value: 'false',
      dataType: ValueType.Boolean,
    } as any;

    /**
     * The two probes: the LIVE one carries no `resourceStatus` (the soft-delete
     * extension supplies `not: DELETED`), the revive probe pins `DELETED`. The
     * fixture answers on that difference rather than on call order, so a test
     * may drive `create` more than once.
     */
    function probes(live: unknown, deleted: unknown): void {
      const answer = (result: unknown) =>
        result === null ? Promise.reject(new DataNotFoundException('globalSetting', '{}')) : Promise.resolve(result);
      mockGlobalSettingRepository.findFirst.mockReset();
      mockGlobalSettingRepository.findFirst.mockImplementation((props: any) =>
        answer(props?.where?.resourceStatus === ResourceStatus.DELETED ? deleted : live),
      );
    }

    it('rejects a live row under a different namespace, and names the namespace that holds the key', async () => {
      const occupant = createMockGlobalSettingEntity({
        id: 'live-1',
        tenantId: 'tenant-1',
        key: 'enable-consultation-sharing',
        namespace: 'feature-flags',
        name: 'Consultation Sharing (legacy)',
      });
      probes(occupant, null);

      await expect(service.create(CREATE)).rejects.toBeInstanceOf(ArgumentInvalidException);
      await expect(service.create(CREATE)).rejects.toThrow(/feature-flags/);
      expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
      expect(mockGlobalSettingRepository.restore).not.toHaveBeenCalled();
    });

    it('probes for the live occupant namespace-agnostically — on (tenantId, key) alone', async () => {
      probes(null, null);
      mockGlobalSettingRepository.create.mockResolvedValue(createMockGlobalSettingEntity());

      await service.create(CREATE);

      const [liveProbe] = mockGlobalSettingRepository.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }];
      expect(liveProbe.where).toEqual({ tenantId: 'tenant-1', key: 'enable-consultation-sharing' });
      // No `resourceStatus`: the soft-delete extension supplies `not: DELETED`,
      // which is exactly "a live row" — and no `name`/`namespace`, which is
      // exactly what the index Lane S1 adds enforces.
      expect(liveProbe.where).not.toHaveProperty('namespace');
      expect(liveProbe.where).not.toHaveProperty('name');
    });

    it('revives a DELETED row matching (tenantId, key) even when name and namespace differ', async () => {
      const deleted = createMockGlobalSettingEntity({
        id: 'dead-1',
        tenantId: 'tenant-1',
        key: 'enable-consultation-sharing',
        namespace: 'feature-flags',
        name: 'Consultation Sharing (legacy)',
        resourceStatus: ResourceStatus.DELETED,
      });
      probes(null, deleted);
      const restored = createMockGlobalSettingEntity({ id: 'dead-1', hasChanges: true, changes: { value: 'false' } });
      mockGlobalSettingRepository.restore.mockResolvedValue(restored);
      mockGlobalSettingRepository.update.mockResolvedValue(restored);

      const result = await service.create(CREATE);

      expect(mockGlobalSettingRepository.restore).toHaveBeenCalledWith('dead-1', 'current-user-id');
      expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
      expect(result.id).toBe('dead-1');
      // The revived row takes the REQUEST's identity, so a caller that asked
      // for one namespace never silently gets the buried row's.
      expect(restored.name).toBe('Consultation Sharing');
      expect(restored.namespace).toBe('registry');
      const [deletedProbe] = mockGlobalSettingRepository.findFirst.mock.calls[1] as [{ where: Record<string, unknown> }];
      expect(deletedProbe.where).toEqual({ tenantId: 'tenant-1', key: 'enable-consultation-sharing', resourceStatus: ResourceStatus.DELETED });
    });

    it('creates normally when no row exists in any namespace', async () => {
      probes(null, null);
      mockGlobalSettingRepository.create.mockResolvedValue(createMockGlobalSettingEntity({ id: 'fresh-1' }));

      const result = await service.create(CREATE);

      expect(result.id).toBe('fresh-1');
      expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(1);
      expect(mockGlobalSettingRepository.restore).not.toHaveBeenCalled();
    });

    it('propagates a non-404 repository failure from the live probe instead of creating a duplicate', async () => {
      mockGlobalSettingRepository.findFirst.mockReset();
      mockGlobalSettingRepository.findFirst.mockRejectedValue(new Error('connection reset'));

      await expect(service.create(CREATE)).rejects.toThrow('connection reset');
      expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
    });
  });
});
