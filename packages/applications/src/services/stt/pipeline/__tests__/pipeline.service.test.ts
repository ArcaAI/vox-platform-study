/**
 * PipelineService Unit Tests
 *
 * Tests for the PipelineService that handles ASR pipeline CRUD operations.
 *
 * TESTING APPROACH:
 * - Uses behavioral mock entities that simulate real entity behavior
 * - Only mocks external boundaries: repositories (I/O) and event emitter (side effects)
 * - Verifies actual state changes through behavioral mocks
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineService } from '../pipeline.service';

// Enum constants to avoid import issues
const ResourceStatusType = {
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
} as const;

const SysEventType = {
    ResourceCreated: 'SysEvent.ResourceCreated',
    ResourceUpdated: 'SysEvent.ResourceUpdated',
    ResourceViewed: 'SysEvent.ResourceViewed',
    ResourceDeleted: 'SysEvent.ResourceDeleted',
} as const;

// Sample YAML config for testing
const validConfigYaml = `
version: "1.0"

models:
  asr: "whisper-large-v3"
  vad: "silero-vad-v4"

inference:
  batch_size: 16
`;

const minimalConfigYaml = `
version: "1.0"

models:
  asr: "whisper-tiny"

inference:
  batch_size: 8
`;

// ============================================
// Behavioral Mock Entity Factory
// ============================================

/**
 * Creates a BEHAVIORAL mock AsrPipelineEntity
 */
function createBehavioralPipelineEntity(overrides: {
    id?: string;
    tenantId?: string;
    name?: string;
    slug?: string;
    description?: string | null;
    configYaml?: string;
    resourceStatus?: string;
    createdBy?: string | null;
    tags?: string[];
    version?: number;
} = {}) {
    // Internal mutable state
    let _name = overrides.name ?? 'Test Pipeline';
    let _slug = overrides.slug ?? 'test-pipeline';
    let _description = overrides.description ?? 'Test description';
    let _configYaml = overrides.configYaml ?? validConfigYaml;
    let _resourceStatus = overrides.resourceStatus ?? ResourceStatusType.ENABLED;
    const _changes: Record<string, any> = {};

    const entity = {
        id: overrides.id ?? 'pipeline-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        createdBy: overrides.createdBy ?? 'user-123',
        tags: overrides.tags ?? ['test'],
        // TASK-302 Stream D Phase E.4 — `_version` is required for the
        // CAS write path. Default = first-write (1); override per test.
        version: overrides.version ?? 1,

        // Getters for mutable state
        get name() { return _name; },
        set name(value: string) { _name = value; _changes.name = value; },
        get slug() { return _slug; },
        set slug(value: string) { _slug = value; _changes.slug = value; },
        get description() { return _description; },
        set description(value: string | null) { _description = value; _changes.description = value; },
        get configYaml() { return _configYaml; },
        set configYaml(value: string) { _configYaml = value; _changes.configYaml = value; },
        get resourceStatus() { return _resourceStatus; },
        get changes() { return _changes; },
        get hasChanges() { return Object.keys(_changes).length > 0; },

        // Status helpers
        get isEnabled() { return _resourceStatus === ResourceStatusType.ENABLED; },
        get isDisabled() { return _resourceStatus === ResourceStatusType.DISABLED; },
        get isArchived() { return _resourceStatus === ResourceStatusType.ARCHIVED; },
        get isDeleted() { return _resourceStatus === ResourceStatusType.DELETED; },
        get isActive() { return _resourceStatus === ResourceStatusType.ENABLED; },

        // BEHAVIORAL methods
        enable(userId?: string) {
            _resourceStatus = ResourceStatusType.ENABLED;
            _changes.resourceStatus = _resourceStatus;
        },

        disable(userId?: string) {
            _resourceStatus = ResourceStatusType.DISABLED;
            _changes.resourceStatus = _resourceStatus;
        },

        archive(userId?: string) {
            _resourceStatus = ResourceStatusType.ARCHIVED;
            _changes.resourceStatus = _resourceStatus;
        },

        delete(userId?: string) {
            _resourceStatus = ResourceStatusType.DELETED;
            _changes.resourceStatus = _resourceStatus;
        },

        // Model slug extraction (simplified version)
        getModelSlugs() {
            const slugs: string[] = [];
            const modelPattern = /^\s*(asr|vad|denoise):\s*["']([^"']+)["']/gm;
            let match;
            while ((match = modelPattern.exec(_configYaml)) !== null) {
                if (match[2]) slugs.push(match[2]);
            }
            return slugs;
        },

        getAsrModelSlug() {
            const match = _configYaml.match(/^\s*asr:\s*["']([^"']+)["']/m);
            return match ? match[1] : null;
        },

        getVadModelSlug() {
            const match = _configYaml.match(/^\s*vad:\s*["']([^"']+)["']/m);
            return match ? match[1] : null;
        },

        toObject() {
            return {
                id: entity.id,
                tenantId: entity.tenantId,
                name: _name,
                slug: _slug,
                description: _description,
                configYaml: _configYaml,
                resourceStatus: _resourceStatus,
                tags: entity.tags,
            };
        },
    };

    return entity;
}

// ============================================
// Mock External Boundaries
// ============================================

const mockClsService = {
    get: vi.fn(),
    set: vi.fn(),
};

const mockEventEmitter = {
    emit: vi.fn(),
};

const mockPipelineRepository = {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findAll: vi.fn(),
    findEnabledPipelines: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    // TASK-302 Stream D Phase E.4 — `update()` now writes via CAS. The
    // legacy `update` stays on the mock so we can assert it is NOT
    // called from the OCC-migrated path.
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
    isSlugUnique: vi.fn(),
};

describe('PipelineService', () => {
    let service: PipelineService;

    beforeEach(() => {
        vi.clearAllMocks();

        mockClsService.get.mockImplementation((key: string) => {
            switch (key) {
                case 'user': return { id: 'current-user-id' };
                case 'tenantId': return 'tenant-1';
                case 'correlationId': return 'corr-123';
                default: return null;
            }
        });

        service = new PipelineService(
            mockPipelineRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new pipeline successfully', async () => {
            mockPipelineRepository.isSlugUnique.mockResolvedValue(true);
            mockPipelineRepository.create.mockImplementation(async (entity: any) => entity);

            const result = await service.create({
                name: 'New Pipeline',
                slug: 'new-pipeline',
                configYaml: validConfigYaml,
            });

            expect(result).toBeDefined();
            expect(mockPipelineRepository.isSlugUnique).toHaveBeenCalledWith('tenant-1', 'new-pipeline');
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceCreated,
                expect.objectContaining({
                    resourceId: expect.any(String),
                })
            );
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(
                service.create({
                    name: 'New Pipeline',
                    slug: 'new-pipeline',
                    configYaml: validConfigYaml,
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when slug already exists', async () => {
            mockPipelineRepository.isSlugUnique.mockResolvedValue(false);

            await expect(
                service.create({
                    name: 'New Pipeline',
                    slug: 'existing-slug',
                    configYaml: validConfigYaml,
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when YAML is invalid', async () => {
            mockPipelineRepository.isSlugUnique.mockResolvedValue(true);

            await expect(
                service.create({
                    name: 'New Pipeline',
                    slug: 'new-pipeline',
                    configYaml: 'invalid yaml without models section',
                })
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('update', () => {
        it('should update an existing pipeline via updateWithVersion and verify state changes (TASK-302 Stream D Phase E.4)', async () => {
            const existingPipeline = createBehavioralPipelineEntity({ id: 'pipeline-1', name: 'Old Name', version: 4 });
            mockPipelineRepository.findById.mockResolvedValue(existingPipeline);
            mockPipelineRepository.updateWithVersion.mockImplementation(
                async (_id: any, entity: any) => ({ ...entity, version: 5 }),
            );

            const result = await service.update('pipeline-1', { name: 'Updated Pipeline', expectedVersion: 4 } as any);

            // BEHAVIORAL VERIFICATION on entity
            expect(existingPipeline.name).toBe('Updated Pipeline');
            expect(existingPipeline.hasChanges).toBe(true);

            // DTO VERIFICATION
            expect(result.name).toBe('Updated Pipeline');
            expect(result.version).toBe(5);

            // OCC contract — CAS write fires with the supplied expectedVersion,
            // legacy non-CAS write does NOT fire.
            expect(mockPipelineRepository.updateWithVersion).toHaveBeenCalledWith('pipeline-1', existingPipeline, 4);
            expect(mockPipelineRepository.update).not.toHaveBeenCalled();

            // Audit event carries both versions (matches C.8 / E.1 / E.2 / E.3).
            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'pipeline-1',
                    data: expect.objectContaining({
                        previousVersion: 4,
                        newVersion: 5,
                    }),
                }),
            );
        });

        it('should throw NotFoundException when pipeline does not exist', async () => {
            mockPipelineRepository.findById.mockResolvedValue(null);

            await expect(
                service.update('non-existent-id', { name: 'Updated', expectedVersion: 1 } as any)
            ).rejects.toThrow(NotFoundException);
        });

        it('should validate slug uniqueness when changing slug', async () => {
            const existingPipeline = createBehavioralPipelineEntity({
                id: 'pipeline-1',
                slug: 'original-slug',
            });
            mockPipelineRepository.findById.mockResolvedValue(existingPipeline);
            mockPipelineRepository.isSlugUnique.mockResolvedValue(false);

            await expect(
                service.update('pipeline-1', { slug: 'taken-slug', expectedVersion: 1 } as any)
            ).rejects.toThrow(BadRequestException);
        });

        it('should validate YAML when changing configYaml', async () => {
            const existingPipeline = createBehavioralPipelineEntity({ id: 'pipeline-1' });
            mockPipelineRepository.findById.mockResolvedValue(existingPipeline);

            await expect(
                service.update('pipeline-1', { configYaml: 'invalid yaml', expectedVersion: 1 } as any)
            ).rejects.toThrow(BadRequestException);
        });

        it('propagates OptimisticConcurrencyException from the repository CAS write (TASK-302 Stream D Phase E.4)', async () => {
            // The OptimisticConcurrencyException class lives in
            // `@arcaai/exceptions`; we import lazily to avoid pulling the
            // package into the module-level imports of this test file.
            const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
            const existingPipeline = createBehavioralPipelineEntity({ id: 'pipeline-1', version: 9 });
            mockPipelineRepository.findById.mockResolvedValue(existingPipeline);
            mockPipelineRepository.updateWithVersion.mockRejectedValue(
                new OptimisticConcurrencyException('AsrPipeline', 'pipeline-1', {
                    expectedVersion: 9,
                    currentVersion: 10,
                }),
            );

            await expect(
                service.update('pipeline-1', { name: 'Stale', expectedVersion: 9 } as any),
            ).rejects.toThrow(OptimisticConcurrencyException);

            // Audit MUST NOT broadcast on a failed CAS write — observers
            // would otherwise see updates that never landed.
            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.anything(),
            );
        });
    });

    describe('getById', () => {
        it('should return pipeline by ID', async () => {
            const pipeline = createBehavioralPipelineEntity({ id: 'pipeline-123' });
            mockPipelineRepository.findById.mockResolvedValue(pipeline);

            const result = await service.getById('pipeline-123');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('pipeline-123');
        });

        it('should return null when pipeline not found', async () => {
            mockPipelineRepository.findById.mockResolvedValue(null);
            const result = await service.getById('non-existent');
            expect(result).toBeNull();
        });

        // TASK-298 D-9 — tenant scoping.
        it('should return null when pipeline tenantId does not match caller tenant (D-9)', async () => {
            const otherTenantPipeline = createBehavioralPipelineEntity({
                id: 'pipeline-other',
                tenantId: 'tenant-other',
            });
            mockPipelineRepository.findById.mockResolvedValue(otherTenantPipeline);

            const result = await service.getById('pipeline-other');

            expect(result).toBeNull();
            // Cross-tenant lookups must NOT emit a "viewed" audit event for
            // the foreign resource — that would leak existence.
            expect(mockEventEmitter.emit).not.toHaveBeenCalledWith(
                SysEventType.ResourceViewed,
                expect.objectContaining({ resourceId: 'pipeline-other' }),
            );
        });

        it('should throw BadRequestException when tenant ID is missing (D-9)', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(service.getById('pipeline-123')).rejects.toThrow(BadRequestException);
        });
    });

    describe('getBySlug', () => {
        it('should return pipeline by slug', async () => {
            const pipeline = createBehavioralPipelineEntity({ slug: 'my-pipeline' });
            mockPipelineRepository.findBySlug.mockResolvedValue(pipeline);

            const result = await service.getBySlug('my-pipeline');

            expect(result).not.toBeNull();
            expect(result!.slug).toBe('my-pipeline');
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(service.getBySlug('my-pipeline')).rejects.toThrow(BadRequestException);
        });

        it('should return null when pipeline not found', async () => {
            mockPipelineRepository.findBySlug.mockResolvedValue(null);
            const result = await service.getBySlug('non-existent');
            expect(result).toBeNull();
        });
    });

    describe('getAll', () => {
        it('should return all enabled pipelines', async () => {
            const pipelines = [
                createBehavioralPipelineEntity({ id: 'p1' }),
                createBehavioralPipelineEntity({ id: 'p2' }),
            ];
            mockPipelineRepository.findEnabledPipelines.mockResolvedValue(pipelines);

            const result = await service.getAll();

            expect(result).toHaveLength(2);
            expect(mockPipelineRepository.findEnabledPipelines).toHaveBeenCalledWith('tenant-1');
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(service.getAll()).rejects.toThrow(BadRequestException);
        });
    });

    describe('list', () => {
        it('should return paginated pipelines', async () => {
            const pipelines = [createBehavioralPipelineEntity({ id: 'p1' })];
            mockPipelineRepository.findAll.mockResolvedValue(pipelines);
            mockPipelineRepository.count.mockResolvedValue(1);

            const result = await service.list(1, 20);

            expect(result.data).toHaveLength(1);
            expect(result.total).toBe(1);
            expect(result.page).toBe(1);
            expect(result.limit).toBe(20);
            expect(result.totalPages).toBe(1);
        });

        it('should calculate correct total pages', async () => {
            mockPipelineRepository.findAll.mockResolvedValue([]);
            mockPipelineRepository.count.mockResolvedValue(45);

            const result = await service.list(1, 10);

            expect(result.totalPages).toBe(5);
        });
    });

    describe('delete', () => {
        it('should soft delete a pipeline and verify state changes', async () => {
            const pipeline = createBehavioralPipelineEntity({ id: 'pipeline-to-delete' });
            mockPipelineRepository.findById.mockResolvedValue(pipeline);
            mockPipelineRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.delete('pipeline-to-delete');

            // BEHAVIORAL VERIFICATION
            expect(pipeline.resourceStatus).toBe(ResourceStatusType.DELETED);
            expect(pipeline.isDeleted).toBe(true);
            expect(pipeline.isActive).toBe(false);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'pipeline-to-delete',
                })
            );
        });

        it('should throw NotFoundException when pipeline does not exist', async () => {
            mockPipelineRepository.findById.mockResolvedValue(null);

            await expect(service.delete('non-existent')).rejects.toThrow(NotFoundException);
        });
    });

    describe('validateYaml', () => {
        it('should return valid for correct YAML', async () => {
            const result = await service.validateYaml(validConfigYaml);

            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        it('should return invalid for empty YAML', async () => {
            const result = await service.validateYaml('');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('YAML configuration is empty');
        });

        it('should return invalid for YAML without models section', async () => {
            const result = await service.validateYaml(`
version: "1.0"
inference:
  batch_size: 16
`);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing required "models" section');
        });

        it('should return invalid for YAML without ASR model', async () => {
            const result = await service.validateYaml(`
version: "1.0"
models:
  vad: "silero-vad"
`);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing required ASR model reference (models.asr)');
        });

                it('should return valid when models.asr is an object with hf_model_id', async () => {
                        const result = await service.validateYaml(`
version: "1.1"
models:
    asr:
        hf_model_id: openai/whisper-large-v3
        engine: safetensor
    vad:
        hf_model_id: snakers4/silero-vad
        engine: onnx
`);

                        expect(result.valid).toBe(true);
                        expect(result.errors).toBeUndefined();
                });

                it('should return invalid when models.asr object has no model reference', async () => {
                        const result = await service.validateYaml(`
version: "1.1"
models:
    asr:
        hf_model_id: ""
        engine: safetensor
`);

                        expect(result.valid).toBe(false);
                        expect(result.errors).toContain('Missing required ASR model reference (models.asr)');
                });
    });

    describe('pipeline lifecycle integration', () => {
        it('should handle complete pipeline lifecycle: create -> update -> delete', async () => {
            // Create
            mockPipelineRepository.isSlugUnique.mockResolvedValue(true);
            let pipeline: any;
            mockPipelineRepository.create.mockImplementation(async (entity: any) => {
                pipeline = entity;
                return entity;
            });

            await service.create({
                name: 'Lifecycle Pipeline',
                slug: 'lifecycle-pipeline',
                configYaml: validConfigYaml,
            });

            // Use behavioral mock for subsequent operations
            pipeline = createBehavioralPipelineEntity({ id: pipeline.id, version: 1 });
            mockPipelineRepository.findById.mockResolvedValue(pipeline);
            // TASK-302 Stream D Phase E.4 — `update()` writes via CAS;
            // `delete()` still uses the legacy non-versioned `update()`.
            // Set BOTH so the lifecycle test exercises the full path.
            mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: any, entity: any) => entity);
            mockPipelineRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            // Update — CAS write with expectedVersion=1
            await service.update(pipeline.id, { name: 'Updated Pipeline', expectedVersion: 1 } as any);
            expect(pipeline.name).toBe('Updated Pipeline');
            expect(pipeline.hasChanges).toBe(true);

            // Delete
            await service.delete(pipeline.id);
            expect(pipeline.isDeleted).toBe(true);
        });
    });
});
