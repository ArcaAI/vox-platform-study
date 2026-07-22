/**
 * TenantService Unit Tests
 *
 * Tests for the TenantService that handles tenant management operations.
 *
 * Testing Strategy:
 * - Tests verify actual behavior outcomes, not just that mocks were called
 * - Mocks are complete representations of real entity structures
 * - Edge cases and error scenarios are thoroughly covered
 * - Tests focus on service logic, not repository implementation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TenantService } from '../tenant.service';
import { SysEventType, ResourceStatusType, ResourceType, TenantFactory, TenantPlan } from '@arcaai/domains';

// Mock ClsService - represents the request context
const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

// Mock EventEmitter - captures system events
const mockEventEmitter = {
    emit: vi.fn(),
};

// Mock TenantRepository - simulates database operations
const mockTenantRepository = {
    findById: vi.fn(),
    findFirst: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // `update()` now writes via Compare-And-Set
    // (`updateWithVersion`). Existing tests below still reference `.update`
    // for legacy assertions (kept for paranoia); the live write path uses
    // `updateWithVersion`.
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
};

// Mock GlobalSettingRepository - for tenant configurations
const mockGlobalSettingRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // UpdateTenantConfigs now writes via
    // Compare-And-Set; tests below still set up `.update` for back-compat
    // assertions but the live write path uses `updateWithVersion`.
    updateWithVersion: vi.fn(),
};

// Mock DepartmentRepository
const mockDepartmentRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
};

// Mock PromptTemplateRepository
const mockPromptTemplateRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
};

// Mock AsrPipelineRepository.
// `create()` clones EVERY enabled SYSTEM ASR pipeline (+ each one's
// current version) into each new tenant, so the repo mock exposes the
// pipeline-clone surface (findEnabledPipelines/isSlugUnique/create/
// setDefaultForTenant) in addition to the legacy findAll/count.
const mockAsrPipelineRepository = {
    findAll: vi.fn(),
    count: vi.fn(),
    findEnabledPipelines: vi.fn(),
    isSlugUnique: vi.fn(),
    create: vi.fn(),
    setDefaultForTenant: vi.fn(),
};

// Mock AsrPipelineVersionRepository — the pipeline clone also
// copies the source pipeline's current version row into the new tenant.
const mockAsrPipelineVersionRepository = {
    findByPipeline: vi.fn(),
    getNextVersionNumber: vi.fn(),
    create: vi.fn(),
};

// Mock AiModelRepository — clone-per-tenant.
const mockAiModelRepository = {
    findAll: vi.fn(),
    isSlugUnique: vi.fn(),
    create: vi.fn(),
};

// Mock CoreDatabaseService.
// (C.4) — `updateTenantConfigs` now wraps the
// per-row CAS loop in `databaseService.baseClient.$transaction(callback)`
// for all-or-nothing semantics. The mock `$transaction` simply invokes the
// callback with a stub tx client so the loop executes; tests then assert
// on tx propagation, conflict rollback, and broadcast suppression.
const mockTxClient = { __tx: true } as const;
// (#4/#5) — `getUsageStats` reads aggregates straight off the extended
// client. Delegates default to empty/zero so suites that never call it are
// unaffected; the getUsageStats tests override per-case.
const mockExtendedClient = {
    userRoleAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    media: { aggregate: vi.fn().mockResolvedValue({ _sum: { size: null } }) },
    tenantBucket: { aggregate: vi.fn().mockResolvedValue({ _sum: { quotaBytes: null } }) },
    audioRecording: { aggregate: vi.fn().mockResolvedValue({ _sum: { duration: null } }) },
    summaryMeta: { count: vi.fn().mockResolvedValue(0) },
    consultation: { count: vi.fn().mockResolvedValue(0) },
};
const mockDatabaseService = {
    getClient: vi.fn(),
    client: mockExtendedClient,
    baseClient: {
        $transaction: vi.fn().mockImplementation(async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient)),
    },
};

// Mock TenantBucketService
const mockTenantBucketService = {
    provisionSystemBuckets: vi.fn(),
    // Plan storageQuotaBytes -> primary bucket quotaBytes.
    applyPlanStorageQuota: vi.fn(),
};

/**
 * Creates a complete mock tenant entity matching the real TenantEntity structure.
 * This ensures tests don't pass due to incomplete mock data.
 */
const createMockTenantEntity = (overrides: Partial<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
    version: number;
}> = {}) => {
    const entity = {
        id: overrides.id ?? 'tenant-id-1',
        key: overrides.key ?? 'TENANT_CODE',
        name: overrides.name ?? 'Test Tenant',
        description: overrides.description ?? null,
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        createdBy: overrides.createdBy ?? null,
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        // Every tenant row carries a server-owned
        // `_version` after the B.5 BaseEntity getter + B.6 mapper. The default
        // is the first-write version (1); per-test overrides exercise the CAS
        // bump path.
        version: overrides.version ?? 1,
        enable: vi.fn(),
        disable: vi.fn(),
        toObject: vi.fn(),
    };
    entity.toObject.mockReturnValue({
        id: entity.id,
        key: entity.key,
        name: entity.name,
        description: entity.description,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        updatedBy: entity.updatedBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
    });
    return entity;
};

/**
 * Creates a complete mock global setting entity for tenant configuration tests.
 *
 * Includes the additional `locked`, `defaultValue`, `dataType`, `description`,
 * and `name` fields used by the access-control + provisioning paths.
 * `locked` is intentionally optional (defaults to `false`) so existing tests
 * are unaffected.
 */
const createMockGlobalSettingEntity = (overrides: Partial<{
    id: string;
    tenantId: string;
    namespace: string;
    name: string;
    key: string;
    value: string;
    defaultValue: string | null;
    dataType: string;
    description: string | null;
    locked: boolean;
    resourceStatus: ResourceStatusType;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    hasChanges: boolean;
    changes: Record<string, unknown>;
}> = {}) => {
    const entity: Record<string, unknown> & { value: string } = {
        id: overrides.id ?? 'setting-id-1',
        tenantId: overrides.tenantId ?? 'tenant-id-1',
        namespace: overrides.namespace ?? 'com.flw.configurations',
        name: overrides.name ?? 'Setting Name',
        key: overrides.key ?? 'setting.key',
        value: overrides.value ?? 'setting-value',
        defaultValue: overrides.defaultValue !== undefined ? overrides.defaultValue : 'default-value',
        dataType: overrides.dataType ?? 'String',
        description: overrides.description !== undefined ? overrides.description : 'Test description',
        locked: overrides.locked ?? false,
        resourceStatus: overrides.resourceStatus ?? ResourceStatusType.ENABLED,
        createdBy: overrides.createdBy ?? null,
        updatedBy: overrides.updatedBy ?? null,
        createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
        deletedAt: overrides.deletedAt ?? null,
        hasChanges: overrides.hasChanges ?? false,
        changes: overrides.changes ?? {},
        toObject: vi.fn(),
    };
    (entity.toObject as ReturnType<typeof vi.fn>).mockReturnValue({
        id: entity.id,
        tenantId: entity.tenantId,
        namespace: entity.namespace,
        name: entity.name,
        key: entity.key,
        value: entity.value,
        defaultValue: entity.defaultValue,
        dataType: entity.dataType,
        description: entity.description,
        locked: entity.locked,
        resourceStatus: entity.resourceStatus,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    });
    return entity;
};

// Mock TenantFactory + GlobalSettingFactory - simulate entity creation without
// triggering the real generated constructors, which require additional setup.
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        TenantFactory: {
            CreateTenant: vi.fn((data) => ({
                ...data,
                id: 'new-tenant-id',
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({
                    id: 'new-tenant-id',
                    ...data,
                    resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                }),
            })),
        },
        GlobalSettingFactory: {
            CreateGlobalSetting: vi.fn((data) => ({
                ...data,
                id: `cloned-${data.key}`,
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                hasChanges: true,
                changes: { ...data },
                toObject: vi.fn().mockReturnValue({ ...data }),
            })),
        },
        // AiModel catalog clone-per-tenant.
        AiModelFactory: {
            CreateAiModel: vi.fn((data) => ({
                ...data,
                id: `cloned-${data.slug}`,
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({ ...data }),
            })),
        },
        // AsrPipeline + version clone-per-tenant (D — extend_clone).
        AsrPipelineFactory: {
            CreateAsrPipeline: vi.fn((data) => ({
                ...data,
                id: `cloned-pipeline-${data.slug}`,
                isDefault: false,
                resourceStatus: (actual as any).ResourceStatusType?.ENABLED ?? 'ENABLED',
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({ ...data }),
            })),
        },
        AsrPipelineVersionFactory: {
            CreateAsrPipelineVersion: vi.fn((data) => ({
                ...data,
                id: `cloned-version-${data.asrPipelineId}-${data.versionNumber}`,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
                toObject: vi.fn().mockReturnValue({ ...data }),
            })),
        },
    };
});

describe('TenantService', () => {
    let service: TenantService;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: return valid user from CLS - complete user context
        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return {
                        id: 'current-user-id',
                        firstName: 'Test',
                        lastName: 'User',
                        email: 'test@example.com',
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

        // Default: echo the persisted department so
        // create()'s post-provision broadcast can read `saved.id` /
        // `saved.createdAt`. Individual tests override this as needed.
        mockDepartmentRepository.create.mockImplementation(async (entity: any) => entity);

        // Default: empty SYSTEM catalog so the model-clone
        // provisioning step is a no-op for the existing create tests. The clone
        // tests below override `findAll` with SYSTEM rows.
        mockAiModelRepository.findAll.mockResolvedValue([]);
        mockAiModelRepository.isSlugUnique.mockResolvedValue(true);
        mockAiModelRepository.create.mockImplementation(async (entity: any) => entity);

        // Default: no SYSTEM pipelines so the pipeline-clone
        // provisioning step is a no-op for the existing create tests. The
        // pipeline-clone tests below override `findEnabledPipelines`.
        mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue([]);
        mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);
        mockAsrPipelineRepository.create.mockImplementation(async (entity: any) => entity);
        mockAsrPipelineRepository.setDefaultForTenant.mockResolvedValue(undefined);
        mockAsrPipelineVersionRepository.findByPipeline.mockResolvedValue([]);
        mockAsrPipelineVersionRepository.getNextVersionNumber.mockResolvedValue(1);
        mockAsrPipelineVersionRepository.create.mockImplementation(async (entity: any) => entity);

        // Create service instance with mocks
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
            mockAiModelRepository as any,
            mockAsrPipelineVersionRepository as any,
        );
    });

    describe('create', () => {
        it('should create a new tenant with all required fields', async () => {
            const newTenant = createMockTenantEntity({
                id: 'new-tenant-id',
                key: 'NEW_TENANT',
                name: 'New Tenant',
                createdBy: 'current-user-id',
            });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(result.id).toBe('new-tenant-id');
            expect(result.key).toBe('NEW_TENANT');
            expect(result.name).toBe('New Tenant');
        });

        // New tenants default to STARTER (overridable).
        it('defaults the plan to STARTER when the request omits it', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            await service.create({ key: 'NEW_TRIAL', name: 'New Trial' });

            expect(TenantFactory.CreateTenant).toHaveBeenCalledWith(expect.objectContaining({ plan: TenantPlan.STARTER }));
        });

        it('respects an explicit plan on create (no STARTER override)', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            await service.create({ key: 'NEW_ENT', name: 'New Ent', plan: TenantPlan.ENTERPRISE });

            expect(TenantFactory.CreateTenant).toHaveBeenCalledWith(expect.objectContaining({ plan: TenantPlan.ENTERPRISE }));
        });

        // Auto-generated tenant key when the request omits it.
        describe('create — tenant key auto-generation', () => {
            it('generates a unique key from the name when key is omitted', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockTenantRepository.findFirst.mockResolvedValue(undefined);

                await service.create({ name: 'Acme Health Clinic' } as any);

                expect(TenantFactory.CreateTenant).toHaveBeenCalledWith(expect.objectContaining({ key: 'acme-health-clinic' }));
            });

            it('appends a numeric collision suffix when the generated key is taken', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockTenantRepository.findFirst.mockImplementation(async (props: any) => {
                    const key = props?.where?.key;
                    if (key === 'acme') return createMockTenantEntity({ key: 'acme' });
                    return undefined;
                });

                await service.create({ name: 'Acme' } as any);

                expect(TenantFactory.CreateTenant).toHaveBeenCalledWith(expect.objectContaining({ key: 'acme-2' }));
            });

            it('uses the explicit key as-is when supplied (no auto-generation)', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);

                await service.create({ key: 'EXPLICIT_KEY', name: 'Explicit Co' });

                expect(TenantFactory.CreateTenant).toHaveBeenCalledWith(expect.objectContaining({ key: 'EXPLICIT_KEY' }));
                // No existence probe for the caller-supplied key — only the
                // (unrelated) __GLOBAL__ config-clone lookup may hit findFirst.
                expect(mockTenantRepository.findFirst).not.toHaveBeenCalledWith(
                    expect.objectContaining({ where: { key: 'EXPLICIT_KEY' } }),
                );
            });
        });

        // Plan storageQuotaBytes applied to the primary bucket
        // as part of the tenant spin-up (composes with provisionSystemBuckets).
        it('applies the plan storage quota to the new tenant after provisioning buckets', async () => {
            const newTenant = { ...createMockTenantEntity({ id: 'new-tenant-id' }), plan: TenantPlan.STARTER };
            mockTenantRepository.create.mockResolvedValue(newTenant);

            await service.create({ key: 'NEW', name: 'New', plan: TenantPlan.STARTER });

            expect(mockTenantBucketService.applyPlanStorageQuota).toHaveBeenCalledWith('new-tenant-id', TenantPlan.STARTER);
        });

        it('does not abort tenant creation when applyPlanStorageQuota fails', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantBucketService.applyPlanStorageQuota.mockRejectedValueOnce(new Error('db down'));

            const result = await service.create({ key: 'NEW', name: 'New' });

            expect(result.id).toBe('new-tenant-id');
        });

        // Clone-per-tenant model catalog.
        const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
        const makeSystemModel = (slug: string, over: Record<string, unknown> = {}) => ({
            id: `sys-${slug}`,
            tenantId: SYSTEM_TENANT_ID,
            name: `Model ${slug}`,
            slug,
            description: 'sys model',
            category: 'NLP',
            taskType: 'SUMMARIZATION',
            modelType: 'BASE_MODEL',
            source: 'LOCAL',
            sourceUri: `uri/${slug}`,
            sourceRevision: 'main',
            format: 'GGUF',
            // The registry columns every clone
            // must carry; dropping them yields NULL-provider clones that
            // shadow the SYSTEM values in the runtime-provider resolvers.
            provider: 'lm-studio',
            architecture: 'granite',
            metaData: { seededBy: 'task-506' },
            memorySizeMb: 100,
            computeType: 'quantized',
            tags: ['x'],
            ...over,
        });

        it('clones the SYSTEM AiModel catalog into the new tenant', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockAiModelRepository.findAll.mockResolvedValue([makeSystemModel('a'), makeSystemModel('b')]);
            mockAiModelRepository.isSlugUnique.mockResolvedValue(true);

            await service.create({ key: 'NEW', name: 'New' });

            // Reads the SYSTEM-owned master catalog.
            expect(mockAiModelRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }) }),
            );
            // One clone per SYSTEM row, each bound to the NEW tenant (never SYSTEM).
            expect(mockAiModelRepository.create).toHaveBeenCalledTimes(2);
            const clonedTenantIds = mockAiModelRepository.create.mock.calls.map((c: any[]) => c[0].tenantId);
            expect(clonedTenantIds).toEqual(['new-tenant-id', 'new-tenant-id']);
        });

        it('clone carries provider, architecture and metaData', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockAiModelRepository.findAll.mockResolvedValue([
                makeSystemModel('a', {
                    provider: 'azure-foundry',
                    architecture: 'transformer',
                    metaData: { voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }], deployment: 'mai-transcribe' },
                }),
            ]);
            mockAiModelRepository.isSlugUnique.mockResolvedValue(true);

            await service.create({ key: 'NEW', name: 'New' });

            expect(mockAiModelRepository.create).toHaveBeenCalledTimes(1);
            const cloned = mockAiModelRepository.create.mock.calls[0][0];
            expect(cloned.provider).toBe('azure-foundry');
            expect(cloned.architecture).toBe('transformer');
            expect(cloned.metaData).toEqual({ voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN' }], deployment: 'mai-transcribe' });
        });

        it('clone is idempotent — skips slugs already present in the tenant', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockAiModelRepository.findAll.mockResolvedValue([makeSystemModel('a'), makeSystemModel('b')]);
            // 'a' already cloned (not unique) → skipped; 'b' is new → cloned.
            mockAiModelRepository.isSlugUnique.mockImplementation(async (_t: string, slug: string) => slug !== 'a');

            await service.create({ key: 'NEW', name: 'New' });

            expect(mockAiModelRepository.create).toHaveBeenCalledTimes(1);
            expect(mockAiModelRepository.create.mock.calls[0][0].slug).toBe('b');
        });

        it('clone failure does not abort tenant creation', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockAiModelRepository.findAll.mockRejectedValue(new Error('db down'));

            const result = await service.create({ key: 'NEW', name: 'New' });

            // The model-catalog provisioning ran but its failure was swallowed.
            expect(mockAiModelRepository.findAll).toHaveBeenCalled();
            expect(result.id).toBe('new-tenant-id');
        });

        // Full-parity policy — clone EVERY enabled SYSTEM ASR pipeline (+ each
        // one's current version) into the new tenant, mark the clone of the
        // SYSTEM default as the tenant default, idempotent per slug,
        // failure-isolated.
        describe('create — provisionTenantPipelineCatalog (full parity)', () => {
            const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
            const makeSystemPipeline = (over: Record<string, unknown> = {}) => ({
                id: 'sys-pipeline-ct2',
                tenantId: SYSTEM_TENANT_ID,
                name: 'Production Pipeline (Faster-Whisper Turbo CT2 int8)',
                slug: 'production-faster-whisper-turbo-int8',
                description: 'system default pipeline',
                configYaml: 'version: "1.1"\nmodels:\n  asr: {}\n',
                tags: ['production'],
                isDefault: false,
                ...over,
            });
            // A realistic SYSTEM catalog: the default (production) + two others.
            const makeSystemCatalog = () => [
                makeSystemPipeline({
                    id: 'sys-pipeline-production',
                    slug: 'production-whisper-large-v3',
                    name: 'Full Features',
                    isDefault: true,
                }),
                makeSystemPipeline({ id: 'sys-pipeline-turbo', slug: 'turbo-whisper-large-v3', name: 'Turbo' }),
                makeSystemPipeline(),
            ];

            it('clones EVERY enabled SYSTEM pipeline into the new tenant and marks the SYSTEM default clone the tenant default', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue(makeSystemCatalog());
                mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);

                await service.create({ key: 'NEW', name: 'New' });

                // Reads the SYSTEM-owned catalog (never a customer tenant).
                expect(mockAsrPipelineRepository.findEnabledPipelines).toHaveBeenCalledWith(SYSTEM_TENANT_ID);
                // Clones ALL three SYSTEM pipelines, each bound to the NEW tenant.
                expect(mockAsrPipelineRepository.create).toHaveBeenCalledTimes(3);
                const createdSlugs = mockAsrPipelineRepository.create.mock.calls.map((c) => c[0].slug);
                expect(new Set(createdSlugs)).toEqual(
                    new Set(['production-whisper-large-v3', 'turbo-whisper-large-v3', 'production-faster-whisper-turbo-int8']),
                );
                mockAsrPipelineRepository.create.mock.calls.forEach(([created]) => {
                    expect(created.tenantId).toBe('new-tenant-id');
                });
                // Exactly one default flip: the clone of the SYSTEM default (production).
                expect(mockAsrPipelineRepository.setDefaultForTenant).toHaveBeenCalledTimes(1);
                const defaultCall = mockAsrPipelineRepository.setDefaultForTenant.mock.calls[0];
                expect(defaultCall[0]).toBe('new-tenant-id');
                const productionClone = mockAsrPipelineRepository.create.mock.calls
                    .map((c) => c[0])
                    .find((p) => p.slug === 'production-whisper-large-v3');
                expect(defaultCall[1]).toBe(productionClone.id);
            });

            // Provisioned clones ARE template copies: they carry the
            // template's slug as provenance and start locked, so a tenant admin
            // clones one to customize rather than editing it in place.
            it('stamps template lineage on every provisioned clone', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue(makeSystemCatalog());
                mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);

                await service.create({ key: 'NEW', name: 'New' });

                expect(mockAsrPipelineRepository.create).toHaveBeenCalledTimes(3);
                mockAsrPipelineRepository.create.mock.calls.forEach(([created]) => {
                    expect(created.templateLocked).toBe(true);
                    expect(created.sourceTemplateSlug).toBe(created.slug);
                });
            });

            it('clones each source pipeline current version (carrying its YAML) as the tenant pipeline v1', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue([makeSystemPipeline({ isDefault: true })]);
                mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);
                // findByPipeline returns newest-first; [0] is the current version.
                mockAsrPipelineVersionRepository.findByPipeline.mockResolvedValue([
                    { id: 'sys-v3', asrPipelineId: 'sys-pipeline-ct2', versionNumber: 3, configYaml: 'CURRENT-VERSION-YAML', name: 'n', description: 'd' },
                    { id: 'sys-v2', asrPipelineId: 'sys-pipeline-ct2', versionNumber: 2, configYaml: 'OLD', name: 'n', description: 'd' },
                ]);
                mockAsrPipelineVersionRepository.getNextVersionNumber.mockResolvedValue(1);

                await service.create({ key: 'NEW', name: 'New' });

                expect(mockAsrPipelineVersionRepository.findByPipeline).toHaveBeenCalledWith('sys-pipeline-ct2');
                expect(mockAsrPipelineVersionRepository.create).toHaveBeenCalledTimes(1);
                const version = mockAsrPipelineVersionRepository.create.mock.calls[0][0];
                expect(version.tenantId).toBe('new-tenant-id');
                expect(version.versionNumber).toBe(1);
                expect(version.configYaml).toBe('CURRENT-VERSION-YAML');
            });

            it('synthesizes v1 from the pipeline configYaml when the source has no version rows', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue([
                    makeSystemPipeline({ configYaml: 'PIPELINE-LEVEL-YAML', isDefault: true }),
                ]);
                mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);
                mockAsrPipelineVersionRepository.findByPipeline.mockResolvedValue([]);

                await service.create({ key: 'NEW', name: 'New' });

                expect(mockAsrPipelineVersionRepository.create).toHaveBeenCalledTimes(1);
                expect(mockAsrPipelineVersionRepository.create.mock.calls[0][0].configYaml).toBe('PIPELINE-LEVEL-YAML');
            });

            it('is idempotent per slug — skips the pipelines the tenant already owns, clones the rest', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue(makeSystemCatalog());
                // Tenant already owns the turbo slug (backfill re-run) → skip only that one.
                mockAsrPipelineRepository.isSlugUnique.mockImplementation(
                    async (_tenantId: string, slug: string) => slug !== 'turbo-whisper-large-v3',
                );

                await service.create({ key: 'NEW', name: 'New' });

                const createdSlugs = mockAsrPipelineRepository.create.mock.calls.map((c) => c[0].slug);
                expect(createdSlugs).not.toContain('turbo-whisper-large-v3');
                expect(mockAsrPipelineRepository.create).toHaveBeenCalledTimes(2);
            });

            it('no SYSTEM pipelines → clone is a safe no-op', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue([]);

                const result = await service.create({ key: 'NEW', name: 'New' });

                expect(mockAsrPipelineRepository.create).not.toHaveBeenCalled();
                expect(mockAsrPipelineRepository.setDefaultForTenant).not.toHaveBeenCalled();
                expect(result.id).toBe('new-tenant-id');
            });

            it('pipeline-clone failure does not abort tenant creation', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockRejectedValue(new Error('db down'));

                const result = await service.create({ key: 'NEW', name: 'New' });

                expect(mockAsrPipelineRepository.findEnabledPipelines).toHaveBeenCalled();
                expect(result.id).toBe('new-tenant-id');
            });

            it('one pipeline clone failing does not abort the others (per-row isolation)', async () => {
                const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
                mockTenantRepository.create.mockResolvedValue(newTenant);
                mockAsrPipelineRepository.findEnabledPipelines.mockResolvedValue(makeSystemCatalog());
                mockAsrPipelineRepository.isSlugUnique.mockResolvedValue(true);
                // The turbo clone throws; production + ct2 still clone.
                mockAsrPipelineRepository.create.mockImplementation(async (entity: any) => {
                    if (entity.slug === 'turbo-whisper-large-v3') throw new Error('unique violation');
                    return entity;
                });

                const result = await service.create({ key: 'NEW', name: 'New' });

                expect(result.id).toBe('new-tenant-id');
                const createdSlugs = mockAsrPipelineRepository.create.mock.calls.map((c) => c[0].slug);
                expect(createdSlugs).toContain('production-whisper-large-v3');
                expect(createdSlugs).toContain('production-faster-whisper-turbo-int8');
                // The default (production) still got flipped despite the sibling failure.
                expect(mockAsrPipelineRepository.setDefaultForTenant).toHaveBeenCalledTimes(1);
            });
        });

        it('should emit ResourceCreated event with complete event data', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'new-tenant-id',
                    createdAt: newTenant.createdAt,
                    responsibleEntityId: 'current-user-id',
                    responsibleIp: '192.168.1.1',
                    correlationId: 'corr-123',
                    tenantId: 'tenant-1',
                })
            );
        });

        it('should throw InternalServerErrorException when repository returns null', async () => {
            mockTenantRepository.create.mockResolvedValue(null);

            await expect(
                service.create({
                    key: 'NEW_TENANT',
                    name: 'New Tenant',
                })
            ).rejects.toThrow('Failed to create TenantEntity');
        });

        it('should create tenant with optional description field', async () => {
            const newTenant = createMockTenantEntity({
                id: 'new-tenant-id',
                description: 'Test description',
            });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
                description: 'Test description',
            });

            expect(result.description).toBe('Test description');
        });

        it('should handle repository errors gracefully', async () => {
            mockTenantRepository.create.mockRejectedValue(new Error('Database connection failed'));

            await expect(
                service.create({
                    key: 'NEW_TENANT',
                    name: 'New Tenant',
                })
            ).rejects.toThrow('Database connection failed');
        });
    });

    describe('fetchAll', () => {
        it('should return paginated tenants with correct pagination metadata', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', name: 'Tenant 1' }),
                createMockTenantEntity({ id: 'tenant-2', name: 'Tenant 2' }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(result.limit).toBe(10);
            expect(result.page).toBe(1);
            // Verify actual tenant data is returned
            expect(result.data[0].name).toBe('Tenant 1');
            expect(result.data[1].name).toBe('Tenant 2');
        });

        it('coerces Tenant-typed filter values via the model registry', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, filters: 'version[gte]:2;plan[equals]:TRIAL' });

            const expectedFilters = { version: { gte: 2 }, plan: { equals: 'TRIAL' } };
            expect(mockTenantRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ filters: expectedFilters })
            );
            expect(mockTenantRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ filters: expectedFilters })
            );
        });

        it('rejects an invalid Tenant plan enum member with a 400', async () => {
            await expect(
                service.fetchAll({ limit: 10, page: 1, filters: 'plan[equals]:GOLD' })
            ).rejects.toThrow(/GOLD/);
        });

        it('should return empty result when no tenants exist', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(0);
            expect(result.count).toBe(0);
        });

        it('should emit ResourceViewed event with tenant IDs', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1' }),
                createMockTenantEntity({ id: 'tenant-2' }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { items: ['tenant-1', 'tenant-2'] },
                })
            );
        });

        it('should pass search parameter to repository', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            await service.fetchAll({ limit: 10, page: 1, search: 'test-search' });

            expect(mockTenantRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ search: 'test-search' })
            );
        });

        it('should return both ENABLED and DISABLED tenants (no client-side filtering)', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', name: 'Active Tenant', resourceStatus: ResourceStatusType.ENABLED }),
                createMockTenantEntity({ id: 'tenant-2', name: 'Disabled Tenant', resourceStatus: ResourceStatusType.DISABLED }),
                createMockTenantEntity({ id: 'tenant-3', name: 'Another Active', resourceStatus: ResourceStatusType.ENABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(3);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(3);
            expect(result.data[1].resourceStatus).toBe(ResourceStatusType.DISABLED);
        });

        it('should not filter out all-DISABLED tenants', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', resourceStatus: ResourceStatusType.DISABLED }),
                createMockTenantEntity({ id: 'tenant-2', resourceStatus: ResourceStatusType.DISABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(2);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toHaveLength(2);
            expect(result.data.every((t: any) => t.resourceStatus === ResourceStatusType.DISABLED)).toBe(true);
        });

        it('should include resourceStatus in every response DTO', async () => {
            const tenants = [
                createMockTenantEntity({ id: 'tenant-1', resourceStatus: ResourceStatusType.DISABLED }),
            ];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data[0]).toHaveProperty('resourceStatus');
            expect(result.data[0].resourceStatus).toBe(ResourceStatusType.DISABLED);
        });
    });

    describe('fetchAllByTenantCodeName', () => {
        it('should return tenants filtered by code name', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', key: 'CODE_1' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllByTenantCodeName({
                limit: 10,
                page: 1,
                codeName: 'CODE_1',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].key).toBe('CODE_1');
            expect(mockTenantRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { key: 'CODE_1' },
                })
            );
        });

        it('should emit event with code name in data', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', key: 'CODE_1' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            await service.fetchAllByTenantCodeName({
                limit: 10,
                page: 1,
                codeName: 'CODE_1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: expect.objectContaining({
                        key: 'CODE_1',
                        items: ['tenant-1'],
                    }),
                })
            );
        });
    });

    describe('fetchAllCreatedByUser', () => {
        it('should return tenants created by specific user', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', createdBy: 'creator-id' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            const result = await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(result.data).toHaveLength(1);
            expect(result.data[0].createdBy).toBe('creator-id');
            expect(mockTenantRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { createdBy: 'creator-id' },
                })
            );
        });

        it('should emit event with createdBy in data', async () => {
            const tenants = [createMockTenantEntity({ id: 'tenant-1', createdBy: 'creator-id' })];
            mockTenantRepository.findAll.mockResolvedValue(tenants);
            mockTenantRepository.count.mockResolvedValue(1);

            await service.fetchAllCreatedByUser({
                limit: 10,
                page: 1,
                userId: 'creator-id',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { createdBy: 'creator-id', items: ['tenant-1'] },
                })
            );
        });
    });

    describe('fetchById', () => {
        // The CLS `tenantId` is `tenant-1` (see `beforeEach`).
        // Happy-path tests therefore set the fetched row's id to `tenant-1`
        // so the new tenant-scope guard does not short-circuit them; the
        // cross-tenant + GLOBAL_ADMIN coverage lives in the dedicated
        // tenant-scope guard describe block below.
        it('should return tenant by ID with complete data', async () => {
            const tenant = createMockTenantEntity({
                id: 'tenant-1',
                name: 'Test Tenant',
                key: 'TEST_KEY',
            });
            mockTenantRepository.findById.mockResolvedValue(tenant);

            const result = await service.fetchById('tenant-1');

            expect(result.id).toBe('tenant-1');
            expect(result.name).toBe('Test Tenant');
            expect(result.key).toBe('TEST_KEY');
        });

        it('should emit ResourceViewed event with tenant data', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-1' });
            mockTenantRepository.findById.mockResolvedValue(tenant);

            await service.fetchById('tenant-1');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors', async () => {
            mockTenantRepository.findById.mockRejectedValue(new Error('Tenant not found'));

            await expect(service.fetchById('non-existent')).rejects.toThrow('Tenant not found');
        });
    });

    describe('fetchByCodeName', () => {
        // Happy-path tests use the CLS tenant id (`tenant-1`)
        // so the new tenant-scope guard does not short-circuit them; the
        // cross-tenant + GLOBAL_ADMIN coverage lives in the dedicated
        // tenant-scope guard describe block below.
        it('should return tenant by code name', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const result = await service.fetchByCodeName('MY_CODE');

            expect(result.id).toBe('tenant-1');
            expect(result.key).toBe('MY_CODE');
            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: 'MY_CODE' },
            });
        });

        it('should emit ResourceViewed event with code name', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            await service.fetchByCodeName('MY_CODE');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: { key: 'MY_CODE', id: 'tenant-1' },
                })
            );
        });
    });

    /**
     * `fetchById` and
     * `fetchByCodeName` previously returned ANY tenant row by primary key
     * or code-name without checking the caller's identity. A Tenant-A user
     * could enumerate Tenant-B's tenant record. The new guard short-circuits
     * with `NotFoundException` whenever the resolved row's id does not match
     * the CLS-supplied `tenantId`, except for GLOBAL_ADMIN callers, who
     * remain authorized for cross-tenant reads (admin UI tenant pickers).
     *
     * The CLS default in `beforeEach` is `tenant-1`. Tests use `tenant-2`
     * as the "other tenant" target. Tests use the existing `setRequestUserRoles`
     * helper (defined later in the file) to opt into GLOBAL_ADMIN context.
     */
    describe('fetchById/fetchByCodeName tenant-scoped', () => {
        describe('fetchById', () => {
            it('returns the tenant when the caller owns it (id matches CLS)', async () => {
                const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
                mockTenantRepository.findById.mockResolvedValue(tenant);

                const result = await service.fetchById('tenant-1');

                expect(result.id).toBe('tenant-1');
            });

            it('throws NotFoundException when the caller is not a GLOBAL_ADMIN and the resolved tenant belongs to another tenant', async () => {
                const { NotFoundException } = await import('@nestjs/common');
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findById.mockResolvedValue(otherTenant);

                await expect(service.fetchById('tenant-2')).rejects.toThrow(NotFoundException);
            });

            it('returns the cross-tenant row when the caller is a GLOBAL_ADMIN (admin UI bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findById.mockResolvedValue(otherTenant);

                const result = await service.fetchById('tenant-2');

                expect(result.id).toBe('tenant-2');
            });
        });

        describe('fetchByCodeName', () => {
            it('returns the tenant when the resolved row belongs to the caller', async () => {
                const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
                mockTenantRepository.findFirst.mockResolvedValue(tenant);

                const result = await service.fetchByCodeName('TENANT_1');

                expect(result.id).toBe('tenant-1');
            });

            it('throws NotFoundException when the caller is not a GLOBAL_ADMIN and the resolved tenant belongs to another tenant', async () => {
                const { NotFoundException } = await import('@nestjs/common');
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);

                await expect(service.fetchByCodeName('TENANT_2')).rejects.toThrow(NotFoundException);
            });

            it('returns the cross-tenant row when the caller is a GLOBAL_ADMIN', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);

                const result = await service.fetchByCodeName('TENANT_2');

                expect(result.id).toBe('tenant-2');
            });
        });
    });

    /**
     * `fetchTenantConfigs` previously
     * resolved ANY tenant by id or code-name and returned the configs
     * (with locked-row scrubbing applied for non-GLOBAL_ADMIN). A Tenant-A
     * user could enumerate Tenant-B's settings list (key names + namespaces
     * + dataType, with only `value` masked on locked rows). The new guard
     * short-circuits with `NotFoundException` (no existence leak) when the
     * resolved tenant id does not match the caller's CLS `tenantId`, except
     * for GLOBAL_ADMIN callers who retain the cross-tenant bypass (admin UI
     * tenant pickers + platform-metadata flows).
     *
     * CLS default in `beforeEach` is `tenant-1`. Tests use `tenant-2` as
     * the "other tenant" target. The existing `setRequestUserRoles` helper
     * (declared further down in this file) is used to opt into GLOBAL_ADMIN
     * context.
     */
    describe('fetchTenantConfigs tenant-scoped', () => {
        describe('by tenantId', () => {
            it('returns configs when the caller owns the resolved tenant (id matches CLS)', async () => {
                const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
                mockTenantRepository.findFirst.mockResolvedValue(tenant);
                const configs = [
                    createMockGlobalSettingEntity({ id: 'cfg-1', tenantId: 'tenant-1', key: 'public', value: 'visible', locked: false }),
                ];
                mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
                mockGlobalSettingRepository.count.mockResolvedValue(1);

                const result = await service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: 'tenant-1' });

                expect(result.data).toHaveLength(1);
                expect(result.count).toBe(1);
            });

            it('throws NotFoundException when a non-GLOBAL_ADMIN caller targets another tenant by id', async () => {
                const { NotFoundException } = await import('@nestjs/common');
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);

                await expect(
                    service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: 'tenant-2' }),
                ).rejects.toThrow(NotFoundException);
                // Guard short-circuits BEFORE the global-setting repo is touched.
                expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
                expect(mockGlobalSettingRepository.count).not.toHaveBeenCalled();
            });

            it('returns scrubbed configs when a GLOBAL_ADMIN caller targets another tenant by id (admin bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);
                const configs = [
                    createMockGlobalSettingEntity({ id: 'cfg-1', tenantId: 'tenant-2', key: 'locked.secret', value: 'shhh', locked: true }),
                ];
                mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
                mockGlobalSettingRepository.count.mockResolvedValue(1);

                const result = await service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: 'tenant-2' });

                expect(result.data).toHaveLength(1);
                // GLOBAL_ADMIN sees the raw locked value (no scrubbing).
                expect((result.data[0] as any).value).toBe('shhh');
            });
        });

        describe('by codeName', () => {
            it('returns configs when the caller owns the resolved tenant (codeName resolves to CLS tenant)', async () => {
                const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
                mockTenantRepository.findFirst.mockResolvedValue(tenant);
                mockGlobalSettingRepository.findAll.mockResolvedValue([]);
                mockGlobalSettingRepository.count.mockResolvedValue(0);

                const result = await service.fetchTenantConfigs({ limit: 10, page: 1, codeName: 'TENANT_1' });

                expect(result.data).toHaveLength(0);
            });

            it('throws NotFoundException when a non-GLOBAL_ADMIN caller targets another tenant by codeName', async () => {
                const { NotFoundException } = await import('@nestjs/common');
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);

                await expect(
                    service.fetchTenantConfigs({ limit: 10, page: 1, codeName: 'TENANT_2' }),
                ).rejects.toThrow(NotFoundException);
                expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
            });

            it('returns configs when a GLOBAL_ADMIN caller targets another tenant by codeName (admin bypass)', async () => {
                setRequestUserRoles(['GLOBAL_ADMIN']);
                const otherTenant = createMockTenantEntity({ id: 'tenant-2', key: 'TENANT_2' });
                mockTenantRepository.findFirst.mockResolvedValue(otherTenant);
                const configs = [
                    createMockGlobalSettingEntity({ id: 'cfg-1', tenantId: 'tenant-2', key: 'public', value: 'visible', locked: false }),
                ];
                mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
                mockGlobalSettingRepository.count.mockResolvedValue(1);

                const result = await service.fetchTenantConfigs({ limit: 10, page: 1, codeName: 'TENANT_2' });

                expect(result.data).toHaveLength(1);
            });
        });
    });

    describe('update', () => {
        it('should update tenant successfully via updateWithVersion (Stream D Phase)', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                name: 'Old Name',
                hasChanges: true,
                changes: { name: 'Updated Tenant' },
                version: 5,
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue({ ...existingTenant, version: 6 });

            const result = await service.update('tenant-123', { name: 'Updated Tenant', expectedVersion: 5 } as any);

            expect(result.id).toBe('tenant-123');
            // CAS path: assert updateWithVersion was called with the
            // expected version snapshot. The legacy `.update` MUST NOT
            // be invoked — it bypasses OCC.
            expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledWith('tenant-123', existingTenant, 5);
            expect(mockTenantRepository.update).not.toHaveBeenCalled();
        });

        it('should emit ResourceUpdated event with changes, previousVersion + newVersion (Stream D Phase)', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'Updated Tenant' },
                version: 9,
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue({ ...existingTenant, version: 10 });

            await service.update('tenant-123', { name: 'Updated Tenant', expectedVersion: 9 } as any);

            // The audit event must carry both versions so the history
            // trail correlates with the CAS bump. Same shape as the
            // GlobalSetting / TenantConfig audit-log fix from C.8.
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'tenant-123',
                    data: expect.objectContaining({
                        previousVersion: 9,
                        newVersion: 10,
                    }),
                }),
            );
        });

        it('should propagate OptimisticConcurrencyException on version drift (Stream D Phase)', async () => {
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'X' },
                version: 4,
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            const occErr = new OptimisticConcurrencyException('Tenant', 'tenant-123', {
                expectedVersion: 4,
                currentVersion: 5,
            });
            mockTenantRepository.updateWithVersion.mockRejectedValue(occErr);

            await expect(
                service.update('tenant-123', { name: 'X', expectedVersion: 4 } as any),
            ).rejects.toBe(occErr);
            // No event is emitted on a failed CAS — the audit log only
            // records successful writes.
            const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName]) => eventName === SysEventType.ResourceUpdated,
            );
            expect(updatedBroadcasts).toHaveLength(0);
        });

        it('should throw ArgumentInvalidException when no changes detected', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: false,
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);

            await expect(
                service.update('tenant-123', { name: 'Same Name', expectedVersion: 1 } as any)
            ).rejects.toThrow('No changes to write to');
        });

        it('should update multiple fields at once', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'New Name', description: 'New Description' },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue(existingTenant);

            await service.update('tenant-123', {
                name: 'New Name',
                description: 'New Description',
                expectedVersion: 1,
            } as any);

            expect(mockTenantRepository.updateWithVersion).toHaveBeenCalled();
        });

        it('should update resourceStatus to DISABLED', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                resourceStatus: ResourceStatusType.ENABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.DISABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    resourceStatus: ResourceStatusType.DISABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                resourceStatus: ResourceStatusType.DISABLED,
                expectedVersion: 1,
            } as any);

            expect(mockTenantRepository.updateWithVersion).toHaveBeenCalledWith('tenant-123', existingTenant, 1);
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
        });

        it('should update resourceStatus to ENABLED', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                resourceStatus: ResourceStatusType.DISABLED,
                hasChanges: true,
                changes: { resourceStatus: ResourceStatusType.ENABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    resourceStatus: ResourceStatusType.ENABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                resourceStatus: ResourceStatusType.ENABLED,
                expectedVersion: 1,
            } as any);

            expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
        });

        it('should update resourceStatus alongside other fields', async () => {
            const existingTenant = createMockTenantEntity({
                id: 'tenant-123',
                hasChanges: true,
                changes: { name: 'New Name', resourceStatus: ResourceStatusType.DISABLED },
            });
            mockTenantRepository.findById.mockResolvedValue(existingTenant);
            mockTenantRepository.updateWithVersion.mockResolvedValue(
                createMockTenantEntity({
                    id: 'tenant-123',
                    name: 'New Name',
                    resourceStatus: ResourceStatusType.DISABLED,
                }),
            );

            const result = await service.update('tenant-123', {
                name: 'New Name',
                resourceStatus: ResourceStatusType.DISABLED,
                expectedVersion: 1,
            } as any);

            expect(result.name).toBe('New Name');
            expect(result.resourceStatus).toBe(ResourceStatusType.DISABLED);
        });
    });

    describe('deleteById', () => {
        it('should soft delete tenant and return deleted entity', async () => {
            const deletedTenant = createMockTenantEntity({
                id: 'tenant-123',
                deletedAt: new Date(),
            });
            mockTenantRepository.softDelete.mockResolvedValue(deletedTenant);

            const result = await service.deleteById('tenant-123');

            expect(result.id).toBe('tenant-123');
            expect(mockTenantRepository.softDelete).toHaveBeenCalledWith('tenant-123');
        });

        it('should emit ResourceDeleted event with complete data', async () => {
            const deletedTenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.softDelete.mockResolvedValue(deletedTenant);

            await service.deleteById('tenant-123');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'tenant-123',
                    responsibleEntityId: 'current-user-id',
                })
            );
        });

        it('should propagate repository errors on delete', async () => {
            mockTenantRepository.softDelete.mockRejectedValue(new Error('Delete failed'));

            await expect(service.deleteById('tenant-123')).rejects.toThrow('Delete failed');
        });
    });

    describe('fetchTenantConfigs', () => {
        it('should throw ArgumentInvalidException when neither tenantId nor codeName provided', async () => {
            await expect(
                service.fetchTenantConfigs({ limit: 10, page: 1 })
            ).rejects.toThrow('Tenant ID or Tenant Code is required');
        });

        it('should throw ArgumentInvalidException when tenant not found', async () => {
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: 'non-existent' })
            ).rejects.toThrow('Tenant not found');
        });

        it('should return all tenant configurations filtered by tenantId', async () => {
            // `fetchTenantConfigs` now refuses cross-tenant
            // reads for non-GLOBAL_ADMIN callers. Align this happy-path probe
            // with the CLS default (`tenant-1`) so the new guard does not
            // short-circuit and the assertion still validates the data flow.
            const tenant = createMockTenantEntity({ id: 'tenant-1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const configs = [
                createMockGlobalSettingEntity({
                    id: 'config-1',
                    tenantId: 'tenant-1',
                    key: 'setting.one',
                    value: 'value-1',
                }),
                createMockGlobalSettingEntity({
                    id: 'config-2',
                    tenantId: 'tenant-1',
                    key: 'setting.two',
                    value: 'value-2',
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(2);

            const result = await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(result.data).toHaveLength(2);
            expect(result.count).toBe(2);
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        tenantId: 'tenant-1',
                    }),
                })
            );
        });

        it('should fetch configs by tenant code name', async () => {
            // Align with CLS default tenant id.
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'MY_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                codeName: 'MY_CODE',
            });

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: 'MY_CODE' },
            });
        });

        it('should emit ResourceViewed event with config IDs', async () => {
            // Align with CLS default tenant id.
            const tenant = createMockTenantEntity({ id: 'tenant-1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const configs = [
                createMockGlobalSettingEntity({ id: 'config-1', tenantId: 'tenant-1' }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-1',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({
                    data: {
                        tenantId: 'tenant-1',
                        items: ['config-1'],
                    },
                })
            );
        });
    });

    describe('updateTenantConfigs', () => {
        it('should throw ArgumentInvalidException when tenant not found', async () => {
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('non-existent', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Tenant not found');
        });

        it('should throw ArgumentInvalidException when config not found', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('tenant-123', [{ id: 'non-existent', value: 'new-value' }])
            ).rejects.toThrow('Config with id non-existent not found');
        });

        it('should throw ArgumentInvalidException when config belongs to different tenant', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            const config = createMockGlobalSettingEntity({
                id: 'config-1',
                tenantId: 'different-tenant',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(config);

            await expect(
                service.updateTenantConfigs('tenant-123', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Config config-1 does not belong to tenant tenant-123');
        });

        it('should find tenant by code name when updating configs', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'TENANT_CODE' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs('TENANT_CODE', [{ id: 'config-1', value: 'new-value' }])
            ).rejects.toThrow('Config with id config-1 not found');

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: 'TENANT_CODE' },
            });
        });
    });

    describe('edge cases', () => {
        it('should handle service creation without user context', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'user') return null;
                return null;
            });

            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);

            const result = await service.create({
                key: 'NEW_TENANT',
                name: 'New Tenant',
            });

            expect(result.id).toBe('new-tenant-id');
        });

        it('should handle empty search results gracefully', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(0);

            const result = await service.fetchAll({ limit: 10, page: 1 });

            expect(result.data).toEqual([]);
            expect(result.count).toBe(0);
        });

        it('should handle large pagination values', async () => {
            mockTenantRepository.findAll.mockResolvedValue([]);
            mockTenantRepository.count.mockResolvedValue(1000);

            const result = await service.fetchAll({ limit: 100, page: 10 });

            expect(result.limit).toBe(100);
            expect(result.page).toBe(10);
            expect(result.count).toBe(1000);
        });
    });

    describe('updateTenantConfigs — SMR provider/model validation', () => {
        const CATALOG_JSON = JSON.stringify([
            {
                provider: 'ollama',
                models: [
                    { name: 'granite4:latest', size: '2.1 GB' },
                    { name: 'gemma3:latest', size: '3.3 GB' },
                ],
            },
            {
                provider: 'lm-studio',
                models: [{ name: 'qwen3.5-4b', size: '3.1 GB' }],
            },
            {
                provider: 'azure-openai',
                models: [{ name: 'gpt-4o-mini', size: '' }],
            },
        ]);

        it('should reject an invalid default-smr-provider not in catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'smr-provider-id', value: 'invalid-provider' },
                ]),
            ).rejects.toThrow(/not a valid SMR provider/i);
        });

        it('should reject an invalid default-smr-model not in the selected provider catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const modelSetting = createMockGlobalSettingEntity({
                id: 'smr-model-id',
                tenantId: 'tenant-123',
                key: 'default-smr-model',
                value: 'granite4:latest',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(modelSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting, providerSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'smr-model-id', value: 'nonexistent-model' },
                ]),
            ).rejects.toThrow(/not a valid model/i);
        });

        it('should accept a valid provider from the catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'smr-provider-id',
                tenantId: 'tenant-123',
                key: 'default-smr-provider',
                value: 'ollama',
                hasChanges: true,
                changes: { value: 'lm-studio' },
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'catalog-id',
                tenantId: 'tenant-123',
                key: 'smr-provider-models',
                value: CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            const result = await service.updateTenantConfigs('tenant-123', [
                { id: 'smr-provider-id', value: 'lm-studio', expectedVersion: 1 } as never,
            ]);

            expect(result.data).toHaveLength(1);
        });
    });

    describe('updateTenantConfigs — Guardrail provider/model validation', () => {
        const GUARDRAIL_CATALOG_JSON = JSON.stringify([
            {
                provider: 'lm-studio',
                models: [
                    { name: 'granite-guardian-4.1-8b', size: '4.9 GB' },
                    { name: 'ibm-granite/granite-guardian-3.2-5b', size: '3.1 GB' },
                ],
            },
            {
                provider: 'ollama',
                models: [{ name: 'granite3-guardian:8b', size: '4.9 GB' }],
            },
            {
                provider: 'azure-openai',
                models: [{ name: 'gpt-4o-mini', size: '' }],
            },
        ]);

        it('should reject an invalid default-guardrail-provider not in catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'guardrail-provider-id',
                tenantId: 'tenant-123',
                key: 'default-guardrail-provider',
                value: 'lm-studio',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'guardrail-catalog-id',
                tenantId: 'tenant-123',
                key: 'guardrail-provider-models',
                value: GUARDRAIL_CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'guardrail-provider-id', value: 'invalid-provider' },
                ]),
            ).rejects.toThrow(/not a valid Guardrail provider/i);
        });

        it('should reject an invalid default-guardrail-model not in the selected provider catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const modelSetting = createMockGlobalSettingEntity({
                id: 'guardrail-model-id',
                tenantId: 'tenant-123',
                key: 'default-guardrail-model',
                value: 'granite-guardian-4.1-8b',
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(modelSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'guardrail-catalog-id',
                tenantId: 'tenant-123',
                key: 'guardrail-provider-models',
                value: GUARDRAIL_CATALOG_JSON,
            });

            const providerSetting = createMockGlobalSettingEntity({
                id: 'guardrail-provider-id',
                tenantId: 'tenant-123',
                key: 'default-guardrail-provider',
                value: 'lm-studio',
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting, providerSetting]);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'guardrail-model-id', value: 'nonexistent-model' },
                ]),
            ).rejects.toThrow(/not a valid model/i);
        });

        it('should accept a valid guardrail provider from the catalog', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const providerSetting = createMockGlobalSettingEntity({
                id: 'guardrail-provider-id',
                tenantId: 'tenant-123',
                key: 'default-guardrail-provider',
                value: 'lm-studio',
                hasChanges: true,
                changes: { value: 'ollama' },
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(providerSetting);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(providerSetting);

            const catalogSetting = createMockGlobalSettingEntity({
                id: 'guardrail-catalog-id',
                tenantId: 'tenant-123',
                key: 'guardrail-provider-models',
                value: GUARDRAIL_CATALOG_JSON,
            });
            mockGlobalSettingRepository.findAll.mockResolvedValue([catalogSetting]);

            const result = await service.updateTenantConfigs('tenant-123', [
                { id: 'guardrail-provider-id', value: 'ollama', expectedVersion: 1 } as never,
            ]);

            expect(result.data).toHaveLength(1);
        });

        it('should reject a locked guardrail setting for a non-super-admin', async () => {
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const lockedProvider = createMockGlobalSettingEntity({
                id: 'guardrail-provider-id',
                tenantId: 'tenant-123',
                key: 'default-guardrail-provider',
                value: 'lm-studio',
                locked: true,
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(lockedProvider);

            await expect(
                service.updateTenantConfigs('tenant-123', [
                    { id: 'guardrail-provider-id', value: 'ollama' },
                ]),
            ).rejects.toThrow(/locked/i);
        });
    });

    /* =================================================================
     * Tenant config provisioning, locked enforcement, and
     * identifier disambiguation.
     * ================================================================= */

    /**
     * Helper that re-installs the CLS mock so the active request user carries
     * the given roles list. Mirrors the default beforeEach setup but lets each
     * test opt into super-admin context without leaking state into siblings.
     */
    const setRequestUserRoles = (roles: string[] | undefined) => {
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

    const VALID_TENANT_UUID = '01931234-7abc-7def-9012-3456789abcde';

    describe('create — provisionTenantConfigs', () => {
        it('reads global tenant settings via globalSettingRepository.findAll filtered by global tenant id', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id', key: 'NEW_TENANT' });
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: '__GLOBAL__' },
            });
            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith({
                where: { tenantId: 'global-id' },
            });
        });

        it('clones each source row using defaultValue as both value and defaultValue, with new tenant id and source metadata', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);

            const sources = [
                createMockGlobalSettingEntity({
                    id: 'src-1',
                    tenantId: 'global-id',
                    name: 'Default STT Model',
                    key: 'default-stt-model',
                    value: 'should-not-be-used',
                    defaultValue: 'whisper-base',
                    dataType: 'String',
                    description: 'STT default',
                    namespace: 'com.flw.stt',
                }),
                createMockGlobalSettingEntity({
                    id: 'src-2',
                    tenantId: 'global-id',
                    name: 'Feature Toggle',
                    key: 'feature.x',
                    value: 'true',
                    defaultValue: null,
                    dataType: 'Boolean',
                    description: null,
                    namespace: 'com.flw.feature-flags',
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(sources);
            mockGlobalSettingRepository.create.mockImplementation(async (entity: any) => entity);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(2);

            const firstCall = mockGlobalSettingRepository.create.mock.calls[0][0];
            expect(firstCall.tenantId).toBe('new-tenant-id');
            expect(firstCall.name).toBe('Default STT Model');
            expect(firstCall.key).toBe('default-stt-model');
            expect(firstCall.dataType).toBe('String');
            expect(firstCall.description).toBe('STT default');
            expect(firstCall.namespace).toBe('com.flw.stt');
            expect(firstCall.value).toBe('whisper-base');
            expect(firstCall.defaultValue).toBe('whisper-base');

            const secondCall = mockGlobalSettingRepository.create.mock.calls[1][0];
            expect(secondCall.tenantId).toBe('new-tenant-id');
            expect(secondCall.key).toBe('feature.x');
            expect(secondCall.value).toBe('true');
            expect(secondCall.defaultValue).toBe('true');
        });

        it('continues cloning when a single insert fails and does not throw from create()', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);

            const sources = [
                createMockGlobalSettingEntity({ id: 'src-1', tenantId: 'global-id', key: 'will-fail' }),
                createMockGlobalSettingEntity({ id: 'src-2', tenantId: 'global-id', key: 'will-succeed' }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(sources);

            mockGlobalSettingRepository.create
                .mockRejectedValueOnce(new Error('unique constraint race'))
                .mockResolvedValueOnce({ id: 'cloned-2' });

            const result = await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(result.id).toBe('new-tenant-id');
            expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(2);
        });

        it('does not throw and still returns the new tenant when global tenant lookup returns null', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(null);

            const result = await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(result.id).toBe('new-tenant-id');
            expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
            expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
        });

        it('does not throw and still returns the new tenant when global tenant lookup itself rejects', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockRejectedValue(new Error('db down'));

            const result = await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(result.id).toBe('new-tenant-id');
            expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
        });

        it('does not block tenant creation when bucket provisioning fails (mirrors existing behaviour)', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantBucketService.provisionSystemBuckets.mockRejectedValue(new Error('s3 down'));
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await expect(
                service.create({ key: 'NEW_TENANT', name: 'New Tenant' }),
            ).resolves.toEqual(expect.objectContaining({ id: 'new-tenant-id' }));
        });
    });

    /**
     * A console-created tenant must own at least
     * one ENABLED department so its first admin can satisfy the login
     * invariant (an ENABLED role AND an ENABLED department in
     * the tenant). `create()` provisions a default General Practice
     * (`GEN`) department for the NEW tenant after config provisioning. The
     * insert is non-fatal: a failure is logged and swallowed so it never
     * aborts tenant creation (mirrors the bucket/config provisioning blocks).
     */
    describe('create — provisionDefaultDepartment', () => {
        it('provisions a GEN department bound to the NEW tenant id (not the CLS tenant)', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id', key: 'NEW_TENANT' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(mockDepartmentRepository.create).toHaveBeenCalledTimes(1);
            const created = mockDepartmentRepository.create.mock.calls[0][0];
            // CLS tenant is `tenant-1`; the department MUST be bound to the
            // freshly created tenant, never the caller's CLS tenant.
            expect(created.tenantId).toBe('new-tenant-id');
            expect(created.code).toBe('GEN');
            expect(created.name).toBe('General Practice');
            expect(created.defaultSummaryTemplate).toBe('SOAP');
            expect(created.preSummaryPromptId).toBeNull();
            expect(created.newPatientPromptId).toBeNull();
            expect(created.revisitPromptId).toBeNull();
        });

        it('broadcasts a ResourceCreated SysEvent for the provisioned department', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            const deptCreatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName, payload]) =>
                    eventName === SysEventType.ResourceCreated &&
                    (payload as any).resourceType === ResourceType.Department,
            );
            expect(deptCreatedBroadcasts).toHaveLength(1);
            const [, payload] = deptCreatedBroadcasts[0] as [string, any];
            expect(payload.data).toEqual(
                expect.objectContaining({ code: 'GEN', tenantId: 'new-tenant-id' }),
            );
        });

        it('does not abort tenant creation when department provisioning fails (non-fatal)', async () => {
            const newTenant = createMockTenantEntity({ id: 'new-tenant-id' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(null);
            mockDepartmentRepository.create.mockRejectedValueOnce(new Error('dept insert failed'));

            const result = await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(result.id).toBe('new-tenant-id');
        });
    });

    describe('provisionDefaultDepartment / tenant-created audit attribution', () => {
        it('rebinds CLS tenantId to the new tenant so provisioning broadcasts are not stamped null', async () => {
            // Models the real global-admin-creating-a-tenant case: CLS carries
            // NO active tenant (root cause) until `create()` rebinds it. A
            // stateful mock is required because a real ClsService's `get`
            // reflects prior `set` calls — the suite-wide static mock does not.
            let clsTenantId: string | null = null;
            mockClsService.get.mockImplementation((key: string) => {
                switch (key) {
                    case 'user':
                        return { id: 'current-user-id', firstName: 'Test', lastName: 'User', email: 'test@example.com' };
                    case 'tenantId':
                        return clsTenantId;
                    default:
                        return null;
                }
            });
            mockClsService.set.mockImplementation((key: string, value: unknown) => {
                if (key === 'tenantId') clsTenantId = value as string;
            });

            const newTenant = createMockTenantEntity({ id: 'new-tenant-id', key: 'NEW_TENANT' });
            mockTenantRepository.create.mockResolvedValue(newTenant);
            mockTenantRepository.findFirst.mockResolvedValue(null);

            await service.create({ key: 'NEW_TENANT', name: 'New Tenant' });

            expect(mockClsService.set).toHaveBeenCalledWith('tenantId', 'new-tenant-id');

            const tenantCreatedBroadcast = mockEventEmitter.emit.mock.calls.find(
                ([eventName, payload]) => eventName === SysEventType.ResourceCreated && (payload as any).resourceId === 'new-tenant-id',
            );
            const departmentCreatedBroadcast = mockEventEmitter.emit.mock.calls.find(
                ([eventName, payload]) => eventName === SysEventType.ResourceCreated && (payload as any).resourceType === ResourceType.Department,
            );

            expect(tenantCreatedBroadcast?.[1].tenantId).toBe('new-tenant-id');
            expect(departmentCreatedBroadcast?.[1].tenantId).toBe('new-tenant-id');
        });
    });

    describe('updateTenantConfigs — locked + __GLOBAL__ guards', () => {
        it('throws ForbiddenException when caller without GLOBAL_ADMIN role tries to edit a locked setting', async () => {
            setRequestUserRoles(['DOCTOR']);
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const lockedConfig = createMockGlobalSettingEntity({
                id: 'cfg-1',
                tenantId: 'tenant-123',
                key: 'default-stt-model',
                locked: true,
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(lockedConfig);

            await expect(
                service.updateTenantConfigs('tenant-123', [{ id: 'cfg-1', value: 'whisper-base' }]),
            ).rejects.toThrow(/locked/i);
        });

        it('allows GLOBAL_ADMIN callers to edit locked settings', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const lockedConfig = createMockGlobalSettingEntity({
                id: 'cfg-1',
                tenantId: 'tenant-123',
                key: 'admin-only-toggle',
                value: 'old',
                locked: true,
                hasChanges: true,
                changes: { value: 'new' },
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(lockedConfig);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(lockedConfig);

            const result = await service.updateTenantConfigs('tenant-123', [
                { id: 'cfg-1', value: 'new', expectedVersion: 1 } as never,
            ]);

            expect(result.data).toHaveLength(1);
            expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
        });

        it('throws ForbiddenException when non-GLOBAL_ADMIN targets the __GLOBAL__ tenant', async () => {
            setRequestUserRoles(['DOCTOR']);
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);

            await expect(
                service.updateTenantConfigs('__GLOBAL__', [{ id: 'cfg-1', value: 'x' }]),
            ).rejects.toThrow(/__GLOBAL__/);

            expect(mockGlobalSettingRepository.findById).not.toHaveBeenCalled();
        });

        it('allows GLOBAL_ADMIN to update settings on the __GLOBAL__ tenant', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const globalTenant = createMockTenantEntity({ id: 'global-id', key: '__GLOBAL__' });
            mockTenantRepository.findFirst.mockResolvedValue(globalTenant);

            const cfg = createMockGlobalSettingEntity({
                id: 'cfg-1',
                tenantId: 'global-id',
                key: 'default-language',
                hasChanges: true,
                changes: { value: 'en' },
            });
            mockGlobalSettingRepository.findById.mockResolvedValue(cfg);
            mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(cfg);

            const result = await service.updateTenantConfigs('__GLOBAL__', [
                { id: 'cfg-1', value: 'en', expectedVersion: 1 } as never,
            ]);

            expect(result.data).toHaveLength(1);
        });
    });

    describe('fetchTenantConfigs / updateTenantConfigs — identifier disambiguation', () => {
        it('looks up tenant by id when identifier is a UUID (fetchTenantConfigs)', async () => {
            // The resolved tenant id deliberately differs from
            // CLS to exercise the UUID-vs-key branch; gate via GLOBAL_ADMIN so
            // the new cross-tenant short-circuit does not fire (the test is
            // about identifier disambiguation, not access control).
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: VALID_TENANT_UUID, key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchTenantConfigs({ limit: 10, page: 1, tenantId: VALID_TENANT_UUID });

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { id: VALID_TENANT_UUID },
            });
        });

        it('looks up tenant by key when identifier is a non-UUID string (fetchTenantConfigs)', async () => {
            // See sibling test above; gate via GLOBAL_ADMIN.
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-123', key: 'CODE_NAME' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findAll.mockResolvedValue([]);
            mockGlobalSettingRepository.count.mockResolvedValue(0);

            await service.fetchTenantConfigs({ limit: 10, page: 1, codeName: 'CODE_NAME' });

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { key: 'CODE_NAME' },
            });
        });

        it('looks up tenant by id when identifier is a UUID (updateTenantConfigs)', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: VALID_TENANT_UUID, key: 'CUSTOMER' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);
            mockGlobalSettingRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateTenantConfigs(VALID_TENANT_UUID, [{ id: 'cfg-1', value: 'x' }]),
            ).rejects.toThrow('Config with id cfg-1 not found');

            expect(mockTenantRepository.findFirst).toHaveBeenCalledWith({
                where: { id: VALID_TENANT_UUID },
            });
        });
    });

    describe('fetchTenantConfigs — locked value masking', () => {
        it('replaces value with empty string for locked rows when caller is non-GLOBAL_ADMIN', async () => {
            // This test deliberately exercises the non-GLOBAL_ADMIN
            // locked-value scrubbing branch, so GLOBAL_ADMIN bypass is off-limits.
            // Align the resolved tenant id with CLS default (`tenant-1`) so the
            // new cross-tenant guard does not short-circuit before the scrubber.
            setRequestUserRoles(['DOCTOR']);
            const tenant = createMockTenantEntity({ id: 'tenant-1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const configs = [
                createMockGlobalSettingEntity({
                    id: 'cfg-1',
                    tenantId: 'tenant-1',
                    key: 'public.setting',
                    value: 'visible',
                    locked: false,
                }),
                createMockGlobalSettingEntity({
                    id: 'cfg-2',
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

            const byKey = Object.fromEntries(result.data.map((c: any) => [c.key, c.value]));
            expect(byKey['public.setting']).toBe('visible');
            expect(byKey['secret.setting']).toBe('');
        });

        it('returns full value for locked rows when caller is GLOBAL_ADMIN', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-123' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const configs = [
                createMockGlobalSettingEntity({
                    id: 'cfg-2',
                    tenantId: 'tenant-123',
                    key: 'secret.setting',
                    value: 'super-secret',
                    locked: true,
                }),
            ];
            mockGlobalSettingRepository.findAll.mockResolvedValue(configs);
            mockGlobalSettingRepository.count.mockResolvedValue(1);

            const result = await service.fetchTenantConfigs({
                limit: 10,
                page: 1,
                tenantId: 'tenant-123',
            });

            expect((result.data[0] as any).value).toBe('super-secret');
        });
    });

    // ──────────────────────────────────────────────────────────────────────
    // Optimistic Concurrency on updateTenantConfigs
    // ──────────────────────────────────────────────────────────────────────
    describe('updateTenantConfigs — optimistic concurrency (Stream D Phase C)', () => {
        it('calls updateWithVersion (not update) when expectedVersion is supplied', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({
                id: 'gs-1',
                tenantId: 'tenant-1',
                locked: false,
                hasChanges: true,
            });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);

            const updateWithVersion = vi.fn().mockResolvedValueOnce(setting);
            (mockGlobalSettingRepository as any).updateWithVersion = updateWithVersion;

            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
            ]);

            // The 4th arg is the tx client threaded by C.4's $transaction wrap.
            expect(updateWithVersion).toHaveBeenCalledWith('gs-1', setting, 5, mockTxClient);
            expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
        });

        it('propagates OptimisticConcurrencyException when expectedVersion drifted', async () => {
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({
                id: 'gs-1',
                tenantId: 'tenant-1',
                locked: false,
                hasChanges: true,
            });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);

            (mockGlobalSettingRepository as any).updateWithVersion = vi.fn().mockRejectedValueOnce(
                new OptimisticConcurrencyException('GlobalSetting', 'gs-1', {
                    expectedVersion: 5,
                    currentVersion: 6,
                }),
            );

            await expect(
                service.updateTenantConfigs('tenant-1', [
                    { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
                ]),
            ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
        });

        it('does NOT call updateWithVersion when the entity has no buffered changes (allowlist no-op)', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({
                id: 'gs-1',
                tenantId: 'tenant-1',
                locked: false,
                hasChanges: false, // entity report no changes after allowlist merge
            });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);

            const updateWithVersion = vi.fn();
            (mockGlobalSettingRepository as any).updateWithVersion = updateWithVersion;

            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'unchanged', expectedVersion: 5 } as any,
            ]);

            expect(updateWithVersion).not.toHaveBeenCalled();
        });
    });

    // (C.4) — Prisma `$transaction(callback)` wraps
    // the per-row CAS loop, so a mid-batch conflict rolls back BOTH the
    // already-applied rows and the in-flight one. We rely on Prisma's
    // interactive transaction semantics: if the callback throws, the SQL
    // transaction is aborted automatically. Unit tests can only verify the
    // structural guarantees (a `$transaction` was started, the conflict
    // propagates, and the success-only broadcast does not fire on conflict).
    // The B.4 Postgres regression test is the on-DB guard that real SQL
    // rollback occurs.
    describe('updateTenantConfigs — atomicity via $transaction (Stream D Phase C)', () => {
        beforeEach(() => {
            // Reset the $transaction mock to the default "invoke callback with tx"
            // implementation; individual tests can override it.
            (mockDatabaseService.baseClient.$transaction as any).mockImplementation(
                async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient),
            );
        });

        it('wraps the bulk update in a single Prisma $transaction', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({
                id: 'gs-1',
                tenantId: 'tenant-1',
                locked: false,
                hasChanges: true,
            });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);
            (mockGlobalSettingRepository as any).updateWithVersion = vi.fn().mockResolvedValueOnce(setting);

            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
            ]);

            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(1);
        });

        it('threads the transaction client through to updateWithVersion as the 4th arg', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({
                id: 'gs-1',
                tenantId: 'tenant-1',
                locked: false,
                hasChanges: true,
            });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);

            const updateWithVersion = vi.fn().mockResolvedValueOnce(setting);
            (mockGlobalSettingRepository as any).updateWithVersion = updateWithVersion;

            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
            ]);

            // Calls signature: (id, entity, expectedVersion, tx)
            expect(updateWithVersion).toHaveBeenCalledWith('gs-1', setting, 5, mockTxClient);
        });

        it('rolls the whole batch back when any row\'s version drifted mid-batch', async () => {
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const row1 = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            const row2 = createMockGlobalSettingEntity({ id: 'gs-2', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (row1 as any).version = 5;
            (row2 as any).version = 9;
            mockGlobalSettingRepository.findById
                .mockResolvedValueOnce(row1)
                .mockResolvedValueOnce(row2);

            (mockGlobalSettingRepository as any).updateWithVersion = vi.fn()
                .mockResolvedValueOnce(row1) // row 1 wrote
                .mockRejectedValueOnce(       // row 2 conflict — Prisma rolls back row 1
                    new OptimisticConcurrencyException('GlobalSetting', 'gs-2', {
                        expectedVersion: 9,
                        currentVersion: 10,
                    }),
                );

            // Clear emit so we can assert it was NOT fired on the failure.
            mockEventEmitter.emit.mockClear();

            await expect(
                service.updateTenantConfigs('tenant-1', [
                    { id: 'gs-1', value: 'a', expectedVersion: 5 } as any,
                    { id: 'gs-2', value: 'b', expectedVersion: 9 } as any,
                ]),
            ).rejects.toBeInstanceOf(OptimisticConcurrencyException);

            // ResourceUpdated must not fire when the batch was rolled back.
            const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName]) => eventName === SysEventType.ResourceUpdated,
            );
            expect(updatedBroadcasts).toEqual([]);
        });

        it('propagates a non-OCC failure inside the transaction so the batch still rolls back', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const setting = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (setting as any).version = 5;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(setting);

            (mockGlobalSettingRepository as any).updateWithVersion = vi.fn().mockRejectedValueOnce(
                new Error('transient db failure'),
            );

            mockEventEmitter.emit.mockClear();

            await expect(
                service.updateTenantConfigs('tenant-1', [
                    { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
                ]),
            ).rejects.toThrow('transient db failure');

            const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName]) => eventName === SysEventType.ResourceUpdated,
            );
            expect(updatedBroadcasts).toEqual([]);
        });
    });

    // (C.8) — the post-write audit log gets the
    // version transition for every persisted row so downstream observers
    // can reconstruct history via `metadata->>'newVersion'` (Research §7).
    // The pre-write `previousVersion` must be snapshotted BEFORE the CAS so
    // the audit reflects the state the operator actually read.
    describe('updateTenantConfigs — audit-log version correlation (Stream D Phase C)', () => {
        beforeEach(() => {
            (mockDatabaseService.baseClient.$transaction as any).mockImplementation(
                async (callback: (tx: typeof mockTxClient) => Promise<unknown>) => callback(mockTxClient),
            );
        });

        it('emits ResourceUpdated with previousVersion and newVersion for each row', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            const settingA = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (settingA as any).version = 5;
            const settingB = createMockGlobalSettingEntity({ id: 'gs-2', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (settingB as any).version = 12;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(settingA).mockResolvedValueOnce(settingB);

            // CAS bumps each row's version by 1.
            const persistedA = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (persistedA as any).version = 6;
            const persistedB = createMockGlobalSettingEntity({ id: 'gs-2', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (persistedB as any).version = 13;

            (mockGlobalSettingRepository as any).updateWithVersion = vi
                .fn()
                .mockResolvedValueOnce(persistedA)
                .mockResolvedValueOnce(persistedB);

            mockEventEmitter.emit.mockClear();

            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'a', expectedVersion: 5 } as any,
                { id: 'gs-2', value: 'b', expectedVersion: 12 } as any,
            ]);

            const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName]) => eventName === SysEventType.ResourceUpdated,
            );
            expect(updatedBroadcasts).toHaveLength(1);

            // Each entry in `data` must carry the pre-write and post-write
            // version numbers, alongside the (scrubbed) entity object so an
            // observer can correlate the transition with the row's state.
            const [, payload] = updatedBroadcasts[0] as [string, { data: Array<Record<string, unknown>> }];
            expect(payload.data).toEqual([
                expect.objectContaining({ id: 'gs-1', previousVersion: 5, newVersion: 6 }),
                expect.objectContaining({ id: 'gs-2', previousVersion: 12, newVersion: 13 }),
            ]);
        });

        it('snapshots previousVersion BEFORE the CAS bump (mid-batch atomicity proof)', async () => {
            setRequestUserRoles(['GLOBAL_ADMIN']);
            const tenant = createMockTenantEntity({ id: 'tenant-1', key: 'TENANT_1' });
            mockTenantRepository.findFirst.mockResolvedValue(tenant);

            // Row read at v5; same id is returned from the CAS at v6.
            // We must see `previousVersion: 5`, NOT `previousVersion: 6`,
            // i.e. the audit reflects what the caller read, not what the
            // post-write `entity.version` was mutated to.
            const settingPre = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (settingPre as any).version = 5;
            const settingPost = createMockGlobalSettingEntity({ id: 'gs-1', tenantId: 'tenant-1', locked: false, hasChanges: true });
            (settingPost as any).version = 6;
            mockGlobalSettingRepository.findById.mockResolvedValueOnce(settingPre);

            (mockGlobalSettingRepository as any).updateWithVersion = vi.fn().mockImplementationOnce(async () => {
                // Simulate Prisma round-trip: the cached entity's `_version`
                // is bumped before we return from the repo.
                (settingPre as any).version = 6;
                return settingPost;
            });

            mockEventEmitter.emit.mockClear();
            await service.updateTenantConfigs('tenant-1', [
                { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
            ]);

            const updatedBroadcasts = mockEventEmitter.emit.mock.calls.filter(
                ([eventName]) => eventName === SysEventType.ResourceUpdated,
            );
            const [, payload] = updatedBroadcasts[0] as [string, { data: Array<Record<string, unknown>> }];
            expect(payload.data[0]).toMatchObject({ previousVersion: 5, newVersion: 6 });
        });
    });

    // ============================================================
    // getUsageStats extended with storage + clinical
    // roll-ups. Counts are read straight off the extended client, scoped by the
    // explicit tenantId arg (mirrors the existing distinct-users query).
    // ============================================================
    describe('getUsageStats storage + clinical roll-ups', () => {
        beforeEach(() => {
            mockTenantRepository.findById.mockResolvedValue(createMockTenantEntity({ id: 'tenant-1' }));
            mockDepartmentRepository.count.mockResolvedValue(2);
            mockPromptTemplateRepository.count.mockResolvedValue(3);
            mockAsrPipelineRepository.count.mockResolvedValue(1);
            mockExtendedClient.userRoleAssignment.findMany.mockResolvedValue([{ userId: 'u-1' }, { userId: 'u-2' }]);
        });

        it('aggregates storage used, transcription minutes, summaries-24h and consultations', async () => {
            mockExtendedClient.media.aggregate.mockResolvedValue({ _sum: { size: 5_000 } });
            mockExtendedClient.audioRecording.aggregate.mockResolvedValue({ _sum: { duration: 180_000 } }); // 3 min
            mockExtendedClient.summaryMeta.count.mockResolvedValue(7);
            mockExtendedClient.consultation.count.mockResolvedValue(42);
            mockExtendedClient.tenantBucket.aggregate.mockResolvedValue({ _sum: { quotaBytes: null } });

            const result = await service.getUsageStats('tenant-1');

            expect(result).toMatchObject({
                totalUsers: 2,
                totalDepartments: 2,
                totalPromptTemplates: 3,
                totalPipelines: 1,
                storageUsedBytes: 5_000,
                transcriptionMinutes: 3,
                summaries24h: 7,
                totalConsultations: 42,
            });
            // No bucket has a quota configured → null (not 0).
            expect(result.storageQuotaBytes).toBeNull();
        });

        it('returns the summed bucket quota (BigInt→number) when configured', async () => {
            mockExtendedClient.tenantBucket.aggregate.mockResolvedValue({ _sum: { quotaBytes: 1_073_741_824n } });

            const result = await service.getUsageStats('tenant-1');

            expect(result.storageQuotaBytes).toBe(1_073_741_824);
        });

        it('only counts summaries generated within the last 24h', async () => {
            await service.getUsageStats('tenant-1');

            const callArg = mockExtendedClient.summaryMeta.count.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('tenant-1');
            expect(callArg.where.generatedAt.gte).toBeInstanceOf(Date);
            // The cutoff is ~24h before "now" (allow a generous window for test timing).
            const ageMs = Date.now() - callArg.where.generatedAt.gte.getTime();
            expect(ageMs).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000);
            expect(ageMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
        });
    });
});
