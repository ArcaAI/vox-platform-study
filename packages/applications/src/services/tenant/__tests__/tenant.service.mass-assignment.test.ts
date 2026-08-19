/**
 * Service-layer mass-assignment regression test.
 *
 * Asserts defense-in-depth: even if the global ValidationPipe is bypassed
 * (internal callers, test harnesses, future refactors), the service MUST
 * NOT apply unauthorized fields onto the GlobalSettingEntity. Only the
 * explicit allowlist (value, description) may be mutated — `changes` is
 * constructed from `{ value, description }` only, so an evil payload
 * carrying key/tenantId/locked/defaultValue has those fields silently
 * dropped rather than applied to the entity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantService } from '../tenant.service';
import { ResourceStatusType } from '@arcaai/domains';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockTenantRepository = {
  findById: vi.fn(),
  findFirst: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
};
const mockGlobalSettingRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // Write path migrated to Compare-And-Set;
  // the mass-assignment guard runs BEFORE the CAS, so dropping unauthorized
  // fields is still proved end-to-end here.
  updateWithVersion: vi.fn(),
};
const mockDepartmentRepository = { findAll: vi.fn(), count: vi.fn() };
const mockPromptTemplateRepository = { findAll: vi.fn(), count: vi.fn() };
const mockAsrPipelineRepository = { findAll: vi.fn(), count: vi.fn() };
// (C.4) — `updateTenantConfigs` wraps writes in
// `databaseService.baseClient.$transaction(callback)`. The stub invokes the
// callback with a sentinel tx client so the loop executes.
const mockTxClient = { __tx: true } as const;
const mockDatabaseService = {
  getClient: vi.fn(),
  baseClient: {
    $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient)),
  },
};
const mockTenantBucketService = { provisionSystemBuckets: vi.fn() };

const createMockTenantEntity = (overrides: { id?: string; key?: string } = {}) => ({
  id: overrides.id ?? 'tenant-123',
  key: overrides.key ?? 'CUSTOMER',
  name: 'Customer Tenant',
  description: null,
  resourceStatus: ResourceStatusType.ENABLED,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-01-29T10:00:00Z'),
  updatedAt: new Date('2026-01-29T10:00:00Z'),
  deletedAt: null,
  hasChanges: false,
  changes: {},
  enable: vi.fn(),
  disable: vi.fn(),
  toObject: vi.fn().mockReturnValue({ id: overrides.id, key: overrides.key }),
});

interface MockSetting extends Record<string, unknown> {
  id: string;
  tenantId: string;
  key: string;
  value: string;
  defaultValue: string | null;
  locked: boolean;
  description: string | null;
  hasChanges: boolean;
  changes: Record<string, unknown>;
  toObject: ReturnType<typeof vi.fn>;
}

const createMockSetting = (overrides: Partial<MockSetting> = {}): MockSetting => ({
  id: overrides.id ?? 'cfg-1',
  tenantId: overrides.tenantId ?? 'tenant-123',
  namespace: 'com.flw.configurations',
  name: 'Audio Language',
  key: overrides.key ?? 'AUDIO_LANG',
  value: overrides.value ?? 'en',
  defaultValue: overrides.defaultValue !== undefined ? overrides.defaultValue : 'en',
  dataType: 'String',
  description: overrides.description !== undefined ? overrides.description : 'Spoken language',
  locked: overrides.locked ?? false,
  resourceStatus: ResourceStatusType.ENABLED,
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-01-29T10:00:00Z'),
  updatedAt: new Date('2026-01-29T10:00:00Z'),
  deletedAt: null,
  hasChanges: overrides.hasChanges ?? false,
  changes: overrides.changes ?? {},
  // A real `GlobalSettingEntity` always carries a `_version` (default 1). The
  // mock omitted it, so `entity.version` was `undefined` and any supplied
  // `expectedVersion` compared unequal once the OCC precondition moved ahead of
  // the no-changes guard. Mirror the entity rather than the omission.
  version: (overrides.version as number | undefined) ?? 1,
  toObject: vi.fn().mockReturnValue({ id: overrides.id, value: overrides.value }),
});

const setRequestUserRoles = (roles: string[] | undefined) => {
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return {
          id: 'doctor-user-id',
          firstName: 'Doctor',
          lastName: 'Evil',
          email: 'doctor@example.com',
          roles,
        };
      case 'tenantId':
        return 'tenant-123';
      case 'tenantCode':
        return 'CUSTOMER';
      case 'correlationId':
        return 'corr-redteam';
      case 'requestIp':
        return '10.0.0.7';
      default:
        return null;
    }
  });
};

describe('Phase 0 Item 2 — TenantService.updateTenantConfigs must NOT apply unauthorized fields', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    setRequestUserRoles(['DOCTOR']);
    service = new TenantService(
      mockTenantRepository as any,
      mockGlobalSettingRepository as any,
      mockDepartmentRepository as any,
      mockPromptTemplateRepository as any,
      mockAsrPipelineRepository as any,
      mockDatabaseService as any,
      mockTenantBucketService as any,
      mockEventEmitter as any,
      mockClsService as any,
      // Model-catalog clone repo (unused by this suite).
      { findAll: async () => [] } as any,
      // Pipeline-version clone repo (unused by this suite).
      { create: async () => ({}) } as any,
      // DepartmentAgentRepository + PromptVersionRepository (unused by this suite).
      { create: async () => ({}) } as any,
      { create: async () => ({}) } as any,
    );
  });

  it('drops "key" / "tenantId" / "locked" / "defaultValue" smuggled in the request payload', async () => {
    const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'CUSTOMER' });
    const setting = createMockSetting({
      id: 'cfg-1',
      tenantId: 'tenant-123',
      key: 'AUDIO_LANG',
      value: 'en',
      defaultValue: 'en',
      locked: false,
      description: 'Spoken language',
    });
    mockTenantRepository.findFirst.mockResolvedValue(tenant);
    mockGlobalSettingRepository.findById.mockResolvedValue(setting);
    mockGlobalSettingRepository.updateWithVersion.mockImplementation((_id: string, entity: MockSetting) => Promise.resolve(entity));

    const evilPayload = {
      id: 'cfg-1',
      value: 'es',
      description: 'Updated description',
      expectedVersion: 1,
      key: 'JWT_SECRET_KEY',
      tenantId: 'attacker-tenant',
      locked: true,
      defaultValue: 'attacker-default',
    } as any;

    await service.updateTenantConfigs('tenant-123', [evilPayload]);

    expect(setting.key, 'key must be immutable via updateTenantConfigs').toBe('AUDIO_LANG');
    expect(setting.tenantId, 'tenantId must be immutable via updateTenantConfigs').toBe('tenant-123');
    expect(setting.locked, 'locked must be immutable via updateTenantConfigs').toBe(false);
    expect(setting.defaultValue, 'defaultValue must be immutable via updateTenantConfigs').toBe('en');
    expect(setting.value, 'value remains the one allowlisted writable field').toBe('es');
  });

  it('still applies the legitimate allowlist (value, description) on a clean payload', async () => {
    const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'CUSTOMER' });
    const setting = createMockSetting({
      id: 'cfg-2',
      tenantId: 'tenant-123',
      key: 'AUDIO_LANG',
      value: 'en',
      description: 'old',
    });
    mockTenantRepository.findFirst.mockResolvedValue(tenant);
    mockGlobalSettingRepository.findById.mockResolvedValue(setting);
    mockGlobalSettingRepository.updateWithVersion.mockImplementation((_id: string, entity: MockSetting) => Promise.resolve(entity));

    await service.updateTenantConfigs('tenant-123', [{ id: 'cfg-2', value: 'fr', description: 'new', expectedVersion: 1 } as any]);

    expect(setting.value).toBe('fr');
    expect(setting.description).toBe('new');
  });
});
