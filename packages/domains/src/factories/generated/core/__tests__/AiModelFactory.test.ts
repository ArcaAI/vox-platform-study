/**
 * AiModelFactory Unit Tests
 *
 * Tests for the AiModelFactory that creates AiModel entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiModelFactory, CreateAiModelProps } from '../AiModelFactory';
import {
  AiModelSource,
  AiModelFormat,
  AiModelAvailability,
  AiDeploymentKind,
  ModelCategory,
  ModelTaskType,
  ModelType,
} from '../../../../enums';

// tenantId is now required at the factory layer.
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

// Mock the generateId function
vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('AiModelFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CreateAiModel', () => {
    const baseProps: CreateAiModelProps = {
      tenantId: TEST_TENANT_ID,
      name: 'Whisper Large V3',
      slug: 'whisper-large-v3',
      category: ModelCategory.AUDIO,
      taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
      modelType: ModelType.BASE_MODEL,
      source: AiModelSource.HUGGINGFACE,
      sourceUri: 'openai/whisper-large-v3',
      format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    };

    it('should create an AI model with required fields', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.id).toBe('generated-uuid-7');
      expect(model.name).toBe('Whisper Large V3');
      expect(model.slug).toBe('whisper-large-v3');
      expect(model.category).toBe(ModelCategory.AUDIO);
      expect(model.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
      expect(model.modelType).toBe(ModelType.BASE_MODEL);
      expect(model.source).toBe(AiModelSource.HUGGINGFACE);
      expect(model.sourceUri).toBe('openai/whisper-large-v3');
      expect(model.format).toBe(AiModelFormat.SAFETENSOR);
    });

    it('leaves the BYO provenance unset — a catalogue row is not declared by a connection', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.sourceConnectionId).toBeNull();
    });

    it('should set createdAt and updatedAt to current time', () => {
      const beforeCreate = new Date();
      const model = AiModelFactory.CreateAiModel(baseProps);
      const afterCreate = new Date();

      expect(model.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(model.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
      expect(model.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(model.updatedAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
    });

    it('should allow custom createdAt and updatedAt', () => {
      const customDate = new Date('2026-01-15T10:00:00Z');
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        createdAt: customDate,
        updatedAt: customDate,
      });

      expect(model.createdAt).toEqual(customDate);
      expect(model.updatedAt).toEqual(customDate);
    });

    it('should set optional description', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        description: 'OpenAI Whisper Large V3 model for speech recognition',
      });

      expect(model.description).toBe('OpenAI Whisper Large V3 model for speech recognition');
    });

    it('should default description to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.description).toBeNull();
    });

    it('should set optional sourceRevision', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        sourceRevision: 'v1.0.0',
      });

      expect(model.sourceRevision).toBe('v1.0.0');
    });

    it('should default sourceRevision to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.sourceRevision).toBeNull();
    });

    it('should set optional memorySizeMb', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        memorySizeMb: 3000,
      });

      expect(model.memorySizeMb).toBe(3000);
    });

    it('should default memorySizeMb to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.memorySizeMb).toBeNull();
    });

    it('should set optional computeType', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        computeType: 'float16',
      });

      expect(model.computeType).toBe('float16');
    });

    it('should default computeType to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.computeType).toBeNull();
    });

    it('should set optional tenantId', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        tenantId: 'tenant-123',
      });

      expect(model.tenantId).toBe('tenant-123');
    });

    it('should set optional tags', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        tags: ['whisper', 'asr', 'openai'],
      });

      expect(model.tags).toEqual(['whisper', 'asr', 'openai']);
    });

    it('should default tags to empty array', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.tags).toEqual([]);
    });

    it('should set createdBy when provided', () => {
      const model = AiModelFactory.CreateAiModel({
        ...baseProps,
        createdBy: 'user-123',
      });

      expect(model.createdBy).toBe('user-123');
    });

    it('should default createdBy to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.createdBy).toBeNull();
    });

    it('should initialize the verification checksum to null', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(model.checksum).toBeNull();
    });

    it('should create entity that passes validation', () => {
      const model = AiModelFactory.CreateAiModel(baseProps);

      expect(() => model.validate()).not.toThrow();
    });
  });

  describe('CreateAsrModel', () => {
    const asrProps = {
      tenantId: TEST_TENANT_ID,
      name: 'Whisper Tiny',
      slug: 'whisper-tiny',
      modelType: ModelType.BASE_MODEL,
      source: AiModelSource.HUGGINGFACE,
      sourceUri: 'openai/whisper-tiny',
      format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    };

    it('should create an ASR model with AUDIO category', () => {
      const model = AiModelFactory.CreateAsrModel(asrProps);

      expect(model.category).toBe(ModelCategory.AUDIO);
    });

    it('should create an ASR model with AUTOMATIC_SPEECH_RECOGNITION task type', () => {
      const model = AiModelFactory.CreateAsrModel(asrProps);

      expect(model.taskType).toBe(ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION);
    });

    it('should set isASR helper to true', () => {
      const model = AiModelFactory.CreateAsrModel(asrProps);

      expect(model.isASR).toBe(true);
      expect(model.isVAD).toBe(false);
      expect(model.isTTS).toBe(false);
    });

    it('should pass through all other properties', () => {
      const model = AiModelFactory.CreateAsrModel({
        ...asrProps,
        description: 'Tiny whisper model',
        memorySizeMb: 500,
        computeType: 'float32',
        tags: ['whisper', 'tiny'],
      });

      expect(model.name).toBe('Whisper Tiny');
      expect(model.description).toBe('Tiny whisper model');
      expect(model.memorySizeMb).toBe(500);
      expect(model.computeType).toBe('float32');
      expect(model.tags).toEqual(['whisper', 'tiny']);
    });
  });

  describe('CreateVadModel', () => {
    const vadProps = {
      tenantId: TEST_TENANT_ID,
      name: 'Silero VAD V4',
      slug: 'silero-vad-v4',
      modelType: ModelType.BASE_MODEL,
      source: AiModelSource.GITHUB,
      sourceUri: 'snakers4/silero-vad',
      format: AiModelFormat.PYTORCH,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    };

    it('should create a VAD model with AUDIO category', () => {
      const model = AiModelFactory.CreateVadModel(vadProps);

      expect(model.category).toBe(ModelCategory.AUDIO);
    });

    it('should create a VAD model with VOICE_ACTIVITY_DETECTION task type', () => {
      const model = AiModelFactory.CreateVadModel(vadProps);

      expect(model.taskType).toBe(ModelTaskType.VOICE_ACTIVITY_DETECTION);
    });

    it('should set isVAD helper to true', () => {
      const model = AiModelFactory.CreateVadModel(vadProps);

      expect(model.isVAD).toBe(true);
      expect(model.isASR).toBe(false);
      expect(model.isTTS).toBe(false);
    });

    it('should pass through all other properties', () => {
      const model = AiModelFactory.CreateVadModel({
        ...vadProps,
        description: 'Silero VAD model',
        memorySizeMb: 100,
        tags: ['vad', 'silero'],
      });

      expect(model.name).toBe('Silero VAD V4');
      expect(model.description).toBe('Silero VAD model');
      expect(model.memorySizeMb).toBe(100);
      expect(model.tags).toEqual(['vad', 'silero']);
    });
  });

  describe('GenerateSlug', () => {
    it('should convert name to lowercase', () => {
      const slug = AiModelFactory.GenerateSlug('Whisper Large V3');

      expect(slug).toBe('whisper-large-v3');
    });

    it('should replace spaces with hyphens', () => {
      const slug = AiModelFactory.GenerateSlug('my model name');

      expect(slug).toBe('my-model-name');
    });

    it('should remove special characters', () => {
      const slug = AiModelFactory.GenerateSlug('Model (v1.0) - Final!');

      expect(slug).toBe('model-v1-0-final');
    });

    it('should remove leading and trailing hyphens', () => {
      const slug = AiModelFactory.GenerateSlug('  Model Name  ');

      expect(slug).toBe('model-name');
    });

    it('should handle multiple consecutive special characters', () => {
      const slug = AiModelFactory.GenerateSlug('Model---Name___Test');

      expect(slug).toBe('model-name-test');
    });

    it('should preserve numbers', () => {
      const slug = AiModelFactory.GenerateSlug('Whisper Large V3 2024');

      expect(slug).toBe('whisper-large-v3-2024');
    });
  });

  describe('entity state after creation', () => {
    it('should create entity with no changes tracked', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'Test Model',
        slug: 'test-model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'test/model',
        format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });

      expect(model.hasChanges).toBe(false);
      expect(model.changes).toEqual({});
    });

  });

  describe('different model sources and formats', () => {
    it('should support HUGGINGFACE source', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'HF Model',
        slug: 'hf-model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'organization/model',
        format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });

      expect(model.isHuggingFace).toBe(true);
    });

    it('should support MLFLOW source', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'MLFlow Model',
        slug: 'mlflow-model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.FINETUNED_MODEL,
        source: AiModelSource.MLFLOW,
        sourceUri: 'models:/my-model/1',
        format: AiModelFormat.PYTORCH,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });

      expect(model.isMLFlow).toBe(true);
    });

    it('should support ONNX format', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'ONNX Model',
        slug: 'onnx-model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: '/models/model.onnx',
        format: AiModelFormat.ONNX,
        libraryName: 'transformers',
        servedBy: 'stt',
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });

      expect(model.format).toBe(AiModelFormat.ONNX);
    });

    it('should support NEMO format', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'NeMo Model',
        slug: 'nemo-model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'nvidia/stt_en_conformer',
        format: AiModelFormat.NEMO,
        libraryName: 'transformers',
        servedBy: 'stt',
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });

      expect(model.format).toBe(AiModelFormat.NEMO);
    });

    // Machine-actionable registry identity columns.
    it('should carry provider, architecture, and metaData when supplied', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'Gemma 4 E2B IT QAT',
        slug: 'lms-gemma-4-e2b-it-qat',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma-4-e2b-it-qat',
        format: AiModelFormat.GGUF,
        libraryName: 'transformers',
        servedBy: 'stt',
        deploymentKind: AiDeploymentKind.SELF_HOSTED,
        provider: 'lm-studio',
        architecture: 'gemma4',
        metaData: { voices: [{ id: 'en-female-1', locale: 'en-IN' }] },
      });

      expect(model.provider).toBe('lm-studio');
      expect(model.architecture).toBe('gemma4');
      expect(model.metaData).toEqual({ voices: [{ id: 'en-female-1', locale: 'en-IN' }] });
    });

    it('should default provider/architecture to null when omitted', () => {
      const model = AiModelFactory.CreateAiModel({
        tenantId: TEST_TENANT_ID,
        name: 'Whisper Large V3',
        slug: 'whisper-large-v3',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-large-v3',
        format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'stt',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
      });
      expect(model.provider).toBeNull();
      expect(model.architecture).toBeNull();
    });
  });

  // ==========================================================================
  // TASK-860 — registry defaults
  // ==========================================================================
  describe('registry defaults (TASK-860)', () => {
    const registryProps: CreateAiModelProps = {
      tenantId: TEST_TENANT_ID,
      name: 'Medical NER',
      slug: 'medical-ner',
      category: ModelCategory.NLP,
      taskType: ModelTaskType.TOKEN_CLASSIFICATION,
      modelType: ModelType.FINETUNED_MODEL,
      source: AiModelSource.HUGGINGFACE,
      sourceUri: 'blaze999/Medical-NER',
      format: AiModelFormat.SAFETENSOR,
      libraryName: 'transformers',
      servedBy: 'nlp',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    };

    it('carries libraryName / servedBy / deploymentKind and defaults the card + bucket fields', () => {
      const model = AiModelFactory.CreateAiModel(registryProps);

      expect(model.libraryName).toBe('transformers');
      expect(model.servedBy).toBe('nlp');
      expect(model.deploymentKind).toBe(AiDeploymentKind.SELF_HOSTED);
      expect(model.gated).toBe(false);
      expect(model.languages).toEqual([]);
      expect(model.isPlatformDefaultFor).toEqual([]);
      expect(model.wireModelId).toBeNull();
      expect(model.license).toBeNull();
      expect(model.baseModel).toBeNull();
      expect(model.hfRevision).toBeNull();
      expect(model.bucketPrefix).toBeNull();
      expect(model.primaryObject).toBeNull();
      expect(model.manifestDigest).toBeNull();
      expect(model.availabilityCheckedAt).toBeNull();
      expect(model.availabilityDetail).toBeNull();
    });

    it('starts a self-hosted row UNKNOWN and a cloud row NOT_APPLICABLE for availability', () => {
      expect(AiModelFactory.CreateAiModel(registryProps).availability).toBe(AiModelAvailability.UNKNOWN);
      const cloud = AiModelFactory.CreateAiModel({ ...registryProps, deploymentKind: AiDeploymentKind.CLOUD, wireModelId: 'gpt-transcribe' });
      expect(cloud.availability).toBe(AiModelAvailability.NOT_APPLICABLE);
      expect(cloud.wireModelId).toBe('gpt-transcribe');
    });

    it('accepts the card metadata + bucket identity when supplied', () => {
      const model = AiModelFactory.CreateAiModel({
        ...registryProps,
        license: 'mit',
        gated: true,
        baseModel: 'google/flan-t5-large',
        languages: ['en'],
        hfRevision: 'sha1',
        bucketPrefix: 'medical-ner/abc/',
        primaryObject: 'model.safetensors',
        isPlatformDefaultFor: ['NAMED_ENTITY_RECOGNITION' as never],
      });

      expect(model.license).toBe('mit');
      expect(model.gated).toBe(true);
      expect(model.baseModel).toBe('google/flan-t5-large');
      expect(model.languages).toEqual(['en']);
      expect(model.hfRevision).toBe('sha1');
      expect(model.bucketPrefix).toBe('medical-ner/abc/');
      expect(model.primaryObject).toBe('model.safetensors');
      expect(model.isPlatformDefaultFor).toEqual(['NAMED_ENTITY_RECOGNITION']);
    });
  });
});
