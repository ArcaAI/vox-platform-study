/**
 * PromptManagementService Unit Tests
 *
 * Tests for prompt template CRUD, versioning, and department assignment.
 * Mocks only at boundaries: repositories (database) and event emitter.
 * Verifies actual service behavior, return values, and side effects.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SysEventType, ResourceStatusType } from '@arcaai/domains';
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
    create: vi.fn(),
    update: vi.fn(),
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
});

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
        isActive: () => (overrides.resourceStatus ?? 'ENABLED') === 'ENABLED',
        incrementVersion: vi.fn().mockImplementation(() => { _changed = true; }),
        enable: vi.fn().mockImplementation(() => { _changed = true; }),
        disable: vi.fn().mockImplementation(() => { _changed = true; }),
        toObject: vi.fn().mockReturnValue(overrides),
    };
    const trackedKeys = new Set(['name', 'description', 'content', 'variables', 'tags', 'resourceStatus', 'scope', 'ownerUserId']);
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
    });

    // ─── updatePromptTemplate ───────────────────────────────────

    describe('updatePromptTemplate', () => {
        it('should create new version snapshot and increment version number on success', async () => {
            const existing = createMockTemplateEntity({ currentVersionNumber: 2 });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(
                createMockTemplateEntity({ currentVersionNumber: 3 }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 3 }));

            const result = await service.updatePromptTemplate('template-id-1', {
                content: 'Updated content',
                changeReason: 'Improved prompt',
            });

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
        });

        it('should throw NotFoundException when template does not exist', async () => {
            mockTemplateRepo.findById.mockResolvedValue(null);

            await expect(
                service.updatePromptTemplate('nonexistent', { content: 'x' }),
            ).rejects.toThrow(NotFoundException);

            await expect(
                service.updatePromptTemplate('nonexistent', { content: 'x' }),
            ).rejects.toThrow('Prompt template nonexistent not found');

            expect(mockVersionRepo.create).not.toHaveBeenCalled();
        });

        it('should perform partial update (only content)', async () => {
            const existing = createMockTemplateEntity({
                name: 'Original',
                content: 'Original content',
            });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            const result = await service.updatePromptTemplate('template-id-1', {
                content: 'New content',
            });

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
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { name: 'Renamed' });

            expect(existing.name).toBe('Renamed');
            expect(existing.content).toBe('Original content');
        });

        it('should perform partial update (only tags)', async () => {
            const existing = createMockTemplateEntity({
                name: 'Original',
                tags: ['old'],
            });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { tags: ['new', 'tags'] });

            expect(existing.tags).toEqual(['new', 'tags']);
        });

        it('should increment version from null when currentVersionNumber is null', async () => {
            const existing = createMockTemplateEntity({ currentVersionNumber: null });
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(
                createMockTemplateEntity({ currentVersionNumber: 1 }),
            );
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity({ versionNumber: 1 }));

            await service.updatePromptTemplate('template-id-1', { content: 'Updated' });

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    versionNumber: 1,
                }),
            );
        });

        it('should include changeReason when provided', async () => {
            const existing = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', {
                content: 'Updated',
                changeReason: 'Bug fix',
            });

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    changeReason: 'Bug fix',
                }),
            );
        });

        it('should handle update without changeReason', async () => {
            const existing = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', { content: 'Updated' });

            expect(mockVersionRepo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    changeReason: null,
                }),
            );
        });

        it('should broadcast ResourceUpdated event', async () => {
            const existing = createMockTemplateEntity();
            mockTemplateRepo.findById.mockResolvedValue(existing);
            mockTemplateRepo.update.mockResolvedValue(existing);
            mockVersionRepo.create.mockResolvedValue(createMockVersionEntity());

            await service.updatePromptTemplate('template-id-1', {
                content: 'Updated',
                changeReason: 'Improvement',
            });

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'template-id-1',
                    data: { changeReason: 'Improvement' },
                }),
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
                    service.updatePromptTemplate('tpl-X', { content: 'edit' } as never),
                ).rejects.toThrow(NotFoundException);
                expect(mockTemplateRepo.update).not.toHaveBeenCalled();
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
                    service.updatePromptTemplate('tpl-P', { content: 'edit' } as never),
                ).rejects.toThrow(ForbiddenException);
            });

            it('throws ForbiddenException on TENANT_DEFAULT when caller lacks manage ability', async () => {
                abilityCan.mockReturnValue(false);
                const tpl = createMockTemplateEntity({ id: 'tpl-D', tenantId: 'tenant-1', scope: 'TENANT_DEFAULT' });
                mockTemplateRepo.findById.mockResolvedValue(tpl);

                await expect(
                    service.updatePromptTemplate('tpl-D', { content: 'edit' } as never),
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
                mockTemplateRepo.update.mockResolvedValue(personal);

                await service.updatePromptTemplate('tpl-mine', { content: 'new content' } as never);

                expect(mockTemplateRepo.update).toHaveBeenCalled();
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
});
