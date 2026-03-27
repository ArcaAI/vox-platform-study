/**
 * AsrPipelineEntity Unit Tests
 *
 * Tests for the AsrPipelineEntity that handles ASR pipeline configuration management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AsrPipelineEntity, IAsrPipelineEntity } from '../AsrPipelineEntity';
import { ResourceStatusType } from '../../../../enums';

// Sample YAML configs for testing
const validConfigYaml = `
version: "1.0"

models:
  asr: "whisper-large-v3"
  vad: "silero-vad-v4"
  denoise: "deepfilternet-v3"

preprocessing:
  vad:
    enabled: true
    threshold: 0.5
  noise_reduction:
    enabled: true
  audio:
    sample_rate: 16000
    channels: 1

inference:
  batch_size: 16
  compute_type: float16
  device: auto
`;

const minimalConfigYaml = `
version: "1.0"

models:
  asr: "whisper-tiny"

inference:
  batch_size: 8
`;

const configWithoutOptionalModels = `
version: "1.0"

models:
  asr: "whisper-base"
`;

// Factory function for creating test entities
function createTestEntity(overrides: Partial<IAsrPipelineEntity> = {}): AsrPipelineEntity {
  return new AsrPipelineEntity({
    id: 'pipeline-test-id',
    tenantId: 'tenant-123',
    name: 'Medical Transcription Pipeline',
    slug: 'medical-transcription',
    description: 'Pipeline for medical consultation transcription',
    configYaml: validConfigYaml,
    createdBy: 'user-123',
    updatedBy: null,
    createdAt: new Date('2026-02-02T10:00:00Z'),
    updatedAt: new Date('2026-02-02T10:00:00Z'),
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: null,
    version: 1,
    tags: ['medical', 'transcription'],
    ...overrides,
  });
}

describe('AsrPipelineEntity', () => {
  describe('constructor', () => {
    it('should initialize with provided values', () => {
      const entity = createTestEntity();

      expect(entity.id).toBe('pipeline-test-id');
      expect(entity.name).toBe('Medical Transcription Pipeline');
      expect(entity.slug).toBe('medical-transcription');
      expect(entity.description).toBe('Pipeline for medical consultation transcription');
      expect(entity.configYaml).toBe(validConfigYaml);
      expect(entity.tenantId).toBe('tenant-123');
    });
  });

  describe('isActive', () => {
    it('should return true when pipeline is ENABLED', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });
      expect(entity.isActive).toBe(true);
    });

    it('should return false when pipeline is DISABLED', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.DISABLED });
      expect(entity.isActive).toBe(false);
    });

    it('should return false when pipeline is ARCHIVED', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ARCHIVED });
      expect(entity.isActive).toBe(false);
    });
  });

  describe('jobCount', () => {
    it('should return 0 when no jobs are associated', () => {
      const entity = createTestEntity({ TranscriptionJobs: null });
      expect(entity.jobCount).toBe(0);
    });

    it('should return 0 when jobs array is undefined', () => {
      const entity = createTestEntity({ TranscriptionJobs: undefined });
      expect(entity.jobCount).toBe(0);
    });

    it('should return correct count when jobs are associated', () => {
      const entity = createTestEntity({
        TranscriptionJobs: [{} as any, {} as any, {} as any],
      });
      expect(entity.jobCount).toBe(3);
    });
  });

  describe('getModelSlugs', () => {
    it('should extract all model slugs from YAML config', () => {
      const entity = createTestEntity({ configYaml: validConfigYaml });

      const slugs = entity.getModelSlugs();

      expect(slugs).toContain('whisper-large-v3');
      expect(slugs).toContain('silero-vad-v4');
      expect(slugs).toContain('deepfilternet-v3');
      expect(slugs).toHaveLength(3);
    });

    it('should extract only ASR model when VAD and denoise are not configured', () => {
      const entity = createTestEntity({ configYaml: configWithoutOptionalModels });

      const slugs = entity.getModelSlugs();

      expect(slugs).toContain('whisper-base');
      expect(slugs).toHaveLength(1);
    });

    it('should return empty array for config without model section', () => {
      const entity = createTestEntity({
        configYaml: `
version: "1.0"
inference:
  batch_size: 8
`,
      });

      const slugs = entity.getModelSlugs();

      expect(slugs).toHaveLength(0);
    });
  });

  describe('getAsrModelSlug', () => {
    it('should return ASR model slug', () => {
      const entity = createTestEntity({ configYaml: validConfigYaml });

      const slug = entity.getAsrModelSlug();

      expect(slug).toBe('whisper-large-v3');
    });

    it('should return null when ASR model is not configured', () => {
      const entity = createTestEntity({
        configYaml: `
version: "1.0"
models:
  vad: "silero-vad"
`,
      });

      const slug = entity.getAsrModelSlug();

      expect(slug).toBeNull();
    });
  });

  describe('getVadModelSlug', () => {
    it('should return VAD model slug', () => {
      const entity = createTestEntity({ configYaml: validConfigYaml });

      const slug = entity.getVadModelSlug();

      expect(slug).toBe('silero-vad-v4');
    });

    it('should return null when VAD model is not configured', () => {
      const entity = createTestEntity({ configYaml: minimalConfigYaml });

      const slug = entity.getVadModelSlug();

      expect(slug).toBeNull();
    });
  });

  describe('getDenoiseModelSlug', () => {
    it('should return denoise model slug', () => {
      const entity = createTestEntity({ configYaml: validConfigYaml });

      const slug = entity.getDenoiseModelSlug();

      expect(slug).toBe('deepfilternet-v3');
    });

    it('should return null when denoise model is not configured', () => {
      const entity = createTestEntity({ configYaml: minimalConfigYaml });

      const slug = entity.getDenoiseModelSlug();

      expect(slug).toBeNull();
    });
  });

  describe('validate', () => {
    it('should pass validation for valid entity', () => {
      const entity = createTestEntity();

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw error when name is empty', () => {
      const entity = createTestEntity({ name: '' });

      expect(() => entity.validate()).toThrow('Pipeline name is required');
    });

    it('should throw error when name is whitespace', () => {
      const entity = createTestEntity({ name: '   ' });

      expect(() => entity.validate()).toThrow('Pipeline name is required');
    });

    it('should throw error when slug is empty', () => {
      const entity = createTestEntity({ slug: '' });

      expect(() => entity.validate()).toThrow('Pipeline slug is required');
    });

    it('should throw error when configYaml is empty', () => {
      const entity = createTestEntity({ configYaml: '' });

      expect(() => entity.validate()).toThrow('Pipeline config YAML is required');
    });

    it('should throw error when configYaml is whitespace', () => {
      const entity = createTestEntity({ configYaml: '   ' });

      expect(() => entity.validate()).toThrow('Pipeline config YAML is required');
    });

    describe('slug format validation', () => {
      it('should accept valid slugs', () => {
        const validSlugs = ['medical-transcription', 'default-pipeline', 'a', 'ab', 'pipeline123', '123pipeline'];

        validSlugs.forEach((slug) => {
          const entity = createTestEntity({ slug });
          expect(() => entity.validate()).not.toThrow();
        });
      });

      it('should reject slugs with uppercase letters', () => {
        const entity = createTestEntity({ slug: 'Medical-Transcription' });

        expect(() => entity.validate()).toThrow('Pipeline slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs with special characters', () => {
        const entity = createTestEntity({ slug: 'medical_transcription' });

        expect(() => entity.validate()).toThrow('Pipeline slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs starting with hyphen', () => {
        const entity = createTestEntity({ slug: '-medical' });

        expect(() => entity.validate()).toThrow('Pipeline slug must be lowercase alphanumeric with hyphens');
      });

      it('should reject slugs ending with hyphen', () => {
        const entity = createTestEntity({ slug: 'medical-' });

        expect(() => entity.validate()).toThrow('Pipeline slug must be lowercase alphanumeric with hyphens');
      });
    });
  });

  describe('change tracking', () => {
    it('should track changes when properties are modified', () => {
      const entity = createTestEntity();

      entity.name = 'Updated Pipeline Name';

      expect(entity.hasChanges).toBe(true);
      expect(entity.changes).toHaveProperty('name', 'Updated Pipeline Name');
    });

    it('should not track changes when value is the same', () => {
      const entity = createTestEntity({ name: 'Same Name' });

      entity.name = 'Same Name';

      expect(entity.hasChanges).toBe(false);
    });

    it('should track configYaml changes', () => {
      const entity = createTestEntity();

      entity.configYaml = minimalConfigYaml;

      expect(entity.hasChanges).toBe(true);
      expect(entity.changes).toHaveProperty('configYaml', minimalConfigYaml);
    });

    it('should track multiple changes', () => {
      const entity = createTestEntity();

      entity.name = 'New Name';
      entity.description = 'New Description';
      entity.configYaml = minimalConfigYaml;

      expect(entity.changes).toEqual(
        expect.objectContaining({
          name: 'New Name',
          description: 'New Description',
          configYaml: minimalConfigYaml,
        }),
      );
    });

    it('should clear changes', () => {
      const entity = createTestEntity();
      entity.name = 'Changed';

      expect(entity.hasChanges).toBe(true);

      entity.clearChanges();

      expect(entity.hasChanges).toBe(false);
      expect(entity.changes).toEqual({});
    });
  });

  describe('resource status management', () => {
    it('should enable pipeline', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.DISABLED });

      entity.enable('user-456');

      expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(entity.isActive).toBe(true);
    });

    it('should disable pipeline', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

      entity.disable('user-456');

      expect(entity.resourceStatus).toBe(ResourceStatusType.DISABLED);
      expect(entity.isActive).toBe(false);
    });

    it('should archive pipeline', () => {
      const entity = createTestEntity();

      entity.archive('user-456');

      expect(entity.resourceStatus).toBe(ResourceStatusType.ARCHIVED);
      expect(entity.isActive).toBe(false);
    });

    it('should soft delete pipeline', () => {
      const entity = createTestEntity();

      entity.delete('user-456');

      expect(entity.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(entity.isDeleted).toBe(true);
    });
  });

  describe('tags support', () => {
    it('should have tags array', () => {
      const entity = createTestEntity({ tags: ['medical', 'transcription'] });

      expect(entity.tags).toEqual(['medical', 'transcription']);
    });

    it('should default to empty tags array', () => {
      const entity = createTestEntity({ tags: [] });

      expect(entity.tags).toEqual([]);
    });
  });

  describe('model slug extraction edge cases', () => {
    it('should handle single-quoted model slugs', () => {
      const entity = createTestEntity({
        configYaml: `
models:
  asr: 'whisper-single-quoted'
`,
      });

      expect(entity.getAsrModelSlug()).toBe('whisper-single-quoted');
    });

    it('should handle double-quoted model slugs', () => {
      const entity = createTestEntity({
        configYaml: `
models:
  asr: "whisper-double-quoted"
`,
      });

      expect(entity.getAsrModelSlug()).toBe('whisper-double-quoted');
    });

    it('should handle model slugs with numbers', () => {
      const entity = createTestEntity({
        configYaml: `
models:
  asr: "whisper-large-v3"
  vad: "silero-vad-v4"
`,
      });

      const slugs = entity.getModelSlugs();

      expect(slugs).toContain('whisper-large-v3');
      expect(slugs).toContain('silero-vad-v4');
    });
  });
});
