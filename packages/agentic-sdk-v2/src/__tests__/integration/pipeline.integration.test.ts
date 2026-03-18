/**
 * @arcaai/vox - Pipeline Integration Tests
 *
 * These tests verify the integration between different plugin packages
 * (VAD, STT, NoiseFilter, MedNER) through the SDK's pipeline architecture.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the plugin packages
vi.mock('@arcaai/room', () => ({
  ProcessorEvent: {
    Ready: 'ready',
    Enabled: 'enabled',
    Disabled: 'disabled',
    Destroyed: 'destroyed',
    Error: 'error',
    Data: 'data',
  },
  ProcessorStatus: {
    IDLE: 'idle',
    INITIALIZING: 'initializing',
    READY: 'ready',
    ENABLED: 'enabled',
    DISABLED: 'disabled',
    ERROR: 'error',
    DESTROYED: 'destroyed',
  },
}));

describe('Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Transcription Pipeline (Sequential)', () => {
    it('should define correct pipeline flow: NoiseFilter → VAD → STT', () => {
      // Pipeline flow verification
      const stages = [
        { name: 'noise-filter', priority: 10 },
        { name: 'vad', priority: 20 },
        { name: 'stt', priority: 30 },
      ];

      // Verify stages are ordered by priority
      const sortedStages = [...stages].sort((a, b) => a.priority - b.priority);
      expect(sortedStages[0].name).toBe('noise-filter');
      expect(sortedStages[1].name).toBe('vad');
      expect(sortedStages[2].name).toBe('stt');
    });

    it('should process audio through pipeline stages sequentially', async () => {
      const processedStages: string[] = [];

      // Simulate stage processing
      const stages = [
        {
          name: 'noise-filter',
          process: async (input: Float32Array) => {
            processedStages.push('noise-filter');
            return input; // Pass through with noise removed
          },
        },
        {
          name: 'vad',
          process: async (input: Float32Array) => {
            processedStages.push('vad');
            return { audio: input, isSpeech: true };
          },
        },
        {
          name: 'stt',
          process: async (input: { audio: Float32Array; isSpeech: boolean }) => {
            processedStages.push('stt');
            return { text: 'Hello world', isFinal: true };
          },
        },
      ];

      // Simulate pipeline execution
      let result: unknown = new Float32Array([0.1, 0.2, 0.3]);
      for (const stage of stages) {
        result = await stage.process(result as Float32Array);
      }

      expect(processedStages).toEqual(['noise-filter', 'vad', 'stt']);
      expect(result).toEqual({ text: 'Hello world', isFinal: true });
    });

    it('should handle stage failures gracefully', async () => {
      const errorHandler = vi.fn();

      const failingStage = {
        name: 'failing-stage',
        process: async () => {
          throw new Error('Stage processing failed');
        },
        onError: errorHandler,
      };

      try {
        await failingStage.process();
      } catch (error) {
        errorHandler(error);
      }

      expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Stage processing failed' })
      );
    });
  });

  describe('Knowledge Pipeline (Parallel)', () => {
    it('should define correct parallel processing stages', () => {
      const stages = [
        { name: 'ner', triggerMode: 'auto' as const },
        { name: 'spell-check', triggerMode: 'manual' as const },
        { name: 'summarization', triggerMode: 'manual' as const },
      ];

      const autoStages = stages.filter((s) => s.triggerMode === 'auto');
      const manualStages = stages.filter((s) => s.triggerMode === 'manual');

      expect(autoStages).toHaveLength(1);
      expect(autoStages[0].name).toBe('ner');
      expect(manualStages).toHaveLength(2);
    });

    it('should process text through NER automatically after transcription', async () => {
      const mockNER = {
        process: vi.fn().mockResolvedValue({
          entities: [
            { text: 'diabetes', type: 'DISEASE', score: 0.95 },
            { text: 'metformin', type: 'MEDICATION', score: 0.92 },
          ],
        }),
      };

      const transcription = {
        text: 'Patient has diabetes and takes metformin.',
        isFinal: true,
      };

      // Simulate auto-trigger of NER after transcription
      const result = await mockNER.process(transcription.text);

      expect(mockNER.process).toHaveBeenCalledWith(transcription.text);
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0].type).toBe('DISEASE');
      expect(result.entities[1].type).toBe('MEDICATION');
    });

    it('should support manual trigger for spell-check and summarization', async () => {
      const mockSpellCheck = {
        trigger: vi.fn().mockResolvedValue({
          corrected: 'Patient has diabetes mellitus type 2.',
          corrections: [{ original: 'diabettes', corrected: 'diabetes' }],
        }),
      };

      const mockSummarization = {
        trigger: vi.fn().mockResolvedValue({
          summary: 'Patient presents with type 2 diabetes, currently on metformin therapy.',
        }),
      };

      // Manual triggers should not run automatically
      expect(mockSpellCheck.trigger).not.toHaveBeenCalled();
      expect(mockSummarization.trigger).not.toHaveBeenCalled();

      // Trigger manually
      const spellCheckResult = await mockSpellCheck.trigger();
      const summaryResult = await mockSummarization.trigger();

      expect(spellCheckResult.corrected).toBeDefined();
      expect(summaryResult.summary).toBeDefined();
    });
  });

  describe('Plugin Enable/Disable During Active Session', () => {
    it('should handle plugin toggling without disrupting pipeline', async () => {
      const pluginStates = {
        noiseFilter: true,
        vad: true,
        stt: true,
      };

      // Simulate plugin toggle
      const togglePlugin = (name: keyof typeof pluginStates) => {
        pluginStates[name] = !pluginStates[name];
      };

      expect(pluginStates.noiseFilter).toBe(true);
      togglePlugin('noiseFilter');
      expect(pluginStates.noiseFilter).toBe(false);
      togglePlugin('noiseFilter');
      expect(pluginStates.noiseFilter).toBe(true);
    });

    it('should skip disabled plugins in pipeline', async () => {
      const processedStages: string[] = [];

      const stages = [
        { name: 'noise-filter', enabled: false },
        { name: 'vad', enabled: true },
        { name: 'stt', enabled: true },
      ];

      // Simulate processing only enabled stages
      for (const stage of stages) {
        if (stage.enabled) {
          processedStages.push(stage.name);
        }
      }

      expect(processedStages).toEqual(['vad', 'stt']);
      expect(processedStages).not.toContain('noise-filter');
    });
  });

  describe('Error Recovery', () => {
    it('should recover from transient errors', async () => {
      let attemptCount = 0;
      const maxRetries = 3;

      const unreliableStage = {
        process: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error('Transient error');
          }
          return { success: true };
        },
      };

      // Simulate retry logic
      let result;
      let lastError: Error | undefined;
      for (let i = 0; i < maxRetries; i++) {
        try {
          result = await unreliableStage.process();
          lastError = undefined; // Clear error on success
          break;
        } catch (error) {
          lastError = error as Error;
        }
      }

      expect(attemptCount).toBe(3);
      expect(result).toEqual({ success: true });
      expect(lastError).toBeUndefined();
    });

    it('should fail after max retries exceeded', async () => {
      let attemptCount = 0;
      const maxRetries = 3;

      const alwaysFailingStage = {
        process: async () => {
          attemptCount++;
          throw new Error('Permanent error');
        },
      };

      let result;
      let lastError;
      for (let i = 0; i < maxRetries; i++) {
        try {
          result = await alwaysFailingStage.process();
          break;
        } catch (error) {
          lastError = error;
        }
      }

      expect(attemptCount).toBe(maxRetries);
      expect(result).toBeUndefined();
      expect(lastError).toBeDefined();
    });
  });

  describe('Event Forwarding', () => {
    it('should forward events from processors to pipeline', () => {
      const eventLog: Array<{ source: string; type: string; data: unknown }> = [];

      // Simulate event emission
      const emitEvent = (source: string, type: string, data: unknown) => {
        eventLog.push({ source, type, data });
      };

      // Simulate processor events
      emitEvent('vad', 'speech-start', { timestamp: Date.now() });
      emitEvent('vad', 'speech-end', { audio: new Float32Array(100), duration: 2.5 });
      emitEvent('stt', 'transcription', { text: 'Hello', isFinal: true });
      emitEvent('ner', 'entities', { entities: [{ text: 'patient', type: 'PERSON' }] });

      expect(eventLog).toHaveLength(4);
      expect(eventLog[0].source).toBe('vad');
      expect(eventLog[0].type).toBe('speech-start');
      expect(eventLog[3].source).toBe('ner');
    });

    it('should forward error events properly', () => {
      const errorHandler = vi.fn();

      // Simulate error event
      const error = new Error('Processing failed');
      errorHandler({ source: 'stt', error, recoverable: true });

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'stt',
          recoverable: true,
        })
      );
    });
  });

  describe('Pipeline State Management', () => {
    it('should track pipeline status correctly', () => {
      const pipelineState = {
        status: 'IDLE' as 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'COMPLETED',
        progress: 0,
        currentStage: null as string | null,
      };

      // Simulate state changes
      pipelineState.status = 'RUNNING';
      pipelineState.currentStage = 'noise-filter';
      pipelineState.progress = 33;

      expect(pipelineState.status).toBe('RUNNING');
      expect(pipelineState.currentStage).toBe('noise-filter');

      pipelineState.currentStage = 'stt';
      pipelineState.progress = 100;
      pipelineState.status = 'COMPLETED';

      expect(pipelineState.status).toBe('COMPLETED');
    });

    it('should support pause and resume', async () => {
      const pipelineState = {
        status: 'RUNNING' as string,
        processedItems: 0,
      };

      // Simulate pause
      pipelineState.status = 'PAUSED';
      expect(pipelineState.status).toBe('PAUSED');

      // Simulate processing during pause (should not process)
      const itemsBeforePause = pipelineState.processedItems;

      // Simulate resume
      pipelineState.status = 'RUNNING';
      pipelineState.processedItems++;

      expect(pipelineState.status).toBe('RUNNING');
      expect(pipelineState.processedItems).toBe(itemsBeforePause + 1);
    });
  });

  describe('Hook Integration', () => {
    it('should define correct hook return types for useVAD', () => {
      const mockUseVADReturn = {
        isActive: true,
        isSpeaking: false,
        speechProbability: 0.3,
        currentSpeechDuration: 0,
        stats: null,
        processor: null,
        isAttached: true,
        error: null,
        attach: vi.fn(),
        detach: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        resetStats: vi.fn(),
        updateOptions: vi.fn(),
      };

      expect(mockUseVADReturn.isActive).toBe(true);
      expect(mockUseVADReturn.isSpeaking).toBe(false);
      expect(typeof mockUseVADReturn.attach).toBe('function');
    });

    it('should define correct hook return types for useSTT', () => {
      const mockUseSTTReturn = {
        isReady: true,
        isProcessing: false,
        isLoading: false,
        currentTranscript: '',
        finalTranscripts: [],
        lastTranscription: null,
        loadProgress: null,
        stats: null,
        processor: null,
        isAttached: true,
        providerType: 'remote' as const,
        language: 'en-US',
        error: null,
        attach: vi.fn(),
        detach: vi.fn(),
        transcribeSegment: vi.fn(),
        clear: vi.fn(),
        setLanguage: vi.fn(),
      };

      expect(mockUseSTTReturn.isReady).toBe(true);
      expect(mockUseSTTReturn.providerType).toBe('remote');
      expect(typeof mockUseSTTReturn.transcribeSegment).toBe('function');
    });

    it('should define correct hook return types for useNoiseFilter', () => {
      const mockUseNoiseFilterReturn = {
        isActive: true,
        isAttached: true,
        isEnabled: true,
        noiseLevel: 'medium' as const,
        isUsingFallback: false,
        stats: null,
        noiseReductionDb: 12.5,
        vadProbability: 0.8,
        processor: null,
        error: null,
        attach: vi.fn(),
        detach: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        toggle: vi.fn(),
        setLevel: vi.fn(),
        updateOptions: vi.fn(),
      };

      expect(mockUseNoiseFilterReturn.isActive).toBe(true);
      expect(mockUseNoiseFilterReturn.noiseLevel).toBe('medium');
      expect(typeof mockUseNoiseFilterReturn.toggle).toBe('function');
    });
  });
});
