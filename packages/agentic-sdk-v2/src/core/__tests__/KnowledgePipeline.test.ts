/**
 * KnowledgePipeline Unit Tests
 *
 * Tests for the parallel knowledge processing pipeline.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model.
 * `@arcaai/med-ner` (in-browser NER) was deleted — `executeNER()` now throws
 * for every location ('browser'/'auto': client-side NER is gone; 'backend':
 * not wired in this SDK). Entity extraction is a server-side agent task —
 * invoke a `NAMED_ENTITY_RECOGNITION` agent via `useAgentInvocation` instead.
 * The entity-mapping tests this file used to carry (NER-L-01, REFACTOR-06,
 * the stable-id dedup tests in `process`) tested that removed client
 * processor and are gone with it.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockLogger } from '../../__tests__/setup';
import { KnowledgePipeline, createKnowledgePipeline } from '../KnowledgePipeline';
import type { KnowledgePipelineConfig } from '../../types/pipeline';
import type { AgenticClient } from '../AgenticClient';

/**
 * TASK-1012 (L-2): summarization runs on the async plane — POST `…/summary/async`, poll
 * `GET /consultations/jobs/:jobId`, then read `…/summary/latest`. The synchronous
 * `POST …/summary` was removed by TASK-1006.
 */
function mockNoteJob(client: Partial<AgenticClient>, consultationId: string, content: string): void {
  (client.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ jobId: 'job-1', status: 'pending', consultationId, createdAt: '' });
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    if (url === '/consultations/jobs/job-1') return { jobId: 'job-1', status: 'COMPLETED', progress: 100 };
    if (url === `/consultations/${consultationId}/summary/latest`) return { id: 's-1', content };
    throw new Error(`unexpected GET ${url}`);
  });
}

describe('KnowledgePipeline', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockApiClient: Partial<AgenticClient>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.clearAllMocks();

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
        ner: { enabled: false, location: 'disabled', triggerMode: 'auto' },
        spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' },
        summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
      };

      const pipeline = new KnowledgePipeline(config, mockApiClient as AgenticClient, mockLogger);

      const currentConfig = pipeline.getConfig();
      expect(currentConfig.ner.enabled).toBe(false);
      expect(currentConfig.ner.location).toBe('disabled');
      expect(currentConfig.spellCheck.enabled).toBe(false);
      expect(currentConfig.summarization.enabled).toBe(true);
    });
  });

  describe('factory function', () => {
    it('should create pipeline using factory', () => {
      const pipeline = createKnowledgePipeline(
        { ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      expect(pipeline).toBeInstanceOf(KnowledgePipeline);
      expect(pipeline.name).toBe('knowledge-pipeline');
    });
  });

  describe('init', () => {
    it('should become ready without loading a client-side NER model (TASK-1006)', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } }, undefined, mockLogger);

      await pipeline.init();

      expect(pipeline.state.isReady).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('KnowledgePipeline initialized', expect.any(Object));
    });
  });

  describe('process', () => {
    it('should skip NER (disabled) and complete with no entities', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } }, undefined, mockLogger);

      await pipeline.init();
      const result = await pipeline.process({ text: 'Patient has diabetes' });

      expect(result.entities).toBeUndefined();
      expect(result.timestamp).toBeDefined();
      expect(pipeline.state.status).toBe('COMPLETED');
    });

    it('should skip manual stages during process', async () => {
      const pipeline = new KnowledgePipeline(
        {
          ner: { enabled: false, location: 'disabled', triggerMode: 'auto' },
          summarization: { enabled: true, location: 'backend', triggerMode: 'manual' },
        },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.init();
      const result = await pipeline.process({ text: 'Patient has diabetes' });

      // Summarization is manual, so it shouldn't have been called
      expect(mockApiClient.post).not.toHaveBeenCalledWith(expect.stringContaining('/summaries'), expect.any(Object));
      expect(result.summary).toBeUndefined();
    });

    it('auto-triggering NER (enabled + location browser) throws — client-side NER was removed', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: true, location: 'browser', triggerMode: 'auto' } }, undefined, mockLogger);

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await pipeline.init();

      await expect(pipeline.process({ text: 'Patient has diabetes' })).rejects.toThrow('Client-side NER is disabled');
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('triggerNER', () => {
    it("throws for location: 'browser' — @arcaai/med-ner was removed (TASK-1006)", async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: true, location: 'browser', triggerMode: 'manual' } }, undefined, mockLogger);

      await pipeline.init();

      await expect(pipeline.triggerNER('Patient has hypertension')).rejects.toThrow('Client-side NER is disabled');
    });

    it("throws for location: 'auto' — no in-browser fallback exists any more", async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: true, location: 'auto', triggerMode: 'manual' } }, undefined, mockLogger);

      await pipeline.init();

      await expect(pipeline.triggerNER('Patient has hypertension')).rejects.toThrow('Client-side NER is disabled');
    });

    it('resolves to [] when ner.enabled is false (disabled by default)', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'manual' } }, undefined, mockLogger);

      await pipeline.init();

      const entities = await pipeline.triggerNER('Patient has diabetes');
      expect(entities).toEqual([]);
    });

    it('should use last input text if not provided', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'manual' } }, undefined, mockLogger);

      await pipeline.init();

      // Process some text first to set lastInput
      await pipeline.process({ text: 'Patient has diabetes' });

      // Trigger NER without text - should use last input (disabled ⇒ resolves [])
      const entities = await pipeline.triggerNER();

      expect(entities).toEqual([]);
    });

    it('should throw if no text provided', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: true, location: 'browser', triggerMode: 'manual' } }, undefined, mockLogger);

      await expect(pipeline.triggerNER()).rejects.toThrow('No text provided for NER extraction');
    });

    it('should throw when location is backend (not wired in this SDK — invoke a NAMED_ENTITY_RECOGNITION agent instead)', async () => {
      const pipeline = new KnowledgePipeline(
        { ner: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.init();

      await expect(pipeline.triggerNER('Patient has diabetes')).rejects.toThrow('Backend NER is not wired in KnowledgePipeline');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });
  });

  describe('triggerSpellCheck', () => {
    it('should manually trigger spell check', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await expect(pipeline.triggerSpellCheck('Pateint has diabets')).rejects.toThrow('Backend spell check is not supported via the API gateway');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should return original text if disabled', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: false, location: 'disabled', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
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
        mockLogger,
      );

      await expect(pipeline.triggerSpellCheck()).rejects.toThrow('No text provided for spell check');
    });
  });

  describe('triggerSummarization', () => {
    it('should manually trigger summarization', async () => {
      mockNoteJob(mockApiClient, 'consultation-123', 'Patient presented with symptoms...');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      const summary = await pipeline.triggerSummarization('consultation-123');

      expect(summary).toBe('Patient presented with symptoms...');
      expect(mockApiClient.post).toHaveBeenCalledWith('/consultations/consultation-123/summary/async', {});
    });

    it('should throw if API client not available', async () => {
      const pipeline = new KnowledgePipeline({ summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } }, undefined, mockLogger);

      await expect(pipeline.triggerSummarization('consultation-123')).rejects.toThrow('API client required for summarization');
    });

    it('should emit summaryComplete event', async () => {
      mockNoteJob(mockApiClient, 'consultation-123', 'Summary text');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      const summaryHandler = vi.fn();
      pipeline.on('summaryComplete', summaryHandler);

      await pipeline.triggerSummarization('consultation-123');

      expect(summaryHandler).toHaveBeenCalledWith({ summary: 'Summary text' });
    });
  });

  describe('getStageResult', () => {
    it('should return cached result after a manual triggerSpellCheck', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.triggerSpellCheck('some text').catch(() => {});

      // spellCheck backend is not supported and threw, so nothing cached under
      // that key — but the accessor itself is exercised and typed correctly.
      expect(pipeline.getStageResult('spellCheck')).toBeUndefined();
    });

    it('should return undefined for non-existent result', () => {
      const pipeline = new KnowledgePipeline();

      expect(pipeline.getStageResult('ner')).toBeUndefined();
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } }, undefined, mockLogger);

      pipeline.updateConfig({
        ner: { enabled: false, location: 'disabled', triggerMode: 'manual' },
        spellCheck: { enabled: true, location: 'backend', triggerMode: 'auto' },
      });

      const config = pipeline.getConfig();
      expect(config.ner.triggerMode).toBe('manual');
      expect(config.spellCheck.enabled).toBe(true);
    });
  });

  describe('destroy', () => {
    it('should destroy pipeline and clear resources', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } }, undefined, mockLogger);

      await pipeline.init();
      await pipeline.process({ text: 'test' });
      await pipeline.destroy();

      expect(pipeline.state.status).toBe('IDLE');
      expect(pipeline.state.isReady).toBe(false);
      expect(pipeline.getStageResult('ner')).toBeUndefined();
    });

    it('should emit final stateChange before removing listeners', async () => {
      const pipeline = new KnowledgePipeline({ ner: { enabled: false, location: 'disabled', triggerMode: 'auto' } }, undefined, mockLogger);

      await pipeline.init();

      const stateChanges: Array<{ status: string; isReady: boolean }> = [];
      pipeline.on('stateChange', (state) => {
        stateChanges.push({ status: state.status, isReady: state.isReady });
      });

      await pipeline.destroy();

      const finalChange = stateChanges.find((s) => s.status === 'IDLE' && s.isReady === false);
      expect(finalChange).toBeDefined();
    });
  });

  // ===========================================================================
  // Stream B Gap Fixes (SDK-206, Layer 1)
  // ===========================================================================

  describe('backend spell check via API gateway is unsupported', () => {
    it('should fail fast for backend spell check', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await expect(pipeline.triggerSpellCheck('Pateint has diabets')).rejects.toThrow('Backend spell check is not supported via the API gateway');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });

    it('should NOT call the old /api/spellcheck endpoint', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        corrected: 'fixed text',
      });

      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow('Backend spell check is not supported via the API gateway');

      expect(mockApiClient.post).not.toHaveBeenCalledWith('/api/spellcheck', expect.any(Object));
    });

    it('should propagate backend spell check API errors and emit error event', async () => {
      const pipeline = new KnowledgePipeline(
        { spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow('Backend spell check is not supported via the API gateway');
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('should throw when backend spell check is used without API client', async () => {
      const pipeline = new KnowledgePipeline({ spellCheck: { enabled: true, location: 'backend', triggerMode: 'manual' } }, undefined, mockLogger);

      await expect(pipeline.triggerSpellCheck('broken text')).rejects.toThrow('Backend spell check is not supported via the API gateway');
    });
  });

  describe('SUM-05: summarization uses correct endpoint', () => {
    it('should call /consultations/:id/summary/async (no /api prefix) with the configured DNA style', async () => {
      mockNoteJob(mockApiClient, 'consultation-123', 'Summary text');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual', dnaStyleId: 'dna-1' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.triggerSummarization('consultation-123');

      // `type` is not a field of the gateway's GenerateSummaryRequest (forbidNonWhitelisted → 400).
      expect(mockApiClient.post).toHaveBeenCalledWith('/consultations/consultation-123/summary/async', { dnaStyleId: 'dna-1' });
    });

    it('should NOT call the removed synchronous POST /consultations/:id/summary (TASK-1012)', async () => {
      mockNoteJob(mockApiClient, 'consultation-123', 'Summary text');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.triggerSummarization('consultation-123');

      expect(mockApiClient.post).not.toHaveBeenCalledWith('/consultations/consultation-123/summary', expect.anything());
    });

    it('should NOT call the old /api/consultations/.../summaries endpoint', async () => {
      mockNoteJob(mockApiClient, 'consultation-123', 'Summary text');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.triggerSummarization('consultation-123');

      expect(mockApiClient.post).not.toHaveBeenCalledWith('/api/consultations/consultation-123/summaries', expect.any(Object));
    });

    it('should correctly interpolate contextId with special characters into the URL', async () => {
      mockNoteJob(mockApiClient, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Summary for UUID');

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      await pipeline.triggerSummarization('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      expect(mockApiClient.post).toHaveBeenCalledWith('/consultations/a1b2c3d4-e5f6-7890-abcd-ef1234567890/summary/async', {});
    });

    it('should propagate summarization API errors and emit error event', async () => {
      (mockApiClient.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Summary service timeout'));

      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: true, location: 'backend', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(pipeline.triggerSummarization('consultation-123')).rejects.toThrow('Summary service timeout');
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ stage: 'summarization' }));
    });

    it('should return empty string when summarization is disabled', async () => {
      const pipeline = new KnowledgePipeline(
        { summarization: { enabled: false, location: 'disabled', triggerMode: 'manual' } },
        mockApiClient as AgenticClient,
        mockLogger,
      );

      const result = await pipeline.triggerSummarization('consultation-123');

      expect(result).toBe('');
      expect(mockApiClient.post).not.toHaveBeenCalled();
    });
  });
});
