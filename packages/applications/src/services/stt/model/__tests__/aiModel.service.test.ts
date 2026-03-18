/**
 * AiModelService Unit Tests
 *
 * Tests for the AiModelService that handles AI model registry management.
 *
 * TESTING APPROACH:
 * - Uses behavioral mock entities that simulate real entity behavior
 * - Only mocks external boundaries: repositories (I/O) and event emitter (side effects)
 * - Verifies actual state changes through behavioral mocks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiModelService } from '../aiModel.service';

// Enum constants to avoid import issues
const AiModelDownloadStatus = {
    NOT_DOWNLOADED: 'NOT_DOWNLOADED',
    DOWNLOADING: 'DOWNLOADING',
    DOWNLOADED: 'DOWNLOADED',
    DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
} as const;

const AiModelSource = {
    HUGGINGFACE: 'HUGGINGFACE',
    MLFLOW: 'MLFLOW',
    GITHUB: 'GITHUB',
    LOCAL: 'LOCAL',
} as const;

const AiModelFormat = {
    SAFETENSOR: 'SAFETENSOR',
    PYTORCH: 'PYTORCH',
    ONNX: 'ONNX',
    NEMO: 'NEMO',
} as const;

const ModelCategory = {
    AUDIO: 'AUDIO',
    NLP: 'NLP',
    VISION: 'VISION',
} as const;

const ModelTaskType = {
    AUTOMATIC_SPEECH_RECOGNITION: 'AUTOMATIC_SPEECH_RECOGNITION',
    VOICE_ACTIVITY_DETECTION: 'VOICE_ACTIVITY_DETECTION',
    TEXT_TO_SPEECH: 'TEXT_TO_SPEECH',
} as const;

const ModelType = {
    BASE_MODEL: 'BASE_MODEL',
    FINETUNED_MODEL: 'FINETUNED_MODEL',
    QUANTIZED_MODEL: 'QUANTIZED_MODEL',
} as const;

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

// ============================================
// Behavioral Mock Entity Factory
// ============================================

/**
 * Creates a BEHAVIORAL mock AiModelEntity
 */
function createBehavioralModelEntity(overrides: {
    id?: string;
    tenantId?: string;
    name?: string;
    slug?: string;
    category?: string;
    taskType?: string;
    modelType?: string;
    source?: string;
    sourceUri?: string;
    format?: string;
    memorySizeMb?: number | null;
    computeType?: string | null;
    downloadStatus?: string;
    localPath?: string | null;
    downloadedAt?: Date | null;
    fileSizeMb?: number | null;
    checksum?: string | null;
    resourceStatus?: string;
    tags?: string[];
} = {}) {
    // Internal mutable state
    let _name = overrides.name ?? 'Whisper Large V3';
    let _slug = overrides.slug ?? 'whisper-large-v3';
    let _memorySizeMb = overrides.memorySizeMb ?? 3000;
    let _computeType = overrides.computeType ?? 'float16';
    let _downloadStatus = overrides.downloadStatus ?? AiModelDownloadStatus.NOT_DOWNLOADED;
    let _localPath = overrides.localPath ?? null;
    let _downloadedAt = overrides.downloadedAt ?? null;
    let _fileSizeMb = overrides.fileSizeMb ?? null;
    let _checksum = overrides.checksum ?? null;
    let _resourceStatus = overrides.resourceStatus ?? ResourceStatusType.ENABLED;
    const _changes: Record<string, any> = {};

    const entity = {
        id: overrides.id ?? 'model-id-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        category: overrides.category ?? ModelCategory.AUDIO,
        taskType: overrides.taskType ?? ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: overrides.modelType ?? ModelType.BASE_MODEL,
        source: overrides.source ?? AiModelSource.HUGGINGFACE,
        sourceUri: overrides.sourceUri ?? 'openai/whisper-large-v3',
        format: overrides.format ?? AiModelFormat.SAFETENSOR,
        tags: overrides.tags ?? ['whisper', 'asr'],

        // Getters for mutable state
        get name() { return _name; },
        set name(value: string) { _name = value; _changes.name = value; },
        get slug() { return _slug; },
        set slug(value: string) { _slug = value; _changes.slug = value; },
        get memorySizeMb() { return _memorySizeMb; },
        set memorySizeMb(value: number | null) { _memorySizeMb = value; _changes.memorySizeMb = value; },
        get computeType() { return _computeType; },
        set computeType(value: string | null) { _computeType = value; _changes.computeType = value; },
        get downloadStatus() { return _downloadStatus; },
        get localPath() { return _localPath; },
        get downloadedAt() { return _downloadedAt; },
        get fileSizeMb() { return _fileSizeMb; },
        get checksum() { return _checksum; },
        get resourceStatus() { return _resourceStatus; },
        get changes() { return _changes; },
        get hasChanges() { return Object.keys(_changes).length > 0; },

        // Status helpers
        get isDownloaded() { return _downloadStatus === AiModelDownloadStatus.DOWNLOADED; },
        get isDownloading() { return _downloadStatus === AiModelDownloadStatus.DOWNLOADING; },
        get isDownloadFailed() { return _downloadStatus === AiModelDownloadStatus.DOWNLOAD_FAILED; },
        get isNotDownloaded() { return _downloadStatus === AiModelDownloadStatus.NOT_DOWNLOADED; },
        get isASR() { return entity.taskType === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION; },
        get isVAD() { return entity.taskType === ModelTaskType.VOICE_ACTIVITY_DETECTION; },
        get isTTS() { return entity.taskType === ModelTaskType.TEXT_TO_SPEECH; },
        get isHuggingFace() { return entity.source === AiModelSource.HUGGINGFACE; },
        get isDeleted() { return _resourceStatus === ResourceStatusType.DELETED; },

        // BEHAVIORAL methods
        markAsDownloading(userId?: string) {
            _downloadStatus = AiModelDownloadStatus.DOWNLOADING;
            _changes.downloadStatus = _downloadStatus;
        },

        markAsDownloaded(localPath: string, fileSizeMb?: number, checksum?: string, userId?: string) {
            _downloadStatus = AiModelDownloadStatus.DOWNLOADED;
            _localPath = localPath;
            _downloadedAt = new Date();
            if (fileSizeMb !== undefined) _fileSizeMb = fileSizeMb;
            if (checksum) _checksum = checksum;
            _changes.downloadStatus = _downloadStatus;
            _changes.localPath = _localPath;
            _changes.downloadedAt = _downloadedAt;
        },

        markAsDownloadFailed(userId?: string) {
            _downloadStatus = AiModelDownloadStatus.DOWNLOAD_FAILED;
            _changes.downloadStatus = _downloadStatus;
        },

        resetDownloadStatus(userId?: string) {
            _downloadStatus = AiModelDownloadStatus.NOT_DOWNLOADED;
            _localPath = null;
            _downloadedAt = null;
            _fileSizeMb = null;
            _checksum = null;
            _changes.downloadStatus = _downloadStatus;
            _changes.localPath = _localPath;
        },

        delete(userId?: string) {
            _resourceStatus = ResourceStatusType.DELETED;
            _changes.resourceStatus = _resourceStatus;
        },

        toObject() {
            return {
                id: entity.id,
                tenantId: entity.tenantId,
                name: _name,
                slug: _slug,
                downloadStatus: _downloadStatus,
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

const mockModelRepository = {
    findById: vi.fn(),
    findBySlug: vi.fn(),
    findAll: vi.fn(),
    findEnabledModels: vi.fn(),
    findByTaskType: vi.fn(),
    findDownloadedModels: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    isSlugUnique: vi.fn(),
};

describe('AiModelService', () => {
    let service: AiModelService;

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

        service = new AiModelService(
            mockModelRepository as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('create', () => {
        it('should create a new model successfully', async () => {
            mockModelRepository.isSlugUnique.mockResolvedValue(true);
            mockModelRepository.create.mockImplementation(async (entity: any) => entity);

            const result = await service.create({
                name: 'Whisper Large V3',
                slug: 'whisper-large-v3',
                category: ModelCategory.AUDIO as any,
                taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION as any,
                modelType: ModelType.BASE_MODEL as any,
                source: AiModelSource.HUGGINGFACE as any,
                sourceUri: 'openai/whisper-large-v3',
                format: AiModelFormat.SAFETENSOR as any,
            });

            expect(result).toBeDefined();
            expect(mockModelRepository.isSlugUnique).toHaveBeenCalledWith('tenant-1', 'whisper-large-v3');
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
                    name: 'Test Model',
                    slug: 'test-model',
                    category: ModelCategory.AUDIO as any,
                    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION as any,
                    modelType: ModelType.BASE_MODEL as any,
                    source: AiModelSource.HUGGINGFACE as any,
                    sourceUri: 'test/model',
                    format: AiModelFormat.SAFETENSOR as any,
                })
            ).rejects.toThrow(BadRequestException);
        });

        it('should throw BadRequestException when slug already exists', async () => {
            mockModelRepository.isSlugUnique.mockResolvedValue(false);

            await expect(
                service.create({
                    name: 'Test Model',
                    slug: 'existing-slug',
                    category: ModelCategory.AUDIO as any,
                    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION as any,
                    modelType: ModelType.BASE_MODEL as any,
                    source: AiModelSource.HUGGINGFACE as any,
                    sourceUri: 'test/model',
                    format: AiModelFormat.SAFETENSOR as any,
                })
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('update', () => {
        it('should update an existing model and verify state changes', async () => {
            const existingModel = createBehavioralModelEntity({ id: 'model-1', name: 'Old Name' });
            mockModelRepository.findById.mockResolvedValue(existingModel);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            const result = await service.update('model-1', { name: 'Updated Model Name' });

            // BEHAVIORAL VERIFICATION on entity
            expect(existingModel.name).toBe('Updated Model Name');
            expect(existingModel.hasChanges).toBe(true);

            // DTO VERIFICATION
            expect(result.name).toBe('Updated Model Name');

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'model-1',
                })
            );
        });

        it('should throw NotFoundException when model does not exist', async () => {
            mockModelRepository.findById.mockResolvedValue(null);

            await expect(
                service.update('non-existent-id', { name: 'Updated' })
            ).rejects.toThrow(NotFoundException);
        });

        it('should validate slug uniqueness when changing slug', async () => {
            const existingModel = createBehavioralModelEntity({
                id: 'model-1',
                slug: 'original-slug',
            });
            mockModelRepository.findById.mockResolvedValue(existingModel);
            mockModelRepository.isSlugUnique.mockResolvedValue(false);

            await expect(
                service.update('model-1', { slug: 'taken-slug' })
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('getById', () => {
        it('should return model by ID', async () => {
            const model = createBehavioralModelEntity({ id: 'model-123' });
            mockModelRepository.findById.mockResolvedValue(model);

            const result = await service.getById('model-123');

            expect(result).not.toBeNull();
            expect(result!.id).toBe('model-123');
        });

        it('should return null when model not found', async () => {
            mockModelRepository.findById.mockResolvedValue(null);
            const result = await service.getById('non-existent');
            expect(result).toBeNull();
        });
    });

    describe('getBySlug', () => {
        it('should return model by slug', async () => {
            const model = createBehavioralModelEntity({ slug: 'whisper-large-v3' });
            mockModelRepository.findBySlug.mockResolvedValue(model);

            const result = await service.getBySlug('whisper-large-v3');

            expect(result).not.toBeNull();
            expect(result!.slug).toBe('whisper-large-v3');
        });

        it('should throw BadRequestException when tenant ID is missing', async () => {
            mockClsService.get.mockImplementation((key: string) => {
                if (key === 'tenantId') return null;
                return null;
            });

            await expect(service.getBySlug('whisper-large-v3')).rejects.toThrow(BadRequestException);
        });
    });

    describe('getAll', () => {
        it('should return all enabled models', async () => {
            const models = [
                createBehavioralModelEntity({ id: 'm1' }),
                createBehavioralModelEntity({ id: 'm2' }),
            ];
            mockModelRepository.findEnabledModels.mockResolvedValue(models);

            const result = await service.getAll();

            expect(result).toHaveLength(2);
            expect(mockModelRepository.findEnabledModels).toHaveBeenCalledWith('tenant-1');
        });
    });

    describe('list', () => {
        it('should return paginated models', async () => {
            const models = [createBehavioralModelEntity({ id: 'm1' })];
            mockModelRepository.findAll.mockResolvedValue(models);
            mockModelRepository.count.mockResolvedValue(1);

            const result = await service.list(1, 20);

            expect(result.data).toHaveLength(1);
            expect(result.total).toBe(1);
            expect(result.page).toBe(1);
        });
    });

    describe('getByTaskType', () => {
        it('should return models by task type', async () => {
            const asrModels = [
                createBehavioralModelEntity({ id: 'm1', taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION }),
            ];
            mockModelRepository.findByTaskType.mockResolvedValue(asrModels);

            const result = await service.getByTaskType(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION as any);

            expect(result).toHaveLength(1);
            expect(result[0].taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
        });
    });

    describe('getDownloadedModels', () => {
        it('should return downloaded models', async () => {
            const downloadedModels = [
                createBehavioralModelEntity({
                    id: 'm1',
                    downloadStatus: AiModelDownloadStatus.DOWNLOADED,
                    localPath: '/models/whisper',
                }),
            ];
            mockModelRepository.findDownloadedModels.mockResolvedValue(downloadedModels);

            const result = await service.getDownloadedModels();

            expect(result).toHaveLength(1);
            expect(result[0].downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADED);
        });
    });

    describe('updateDownloadStatus', () => {
        it('should mark model as downloading and verify state changes', async () => {
            const model = createBehavioralModelEntity({
                id: 'model-123',
                downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
            });
            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.updateDownloadStatus('model-123', AiModelDownloadStatus.DOWNLOADING as any);

            // BEHAVIORAL VERIFICATION
            expect(model.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADING);
            expect(model.isDownloading).toBe(true);
            expect(model.hasChanges).toBe(true);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceUpdated,
                expect.objectContaining({
                    resourceId: 'model-123',
                })
            );
        });

        it('should mark model as downloaded with all details', async () => {
            const model = createBehavioralModelEntity({
                id: 'model-123',
                downloadStatus: AiModelDownloadStatus.DOWNLOADING,
            });
            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.updateDownloadStatus(
                'model-123',
                AiModelDownloadStatus.DOWNLOADED as any,
                '/models/whisper',
                3000,
                'sha256-abc'
            );

            // BEHAVIORAL VERIFICATION
            expect(model.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADED);
            expect(model.isDownloaded).toBe(true);
            expect(model.localPath).toBe('/models/whisper');
            expect(model.downloadedAt).not.toBeNull();
        });

        it('should throw BadRequestException when DOWNLOADED status missing localPath', async () => {
            const model = createBehavioralModelEntity({ id: 'model-123' });
            mockModelRepository.findById.mockResolvedValue(model);

            await expect(
                service.updateDownloadStatus('model-123', AiModelDownloadStatus.DOWNLOADED as any)
            ).rejects.toThrow(BadRequestException);
        });

        it('should mark model as download failed', async () => {
            const model = createBehavioralModelEntity({
                id: 'model-123',
                downloadStatus: AiModelDownloadStatus.DOWNLOADING,
            });
            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.updateDownloadStatus('model-123', AiModelDownloadStatus.DOWNLOAD_FAILED as any);

            // BEHAVIORAL VERIFICATION
            expect(model.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOAD_FAILED);
            expect(model.isDownloadFailed).toBe(true);
        });

        it('should reset download status', async () => {
            const model = createBehavioralModelEntity({
                id: 'model-123',
                downloadStatus: AiModelDownloadStatus.DOWNLOADED,
                localPath: '/models/whisper',
            });
            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.updateDownloadStatus('model-123', AiModelDownloadStatus.NOT_DOWNLOADED as any);

            // BEHAVIORAL VERIFICATION
            expect(model.downloadStatus).toBe(AiModelDownloadStatus.NOT_DOWNLOADED);
            expect(model.isNotDownloaded).toBe(true);
            expect(model.localPath).toBeNull();
        });

        it('should throw NotFoundException when model does not exist', async () => {
            mockModelRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateDownloadStatus('non-existent', AiModelDownloadStatus.DOWNLOADING as any)
            ).rejects.toThrow(NotFoundException);
        });
    });

    describe('delete', () => {
        it('should soft delete a model and verify state changes', async () => {
            const model = createBehavioralModelEntity({ id: 'model-to-delete' });
            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            await service.delete('model-to-delete');

            // BEHAVIORAL VERIFICATION
            expect(model.resourceStatus).toBe(ResourceStatusType.DELETED);
            expect(model.isDeleted).toBe(true);

            expect(mockEventEmitter.emit).toHaveBeenCalledWith(
                SysEventType.ResourceDeleted,
                expect.objectContaining({
                    resourceId: 'model-to-delete',
                })
            );
        });

        it('should throw NotFoundException when model does not exist', async () => {
            mockModelRepository.findById.mockResolvedValue(null);

            await expect(service.delete('non-existent')).rejects.toThrow(NotFoundException);
        });
    });

    describe('model download lifecycle integration', () => {
        it('should handle complete download lifecycle', async () => {
            const model = createBehavioralModelEntity({
                id: 'model-123',
                downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
            });

            mockModelRepository.findById.mockResolvedValue(model);
            mockModelRepository.update.mockImplementation(async (_id: any, entity: any) => entity);

            // Step 1: Not downloaded
            expect(model.isNotDownloaded).toBe(true);

            // Step 2: Start download
            await service.updateDownloadStatus('model-123', AiModelDownloadStatus.DOWNLOADING as any);
            expect(model.isDownloading).toBe(true);

            // Step 3: Complete download
            await service.updateDownloadStatus(
                'model-123',
                AiModelDownloadStatus.DOWNLOADED as any,
                '/models/whisper-large-v3',
                3000,
                'sha256-xyz'
            );
            expect(model.isDownloaded).toBe(true);
            expect(model.localPath).toBe('/models/whisper-large-v3');
        });
    });
});
