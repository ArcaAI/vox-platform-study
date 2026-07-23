/**
 * TenantService — locked-runtime integration tests.
 *
 * Closes a runtime gap: earlier the `GlobalSettingEntity` did not expose the
 * `locked` column, so the runtime guards
 * (`(config as unknown as { locked? }).locked === true`)
 * were unreachable in production. This file verifies the access-control and
 * provisioning paths end-to-end using REAL `GlobalSettingFactory` /
 * `GlobalSettingEntity` instances (not ad-hoc mock objects) so the typed
 * `entity.locked` plumbing is exercised top-to-bottom.
 *
 * Repositories and the tenant entity remain mocked at the boundary — the
 * point of these tests is the locked-field round trip through the domain
 * factory, the service guards, and the response, not the persistence layer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantService } from '../tenant.service';
import {
    GlobalSettingFactory,
    GlobalSettingEntity,
    ResourceStatusType,
    ValueType,
} from '@arcaai/domains';

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

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
    // UpdateTenantConfigs now writes via
    // Compare-And-Set; the locked guard runs *before* the CAS call.
    updateWithVersion: vi.fn(),
};

const mockDepartmentRepository = { findAll: vi.fn(), count: vi.fn() };
const mockPromptTemplateRepository = { findAll: vi.fn(), count: vi.fn() };
// `findDefault` returns null so the new pipeline-clone
// provisioning step is a clean no-op for this suite (which exercises create()).
const mockAsrPipelineRepository = { findAll: vi.fn(), count: vi.fn(), findDefault: vi.fn().mockResolvedValue(null) };
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

/**
 * Minimal mock TenantEntity. The tenant entity is unaffected by the
 * locked-runtime gap this file closes, and the existing
 * `tenant.service.test.ts` already
 * proves the tenant-side wiring. We just need the fields the service reads.
 */
const createMockTenantEntity = (overrides: Partial<{ id: string; key: string; name: string }> = {}) => ({
    id: overrides.id ?? 'tenant-id-1',
    key: overrides.key ?? 'CUSTOMER',
    name: overrides.name ?? 'Test Tenant',
    description: null,
    resourceStatus: ResourceStatusType.ENABLED,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-01-29T10:00:00Z'),
    updatedAt: new Date('2026-01-29T10:00:00Z'),
    deletedAt: null,
    hasChanges: false,
    changes: {},
    toObject: vi.fn().mockReturnValue({ id: overrides.id ?? 'tenant-id-1' }),
});

/**
 * Build a real `GlobalSettingEntity` via `GlobalSettingFactory`. This is the
 * critical difference vs. the existing `tenant.service.test.ts`: it exercises
 * the actual factory → entity → typed `locked` getter pipeline.
 */
const buildSetting = (overrides: {
    tenantId?: string;
    key?: string;
    name?: string;
    value?: string;
    defaultValue?: string;
    namespace?: string;
    description?: string;
    locked?: boolean;
    dataType?: ValueType;
} = {}): GlobalSettingEntity =>
    GlobalSettingFactory.CreateGlobalSetting({
        tenantId: overrides.tenantId ?? 'tenant-id-1',
        name: overrides.name ?? 'Test Setting',
        key: overrides.key ?? 'test.setting',
        value: overrides.value ?? 'test-value',
        defaultValue: overrides.defaultValue ?? 'test-default',
        namespace: overrides.namespace ?? 'com.flw.test',
        description: overrides.description ?? 'Test description',
        dataType: overrides.dataType ?? ValueType.String,
        locked: overrides.locked ?? false,
    });

/**
 * Only the `TenantFactory` is mocked — the real `GlobalSettingFactory`
 * provided by `@arcaai/domains` is preserved so the tests can construct
 * real entities and verify `locked` plumbing.
 */
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual<typeof import('@arcaai/domains')>('@arcaai/domains');
    return {
        ...actual,
        TenantFactory: {
            CreateTenant: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-tenant-id',
                resourceStatus: ResourceStatusType.ENABLED,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-tenant-id',
                    ...data,
                    resourceStatus: ResourceStatusType.ENABLED,
                }),
            })),
        },
    };
});

const installCls = (roles: string[] | undefined) => {
    mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
            case 'user':
                return {
                    id: 'current-user-id',
                    firstName: 'Test',
                    lastName: 'User',
                    email: 'test@example.com',
                    roles,
                };
            case 'tenantId':
                return 'tenant-1';
            case 'tenantCode':
                return 'TENANT_1';
            case 'correlationId':
                return 'corr-123';
            case 'requestIp':
                return '192.168.1.1';
            default:
                return null;
        }
    });
};

describe('TenantService — locked-field runtime plumbing (Agent D)', () => {
    let service: TenantService;

    beforeEach(() => {
        vi.clearAllMocks();
        installCls(['DOCTOR']);

        service = new TenantService(
            mockTenantRepository as never,
            mockGlobalSettingRepository as never,
            mockDepartmentRepository as never,
            mockPromptTemplateRepository as never,
            mockAsrPipelineRepository as never,
            mockDatabaseService as never,
            mockTenantBucketService as never,
            mockEventEmitter as never,
            mockClsService as never,
            // Model-catalog clone repo (no-op for this suite).
            { findAll: async () => [] } as never,
            // Pipeline-version clone repo (unused; clone is a no-op here).
            { create: async () => ({}) } as never,
            // DepartmentAgentRepository + PromptVersionRepository (unused; no-op here).
            { create: async () => ({}) } as never,
            { create: async () => ({}) } as never,
        );
    });

    describe('provisionTenantConfigs — preserves locked from source rows', () => {
        it('clones a locked=true row from __GLOBAL__ as a locked=true row on the new tenant', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id', key: 'NEW_TENANT' });
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });

            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);

            const sources = [
                buildSetting({
                    tenantId: 'global-id',
                    name: 'Default STT Model',
                    key: 'default-stt-model',
                    value: 'should-not-be-used',
                    defaultValue: 'whisper-base',
                    namespace: 'com.flw.stt',
                    description: 'STT default',
                    dataType: ValueType.String,
                    locked: true,
                }),
                buildSetting({
                    tenantId: 'global-id',
                    name: 'Feature Toggle',
                    key: 'feature.x',
                    value: 'true',
                    defaultValue: 'false',
                    namespace: 'com.flw.feature-flags',
                    description: 'Toggle X',
                    dataType: ValueType.Boolean,
                    locked: false,
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(sources);
            mockGlobalSettingRepository.create.mockImplementation(async (entity: GlobalSettingEntity) => entity);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(2);

            const firstClone = mockGlobalSettingRepository.create.mock.calls[0][0] as GlobalSettingEntity;
            expect(firstClone).toBeInstanceOf(GlobalSettingEntity);
            expect(firstClone.tenantId).toBe('new-tenant-id');
            expect(firstClone.key).toBe('default-stt-model');
            expect(firstClone.locked).toBe(true);
            expect(firstClone.value).toBe('whisper-base');

            const secondClone = mockGlobalSettingRepository.create.mock.calls[1][0] as GlobalSettingEntity;
            expect(secondClone).toBeInstanceOf(GlobalSettingEntity);
            expect(secondClone.tenantId).toBe('new-tenant-id');
            expect(secondClone.key).toBe('feature.x');
            expect(secondClone.locked).toBe(false);
        });
    });

    describe('updateTenantConfigs — locked guard via real entity', () => {
        it('throws ForbiddenException when target row has locked=true and caller is non-GLOBAL_ADMIN', async () => {
            installCls(['DOCTOR']);
            const tenant = createMockTenantEntity({ id: 'tenant-id-1', key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const lockedSetting = buildSetting({
                tenantId: 'tenant-id-1',
                key: 'default-stt-model',
                value: 'whisper-base',
                locked: true,
            });
            // Sanity: confirms typed boolean is preserved through factory.
            expect(lockedSetting.locked).toBe(true);

            mockGlobalSettingRepository.findById.mockResolvedValue(lockedSetting);

            await expect(
                service.updateTenantConfigs('tenant-id-1', [
                    { id: lockedSetting.id, value: 'whisper-large', expectedVersion: 1 } as never,
                ]),
            ).rejects.toThrow(/locked/i);

            expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
        });

        it('permits updating a locked=true row when caller has GLOBAL_ADMIN role', async () => {
            installCls(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-id-1', key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const lockedSetting = buildSetting({
                tenantId: 'tenant-id-1',
                key: 'admin-only-toggle',
                value: 'old',
                locked: true,
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(lockedSetting);
            mockGlobalSettingRepository.updateWithVersion.mockImplementation(
                async (_id: string, entity: GlobalSettingEntity) => entity,
            );

            const result = await service.updateTenantConfigs('tenant-id-1', [
                { id: lockedSetting.id, value: 'new', expectedVersion: 1 } as never,
            ]);

            expect(result.data).toHaveLength(1);
            expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalledTimes(1);
            const callArgs = mockGlobalSettingRepository.updateWithVersion.mock.calls[0];
            const persistedEntity = callArgs[1] as GlobalSettingEntity;
            expect(persistedEntity.locked).toBe(true);
            expect(persistedEntity.value).toBe('new');
            // The expectedVersion is the third positional argument.
            expect(callArgs[2]).toBe(1);
        });
    });

    describe('fetchTenantConfigs — locked-value masking via real entity', () => {
        it('masks the value of locked=true rows when caller is non-GLOBAL_ADMIN', async () => {
            installCls(['DOCTOR']);
            // Pinned to the CLS tenant (`tenant-1`)
            // so the new fetchTenantConfigs GLOBAL_ADMIN gate doesn't
            // 404 a non-GLOBAL_ADMIN reading another tenant's configs.
            // The locked-masking behavior under test is orthogonal to
            // the cross-tenant guard.
            const tenant = createMockTenantEntity({ id: 'tenant-1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const configs = [
                buildSetting({
                    tenantId: 'tenant-1',
                    key: 'public.setting',
                    value: 'visible',
                    locked: false,
                }),
                buildSetting({
                    tenantId: 'tenant-1',
                    key: 'secret.setting',
                    value: 'super-secret',
                    locked: true,
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(2);

            const result = await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            const byKey = Object.fromEntries(result.data.map((c) => [c.key, c.value]));
            expect(byKey['public.setting']).toBe('visible');
            expect(byKey['secret.setting']).toBe('');

            const lockedResult = result.data.find((c) => c.key === 'secret.setting');
            expect(lockedResult).toBeInstanceOf(GlobalSettingEntity);
            expect(lockedResult!.locked).toBe(true);
        });
    });
});
