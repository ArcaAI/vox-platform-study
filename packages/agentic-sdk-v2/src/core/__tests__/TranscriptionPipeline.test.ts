/**
 * TranscriptionPipeline Unit Tests
 *
 * Tests for the audio processing pipeline.
 *
 * TASK-1006 (following TASK-865): the `noiseFilter` / `vad` client stages and
 * the `clientInference` gate were removed — the browser never runs a model.
 * The pipeline now hosts a single stage: backend STT over the streaming
 * transport (or a legacy `sttSocket`). Local-provider tests (`provider:
 * 'local'`, VAD-gated segment transcription, VAD event emission) were
 * removed along with the code paths they exercised.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptionPipeline, createTranscriptionPipeline } from '../TranscriptionPipeline';
import { createMockLogger } from '../../__tests__/setup';
import type { TranscriptionPipelineConfig } from '../../types/pipeline';
import { createSTT } from '@arcaai/stt';

// Mock the external processor module
const mockSTT = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  setStreamingTransport: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => mockSTT),
}));

function sttSocket() {
  return { enabled: true, location: 'backend' as const, provider: 'backend' as const, sttSocket: 'wss://api.test/ws/stt' };
}

describe('TranscriptionPipeline', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  const mockTrack = {} as MediaStreamTrack;
  const mockAudioContext = {} as AudioContext;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.clearAllMocks();

    // Reset mock processor
    mockSTT.init.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create pipeline with default config', () => {
      const pipeline = new TranscriptionPipeline();

      expect(pipeline.name).toBe('transcription-pipeline');
      expect(pipeline.state.status).toBe('IDLE');
      expect(pipeline.isInitialized).toBe(false);
      expect(pipeline.isRunning).toBe(false);
    });

    it('should create pipeline with custom config', () => {
      const config: Partial<TranscriptionPipelineConfig> = {
        stt: { enabled: false, location: 'skip' },
      };

      const pipeline = new TranscriptionPipeline(config, mockLogger);

      expect(pipeline.name).toBe('transcription-pipeline');
      const currentConfig = pipeline.getConfig();
      expect(currentConfig.stt.enabled).toBe(false);
    });
  });

  describe('factory function', () => {
    it('should create pipeline using factory', () => {
      const pipeline = createTranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      expect(pipeline).toBeInstanceOf(TranscriptionPipeline);
      expect(pipeline.name).toBe('transcription-pipeline');
    });
  });

  describe('start', () => {
    it('should initialize and start the stt stage', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(pipeline.isInitialized).toBe(true);
      expect(pipeline.isRunning).toBe(true);
      expect(pipeline.state.status).toBe('RUNNING');
      expect(pipeline.state.progress).toBe(100);

      expect(mockSTT.init).toHaveBeenCalled();
    });

    it('should not initialize a disabled stt stage', async () => {
      const pipeline = new TranscriptionPipeline({ stt: { enabled: false, location: 'skip' } }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(mockSTT.init).not.toHaveBeenCalled();
    });

    it('should not reinitialize if already running', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(mockSTT.init).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('TranscriptionPipeline already running', expect.any(Object));
    });

    it('should emit stateChange events during initialization', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const stateChanges: Array<{ status: string }> = [];
      pipeline.on('stateChange', (state) => {
        stateChanges.push({ status: state.status });
      });

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(stateChanges.some((s) => s.status === 'RUNNING')).toBe(true);
    });

    it('should handle initialization errors', async () => {
      mockSTT.init.mockRejectedValueOnce(new Error('Init failed'));

      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(pipeline.start({ track: mockTrack, audioContext: mockAudioContext })).rejects.toThrow('Init failed');

      expect(pipeline.state.status).toBe('ERROR');
      expect(errorHandler).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }));
    });

    it('should map backend STT options to @arcaai/stt shape', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: {
            enabled: true,
            location: 'backend',
            provider: 'backend',
            sttSocket: 'wss://api.test/ws/stt',
            language: 'th',
            diarization: true,
            numSpeakers: 3,
          },
        },
        mockLogger,
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(createSTT).toHaveBeenCalledWith(
        expect.objectContaining({
          sttSocket: 'wss://api.test/ws/stt',
          audio: expect.objectContaining({ language: 'th' }),
          features: expect.objectContaining({
            provider: 'remote',
            diarization: true,
            numSpeakers: 3,
            returnTimestamps: 'word',
            codeSwitching: false,
          }),
        }),
      );
    });

    it("resolves 'auto' provider to remote when an sttSocket is configured", async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: {
            enabled: true,
            location: 'auto',
            provider: 'auto',
            sttSocket: 'wss://api.test/ws/stt',
            language: 'en-US',
          },
        },
        mockLogger,
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(createSTT).toHaveBeenCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({ provider: 'remote' }),
        }),
      );
    });

    it("resolves 'auto' provider to remote when a streamingTransport is configured (no sttSocket)", async () => {
      const transport = { sessionManager: {}, wsClient: {}, agentSlug: 'clinic-asr' };
      const pipeline = new TranscriptionPipeline(
        {
          stt: {
            enabled: true,
            location: 'auto',
            provider: 'auto',
            streamingTransport: transport,
          },
        },
        mockLogger,
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(createSTT).toHaveBeenCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({ provider: 'remote' }),
        }),
      );
      expect(mockSTT.setStreamingTransport).toHaveBeenCalledWith(transport);
    });

    it('should fail fast when backend STT is selected without sttSocket or streamingTransport', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: {
            enabled: true,
            location: 'backend',
            provider: 'backend',
          },
        },
        mockLogger,
      );

      await expect(pipeline.start({ track: mockTrack, audioContext: mockAudioContext })).rejects.toThrow(
        'stt.sttSocket or stt.streamingTransport is required to transcribe',
      );
    });
  });

  describe('stop', () => {
    it('should stop and destroy all processors', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.stop();

      expect(pipeline.isInitialized).toBe(false);
      expect(pipeline.isRunning).toBe(false);
      expect(pipeline.state.status).toBe('IDLE');

      expect(mockSTT.destroy).toHaveBeenCalled();
    });

    it('should do nothing if already stopped', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.stop();

      expect(mockSTT.destroy).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    it('should pause the pipeline', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();

      expect(pipeline.state.status).toBe('PAUSED');
      expect(mockSTT.disable).toHaveBeenCalled();
    });

    it('should resume the pipeline', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();
      await pipeline.resume();

      expect(pipeline.state.status).toBe('RUNNING');
      expect(mockSTT.enable).toHaveBeenCalled();
    });

    it('should not pause if not running', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      pipeline.pause();

      expect(pipeline.state.status).toBe('IDLE');
    });

    it('should not resume if not paused', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      pipeline.resume();

      // Should still be running, enable not called again
      expect(pipeline.state.status).toBe('RUNNING');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      pipeline.updateConfig({
        stt: { enabled: false, location: 'skip' },
      });

      const config = pipeline.getConfig();
      expect(config.stt.enabled).toBe(false);
    });

    it('should merge config deeply', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: { ...sttSocket(), language: 'en' },
        },
        mockLogger,
      );

      pipeline.updateConfig({
        stt: { language: 'th' } as TranscriptionPipelineConfig['stt'],
      });

      const config = pipeline.getConfig();
      expect(config.stt.enabled).toBe(true);
      expect(config.stt.language).toBe('th');
    });
  });

  describe('toggleStage', () => {
    it('should toggle stage enabled state', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.toggleStage('stt', false);

      expect(mockSTT.disable).toHaveBeenCalled();

      const config = pipeline.getConfig();
      expect(config.stt.enabled).toBe(false);
    });

    it('should enable stage after being disabled', async () => {
      const pipeline = new TranscriptionPipeline({ stt: { enabled: false, location: 'skip' } }, mockLogger);

      await pipeline.toggleStage('stt', true);

      const config = pipeline.getConfig();
      expect(config.stt.enabled).toBe(true);
    });
  });

  describe('getProcessor', () => {
    it('should return processor by name', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const processor = pipeline.getProcessor('stt');
      expect(processor).toBeDefined();
    });

    it('should return null for non-existent processor', () => {
      const pipeline = new TranscriptionPipeline();

      expect(pipeline.getProcessor('stt')).toBeNull();
    });
  });

  describe('getProcessedTrack', () => {
    it('should return original track when no processing', async () => {
      const pipeline = new TranscriptionPipeline({ stt: { ...sttSocket(), enabled: false } }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const track = pipeline.getProcessedTrack();
      expect(track).toBe(mockTrack);
    });

    it('should return processed track when available', async () => {
      const processedTrack = {} as MediaStreamTrack;
      mockSTT.processedTrack = processedTrack;

      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const track = pipeline.getProcessedTrack();
      expect(track).toBe(processedTrack);

      // Cleanup
      mockSTT.processedTrack = null;
    });
  });

  describe('event handling', () => {
    it('should emit transcription events', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const transcriptionHandler = vi.fn();
      pipeline.on('transcription', transcriptionHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      // Get the data handler registered with the STT processor
      const dataHandler = mockSTT.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (payload: unknown) => void;

      // Simulate STT transcription event
      dataHandler?.({
        type: 'stt-transcription',
        data: { text: 'Hello world', isFinal: true, confidence: 0.95 },
        timestamp: Date.now(),
      });

      expect(transcriptionHandler).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello world', isFinal: true }));
    });

    it('should emit partialTranscription events', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const partialHandler = vi.fn();
      pipeline.on('partialTranscription', partialHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockSTT.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (payload: unknown) => void;

      dataHandler?.({
        type: 'stt-transcription',
        data: { text: 'Hello', isFinal: false, confidence: 0.7 },
        timestamp: Date.now(),
      });

      expect(partialHandler).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello', isFinal: false }));
    });

    it('should emit partialTranscription for stt-partial events', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const partialHandler = vi.fn();
      pipeline.on('partialTranscription', partialHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockSTT.on.mock.calls.find((call) => call[0] === 'data')?.[1] as (payload: unknown) => void;

      dataHandler?.({
        type: 'stt-partial',
        data: { text: 'Hello from partial event', isFinal: false, confidence: 0.5 },
        timestamp: Date.now(),
      });

      expect(partialHandler).toHaveBeenCalledWith(expect.objectContaining({ text: 'Hello from partial event', isFinal: false }));
    });
  });

  describe('destroy', () => {
    it('should destroy pipeline and clear resources', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.destroy();

      expect(pipeline.isInitialized).toBe(false);
      expect(pipeline.state.status).toBe('IDLE');
    });
  });

  // =========================================================================
  // AudioContext/MediaStream leak
  // =========================================================================

  describe('stop should release audio resources', () => {
    it('should stop all MediaStream tracks when stopping', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const mockStop = vi.fn();
      const trackWithStop = { ...mockTrack, stop: mockStop };

      await pipeline.start({ track: trackWithStop as any, audioContext: mockAudioContext });
      await pipeline.stop();

      expect(mockStop).toHaveBeenCalled();
    });

    it('should close AudioContext when stopping (contextOwnership: owned)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: sttSocket(),
          contextOwnership: 'owned',
        },
        mockLogger,
      );

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxWithClose = { ...mockAudioContext, close: mockClose, state: 'running' };

      await pipeline.start({ track: mockTrack, audioContext: ctxWithClose as any });
      await pipeline.stop();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should NOT close AudioContext when contextOwnership is borrowed (default)', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxWithClose = { ...mockAudioContext, close: mockClose, state: 'running' };

      await pipeline.start({ track: mockTrack, audioContext: ctxWithClose as any });
      await pipeline.stop();

      expect(mockClose).not.toHaveBeenCalled();
    });

    it('should not close AudioContext if already closed (owned context)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          stt: sttSocket(),
          contextOwnership: 'owned',
        },
        mockLogger,
      );

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxAlreadyClosed = { ...mockAudioContext, close: mockClose, state: 'closed' };

      await pipeline.start({ track: mockTrack, audioContext: ctxAlreadyClosed as any });
      await pipeline.stop();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // pause()/resume() should be async
  // =========================================================================

  describe('pause/resume should await processor operations', () => {
    it('pause() should return a Promise', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const result = pipeline.pause();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('resume() should return a Promise', async () => {
      const pipeline = new TranscriptionPipeline({ stt: sttSocket() }, mockLogger);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();

      const result = pipeline.resume();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
