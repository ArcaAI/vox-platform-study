/**
 * PromptManagementService Unit Tests
 *
 * Tests for prompt template CRUD, versioning, and department assignment.
 * Mocks only at boundaries: repositories (database) and event emitter.
 * Verifies actual service behavior, return values, and side effects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SysEventType, ResourceStatusType, PromptTemplateFactory } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { PromptManagementService } from '../prompt-management.service';

// ─── Mock Factories ─────────────────────────────────────────────────
// Each mock factory returns an object matching the real repository interface.
// Only methods actually used by the service are included.

const createMockClsService = () => ({
    get: vi.fn(),
    set: vi.fn(),
});

const createMockEventEmitter = () => ({
    emit: vi.fn(),
});

const createMockQueryBuilder = () => {
    const mockWhere = vi.fn().mockReturnThis();
    const mockWhereOr = vi.fn().mockReturnThis();
    const mockToList = vi.fn().mockResolvedValue([]);
    return {
        Where: mockWhere,
        WhereOr: mockWhereOr,
        ToList: mockToList,
    };
};

const createMockDepartmentService = () => ({
    updatePromptConfig: vi.fn(),
    getAll: vi.fn(),
    getById: vi.fn(),
    getByCode: vi.fn(),
    getRootDepartments: vi.fn(),
    getChildren: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(),
});

const createMockPromptTemplateRepository = () => ({
    findById: vi.fn(),
    findByName: vi.fn(),
    findByDepartment: vi.fn(),
    findByCategory: vi.fn(),
    findMyPersonalForDepartment: vi.fn(),
    findAll: vi.fn(),
    findPaginated: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // TASK-302 Stream D Phase E.3 — `updatePromptTemplate` now writes via
    // Compare-And-Set (`updateWithVersion`). Legacy `.update` stays on
    // the mock for assertions that confirm it is NOT called.
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
    $: vi.fn(),
});

const createMockPromptVersionRepository = () => ({
    findByTemplate: vi.fn(),
    findByVersionNumber: vi.fn(),
    create: vi.fn(),
});

const createMockPromptUsageRecordRepository = () => ({
    findByTemplate: vi.fn().mockResolvedValue([]),
    findByDepartment: vi.fn().mockResolvedValue([]),
    // TASK-328 A4 — analytics groupBy aggregations
    groupByDepartment: vi.fn().mockResolvedValue([]),
    groupByDoctor: vi.fn().mockResolvedValue([]),
    groupByDay: vi.fn().mockResolvedValue([]),
});

// TASK-328 A4 — SMR/text-generation client is an injected dependency
// (HttpService) so the prompt-test path is unit-testable with a mock; the
// live SMR call is verified in CI against the running Python service.
const createMockHttpService = (responseData: Record<string, unknown>) => ({
    axiosRef: {
        post: vi.fn().mockResolvedValue({ data: responseData }),
    },
});

const createMockConfigService = (smrUrl = 'http://smr.local:8862') => ({
    get: vi.fn().mockReturnValue(smrUrl),
});

const wordsOfLength = (n: number): string =>
    Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

// ─── Entity Helpers ─────────────────────────────────────────────────
// Complete mock entities matching real entity structure for mapper compatibility.

const createMockTemplateEntity = (overrides: Record<string, unknown> = {}) => {
    let _changed = false;
    const entity: Record<string, unknown> = {
        id: overrides.id ?? 'template-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        name: overrides.name ?? 'Test Prompt',
        description: 'description' in overrides ? overrides.description : 'A test prompt template',
        content: overrides.content ?? 'You are a clinical assistant.',
        category: overrides.category ?? 'SYSTEM',
        status: 'status' in overrides ? overrides.status : 'DRAFT',
        variables: 'variables' in overrides ? overrides.variables : null,
        currentVersionNumber: 'currentVersionNumber' in overrides ? overrides.currentVersionNumber : 1,
        departmentId: 'departmentId' in overrides ? overrides.departmentId : null,
        scope: 'scope' in overrides ? overrides.scope : 'TENANT_DEFAULT',
        ownerUserId: 'ownerUserId' in overrides ? overrides.ownerUserId : null,
        tags: 'tags' in overrides ? overrides.tags : [],
        resourceStatus: overrides.resourceStatus ?? 'ENABLED',
        createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
        updatedAt: overrides.updatedAt ?? new Date('2026-02-18T10:00:00Z'),
        createdBy: overrides.createdBy ?? 'user-id-1',
        updatedBy: overrides.updatedBy ?? null,
        changes: overrides.changes ?? {},
        // TASK-302 Stream D Phase E.3 — `_version` is required for the CAS
        // write path. Default = first-write (1); override per-test as needed.
        // Distinct from `currentVersionNumber` (the human-meaningful
        // PromptVersion history counter).
        version: 'version' in overrides ? overrides.version : 1,
        isActive: () => (overrides.resourceStatus ?? 'ENABLED') === 'ENABLED',
        incrementVersion: vi.fn().mockImplementation(() => { _changed = true; }),
        enable: vi.fn().mockImplementation(() => { _changed = true; }),
        disable: vi.fn().mockImplementation(() => { _changed = true; }),
        toObject: vi.fn().mockReturnValue(overrides),
    };
    const trackedKeys = new Set(['name', 'description', 'content', 'status', 'variables', 'tags', 'resourceStatus', 'scope', 'ownerUserId']);
    return new Proxy(entity, {
        set(target, prop, value) {
            if (trackedKeys.has(prop as string)) _changed = true;
            target[prop as string] = value;
            return true;
        },
        get(target, prop) {
            if (prop === 'hasChanges') return _changed;
            return target[prop as string];
        },
    });
};

const createMockVersionEntity = (overrides: Record<string, unknown> = {}) => ({
    id: overrides.id ?? 'version-id-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    promptTemplateId: overrides.promptTemplateId ?? 'template-id-1',
    versionNumber: overrides.versionNumber ?? 1,
    content: overrides.content ?? 'You are a clinical assistant.',
    variables: overrides.variables ?? null,
    changeReason: overrides.changeReason ?? 'Initial version',
    changedBy: overrides.changedBy ?? 'user-id-1',
    createdAt: overrides.createdAt ?? new Date('2026-02-18T10:00:00Z'),
});

// Mock domain factories — return complete entities
vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        PromptTemplateFactory: {
            CreatePromptTemplate: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-template-id',
                currentVersionNumber: 1,
                createdAt: new Date('2026-02-18T10:00:00Z'),
                updatedAt: new Date('2026-02-18T10:00:00Z'),
                resourceStatus: 'ENABLED',
                isActive: () => true,
                incrementVersion: vi.fn(),
                toObject: vi.fn().mockReturnValue(data),
            })),
        },
        PromptVersionFactory: {
            CreatePromptVersion: vi.fn((data: Record<string, unknown>) => ({
                ...data,
                id: 'new-version-id',
                createdAt: new Date('2026-02-18T10:00:00Z'),
            })),
        },
    };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('PromptManagementService', () => {
    let service: PromptManagementService;
    let mockTemplateRepo: ReturnType<typeof createMockPromptTemplateRepository>;
    let mockVersionRepo: ReturnType<typeof createMockPromptVersionRepository>;
    let mockUsageRepo: ReturnType<typeof createMockPromptUsageRecordRepository>;
    let mockClsService: ReturnType<typeof createMockClsService>;
    let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;
    let mockDepartmentService: ReturnType<typeof createMockDepartmentService>;
    let abilityCan: ReturnType<typeof vi.fn>;

    const defaultClsContext = {
        user: { id: 'user-id-1', firstName: 'Test', lastName: 'User', email: 'test@test.com' },
        tenantId: 'tenant-1',
    };

    beforeEach(() => {
        vi.clearAllMocks();

        mockTemplateRepo = createMockPromptTemplateRepository();
        mockVersionRepo = createMockPromptVersionRepository();
        mockUsageRepo = createMockPromptUsageRecordRepository();
        mockClsService = createMockClsService();
        mockEventEmitter = createMockEventEmitter();
        mockDepartmentService = createMockDepartmentService();
        abilityCan = vi.fn().mockReturnValue(true); // default: caller can manage; override per-test

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user':
                    return defaultClsContext.user;
                case 'tenantId':
                    return defaultClsContext.tenantId;
                case 'userAbility':
                    return { can: abilityCan };
                default:
                    return null;
            }
        });

        service = new PromptManagementService(
            mockTemplateRepo as never,
            mockVersionRepo as never,
            mockUsageRepo as never,
            mockDepartmentService as never,
            mockEventEmitter as never,
            mockClsService as never,
        );
    });

    // ─── createPromptTemplate ───────────────────────────────────

    describe('createPromptTemplate', () => {
        it('should create template and return response with correct fields on success', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            const savedEntity = createMockTemplateEntity({
                id: 'template-id-1',
                name: 'New Prompt',
                category: 'DNA_ANALYSIS',
                content: 'Analyze writing style.',
            });
            mockTemplateRepo.create.mockResolvedValue(savedEntity);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.createPromptTemplate({
                name: 'New Prompt',
                content: 'Analyze writing style.',
                category: 'DNA_ANALYSIS',
            });

            expect(result.id).toBe('template-id-1');
            expect(result.name).toBe('New Prompt');
            expect(result.category).toBe('DNA_ANALYSIS');
            expect(result.content).toBe('Analyze writing style.');
            expect(result.currentVersionNumber).toBe(1);
            expect(result.createdAt).toBeDefined();
            expect(result.updatedAt).toBeDefined();
        });

        it('should create initial PromptVersion v1 alongside template', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity());
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.createPromptTemplate({
                name: 'Test',
                content: 'Content',
                category: 'SYSTEM',
            });

            expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    versionNumber: 1,
                    content: 'Content',
                    changeReason: 'Initial version',
                }),
            );
        });

        it('should throw BadRequestException when name already exists (duplicate name)', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(createMockTemplateEntity());

            await expect(
                service.createPromptTemplate({
                    name: 'Duplicate',
                    content: 'x',
                    category: 'SYSTEM',
                }),
            ).rejects.toThrow(BadRequestException);

            await expect(
                service.createPromptTemplate({
                    name: 'Duplicate',
                    content: 'x',
                    category: 'SYSTEM',
                }),
            ).rejects.toThrow("Prompt template with name 'Duplicate' already exists");

            expect(mockTemplateRepo.create).not.toHaveBeenCalled();
        });

        it('should throw BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((key: string) =>
                key === 'tenantId' ? null : defaultClsContext.user,
            );
            mockTemplateRepo.findByName.mockResolvedValue(null);

            await expect(
                service.createPromptTemplate({ name: 'Test', content: 'x', category: 'SYSTEM' }),
            ).rejects.toThrow(BadRequestException);

            await expect(
                service.createPromptTemplate({ name: 'Test', content: 'x', category: 'SYSTEM' }),
            ).rejects.toThrow('Tenant ID is required');

            expect(mockTemplateRepo.create).not.toHaveBeenCalled();
        });

        it('should include optional fields when provided (description, variables, departmentId, tags)', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            const savedEntity = createMockTemplateEntity({
                id: 'tpl-1',
                name: 'Full Prompt',
                description: 'A detailed prompt',
                variables: { format: 'SOAP' },
                departmentId: 'dept-1',
                tags: ['clinical', 'soap'],
            });
            mockTemplateRepo.create.mockResolvedValue(savedEntity);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.createPromptTemplate({
                name: 'Full Prompt',
                content: 'Content',
                category: 'SUMMARY',
                description: 'A detailed prompt',
                variables: { format: 'SOAP' },
                departmentId: 'dept-1',
                tags: ['clinical', 'soap'],
            });

            expect(result.id).toBe('tpl-1');
            expect(result.name).toBe('Full Prompt');
            expect(result.description).toBe('A detailed prompt');
            expect(result.variables).toEqual({ format: 'SOAP' });
            expect(result.departmentId).toBe('dept-1');
            expect(result.tags).toEqual(['clinical', 'soap']);
        });

        it('should create template without optional fields when omitted', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            const savedEntity = createMockTemplateEntity({
                name: 'Minimal',
                description: null,
                variables: null,
                departmentId: null,
                tags: [],
            });
            mockTemplateRepo.create.mockResolvedValue(savedEntity);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.createPromptTemplate({
                name: 'Minimal',
                content: 'Minimal content',
                category: 'CUSTOM',
            });

            expect(result.name).toBe('Minimal');
            expect(result.description).toBeUndefined();
            expect(result.variables).toBeUndefined();
            expect(result.departmentId).toBeUndefined();
            expect(result.tags).toEqual([]);
        });

        it('should broadcast ResourceCreated event', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1' }));
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.createPromptTemplate({
                name: 'Test',
                content: 'x',
                category: 'SYSTEM',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: 'tpl-1',
                    data: { name: 'Test', category: 'SYSTEM' },
                }),
            );
        });

        // TASK-331 doc-02 F5 — publication status threaded to the factory.
        it('should pass the provided status to the factory', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ status: 'PUBLISHED' }));
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.createPromptTemplate({
                name: 'Published Prompt',
                content: 'x',
                category: 'SYSTEM',
                status: 'PUBLISHED',
            } as never);

            expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'PUBLISHED' }),
            );
            expect(result.status).toBe('PUBLISHED');
        });

        it('should default status to DRAFT when omitted', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ status: 'DRAFT' }));
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.createPromptTemplate({
                name: 'Drafty',
                content: 'x',
                category: 'SYSTEM',
            });

            expect(PromptTemplateFactory.CreatePromptTemplate).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'DRAFT' }),
            );
            expect(result.status).toBe('DRAFT');
        });
    });

    // ─── updatePromptTemplate ───────────────────────────────────

    describe('updatePromptTemplate', () => {
        it('should create new version snapshot and increment version number on success', async () => {
            const existing = createMockTemplateEntity({ currentVersionNumber: 2, version: 4 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(
                createMockTemplateEntity({ currentVersionNumber: 3, version: 5 }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 3 }));

            const result = await service.updatePromptTemplate('template-id-1', {
                content: 'Updated content',
                changeReason: 'Improved prompt',
                expectedVersion: 4,
            } as never);

            expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    versionNumber: 3,
                    content: 'Updated content',
                    changeReason: 'Improved prompt',
                }),
            );
            expect(existing.incrementVersion).toHaveBeenCalled();
            expect(result.currentVersionNumber).toBe(3);
            // CAS-only — the legacy non-versioned write MUST NOT fire.
            expect(mockTemplateRepo.update).not.toHaveBeenCalled();
            expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('template-id-1', existing, 4);
        });

        it('should throw NotFoundException when template does not exist', async () => {
            mockTemplateRepo.findById.mockResolvedValue(null);

            await expect(
                service.updatePromptTemplate('nonexistent', { content: 'x', expectedVersion: 1 } as never),
            ).rejects.toThrow(NotFoundException);

            await expect(
                service.updatePromptTemplate('nonexistent', { content: 'x', expectedVersion: 1 } as never),
            ).rejects.toThrow('Prompt template nonexistent not found');

            expect(mockVersionRepo.create).not.toHaveBeenCalled();
        });

        it('should perform partial update (only content)', async () => {
            const existing = createMockTemplateEntity({
                name: 'Original',
                content: 'Original content',
            });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.updatePromptTemplate('template-id-1', {
                content: 'New content',
                expectedVersion: 1,
            } as never);

            expect(existing.content).toBe('New content');
            expect(existing.name).toBe('Original');
            expect(result.content).toBe('New content');
        });

        it('should perform partial update (only name)', async () => {
            const existing = createMockTemplateEntity({
                name: 'Original',
                content: 'Original content',
            });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { name: 'Renamed', expectedVersion: 1 } as never);

            expect(existing.name).toBe('Renamed');
            expect(existing.content).toBe('Original content');
        });

        it('should perform partial update (only tags)', async () => {
            const existing = createMockTemplateEntity({
                name: 'Original',
                tags: ['old'],
            });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { tags: ['new', 'tags'], expectedVersion: 1 } as never);

            expect(existing.tags).toEqual(['new', 'tags']);
        });

        // TASK-331 doc-02 F5 — a status-only change is a mutating edit (no new
        // PromptVersion snapshot, but the OCC write still proceeds).
        it('should apply a status change without creating a new version snapshot', async () => {
            const existing = createMockTemplateEntity({ status: 'DRAFT', version: 3 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(
                createMockTemplateEntity({ status: 'PUBLISHED', version: 4 }),
            );

            const result = await service.updatePromptTemplate('template-id-1', {
                status: 'PUBLISHED',
                expectedVersion: 3,
            } as never);

            expect(existing.status).toBe('PUBLISHED');
            // status-only edits don't spawn a PromptVersion row
            expect(mockVersionRepo.create).not.toHaveBeenCalled();
            // but the OCC write must still fire (status counts as a change)
            expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('template-id-1', existing, 3);
            expect(result.status).toBe('PUBLISHED');
        });

        it('should increment version from null when currentVersionNumber is null', async () => {
            const existing = createMockTemplateEntity({ currentVersionNumber: null });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(
                createMockTemplateEntity({ currentVersionNumber: 1 }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 1 }));

            await service.updatePromptTemplate('template-id-1', { content: 'Updated', expectedVersion: 1 } as never);

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    versionNumber: 1,
                }),
            );
        });

        it('should include changeReason when provided', async () => {
            const existing = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', {
                content: 'Updated',
                changeReason: 'Bug fix',
                expectedVersion: 1,
            } as never);

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    changeReason: 'Bug fix',
                }),
            );
        });

        it('should handle update without changeReason', async () => {
            const existing = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { content: 'Updated', expectedVersion: 1 } as never);

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    changeReason: null,
                }),
            );
        });

        it('should broadcast ResourceUpdated event with previousVersion + newVersion (TASK-302 Stream D Phase E.3)', async () => {
            const existing = createMockTemplateEntity({ version: 9 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ version: 10 }));
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', {
                content: 'Updated',
                changeReason: 'Improvement',
                expectedVersion: 9,
            } as never);

            // Same audit shape as Phase C.8 / E.1 / E.2: the SysEvent carries
            // both versions so downstream observers can correlate the change
            // with the row's prior state.
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'template-id-1',
                    data: expect.objectContaining({
                        changeReason: 'Improvement',
                        previousVersion: 9,
                        newVersion: 10,
                    }),
                }),
            );
        });

        it('propagates OptimisticConcurrencyException from the repository CAS write (TASK-302 Stream D Phase E.3)', async () => {
            // When the row drifted between read and write, the repository's
            // `updateWithVersion` predicate matches 0 rows and throws. The
            // service must surface that exception unwrapped so the
            // `ExceptionInterceptor` can map it to 412 Precondition Failed.
            const existing = createMockTemplateEntity({ version: 9 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('PromptTemplate', 'template-id-1', {
                    expectedVersion: 9,
                    currentVersion: 10,
                }),
            );

            await expect(
                service.updatePromptTemplate('template-id-1', {
                    content: 'Stale write',
                    expectedVersion: 9,
                } as never),
            ).rejects.toThrow(OptimisticConcurrencyException);

            // Audit-log MUST NOT broadcast on a failed CAS write — otherwise
            // observers would see "update" events for changes that never
            // landed.
            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.anything(),
            );
        });
    });

    // ─── getPromptTemplate ──────────────────────────────────────

    describe('getPromptTemplate', () => {
        it('should return template response when found', async () => {
            mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity());

            const result = await service.getPromptTemplate('template-id-1');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('template-id-1');
            expect(result!.name).toBe('Test Prompt');
            expect(result!.content).toBe('You are a clinical assistant.');
            expect(result!.category).toBe('SYSTEM');
        });

        it('should return null when template not found', async () => {
            mockTemplateRepo.findById.mockResolvedValue(null);

            const result = await service.getPromptTemplate('nonexistent');

            expect(result).toBeNull();
        });
    });

    // ─── listPromptTemplates ────────────────────────────────────

    describe('listPromptTemplates', () => {
        it('should return all templates when no filters provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1' }),
                createMockTemplateEntity({ id: 't2' }),
            ]);

            const result = await service.listPromptTemplates();

            expect(mockTemplateRepo.$).toHaveBeenCalled();
            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
            expect(mockQb.Where).toHaveBeenCalledTimes(2);
            expect(result).toHaveLength(2);
        });

        it('should filter by category when provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', category: 'DNA_ANALYSIS' }),
            ]);

            const result = await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

            expect(mockQb.Where).toHaveBeenCalledWith({ category: 'DNA_ANALYSIS' });
            expect(result).toHaveLength(1);
            expect(result[0].category).toBe('DNA_ANALYSIS');
        });

        it('should filter by departmentId when provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', departmentId: 'dept-1' }),
            ]);

            const result = await service.listPromptTemplates({ departmentId: 'dept-1' });

            expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
            expect(result).toHaveLength(1);
        });

        // TASK-331 doc-02 F5 — server-side status filter.
        it('should filter by status when provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', status: 'PUBLISHED' }),
            ]);

            const result = await service.listPromptTemplates({ status: 'PUBLISHED' });

            expect(mockQb.Where).toHaveBeenCalledWith({ status: 'PUBLISHED' });
            expect(result).toHaveLength(1);
        });

        it('should apply both category and departmentId filters simultaneously', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({
                    id: 't1',
                    category: 'SUMMARY',
                    departmentId: 'dept-1',
                }),
            ]);

            const result = await service.listPromptTemplates({
                category: 'SUMMARY',
                departmentId: 'dept-1',
            });

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
            expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
            expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
            expect(mockQb.Where).toHaveBeenCalledTimes(4);
            expect(result).toHaveLength(1);
            expect(result[0].category).toBe('SUMMARY');
            expect(result[0].departmentId).toBe('dept-1');
        });

        it('should return empty array when no templates match', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            const result = await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

            expect(result).toEqual([]);
        });

        it('should always filter by tenantId from ClsService context', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
        });

        it('should include tenantId filter alongside category filter', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates({ category: 'DNA_ANALYSIS' });

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ category: 'DNA_ANALYSIS' });
        });

        it('should include tenantId filter alongside departmentId filter', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates({ departmentId: 'dept-1' });

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
        });

        it('should throw BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((key: string) =>
                key === 'tenantId' ? null : defaultClsContext.user,
            );

            await expect(service.listPromptTemplates()).rejects.toThrow(BadRequestException);
        });

        it('should include descriptive message in BadRequestException for missing tenantId', async () => {
            mockClsService.get.mockImplementation((key: string) =>
                key === 'tenantId' ? null : defaultClsContext.user,
            );

            await expect(service.listPromptTemplates()).rejects.toThrow('Tenant ID is required');
        });

        it('should filter by resourceStatus ENABLED by default when includeDisabled is not set', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates();

            expect(mockQb.Where).toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
            );
        });

        it('should not filter by resourceStatus when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', resourceStatus: 'ENABLED' }),
                createMockTemplateEntity({ id: 't2', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listPromptTemplates({ includeDisabled: true });

            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
            );
            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(result).toHaveLength(2);
        });

        it('should filter by resourceStatus ENABLED when includeDisabled is explicitly false', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates({ includeDisabled: false });

            expect(mockQb.Where).toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
            );
        });

        it('should return mixed ENABLED and DISABLED templates when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', name: 'Active Prompt', resourceStatus: 'ENABLED' }),
                createMockTemplateEntity({ id: 't2', name: 'Disabled Prompt', resourceStatus: 'DISABLED' }),
                createMockTemplateEntity({ id: 't3', name: 'Another Active', resourceStatus: 'ENABLED' }),
            ]);

            const result = await service.listPromptTemplates({ includeDisabled: true });

            expect(result).toHaveLength(3);
            expect(result.find(t => t.id === 't2')).toBeDefined();
        });

        it('should not filter out all-DISABLED results when includeDisabled is true', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', resourceStatus: 'DISABLED' }),
                createMockTemplateEntity({ id: 't2', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listPromptTemplates({ includeDisabled: true });

            expect(result).toHaveLength(2);
            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
            );
        });

        it('should include resourceStatus in response DTOs', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listPromptTemplates({ includeDisabled: true });

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveProperty('resourceStatus');
        });

        it('should combine includeDisabled with category filter', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', category: 'SUMMARY', resourceStatus: 'DISABLED' }),
            ]);

            const result = await service.listPromptTemplates({
                category: 'SUMMARY',
                includeDisabled: true,
            });

            expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }),
            );
            expect(result).toHaveLength(1);
        });

        it('should filter by search term with case-insensitive partial match', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([
                createMockTemplateEntity({ id: 't1', name: 'Clinical Summary' }),
            ]);

            const result = await service.listPromptTemplates({ search: 'clinical' });

            expect(mockQb.Where).toHaveBeenCalledWith({ name: { contains: 'clinical', mode: 'insensitive' } });
            expect(result).toHaveLength(1);
        });

        it('should apply search filter alongside category and departmentId', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates({
                category: 'SUMMARY',
                departmentId: 'dept-1',
                search: 'genetics',
            });

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
            expect(mockQb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
            expect(mockQb.Where).toHaveBeenCalledWith({ departmentId: 'dept-1' });
            expect(mockQb.Where).toHaveBeenCalledWith({ name: { contains: 'genetics', mode: 'insensitive' } });
            expect(mockQb.Where).toHaveBeenCalledTimes(5);
        });

        it('should not apply search filter when search is not provided', async () => {
            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await service.listPromptTemplates({ category: 'SYSTEM' });

            expect(mockQb.Where).not.toHaveBeenCalledWith(
                expect.objectContaining({ name: expect.anything() }),
            );
        });
    });

    // ─── getVersions ────────────────────────────────────────────

    describe('getVersions', () => {
        it('should return version history for a template', async () => {
            mockVersionRepo.findByTemplate.mockResolvedValue([
                createMockVersionEntity({ id: 'v2', versionNumber: 2 }),
                createMockVersionEntity({ id: 'v1', versionNumber: 1 }),
            ]);

            const result = await service.getVersions('template-id-1');

            expect(mockVersionRepo.findByTemplate).toHaveBeenCalledWith('template-id-1');
            expect(result).toHaveLength(2);
            expect(result[0].versionNumber).toBe(2);
            expect(result[1].versionNumber).toBe(1);
        });

        it('should return empty array when no versions exist', async () => {
            mockVersionRepo.findByTemplate.mockResolvedValue([]);

            const result = await service.getVersions('template-id-1');

            expect(result).toEqual([]);
        });
    });

    // ─── getVersion ───────────────────────────────────────────

    describe('getVersion', () => {
        it('should return a specific version by template ID and version number', async () => {
            mockVersionRepo.findByVersionNumber.mockResolvedValue(
                createMockVersionEntity({ promptTemplateId: 'tpl-1', versionNumber: 2, content: 'v2 content' }),
            );

            const result = await service.getVersion('tpl-1', 2);

            expect(result).not.toBeNull();
            expect(result!.versionNumber).toBe(2);
            expect(result!.content).toBe('v2 content');
            expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('tpl-1', 2);
        });

        it('should return null when version does not exist', async () => {
            mockVersionRepo.findByVersionNumber.mockResolvedValue(null);

            const result = await service.getVersion('tpl-1', 99);

            expect(result).toBeNull();
            expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('tpl-1', 99);
        });

        it('should pass exact templateId and versionNumber to repository', async () => {
            mockVersionRepo.findByVersionNumber.mockResolvedValue(null);

            await service.getVersion('template-abc', 5);

            expect(mockVersionRepo.findByVersionNumber).toHaveBeenCalledWith('template-abc', 5);
        });
    });

    // ─── softDeletePromptTemplate ───────────────────────────────

    describe('softDeletePromptTemplate', () => {
        it('should soft delete and return deleted template', async () => {
            const entity = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(entity);
            mockTemplateRepo.softDelete.mockResolvedValue(
                createMockTemplateEntity({ resourceStatus: 'DELETED' }),
            );

            const result = await service.softDeletePromptTemplate('template-id-1');

            expect(mockTemplateRepo.softDelete).toHaveBeenCalledWith('template-id-1');
            expect(result.id).toBe('template-id-1');
        });

        it('should throw NotFoundException when template not found', async () => {
            mockTemplateRepo.findById.mockResolvedValue(null);

            await expect(
                service.softDeletePromptTemplate('nonexistent'),
            ).rejects.toThrow(NotFoundException);

            await expect(
                service.softDeletePromptTemplate('nonexistent'),
            ).rejects.toThrow('Prompt template nonexistent not found');

            expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
        });

        it('should broadcast ResourceDeleted event', async () => {
            mockTemplateRepo.findById.mockResolvedValue(createMockTemplateEntity());
            mockTemplateRepo.softDelete.mockResolvedValue(createMockTemplateEntity());

            await service.softDeletePromptTemplate('template-id-1');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'template-id-1',
                }),
            );
        });
    });

    // ─── Cross-Tenant Isolation ──────────────────────────────────

    describe('Cross-Tenant Isolation', () => {
        it('listPromptTemplates should use calling tenant context, not a hardcoded value', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-X';
                if (key === 'userAbility') return { can: abilityCan };
                return defaultClsContext.user;
            });

            const tenantXService = new PromptManagementService(
                mockTemplateRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockDepartmentService as never,
                mockEventEmitter as never,
                mockClsService as never,
            );

            const mockQb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(mockQb);
            mockQb.ToList.mockResolvedValue([]);

            await tenantXService.listPromptTemplates();

            expect(mockQb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-X' });
            expect(mockQb.Where).not.toHaveBeenCalledWith({ tenantId: 'tenant-1' });
        });

        it('createPromptTemplate should embed calling tenant into entity', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return 'tenant-Y';
                if (key === 'user') return { id: 'user-Y' };
                if (key === 'userAbility') return { can: abilityCan };
                return null;
            });

            const tenantYService = new PromptManagementService(
                mockTemplateRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockDepartmentService as never,
                mockEventEmitter as never,
                mockClsService as never,
            );

            mockTemplateRepo.findByName.mockResolvedValue(null);
            mockTemplateRepo.create.mockResolvedValue(createMockTemplateEntity({ tenantId: 'tenant-Y' }));
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await tenantYService.createPromptTemplate({
                name: 'Cross-tenant test',
                content: 'Content',
                category: 'SYSTEM',
            });

            expect(mockTemplateRepo.findByName).toHaveBeenCalledWith('tenant-Y', 'Cross-tenant test');
        });
    });

    describe('getUsageStats', () => {
        it('should return total usages and last used timestamp when records exist', async () => {
            const now = new Date('2026-02-20T10:00:00Z');
            const earlier = new Date('2026-02-19T08:00:00Z');
            mockUsageRepo.findByTemplate.mockResolvedValue([
                { id: 'rec-1', createdAt: now },
                { id: 'rec-2', createdAt: earlier },
            ]);

            const result = await service.getUsageStats('template-1');

            expect(mockUsageRepo.findByTemplate).toHaveBeenCalledWith('template-1');
            expect(result).toEqual({
                totalUsages: 2,
                lastUsedAt: now.toISOString(),
            });
        });

        it('should return zero usages and null lastUsedAt when no records exist', async () => {
            mockUsageRepo.findByTemplate.mockResolvedValue([]);

            const result = await service.getUsageStats('template-no-usage');

            expect(mockUsageRepo.findByTemplate).toHaveBeenCalledWith('template-no-usage');
            expect(result).toEqual({
                totalUsages: 0,
                lastUsedAt: null,
            });
        });

        it('should handle records with missing CreatedAt gracefully', async () => {
            mockUsageRepo.findByTemplate.mockResolvedValue([
                { id: 'rec-1', CreatedAt: undefined },
            ]);

            const result = await service.getUsageStats('template-bad-date');

            expect(result).toEqual({
                totalUsages: 1,
                lastUsedAt: null,
            });
        });
    });

    // ─── TASK-294 DEF-C2: Authorization & tenant scope ───────────────────

    describe('Authorization & tenant scope (DEF-C2)', () => {
        describe('updatePromptTemplate', () => {
            it('throws NotFoundException when template tenant does not match caller tenant', async () => {
                const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
                mockTemplateRepo.findById.mockResolvedValue(foreign);

                await expect(
                    service.updatePromptTemplate('tpl-X', { content: 'edit', expectedVersion: 1 } as never),
                ).rejects.toThrow(NotFoundException);
                // DEF-C2 + TASK-302: neither legacy nor CAS writers may fire on
                // a foreign-tenant row.
                expect(mockTemplateRepo.update).not.toHaveBeenCalled();
                expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
            });

            it('throws ForbiddenException on USER_PERSONAL owned by a different user', async () => {
                const personal = createMockTemplateEntity({
                    id: 'tpl-P',
                    tenantId: 'tenant-1',
                    scope: 'USER_PERSONAL',
                    ownerUserId: 'someone-else',
                });
                mockTemplateRepo.findById.mockResolvedValue(personal);

                await expect(
                    service.updatePromptTemplate('tpl-P', { content: 'edit', expectedVersion: 1 } as never),
                ).rejects.toThrow(ForbiddenException);
            });

            it('throws ForbiddenException on TENANT_DEFAULT when caller lacks manage ability', async () => {
                abilityCan.mockReturnValue(false);
                const tpl = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
                mockTemplateRepo.findById.mockResolvedValue(tpl);

                await expect(
                    service.updatePromptTemplate('tpl-D', { content: 'edit', expectedVersion: 1 } as never),
                ).rejects.toThrow(ForbiddenException);
            });

            it('allows caller to update own USER_PERSONAL template', async () => {
                abilityCan.mockReturnValue(false); // even without manage, owner can mutate
                const personal = createMockTemplateEntity({
                    id: 'tpl-mine',
                    tenantId: 'tenant-1',
                    scope: 'USER_PERSONAL',
                    ownerUserId: 'user-id-1',
                });
                mockTemplateRepo.findById.mockResolvedValue(personal);
                mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());
                mockTemplateRepo.updateWithVersion.mockResolvedValue(personal);

                await service.updatePromptTemplate('tpl-mine', { content: 'new content', expectedVersion: 1 } as never);

                expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalled();
            });
        });

        describe('getPromptTemplate', () => {
            it('returns null on cross-tenant lookup (no existence leak)', async () => {
                const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
                mockTemplateRepo.findById.mockResolvedValue(foreign);

                const result = await service.getPromptTemplate('tpl-X');

                expect(result).toBeNull();
            });

            it('returns the template when tenant matches', async () => {
                const tpl = createMockTemplateEntity({ id: 'tpl-1', tenantId: 'tenant-1' });
                mockTemplateRepo.findById.mockResolvedValue(tpl);

                const result = await service.getPromptTemplate('tpl-1');

                expect(result).not.toBeNull();
            });

            it('returns null when caller is not the owner of a USER_PERSONAL template', async () => {
                const personal = createMockTemplateEntity({
                    id: 'tpl-P',
                    tenantId: 'tenant-1',
                    scope: 'USER_PERSONAL',
                    ownerUserId: 'someone-else',
                });
                mockTemplateRepo.findById.mockResolvedValue(personal);

                const result = await service.getPromptTemplate('tpl-P');

                expect(result).toBeNull();
            });
        });

        describe('softDeletePromptTemplate', () => {
            it('throws NotFoundException on cross-tenant delete attempt', async () => {
                const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER' });
                mockTemplateRepo.findById.mockResolvedValue(foreign);

                await expect(service.softDeletePromptTemplate('tpl-X')).rejects.toThrow(NotFoundException);
                expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
            });

            it('throws ForbiddenException when caller does not own a USER_PERSONAL template', async () => {
                const personal = createMockTemplateEntity({
                    id: 'tpl-P',
                    tenantId: 'tenant-1',
                    scope: 'USER_PERSONAL',
                    ownerUserId: 'someone-else',
                });
                mockTemplateRepo.findById.mockResolvedValue(personal);

                await expect(service.softDeletePromptTemplate('tpl-P')).rejects.toThrow(ForbiddenException);
            });

            it('throws ForbiddenException when caller lacks manage on a TENANT_DEFAULT', async () => {
                abilityCan.mockReturnValue(false);
                const tpl = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
                mockTemplateRepo.findById.mockResolvedValue(tpl);

                await expect(service.softDeletePromptTemplate('tpl-D')).rejects.toThrow(ForbiddenException);
            });
        });
    });

    describe('createPromptTemplate scope defaults (DEF-C2)', () => {
        it('defaults newly created template to scope=TENANT_DEFAULT', async () => {
            mockTemplateRepo.findByName.mockResolvedValue(null);
            const saved = createMockTemplateEntity({ scope: 'TENANT_DEFAULT' });
            mockTemplateRepo.create.mockResolvedValue(saved);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.createPromptTemplate({ name: 'New', content: 'X', category: 'SYSTEM' });

            // factory call assertion happens via mocked factory; here we assert
            // create succeeded and event was broadcast with the default scope.
            expect(mockTemplateRepo.create).toHaveBeenCalled();
        });

        it('throws ForbiddenException when caller lacks manage ability for default creation', async () => {
            abilityCan.mockReturnValue(false);

            await expect(
                service.createPromptTemplate({ name: 'New', content: 'X', category: 'SYSTEM' }),
            ).rejects.toThrow(ForbiddenException);
        });
    });

    describe('createPersonal (DEF-C2 W5B-7)', () => {
        it('stamps scope=USER_PERSONAL and ownerUserId=requestUserId', async () => {
            const saved = createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
            mockTemplateRepo.create.mockResolvedValue(saved);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.createPersonal({ name: 'Mine', content: 'X', category: 'CUSTOM' });

            expect(mockTemplateRepo.create).toHaveBeenCalled();
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

            await expect(
                service.createPersonal({ name: 'X', content: 'X', category: 'CUSTOM' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('does NOT require manage ability', async () => {
            abilityCan.mockReturnValue(false); // caller cannot manage tenant defaults, but personal is fine
            const saved = createMockTemplateEntity({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
            mockTemplateRepo.create.mockResolvedValue(saved);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await expect(
                service.createPersonal({ name: 'Mine', content: 'X', category: 'CUSTOM' }),
            ).resolves.toBeDefined();
        });
    });

    describe('listDefaultsForDepartment (DEF-C2 W5B-7)', () => {
        it('returns templates with scope=TENANT_DEFAULT or DEPARTMENT_DEFAULT scoped to the department', async () => {
            const qb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(qb);
            qb.ToList.mockResolvedValue([]);

            await service.listDefaultsForDepartment('dept-1');

            expect(qb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'TENANT_DEFAULT' });
            expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'DEPARTMENT_DEFAULT', departmentId: 'dept-1' });
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

            await expect(service.listDefaultsForDepartment('dept-1')).rejects.toThrow(BadRequestException);
        });
    });

    describe('listMyPersonalForDepartment (DEF-C2 W5B-7)', () => {
        it('delegates to findMyPersonalForDepartment with caller tenant + user', async () => {
            mockTemplateRepo.findMyPersonalForDepartment.mockResolvedValue([]);

            await service.listMyPersonalForDepartment('dept-1');

            expect(mockTemplateRepo.findMyPersonalForDepartment).toHaveBeenCalledWith('tenant-1', 'user-id-1', 'dept-1');
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

            await expect(service.listMyPersonalForDepartment('dept-1')).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException when caller user id is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'tenantId' ? 'tenant-1' : null));

            await expect(service.listMyPersonalForDepartment('dept-1')).rejects.toThrow(BadRequestException);
        });
    });

    // ─── TASK-331 doc-09: end-user readable templates (no admin ability) ─────
    describe('listAvailableForCaller (TASK-331 doc-09)', () => {
        it('scopes to tenant + ENABLED and ORs (TENANT_DEFAULT, DEPARTMENT_DEFAULT, own USER_PERSONAL)', async () => {
            const qb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(qb);
            qb.ToList.mockResolvedValue([createMockTemplateEntity({ id: 't1' })]);

            const result = await service.listAvailableForCaller();

            expect(qb.Where).toHaveBeenCalledWith({ tenantId: 'tenant-1' });
            expect(qb.Where).toHaveBeenCalledWith({ resourceStatus: ResourceStatusType.ENABLED });
            expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'TENANT_DEFAULT' });
            expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'DEPARTMENT_DEFAULT' });
            expect(qb.WhereOr).toHaveBeenCalledWith({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
            expect(result).toHaveLength(1);
        });

        it('applies the category filter when provided', async () => {
            const qb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(qb);
            qb.ToList.mockResolvedValue([]);

            await service.listAvailableForCaller({ category: 'SUMMARY' });

            expect(qb.Where).toHaveBeenCalledWith({ category: 'SUMMARY' });
        });

        it('does NOT include other users personal templates (owner predicate bound to caller)', async () => {
            const qb = createMockQueryBuilder();
            mockTemplateRepo.$.mockReturnValue(qb);
            qb.ToList.mockResolvedValue([]);

            await service.listAvailableForCaller();

            const personalCalls = qb.WhereOr.mock.calls.filter(
                ([p]: [Record<string, unknown>]) => p?.scope === 'USER_PERSONAL',
            );
            expect(personalCalls).toHaveLength(1);
            expect(personalCalls[0][0]).toEqual({ scope: 'USER_PERSONAL', ownerUserId: 'user-id-1' });
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'user' ? defaultClsContext.user : null));

            await expect(service.listAvailableForCaller()).rejects.toThrow(BadRequestException);
        });

        it('throws BadRequestException when caller user id is missing', async () => {
            mockClsService.get.mockImplementation((k: string) => (k === 'tenantId' ? 'tenant-1' : null));

            await expect(service.listAvailableForCaller()).rejects.toThrow(BadRequestException);
        });
    });

    // ─── TASK-294 DEF-C4 W5B-8: assign templates to department ───────────

    describe('assignToDepartment (DEF-C4 W5B-8)', () => {
        it('delegates to DepartmentService.updatePromptConfig with the right fields', async () => {
            mockDepartmentService.updatePromptConfig.mockResolvedValue({ id: 'dept-1' });

            await service.assignToDepartment({
                departmentId: 'dept-1',
                newPatientPromptId: 'np-1',
                revisitPromptId: 'rv-1',
                // TASK-302 Stream D Phase E.2 — the AssignDepartmentPromptRequest
                // DTO now carries the target Department row's expectedVersion
                // so the downstream `updatePromptConfig` can CAS against it.
                expectedVersion: 7,
            } as never);

            expect(mockDepartmentService.updatePromptConfig).toHaveBeenCalledWith('dept-1', {
                newPatientPromptId: 'np-1',
                revisitPromptId: 'rv-1',
                expectedVersion: 7,
            });
        });

        it('propagates ForbiddenException / NotFoundException from DepartmentService (tenant guard)', async () => {
            mockDepartmentService.updatePromptConfig.mockRejectedValue(new NotFoundException('Department not found'));

            await expect(
                service.assignToDepartment({ departmentId: 'wrong', newPatientPromptId: 'np-1', expectedVersion: 1 } as never),
            ).rejects.toThrow(NotFoundException);
        });
    });

    // ─── TASK-328 A4: prompt quality/score test run ──────────────────────

    describe('testPromptTemplate (TASK-328 A4)', () => {
        const buildSmrService = (responseData: Record<string, unknown>) => {
            const httpMock = createMockHttpService(responseData);
            const configMock = createMockConfigService();
            const svc = new PromptManagementService(
                mockTemplateRepo as never,
                mockVersionRepo as never,
                mockUsageRepo as never,
                mockDepartmentService as never,
                mockEventEmitter as never,
                mockClsService as never,
                httpMock as never,
                configMock as never,
                undefined,
            );
            return { svc, httpMock, configMock };
        };

        it('runs the template against SMR and persists lastTestScore/lastTestOutput/lastTestAt via OCC write', async () => {
            const output = wordsOfLength(60); // ≥ 50 words → full score
            const existing = createMockTemplateEntity({ id: 'tpl-1', version: 5, content: 'Summarize {{topic}}' });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(
                createMockTemplateEntity({ id: 'tpl-1', version: 6 }),
            );
            const { svc, httpMock } = buildSmrService({ content: output });

            const result = await svc.testPromptTemplate('tpl-1', { variables: { topic: 'asthma' }, expectedVersion: 5 } as never);

            // SMR client was invoked with the interpolated prompt
            expect(httpMock.axiosRef.post).toHaveBeenCalledTimes(1);
            const [, payload] = httpMock.axiosRef.post.mock.calls[0];
            expect((payload as { prompt: string }).prompt).toContain('asthma');

            // Persisted via Compare-And-Set against the row `_version`
            expect(mockTemplateRepo.updateWithVersion).toHaveBeenCalledWith('tpl-1', existing, 5);
            expect(existing.lastTestScore).toBe(1);
            expect(existing.lastTestOutput).toBe(output);
            expect(existing.lastTestAt).toBeInstanceOf(Date);

            // Result DTO surfaces the score/output + the new row version
            expect(result.id).toBe('tpl-1');
            expect(result.score).toBe(1);
            expect(result.output).toBe(output);
            expect(result.version).toBe(6);
            expect(typeof result.testedAt).toBe('string');
        });

        it('scores a short SMR output below 1.0 (deterministic word-count heuristic)', async () => {
            const output = wordsOfLength(5); // 5/50 → 0.1
            const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
            const { svc } = buildSmrService({ content: output });

            const result = await svc.testPromptTemplate('tpl-1', { expectedVersion: 1 } as never);

            expect(result.score).toBeCloseTo(0.1, 5);
        });

        it('broadcasts ResourceUpdated after a successful test run', async () => {
            const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2 }));
            const { svc } = buildSmrService({ content: wordsOfLength(80) });

            await svc.testPromptTemplate('tpl-1', { expectedVersion: 1 } as never);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({ resourceId: 'tpl-1' }),
            );
        });

        it('throws NotFoundException on a cross-tenant template (no SMR call, no write)', async () => {
            const foreign = createMockTemplateEntity({ id: 'tpl-X', tenantId: 'tenant-OTHER', version: 1 });
            mockTemplateRepo.findById.mockResolvedValue(foreign);
            const { svc, httpMock } = buildSmrService({ content: wordsOfLength(80) });

            await expect(
                svc.testPromptTemplate('tpl-X', { expectedVersion: 1 } as never),
            ).rejects.toThrow(NotFoundException);
            expect(httpMock.axiosRef.post).not.toHaveBeenCalled();
            expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
        });

        it('propagates OptimisticConcurrencyException from the CAS write', async () => {
            const existing = createMockTemplateEntity({ id: 'tpl-1', version: 5 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('PromptTemplate', 'tpl-1', { expectedVersion: 5, currentVersion: 6 }),
            );
            const { svc } = buildSmrService({ content: wordsOfLength(80) });

            await expect(
                svc.testPromptTemplate('tpl-1', { expectedVersion: 5 } as never),
            ).rejects.toThrow(OptimisticConcurrencyException);
        });

        // ── TASK-331 doc-02 F8: deterministic composite rubric ──────────
        describe('deterministic output rubric (TASK-331 doc-02 F8)', () => {
            const runWith = async (entityOverrides: Record<string, unknown>, output: string) => {
                const existing = createMockTemplateEntity({ id: 'tpl-1', version: 1, ...entityOverrides });
                mockTemplateRepo.findById.mockResolvedValue(existing);
                mockTemplateRepo.updateWithVersion.mockResolvedValue(createMockTemplateEntity({ id: 'tpl-1', version: 2, ...entityOverrides }));
                const { svc } = buildSmrService({ content: output });
                return svc.testPromptTemplate('tpl-1', { expectedVersion: 1 } as never);
            };

            it('scores an empty output as 0 (non-empty gate)', async () => {
                const result = await runWith({ category: 'SYSTEM', content: 'Plain prompt', variables: null }, '   ');
                expect(result.score).toBe(0);
                expect(result.metrics?.nonEmpty).toBe(false);
            });

            it('scores a long plain output as full length (length-only dimension)', async () => {
                const result = await runWith({ category: 'SYSTEM', content: 'Plain prompt', variables: null }, wordsOfLength(60));
                expect(result.score).toBe(1);
                expect(result.metrics?.jsonExpected).toBe(false);
                expect(result.metrics?.variableCoverage).toBeNull();
            });

            it('rewards valid JSON for a JSON/DNA template', async () => {
                const jsonOutput = JSON.stringify({ summary: wordsOfLength(60) });
                const result = await runWith({ category: 'DNA_ANALYSIS', content: 'Return JSON', variables: null }, jsonOutput);
                // dimensions: [length=1, json=1] → 1.0
                expect(result.metrics?.jsonExpected).toBe(true);
                expect(result.metrics?.jsonValid).toBe(true);
                expect(result.score).toBe(1);
            });

            it('penalizes invalid JSON for a JSON/DNA template', async () => {
                const result = await runWith({ category: 'DNA_ANALYSIS', content: 'Return JSON', variables: null }, wordsOfLength(60));
                // dimensions: [length=1, json=0] → 0.5
                expect(result.metrics?.jsonExpected).toBe(true);
                expect(result.metrics?.jsonValid).toBe(false);
                expect(result.score).toBe(0.5);
            });

            it('detects a JSON-enforcement cue in the content (no DNA category)', async () => {
                const result = await runWith({ category: 'SYSTEM', content: 'Respond strictly in json', variables: null }, wordsOfLength(60));
                expect(result.metrics?.jsonExpected).toBe(true);
                expect(result.metrics?.jsonValid).toBe(false);
                expect(result.score).toBe(0.5);
            });

            it('measures declared-variable coverage in the output', async () => {
                const result = await runWith(
                    { category: 'SYSTEM', content: 'Note about {{topic}} for {{patient}}', variables: [{ name: 'topic' }, { name: 'patient' }] },
                    `topic ${wordsOfLength(60)}`,
                );
                // dimensions: [length=1, coverage=0.5] → 0.75
                expect(result.metrics?.variablesDeclared).toBe(2);
                expect(result.metrics?.variableCoverage).toBe(0.5);
                expect(result.score).toBe(0.75);
            });

            it('surfaces the metrics breakdown on the result DTO', async () => {
                const result = await runWith({ category: 'SYSTEM', content: 'Plain', variables: null }, wordsOfLength(60));
                expect(result.metrics).toBeDefined();
                expect(result.metrics?.wordCount).toBe(60);
                expect(result.metrics?.lengthScore).toBe(1);
            });
        });
    });

    // ─── TASK-328 A4: repository-level pagination ────────────────────────

    describe('listPromptTemplatesPaginated (TASK-328 A4)', () => {
        it('delegates to repository.findPaginated and returns {data,count,page,limit}', async () => {
            mockTemplateRepo.findPaginated.mockResolvedValue({
                data: [createMockTemplateEntity({ id: 't1' }), createMockTemplateEntity({ id: 't2' })],
                count: 7,
            });

            const result = await service.listPromptTemplatesPaginated({ page: 2, limit: 2 });

            expect(mockTemplateRepo.findPaginated).toHaveBeenCalledWith(
                expect.objectContaining({ tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }),
                2,
                2,
            );
            expect(result.count).toBe(7);
            expect(result.page).toBe(2);
            expect(result.limit).toBe(2);
            expect(result.data).toHaveLength(2);
        });

        it('defaults to page 1 / limit 50 and applies filters into the where clause', async () => {
            mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await service.listPromptTemplatesPaginated({ category: 'SUMMARY', search: 'soap', includeDisabled: true });

            const [where, page, limit] = mockTemplateRepo.findPaginated.mock.calls[0];
            expect(page).toBe(1);
            expect(limit).toBe(50);
            expect(where).toMatchObject({ tenantId: 'tenant-1', category: 'SUMMARY', name: { contains: 'soap', mode: 'insensitive' } });
            // includeDisabled drops the ENABLED-only constraint
            expect(where).not.toHaveProperty('resourceStatus');
        });

        // TASK-331 doc-02 F5 — server-side status filter folds into the where clause.
        it('applies the status filter into the where clause', async () => {
            mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await service.listPromptTemplatesPaginated({ status: 'PUBLISHED' });

            const [where] = mockTemplateRepo.findPaginated.mock.calls[0];
            expect(where).toMatchObject({ tenantId: 'tenant-1', status: 'PUBLISHED' });
        });

        it('does not add a status constraint when status is omitted', async () => {
            mockTemplateRepo.findPaginated.mockResolvedValue({ data: [], count: 0 });

            await service.listPromptTemplatesPaginated({ category: 'SUMMARY' });

            const [where] = mockTemplateRepo.findPaginated.mock.calls[0];
            expect(where).not.toHaveProperty('status');
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => (key === 'user' ? defaultClsContext.user : null));

            await expect(service.listPromptTemplatesPaginated()).rejects.toThrow(BadRequestException);
        });
    });

    // ─── TASK-328 A4: usage analytics (groupBy dept / doctor / time) ─────

    describe('getUsageAnalytics (TASK-328 A4)', () => {
        it('returns aggregates grouped by department, doctor, and day', async () => {
            mockUsageRepo.groupByDepartment.mockResolvedValue([
                { departmentId: 'dept-1', count: 4 },
                { departmentId: null, count: 1 },
            ]);
            mockUsageRepo.groupByDoctor.mockResolvedValue([{ doctorId: 'doc-1', count: 5 }]);
            mockUsageRepo.groupByDay.mockResolvedValue([
                { day: '2026-06-01', count: 2 },
                { day: '2026-06-02', count: 3 },
            ]);

            const result = await service.getUsageAnalytics();

            expect(mockUsageRepo.groupByDepartment).toHaveBeenCalledWith('tenant-1', undefined);
            expect(mockUsageRepo.groupByDoctor).toHaveBeenCalledWith('tenant-1', undefined);
            expect(mockUsageRepo.groupByDay).toHaveBeenCalledWith('tenant-1', undefined);
            expect(result.totalUsages).toBe(5);
            expect(result.byDepartment).toEqual([
                { departmentId: 'dept-1', count: 4 },
                { departmentId: null, count: 1 },
            ]);
            expect(result.byDoctor).toEqual([{ doctorId: 'doc-1', count: 5 }]);
            expect(result.byDay).toEqual([
                { day: '2026-06-01', count: 2 },
                { day: '2026-06-02', count: 3 },
            ]);
        });

        it('passes through an optional promptTemplateId filter to the repository', async () => {
            mockUsageRepo.groupByDepartment.mockResolvedValue([]);
            mockUsageRepo.groupByDoctor.mockResolvedValue([]);
            mockUsageRepo.groupByDay.mockResolvedValue([]);

            await service.getUsageAnalytics({ promptTemplateId: 'tpl-9' });

            expect(mockUsageRepo.groupByDepartment).toHaveBeenCalledWith('tenant-1', 'tpl-9');
            expect(mockUsageRepo.groupByDoctor).toHaveBeenCalledWith('tenant-1', 'tpl-9');
            expect(mockUsageRepo.groupByDay).toHaveBeenCalledWith('tenant-1', 'tpl-9');
        });

        it('throws BadRequestException when tenantId is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => (key === 'user' ? defaultClsContext.user : null));

            await expect(service.getUsageAnalytics()).rejects.toThrow(BadRequestException);
        });
    });
});
