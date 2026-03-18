/**
 * KnowledgePipeline Unit Tests
 *
 * Tests for the parallel knowledge processing pipeline.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockLogger } from '../../__tests__/setup';
import type { KnowledgePipelineConfig } from '../../types/pipeline';
import type { AgenticClient } from '../AgenticClient';

// Mock @arcaai/med-ner module before importing KnowledgePipeline
const mockMedNERProcessor = {
  init: vi.fn().mockResolvedValue(undefined),
  extract: vi.fn().mockResolvedValue({
    text: 'test text',
    entities: [
      { text: 'diabetes', type: 'CONDITION', score: 0.95, start: 0, end: 8 },
    ],
    processingTime: 100,
    timestamp: Date.now(),
  }),
  isInitialized: vi.fn().mockReturnValue(true),
};

vi.mock('@arcaai/med-ner', () => ({
  createMedNER: vi.fn(() => mockMedNERProcessor),
}));

// Import after mock setup
import { KnowledgePipeline, createKnowledgePipeline } from '../KnowledgePipeline';
import { createMedNER } from '@arcaai/med-ner';

describe('KnowledgePipeline', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockApiClient: Partial<AgenticClient>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.clearAllMocks();

    // Reset the mock processor state
    mockMedNERProcessor.init.mockResolvedValue(undefined);
    mockMedNERProcessor.extract.mockResolvedValue({
      text: 'test text',
      entities: [
        { text: 'diabetes', type: 'CONDITION', score: 0.95, start: 0, end: 8 },
      ],
      processingTime: 100,
      timestamp: Date.now(),
    });
    mockMedNERProcessor.isInitialized.mockReturnValue(true);

    // Create mock API client
    mockApiClient = {
      post: vi.fn().mockResolvedValue({ entities: [], corrected: '', content: '' }),
      get: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create pipeline with default config', () => {
      const pipeline = new KnowledgePipeline();

      expect(pipeline.name).toBe('knowledge-pipeline');
      expect(pipeline.state.status).toBe('IDLE');
    });

    it('should create pipeline with custom config', () => {
      const config: Partial<KnowledgePipelineConfig> = {
        ner: { enabled: true, location: 'browser', triggerMode: 'auto' },
        spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
        summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
      };

      const pipeline = new KnowledgePipeline(config, mockApiClient as AgenticClient, mockLogger);

      const currentConfig = pipeline.getConfig();
      expect(currentConfig.ner.enabled).toBe(true);
      expect(currentConfig.ner.location).toBe('browser');
      expect(currentConfig.spellCheck.enabled).toBe(false);
      expect(currentConfig.summarization.enabled).toBe(true);
    });
  });

  describe('factory function', () => {
    it('should create pipeline using factory', () => {
      const pipeline = createKnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      expect(pipeline).toBeInstanceOf(KnowledgePipeline);
      expect(pipeline.name).toBe('knowledge-pipeline');
    });
  });

  describe('init', () => {
    it('should initialize browser-based NER processor', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      await pipeline.init();

      expect(pipeline.state.isReady).toBe(true);
      expect(createMedNER).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'KnowledgePipeline initialized',
        expect.any(Object)
      );
    });

    it('should skip NER init if disabled', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: false, location: 'disabled', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();

      expect(pipeline.state.isReady).toBe(true);
      expect(createMedNER).not.toHaveBeenCalled();
    });

    it('should skip NER init if backend-based', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'auto' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();

      expect(pipeline.state.isReady).toBe(true);
      expect(createMedNER).not.toHaveBeenCalled();
    });
  });

  describe('process', () => {
    it('should process text through auto stages', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const result = await pipeline.process({ text: 'Patient has diabetes' });

      expect(result.entities).toBeDefined();
      expect(result.entities?.length).toBeGreaterThan(0);
      expect(result.timestamp).toBeDefined();
      expect(pipeline.state.status).toBe('COMPLETED');
    });

    it('should skip manual stages during process', async () => {
      const pipeline = new KnowledgePipeline(
        {
          ner: { enabled: true, location: 'browser', triggerMode: 'auto' },
          summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
        },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();
      const result = await pipeline.process({ text: 'Patient has diabetes' });

      // Summarization is manual, so it shouldn't have been called
      expect(mockApiClient.post).not.toHaveBeenCalledWith(
        expect.stringContaining('/summaries'),
        expect.any(Object)
      );
      expect(result.summary).toBeUndefined();
    });

    it('should emit nerComplete event', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      const nerHandler = vi.fn();
      pipeline.on('nerComplete', nerHandler);

      await pipeline.init();
      await pipeline.process({ text: 'Patient has diabetes' });

      expect(nerHandler).toHaveBeenCalledWith(
        expect.objectContaining({ entities: expect.any(Array) })
      );
    });

    it('should handle process errors', async () => {
      // Set up a mock that rejects on extract
      mockMedNERProcessor.extract.mockRejectedValueOnce(new Error('NER failed'));

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await pipeline.init();

      await expect(pipeline.process({ text: 'test' })).rejects.toThrow('NER failed');
      expect(pipeline.state.status).toBe('ERROR');
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('triggerNER', () => {
    it('should manually trigger NER extraction', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('Patient has hypertension');

      expect(entities).toBeInstanceOf(Array);
      // Verify createMedNER was called during init
      expect(createMedNER).toHaveBeenCalled();
    });

    it('should use last input text if not provided', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();

      // Process some text first to set lastInput
      await pipeline.process({ text: 'Patient has diabetes' });

      // Trigger NER without text - should use last input
      const entities = await pipeline.triggerNER();

      expect(entities).toBeInstanceOf(Array);
    });

    it('should throw if no text provided', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await expect(pipeline.triggerNER()).rejects.toThrow('No text provided for NER extraction');
    });

    it('should throw when location is backend (API gateway does not proxy /nlp/*)', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();

      await expect(pipeline.triggerNER('Patient has diabetes')).rejects.toThrow(
        'Backend NER is not supported via the API gateway',
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });
  });

  describe('triggerSpellCheck', () => {
    it('should manually trigger spell check', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await expect(pipeline.triggerSpellCheck('Pateint has diabets')).rejects.toThrow(
        'Backend spell check is not supported via the API gateway',
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should return original text if disabled', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      // Process to set last input
      await pipeline.process({ text: 'some text' });
      const result = await pipeline.triggerSpellCheck('some text');

      expect(result).toBe('some text');
    });

    it('should throw if no text provided', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await expect(pipeline.triggerSpellCheck()).rejects.toThrow('No text provided for spell check');
    });
  });

  describe('triggerSummarization', () => {
    it('should manually trigger summarization', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Patient presented with symptoms...',
      });

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const summary = await pipeline.triggerSummarization('consultation-123');

      expect(summary).toBe('Patient presented with symptoms...');
      expect(mockApiClient.post).toHaveBeenCalledWith(
        '/consultations/consultation-123/summary',
        expect.any(Object)
      );
    });

    it('should throw if API client not available', async () => {
      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await expect(pipeline.triggerSummarization('consultation-123')).rejects.toThrow(
        'API client required for summarization'
      );
    });

    it('should emit summaryComplete event', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Summary text',
      });

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const summaryHandler = vi.fn();
      pipeline.on('summaryComplete', summaryHandler);

      await pipeline.triggerSummarization('consultation-123');

      expect(summaryHandler).toHaveBeenCalledWith({ summary: 'Summary text' });
    });
  });

  describe('getStageResult', () => {
    it('should return cached result', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      await pipeline.process({ text: 'test' });

      const result = pipeline.getStageResult('ner');
      expect(result).toBeDefined();
    });

    it('should return undefined for non-existent result', () => {
      const pipeline = new KnowledgePipeline();

      expect(pipeline.getStageResult('ner')).toBeUndefined();
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      pipeline.updateConfig({
        ner: { enabled: true, location: 'browser', triggerMode: 'manual' },
        spellCheck: { enabled: true, location: 'backend', triggerMode: 'auto' },
      });

      const config = pipeline.getConfig();
      expect(config.ner.triggerMode).toBe('manual');
      expect(config.spellCheck.enabled).toBe(true);
    });
  });

  describe('destroy', () => {
    it('should destroy pipeline and clear resources', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      await pipeline.process({ text: 'test' });
      await pipeline.destroy();

      expect(pipeline.state.status).toBe('IDLE');
      expect(pipeline.state.isReady).toBe(false);
      expect(pipeline.getStageResult('ner')).toBeUndefined();
    });

    it('should emit final stateChange before removing listeners (BUG-07)', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'auto' } },
        undefined,
        mockLogger
      );

      await pipeline.init();

      const stateChanges: Array<{ status: string; isReady: boolean }> = [];
      pipeline.on('stateChange', (state) => {
        stateChanges.push({ status: state.status, isReady: state.isReady });
      });

      await pipeline.destroy();

      const finalChange = stateChanges.find(
        (s) => s.status === 'IDLE' && s.isReady === false
      );
      expect(finalChange).toBeDefined();
    });
  });

  // ===========================================================================
  // Stream B Gap Fixes (SDK-206, Layer 1)
  // ===========================================================================

  describe('NER-R-01: backend NER via API gateway is unsupported', () => {
    it('should fail fast for backend NER extraction', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();
      await expect(pipeline.triggerNER('Patient has diabetes')).rejects.toThrow(
        'Backend NER is not supported via the API gateway',
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should NOT call the old /api/ner/extract endpoint', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        entities: [],
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();
      await expect(pipeline.triggerNER('test text')).rejects.toThrow(
        'Backend NER is not supported via the API gateway',
      );

      expect(mockApiClient.post).not.toHaveBeenCalledWith(
        '/api/ner/extract',
        expect.any(Object)
      );
    });

    it('should return empty array when backend returns no entities', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.init();
      await expect(pipeline.triggerNER('no entities here')).rejects.toThrow(
        'Backend NER is not supported via the API gateway',
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should propagate backend NER API errors and emit error event', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await pipeline.init();
      await expect(pipeline.triggerNER('test')).rejects.toThrow(
        'Backend NER is not supported via the API gateway',
      );
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should throw when backend NER is used without API client', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      await expect(pipeline.triggerNER('test')).rejects.toThrow(
        'Backend NER is not supported via the API gateway'
      );
    });

    it('should fail fast for backend spell check', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await expect(pipeline.triggerSpellCheck('Pateint has diabets')).rejects.toThrow(
        'Backend spell check is not supported via the API gateway',
      );
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should NOT call the old /api/spellcheck endpoint', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        corrected: 'fixed text',
      });

      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow(
        'Backend spell check is not supported via the API gateway'
      );

      expect(mockApiClient.post).not.toHaveBeenCalledWith(
        '/api/spellcheck',
        expect.any(Object)
      );
    });

    it('should propagate backend spell check API errors and emit error event', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow(
        'Backend spell check is not supported via the API gateway'
      );
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should throw when backend spell check is used without API client', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow(
        'Backend spell check is not supported via the API gateway'
      );
    });
  });

  describe('NER-L-01: browser NER maps to correct MedicalEntity fields', () => {
    it('should map NER output "type" to MedicalEntity "entityType"', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'Patient has diabetes',
        entities: [
          { text: 'diabetes', type: 'DISEASE', score: 0.95, start: 16, end: 24 },
        ],
        processingTime: 50,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('Patient has diabetes');

      expect(entities).toHaveLength(1);
      expect(entities[0]).toHaveProperty('entityType', 'DISEASE');
      expect(entities[0]).not.toHaveProperty('type');
    });

    it('should map NER output "score" to MedicalEntity "confidence"', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'test',
        entities: [
          { text: 'aspirin', type: 'MEDICATION', score: 0.88, start: 0, end: 7 },
        ],
        processingTime: 30,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('aspirin');

      expect(entities[0]).toHaveProperty('confidence', 0.88);
      expect(entities[0]).not.toHaveProperty('score');
    });

    it('should map NER output "start"/"end" to "startOffset"/"endOffset"', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'Patient has headache',
        entities: [
          { text: 'headache', type: 'SYMPTOM', score: 0.92, start: 12, end: 20 },
        ],
        processingTime: 25,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('Patient has headache');

      expect(entities[0]).toHaveProperty('startOffset', 12);
      expect(entities[0]).toHaveProperty('endOffset', 20);
      expect(entities[0]).not.toHaveProperty('start');
      expect(entities[0]).not.toHaveProperty('end');
    });

    it('should include all MedicalEntity required fields', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'diabetes',
        entities: [
          { text: 'diabetes', type: 'DISEASE', score: 0.95, start: 0, end: 8 },
        ],
        processingTime: 20,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('diabetes');

      const entity = entities[0];
      expect(entity).toHaveProperty('id');
      expect(entity).toHaveProperty('text', 'diabetes');
      expect(entity).toHaveProperty('entityType', 'DISEASE');
      expect(entity).toHaveProperty('confidence', 0.95);
      expect(entity).toHaveProperty('startOffset', 0);
      expect(entity).toHaveProperty('endOffset', 8);
    });

    it('should correctly map multiple entities in a single extraction', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'Patient takes aspirin for headache',
        entities: [
          { text: 'aspirin', type: 'MEDICATION', score: 0.92, start: 14, end: 21 },
          { text: 'headache', type: 'SYMPTOM', score: 0.87, start: 26, end: 34 },
        ],
        processingTime: 40,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('Patient takes aspirin for headache');

      expect(entities).toHaveLength(2);

      expect(entities[0]).toMatchObject({
        text: 'aspirin',
        entityType: 'MEDICATION',
        confidence: 0.92,
        startOffset: 14,
        endOffset: 21,
      });

      expect(entities[1]).toMatchObject({
        text: 'headache',
        entityType: 'SYMPTOM',
        confidence: 0.87,
        startOffset: 26,
        endOffset: 34,
      });
    });

    it('should generate unique IDs for each entity in a batch', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'aspirin headache fever',
        entities: [
          { text: 'aspirin', type: 'MEDICATION', score: 0.9, start: 0, end: 7 },
          { text: 'headache', type: 'SYMPTOM', score: 0.85, start: 8, end: 16 },
          { text: 'fever', type: 'SYMPTOM', score: 0.88, start: 17, end: 22 },
        ],
        processingTime: 30,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('aspirin headache fever');

      const ids = entities.map((e) => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      ids.forEach((id) => expect(id).toMatch(uuidRegex));
    });

    it('should return empty array when browser NER finds no entities', async () => {
      mockMedNERProcessor.extract.mockResolvedValueOnce({
        text: 'Hello world',
        entities: [],
        processingTime: 10,
        timestamp: Date.now(),
      });

      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'browser', triggerMode: 'manual' } },
        undefined,
        mockLogger
      );

      await pipeline.init();
      const entities = await pipeline.triggerNER('Hello world');

      expect(entities).toEqual([]);
    });
  });

  describe('SUM-05: summarization uses correct endpoint', () => {
    it('should call /consultations/:id/summary (singular, no /api prefix)', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Summary text',
      });

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.triggerSummarization('consultation-123');

      expect(mockApiClient.post).toHaveBeenCalledWith(
        '/consultations/consultation-123/summary',
        expect.any(Object)
      );
    });

    it('should NOT call the old /api/consultations/.../summaries endpoint', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Summary text',
      });

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.triggerSummarization('consultation-123');

      expect(mockApiClient.post).not.toHaveBeenCalledWith(
        '/api/consultations/consultation-123/summaries',
        expect.any(Object)
      );
    });

    it('should correctly interpolate contextId with special characters into the URL', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: 'Summary for UUID',
      });

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      await pipeline.triggerSummarization('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(mockApiClient.post).toHaveBeenCalledWith(
        '/consultations/a1b2c3d4-e5f6-7890-abcd-ef1234567890/summary',
        expect.any(Object)
      );
    });

    it('should propagate summarization API errors and emit error event', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Summary service timeout')
      );

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(pipeline.triggerSummarization('consultation-123')).rejects.toThrow(
        'Summary service timeout'
      );
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'summarization' })
      );
    });

    it('should return empty string when summarization is disabled', async () => {
      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: false, location: 'disabled', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const result = await pipeline.triggerSummarization('consultation-123');

      expect(result).toBe('');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // REFACTOR-06: Entity IDs should use crypto.randomUUID()
  // =========================================================================

  describe('REFACTOR-06: entity ID generation', () => {
    it('should generate entity IDs using UUID format for browser NER', async () => {
      const pipeline = new KnowledgePipeline(
        {
          ner: { enabled: true, location: 'browser', triggerMode: 'manual', model: 'test-model' },
        },
        mockApiClient as AgenticClient,
        mockLogger
      );

      const mockExtract = vi.fn().mockResolvedValue({
        entities: [
          { text: 'aspirin', type: 'MEDICATION', score: 0.95, start: 0, end: 7 },
          { text: 'headache', type: 'SYMPTOM', score: 0.88, start: 12, end: 20 },
        ],
      });

      (pipeline as any).nerProcessor = { extract: mockExtract };

      const entities = await pipeline.triggerNER('aspirin for headache');

      expect(entities).toHaveLength(2);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const entity of entities) {
        expect(entity.id).toMatch(uuidRegex);
      }
    });
  });
});
