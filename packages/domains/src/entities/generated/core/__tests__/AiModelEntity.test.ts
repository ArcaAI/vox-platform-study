/**
 * AiModelEntity Unit Tests
 *
 * Tests for the AiModelEntity that handles AI model registry management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AiModelEntity, IAiModelEntity } from '../AiModelEntity';
import {
    AiModelSource,
    AiModelFormat,
    AiModelDownloadStatus,
    ModelCategory,
    ModelTaskType,
    ModelType,
    ResourceStatusType,
} from '../../../../enums';

// Factory function for creating test entities
function createTestEntity(overrides: Partial<IAiModelEntity> = {}): AiModelEntity {
    return new AiModelEntity({
        id: 'model-test-id',
        tenantId: 'tenant-123',
        name: 'Whisper Large V3',
        slug: 'whisper-large-v3',
        description: 'OpenAI Whisper Large V3 model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-large-v3',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3000,
        computeType: 'float16',
        downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
        localPath: null,
        downloadedAt: null,
        fileSizeMb: null,
        checksum: null,
        createdBy: 'user-123',
        updatedBy: null,
        createdAt: new Date('2026-02-02T10:00:00Z'),
        updatedAt: new Date('2026-02-02T10:00:00Z'),
        resourceStatus: ResourceStatusType.ENABLED,
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        metaData: null,
        version: 1,
        tags: ['whisper', 'asr', 'openai'],
        ...overrides,
    });
}

describe('AiModelEntity', () => {
    describe('constructor', () => {
        it('should initialize with provided values', () => {
            const entity = createTestEntity();

            expect(entity.id).toBe('model-test-id');
            expect(entity.name).toBe('Whisper Large V3');
            expect(entity.slug).toBe('whisper-large-v3');
            expect(entity.category).toBe(ModelCategory.AUDIO);
            expect(entity.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
            expect(entity.source).toBe(AiModelSource.HUGGINGFACE);
            expect(entity.format).toBe(AiModelFormat.SAFETENSOR);
            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.NOT_DOWNLOADED);
        });
    });

    describe('download status helpers', () => {
        it('isDownloaded should return true only for DOWNLOADED status', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOADED });
            expect(entity.isDownloaded).toBe(true);
            expect(entity.isDownloading).toBe(false);
            expect(entity.isDownloadFailed).toBe(false);
            expect(entity.isNotDownloaded).toBe(false);
        });

        it('isDownloading should return true only for DOWNLOADING status', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOADING });
            expect(entity.isDownloading).toBe(true);
            expect(entity.isDownloaded).toBe(false);
        });

        it('isDownloadFailed should return true only for DOWNLOAD_FAILED status', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOAD_FAILED });
            expect(entity.isDownloadFailed).toBe(true);
            expect(entity.isDownloaded).toBe(false);
        });

        it('isNotDownloaded should return true only for NOT_DOWNLOADED status', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED });
            expect(entity.isNotDownloaded).toBe(true);
            expect(entity.isDownloaded).toBe(false);
        });
    });

    describe('task type helpers', () => {
        it('isASR should return true for AUTOMATIC_SPEECH_RECOGNITION task type', () => {
            const entity = createTestEntity({ taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION });
            expect(entity.isASR).toBe(true);
            expect(entity.isVAD).toBe(false);
            expect(entity.isTTS).toBe(false);
        });

        it('isVAD should return true for VOICE_ACTIVITY_DETECTION task type', () => {
            const entity = createTestEntity({ taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION });
            expect(entity.isVAD).toBe(true);
            expect(entity.isASR).toBe(false);
        });

        it('isTTS should return true for TEXT_TO_SPEECH task type', () => {
            const entity = createTestEntity({ taskType: ModelTaskType.TEXT_TO_SPEECH });
            expect(entity.isTTS).toBe(true);
            expect(entity.isASR).toBe(false);
        });

        it('isAudioModel should return true for AUDIO category', () => {
            const entity = createTestEntity({ category: ModelCategory.AUDIO });
            expect(entity.isAudioModel).toBe(true);
        });

        it('isAudioModel should return false for non-AUDIO category', () => {
            const entity = createTestEntity({ category: ModelCategory.NLP });
            expect(entity.isAudioModel).toBe(false);
        });
    });

    describe('source helpers', () => {
        it('isHuggingFace should return true for HUGGINGFACE source', () => {
            const entity = createTestEntity({ source: AiModelSource.HUGGINGFACE });
            expect(entity.isHuggingFace).toBe(true);
            expect(entity.isMLFlow).toBe(false);
        });

        it('isMLFlow should return true for MLFLOW source', () => {
            const entity = createTestEntity({ source: AiModelSource.MLFLOW });
            expect(entity.isMLFlow).toBe(true);
            expect(entity.isHuggingFace).toBe(false);
        });
    });

    describe('markAsDownloading', () => {
        it('should set download status to DOWNLOADING', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED });

            entity.markAsDownloading('user-456');

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADING);
            expect(entity.hasChanges).toBe(true);
            expect(entity.changes).toHaveProperty('downloadStatus', AiModelDownloadStatus.DOWNLOADING);
            expect(entity.changes).toHaveProperty('updatedBy', 'user-456');
        });

        it('should work without userId', () => {
            const entity = createTestEntity();

            entity.markAsDownloading();

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADING);
        });
    });

    describe('markAsDownloaded', () => {
        it('should set download status to DOWNLOADED with all details', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOADING });

            entity.markAsDownloaded('/models/whisper-large-v3', 3000, 'sha256-abc123', 'user-456');

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADED);
            expect(entity.localPath).toBe('/models/whisper-large-v3');
            expect(entity.fileSizeMb).toBe(3000);
            expect(entity.checksum).toBe('sha256-abc123');
            expect(entity.downloadedAt).not.toBeNull();
            expect(entity.changes).toHaveProperty('updatedBy', 'user-456');
        });

        it('should work with only required parameters', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOADING });

            entity.markAsDownloaded('/models/whisper-large-v3');

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADED);
            expect(entity.localPath).toBe('/models/whisper-large-v3');
            expect(entity.downloadedAt).not.toBeNull();
        });
    });

    describe('markAsDownloadFailed', () => {
        it('should set download status to DOWNLOAD_FAILED', () => {
            const entity = createTestEntity({ downloadStatus: AiModelDownloadStatus.DOWNLOADING });

            entity.markAsDownloadFailed('user-456');

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOAD_FAILED);
            expect(entity.hasChanges).toBe(true);
            expect(entity.changes).toHaveProperty('updatedBy', 'user-456');
        });
    });

    describe('resetDownloadStatus', () => {
        it('should reset all download-related fields', () => {
            const entity = createTestEntity({
                downloadStatus: AiModelDownloadStatus.DOWNLOADED,
                localPath: '/models/whisper',
                downloadedAt: new Date(),
                fileSizeMb: 3000,
                checksum: 'sha256-abc',
            });

            entity.resetDownloadStatus('user-456');

            expect(entity.downloadStatus).toBe(AiModelDownloadStatus.NOT_DOWNLOADED);
            expect(entity.localPath).toBeNull();
            expect(entity.downloadedAt).toBeNull();
            expect(entity.fileSizeMb).toBeNull();
            expect(entity.checksum).toBeNull();
            expect(entity.changes).toHaveProperty('updatedBy', 'user-456');
        });
    });

    describe('validate', () => {
        it('should pass validation for valid entity', () => {
            const entity = createTestEntity();

            expect(() => entity.validate()).not.toThrow();
        });

        it('should throw error when name is empty', () => {
            const entity = createTestEntity({ name: '' });

            expect(() => entity.validate()).toThrow('Model name is required');
        });

        it('should throw error when name is whitespace', () => {
            const entity = createTestEntity({ name: '   ' });

            expect(() => entity.validate()).toThrow('Model name is required');
        });

        it('should throw error when slug is empty', () => {
            const entity = createTestEntity({ slug: '' });

            expect(() => entity.validate()).toThrow('Model slug is required');
        });

        it('should throw error when sourceUri is empty', () => {
            const entity = createTestEntity({ sourceUri: '' });

            expect(() => entity.validate()).toThrow('Model source URI is required');
        });

        describe('slug format validation', () => {
            it('should accept valid slugs', () => {
                const validSlugs = [
                    'whisper-large-v3',
                    'silero-vad-v4',
                    'a',
                    'ab',
                    'model123',
                    '123model',
                    'a1b2c3',
                ];

                validSlugs.forEach((slug) => {
                    const entity = createTestEntity({ slug });
                    expect(() => entity.validate()).not.toThrow();
                });
            });

            it('should reject slugs with uppercase letters', () => {
                const entity = createTestEntity({ slug: 'Whisper-Large-V3' });

                expect(() => entity.validate()).toThrow(
                    'Model slug must be lowercase alphanumeric with hyphens'
                );
            });

            it('should reject slugs with special characters', () => {
                const entity = createTestEntity({ slug: 'whisper_large_v3' });

                expect(() => entity.validate()).toThrow(
                    'Model slug must be lowercase alphanumeric with hyphens'
                );
            });

            it('should reject slugs starting with hyphen', () => {
                const entity = createTestEntity({ slug: '-whisper' });

                expect(() => entity.validate()).toThrow(
                    'Model slug must be lowercase alphanumeric with hyphens'
                );
            });

            it('should reject slugs ending with hyphen', () => {
                const entity = createTestEntity({ slug: 'whisper-' });

                expect(() => entity.validate()).toThrow(
                    'Model slug must be lowercase alphanumeric with hyphens'
                );
            });
        });
    });

    describe('change tracking', () => {
        it('should track changes when properties are modified', () => {
            const entity = createTestEntity();

            entity.name = 'Updated Model Name';

            expect(entity.hasChanges).toBe(true);
            expect(entity.changes).toHaveProperty('name', 'Updated Model Name');
        });

        it('should not track changes when value is the same', () => {
            const entity = createTestEntity({ name: 'Same Name' });

            entity.name = 'Same Name';

            expect(entity.hasChanges).toBe(false);
        });

        it('should track multiple changes', () => {
            const entity = createTestEntity();

            entity.name = 'New Name';
            entity.description = 'New Description';
            entity.memorySizeMb = 4000;

            expect(entity.changes).toEqual(expect.objectContaining({
                name: 'New Name',
                description: 'New Description',
                memorySizeMb: 4000,
            }));
        });
    });

    describe('model download lifecycle', () => {
        it('should handle complete download lifecycle', () => {
            const entity = createTestEntity({
                downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
            });

            expect(entity.isNotDownloaded).toBe(true);

            // Start download
            entity.markAsDownloading('user-123');
            expect(entity.isDownloading).toBe(true);

            // Complete download
            entity.markAsDownloaded('/models/whisper', 3000, 'sha256-xyz');
            expect(entity.isDownloaded).toBe(true);
            expect(entity.localPath).toBe('/models/whisper');

            // Reset for re-download
            entity.resetDownloadStatus();
            expect(entity.isNotDownloaded).toBe(true);
            expect(entity.localPath).toBeNull();
        });

        it('should handle failed download with retry', () => {
            const entity = createTestEntity({
                downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
            });

            // Start download
            entity.markAsDownloading();
            expect(entity.isDownloading).toBe(true);

            // Download fails
            entity.markAsDownloadFailed();
            expect(entity.isDownloadFailed).toBe(true);

            // Reset and retry
            entity.resetDownloadStatus();
            expect(entity.isNotDownloaded).toBe(true);

            // Try again
            entity.markAsDownloading();
            entity.markAsDownloaded('/models/whisper', 3000);
            expect(entity.isDownloaded).toBe(true);
        });
    });

    describe('tags support', () => {
        it('should have tags array', () => {
            const entity = createTestEntity({ tags: ['whisper', 'asr', 'openai'] });

            expect(entity.tags).toEqual(['whisper', 'asr', 'openai']);
        });

        it('should default to empty tags array', () => {
            const entity = createTestEntity({ tags: [] });

            expect(entity.tags).toEqual([]);
        });
    });
});
