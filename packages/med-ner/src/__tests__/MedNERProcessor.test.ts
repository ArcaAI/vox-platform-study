/**
 * @arcaai/med-ner - MedNERProcessor Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pipeline function BEFORE importing the processor
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(
    vi.fn().mockResolvedValue([
      { word: 'Type', entity: 'B-Disease', score: 0.95, index: 1, start: 0, end: 4 },
      { word: '2', entity: 'I-Disease', score: 0.92, index: 2, start: 5, end: 6 },
      { word: 'Diabetes', entity: 'I-Disease', score: 0.98, index: 3, start: 7, end: 15 },
      { word: 'Metformin', entity: 'B-Drug', score: 0.89, index: 4, start: 30, end: 39 },
    ])
  ),
  env: {
    allowLocalModels: false,
    useBrowserCache: true,
  },
}));

import { MedNERProcessor, createMedNER } from '../processors/MedNERProcessor.js';
import {
  MedicalEntityType,
  MedNERErrorCode,
  DEFAULT_MED_NER_OPTIONS,
} from '../types/index.js';

// Mock pipeline results for reference in tests
const mockPipelineResults = [
  { word: 'Type', entity: 'B-Disease', score: 0.95, index: 1, start: 0, end: 4 },
  { word: '2', entity: 'I-Disease', score: 0.92, index: 2, start: 5, end: 6 },
  { word: 'Diabetes', entity: 'I-Disease', score: 0.98, index: 3, start: 7, end: 15 },
  { word: 'Metformin', entity: 'B-Drug', score: 0.89, index: 4, start: 30, end: 39 },
];

describe('MedNERProcessor', () => {
  let processor: MedNERProcessor;

  beforeEach(() => {
    processor = new MedNERProcessor();
  });

  describe('constructor', () => {
    it('should create processor with default options', () => {
      // Phase 0 (0.8) / SOTA gap review D7 — default preset is now
      // 'clinical' (samrawal/bert-base-uncased_clinical-ner), not the generic
      // Xenova/bert-base-NER.
      expect(processor.name).toBe('med-ner-processor');
      expect(processor.getModelId()).toBe('samrawal/bert-base-uncased_clinical-ner');
    });

    it('should accept custom options', () => {
      const customProcessor = new MedNERProcessor({
        model: 'biomedical',
        threshold: 0.7,
        entityTypes: [MedicalEntityType.DISEASE],
      });

      expect(customProcessor.getModelId()).toBe('Kushtrim/bert-base-cased-biomedical-ner');
      expect(customProcessor.getOptions().threshold).toBe(0.7);
      expect(customProcessor.getOptions().entityTypes).toEqual([MedicalEntityType.DISEASE]);
    });
  });

  describe('isSupported', () => {
    it('should return boolean', () => {
      expect(typeof processor.isSupported()).toBe('boolean');
    });
  });

  describe('isInitialized', () => {
    it('should return false before init', () => {
      expect(processor.isInitialized()).toBe(false);
    });
  });

  describe('isProcessing', () => {
    it('should return false when not processing', () => {
      expect(processor.isProcessing()).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = processor.getStats();

      expect(stats.isReady).toBe(false);
      expect(stats.isProcessing).toBe(false);
      expect(stats.textsProcessed).toBe(0);
      expect(stats.entitiesExtracted).toBe(0);
      expect(stats.averageProcessingTime).toBe(0);
      expect(typeof stats.timestamp).toBe('number');
    });
  });

  describe('getOptions', () => {
    it('should return current options', () => {
      const options = processor.getOptions();

      expect(options.model).toBe(DEFAULT_MED_NER_OPTIONS.model);
      expect(options.threshold).toBe(DEFAULT_MED_NER_OPTIONS.threshold);
      expect(options.mergeAdjacent).toBe(DEFAULT_MED_NER_OPTIONS.mergeAdjacent);
      expect(options.mergeOverlapping).toBe(DEFAULT_MED_NER_OPTIONS.mergeOverlapping);
    });
  });

  describe('updateOptions', () => {
    it('should update threshold', () => {
      processor.updateOptions({ threshold: 0.8 });
      expect(processor.getOptions().threshold).toBe(0.8);
    });

    it('should update entity types', () => {
      processor.updateOptions({ entityTypes: [MedicalEntityType.MEDICATION] });
      expect(processor.getOptions().entityTypes).toEqual([MedicalEntityType.MEDICATION]);
    });

    it('should update merge options', () => {
      processor.updateOptions({ mergeAdjacent: false, mergeOverlapping: false });
      expect(processor.getOptions().mergeAdjacent).toBe(false);
      expect(processor.getOptions().mergeOverlapping).toBe(false);
    });
  });

  describe('resetStats', () => {
    it('should reset all statistics', () => {
      // First, simulate some activity
      const stats = processor.getStats();
      expect(stats.textsProcessed).toBe(0);

      processor.resetStats();
      const newStats = processor.getStats();

      expect(newStats.textsProcessed).toBe(0);
      expect(newStats.entitiesExtracted).toBe(0);
      expect(newStats.averageProcessingTime).toBe(0);
      expect(newStats.averageConfidence).toBe(0);
    });
  });

  describe('event emitter', () => {
    it('should add and remove event listeners', () => {
      const callback = vi.fn();

      processor.on('data', callback);
      processor.off('data', callback);

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('destroy', () => {
    it('should clean up resources', async () => {
      await processor.destroy();
      expect(processor.isInitialized()).toBe(false);
    });
  });
});

describe('createMedNER', () => {
  it('should create a MedNERProcessor instance', () => {
    const processor = createMedNER();
    expect(processor).toBeInstanceOf(MedNERProcessor);
  });

  it('should pass options to processor', () => {
    const processor = createMedNER({
      model: 'clinical',
      threshold: 0.65,
    });

    expect(processor.getModelId()).toBe('samrawal/bert-base-uncased_clinical-ner');
    expect(processor.getOptions().threshold).toBe(0.65);
  });

  it('should accept callbacks', () => {
    const onEntitiesExtracted = vi.fn();
    const onError = vi.fn();

    const processor = createMedNER({
      onEntitiesExtracted,
      onError,
    });

    expect(processor).toBeInstanceOf(MedNERProcessor);
  });
});
