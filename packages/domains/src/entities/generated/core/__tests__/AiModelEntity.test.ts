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
  AiModelAvailability,
  AiDeploymentKind,
  AiTaskKind,
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
    libraryName: 'transformers',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    gated: false,
    languages: [],
    availability: AiModelAvailability.UNKNOWN,
    isPlatformDefaultFor: [],
    memorySizeMb: 3000,
    computeType: 'float16',
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
        const validSlugs = ['whisper-large-v3', 'silero-vad-v4', 'a', 'ab', 'model123', '123model', 'a1b2c3', 'arcaai-whisper-large-ml-en-gguf-q8_0', 'whisper_large_v3'];

        validSlugs.forEach((slug) => {
          const entity = createTestEntity({ slug });
          expect(() => entity.validate()).not.toThrow();
        });
      });

      it('should reject slugs with uppercase letters', () => {
        const entity = createTestEntity({ slug: 'Whisper-Large-V3' });

        expect(() => entity.validate()).toThrow('Model slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs with special characters', () => {
        const entity = createTestEntity({ slug: 'whisper.large/v3' });

        expect(() => entity.validate()).toThrow('Model slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs starting with hyphen', () => {
        const entity = createTestEntity({ slug: '-whisper' });

        expect(() => entity.validate()).toThrow('Model slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs ending with hyphen', () => {
        const entity = createTestEntity({ slug: 'whisper-' });

        expect(() => entity.validate()).toThrow('Model slug must be lowercase alphanumeric with hyphens');
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

      expect(entity.changes).toEqual(
        expect.objectContaining({
          name: 'New Name',
          description: 'New Description',
          memorySizeMb: 4000,
        }),
      );
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

  // ==========================================================================
  // TASK-860 — registry fields (HF taxonomy, bucket identity, availability)
  // ==========================================================================
  describe('registry fields (TASK-860)', () => {
    it('round-trips libraryName / servedBy / deploymentKind / card metadata / bucket identity', () => {
      const entity = createTestEntity({
        libraryName: 'whisper.cpp',
        servedBy: 'stt',
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        wireModelId: null,
        license: 'apache-2.0',
        gated: true,
        baseModel: 'openai/whisper-large-v3-turbo',
        languages: ['ml', 'en'],
        hfRevision: 'abc123',
        bucketPrefix: 'arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/',
        primaryObject: 'ggml-model-f16.bin',
        manifestDigest: 'deadbeef',
        availability: AiModelAvailability.AVAILABLE,
        isPlatformDefaultFor: [AiTaskKind.SPEECH_TO_TEXT],
      });

      expect(entity.libraryName).toBe('whisper.cpp');
      expect(entity.servedBy).toBe('stt');
      expect(entity.deploymentKind).toBe(AiDeploymentKind.SELF_HOSTED);
      expect(entity.license).toBe('apache-2.0');
      expect(entity.gated).toBe(true);
      expect(entity.baseModel).toBe('openai/whisper-large-v3-turbo');
      expect(entity.languages).toEqual(['ml', 'en']);
      expect(entity.hfRevision).toBe('abc123');
      expect(entity.bucketPrefix).toBe('arcaai-whisper-large-ml-en-gguf/f16-0123456789ab/');
      expect(entity.primaryObject).toBe('ggml-model-f16.bin');
      expect(entity.manifestDigest).toBe('deadbeef');
      expect(entity.availability).toBe(AiModelAvailability.AVAILABLE);
      expect(entity.isPlatformDefaultFor).toEqual([AiTaskKind.SPEECH_TO_TEXT]);
    });

    it('isCloud reflects deploymentKind, not the deprecated format pseudo-values', () => {
      expect(createTestEntity({ deploymentKind: AiDeploymentKind.CLOUD, format: AiModelFormat.SAFETENSOR }).isCloud).toBe(true);
      expect(createTestEntity({ deploymentKind: AiDeploymentKind.SELF_HOSTED, format: AiModelFormat.AZURE_SPEECH }).isCloud).toBe(false);
    });

    it('markAvailability stamps availability + checkedAt + detail through change tracking', () => {
      const entity = createTestEntity();
      const checkedAt = new Date('2026-09-04T10:00:00Z');

      entity.markAvailability(AiModelAvailability.MISSING, { reason: 'manifest.json absent' }, checkedAt);

      expect(entity.availability).toBe(AiModelAvailability.MISSING);
      expect(entity.availabilityCheckedAt).toBe(checkedAt);
      expect(entity.availabilityDetail).toEqual({ reason: 'manifest.json absent' });
      expect(entity.changes).toHaveProperty('availability', AiModelAvailability.MISSING);
      expect(entity.changes).toHaveProperty('availabilityCheckedAt', checkedAt);
    });

    it('recordPublish writes the bucket IDENTITY and the MEASURED availability, and nothing else (TASK-890 §3.11)', () => {
      const entity = createTestEntity();

      entity.recordPublish({
        bucketPrefix: 'medical-ner/0123456789ab/',
        primaryObject: 'model.safetensors',
        manifestDigest: 'cafe',
        checksum: 'sha',
        hfRevision: 'rev1',
        userId: 'user-9',
      });

      expect(entity.bucketPrefix).toBe('medical-ner/0123456789ab/');
      expect(entity.primaryObject).toBe('model.safetensors');
      expect(entity.manifestDigest).toBe('cafe');
      expect(entity.hfRevision).toBe('rev1');
      expect(entity.availability).toBe(AiModelAvailability.AVAILABLE);
      expect(entity.availabilityCheckedAt).toBeInstanceOf(Date);
      expect(entity.checksum).toBe('sha');
      expect(entity.changes).toHaveProperty('updatedBy', 'user-9');
      // The mount path is DERIVED from the identity above; no column carries it any more.
      expect(entity.changes).not.toHaveProperty('localPath');
    });

    it('setPlatformDefaultFor replaces the task list through change tracking', () => {
      const entity = createTestEntity({ isPlatformDefaultFor: [AiTaskKind.SPEECH_TO_TEXT] });

      entity.setPlatformDefaultFor([AiTaskKind.TEXT_GENERATION, AiTaskKind.TEXT_GENERATION], 'user-1');

      // De-duplicated; order preserved.
      expect(entity.isPlatformDefaultFor).toEqual([AiTaskKind.TEXT_GENERATION]);
      expect(entity.changes).toHaveProperty('isPlatformDefaultFor', [AiTaskKind.TEXT_GENERATION]);
      expect(entity.changes).toHaveProperty('updatedBy', 'user-1');
    });

    it('validate rejects an empty libraryName / servedBy and a CLOUD row without a wireModelId', () => {
      expect(() => createTestEntity({ libraryName: '' }).validate()).toThrow(/libraryName/);
      expect(() => createTestEntity({ servedBy: ' ' }).validate()).toThrow(/servedBy/);
      expect(() => createTestEntity({ deploymentKind: AiDeploymentKind.CLOUD, wireModelId: null }).validate()).toThrow(/wireModelId/);
      expect(() => createTestEntity({ deploymentKind: AiDeploymentKind.CLOUD, wireModelId: 'gpt-transcribe' }).validate()).not.toThrow();
    });
  });
});
