/**
 * TranscriptionPipeline Unit Tests
 *
 * Tests for the sequential audio processing pipeline.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptionPipeline, createTranscriptionPipeline } from '../TranscriptionPipeline';
import { createMockLogger } from '../../__tests__/setup';
import type { TranscriptionPipelineConfig } from '../../types/pipeline';
import { createVAD } from '@arcaai/vad';
import { createSTT } from '@arcaai/stt';

// Mock the external processor modules
const mockNoiseFilter = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

const mockVAD = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

const mockSTT = {
  init: vi.fn().mockResolvedValue(undefined),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  getProviderType: vi.fn(() => 'local' as const),
  transcribeSegment: vi.fn().mockResolvedValue({
    text: 'speech segment',
    isFinal: true,
    language: 'en',
  }),
  on: vi.fn(),
  off: vi.fn(),
  processedTrack: null as MediaStreamTrack | null,
};

vi.mock('@arcaai/noise-filter', () => ({
  createNoiseFilter: vi.fn(() => mockNoiseFilter),
}));

vi.mock('@arcaai/vad', () => ({
  createVAD: vi.fn(() => mockVAD),
}));

vi.mock('@arcaai/stt', () => ({
  createSTT: vi.fn(() => mockSTT),
}));

describe('TranscriptionPipeline', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;
  const mockTrack = {} as MediaStreamTrack;
  const mockAudioContext = {} as AudioContext;

  beforeEach(() => {
    mockLogger = createMockLogger();
    vi.clearAllMocks();

    // Reset mock processors
    mockNoiseFilter.init.mockResolvedValue(undefined);
    mockVAD.init.mockResolvedValue(undefined);
    mockSTT.init.mockResolvedValue(undefined);
    mockSTT.getProviderType.mockReturnValue('local');
    mockSTT.transcribeSegment.mockResolvedValue({
      text: 'speech segment',
      isFinal: true,
      language: 'en',
    });
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
        noiseFilter: { enabled: true, level: 'high', location: 'browser' },
        vad: { enabled: true, sensitivity: 0.7, location: 'browser' },
        stt: { enabled: false, location: 'skip' },
      };

      const pipeline = new TranscriptionPipeline(config, mockLogger);

      expect(pipeline.name).toBe('transcription-pipeline');
      const currentConfig = pipeline.getConfig();
      expect(currentConfig.noiseFilter.enabled).toBe(true);
      expect(currentConfig.noiseFilter.level).toBe('high');
      expect(currentConfig.vad.enabled).toBe(true);
      expect(currentConfig.stt.enabled).toBe(false);
    });
  });

  describe('factory function', () => {
    it('should create pipeline using factory', () => {
      const pipeline = createTranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      expect(pipeline).toBeInstanceOf(TranscriptionPipeline);
      expect(pipeline.name).toBe('transcription-pipeline');
    });
  });

  describe('start', () => {
    it('should initialize and start enabled stages', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          vad: { enabled: true, location: 'browser' },
          stt: { enabled: true, location: 'browser' },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(pipeline.isInitialized).toBe(true);
      expect(pipeline.isRunning).toBe(true);
      expect(pipeline.state.status).toBe('RUNNING');
      expect(pipeline.state.progress).toBe(100);

      expect(mockNoiseFilter.init).toHaveBeenCalled();
      expect(mockVAD.init).toHaveBeenCalled();
      expect(mockSTT.init).toHaveBeenCalled();
    });

    it('should only initialize enabled stages', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          vad: { enabled: false, location: 'browser' },
          stt: { enabled: false, location: 'skip' },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(mockNoiseFilter.init).toHaveBeenCalled();
      expect(mockVAD.init).not.toHaveBeenCalled();
      expect(mockSTT.init).not.toHaveBeenCalled();
    });

    it('should not reinitialize if already running', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(mockNoiseFilter.init).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'TranscriptionPipeline already running',
        expect.any(Object)
      );
    });

    it('should emit stateChange events during initialization', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const stateChanges: Array<{ status: string }> = [];
      pipeline.on('stateChange', (state) => {
        stateChanges.push({ status: state.status });
      });

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(stateChanges.some((s) => s.status === 'RUNNING')).toBe(true);
    });

    it('should handle initialization errors', async () => {
      mockNoiseFilter.init.mockRejectedValueOnce(new Error('Init failed'));

      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const errorHandler = vi.fn();
      pipeline.on('error', errorHandler);

      await expect(
        pipeline.start({ track: mockTrack, audioContext: mockAudioContext })
      ).rejects.toThrow('Init failed');

      expect(pipeline.state.status).toBe('ERROR');
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('should map VAD sensitivity and timing options correctly', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: {
            enabled: true,
            location: 'browser',
            sensitivity: 0.7,
            minSpeechDuration: 320,
            minSilenceDuration: 900,
          },
          stt: { enabled: false, location: 'skip' },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const vadCalls = vi.mocked(createVAD).mock.calls;
      const vadOptions = vadCalls[vadCalls.length - 1]?.[0] as Record<string, number>;
      expect(vadOptions.positiveSpeechThreshold).toBe(0.7);
      expect(vadOptions.negativeSpeechThreshold).toBeCloseTo(0.55, 5);
      expect(vadOptions.minSpeechMs).toBe(320);
      expect(vadOptions.redemptionMs).toBe(900);
    });

    it('should map local STT options to @arcaai/stt shape', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: { enabled: false, location: 'browser' },
          stt: {
            enabled: true,
            location: 'browser',
            provider: 'local',
            language: 'th',
            modelId: 'small',
            diarization: true,
            numSpeakers: 3,
          },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(createSTT).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: expect.objectContaining({ language: 'th' }),
          features: expect.objectContaining({
            provider: 'local',
            modelId: 'small',
            diarization: true,
            numSpeakers: 3,
            returnTimestamps: 'word',
            codeSwitching: false,
          }),
        })
      );
    });

    it('should resolve auto STT provider to local when no backend socket is configured', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: { enabled: false, location: 'browser' },
          stt: {
            enabled: true,
            location: 'auto',
            provider: 'auto',
            language: 'en-US',
          },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      expect(createSTT).toHaveBeenCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({
            provider: 'local',
            modelId: 'tiny',
          }),
        })
      );
    });

    it('should fail fast when backend STT is selected without sttSocket', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: { enabled: false, location: 'browser' },
          stt: {
            enabled: true,
            location: 'backend',
            provider: 'backend',
          },
        },
        mockLogger
      );

      await expect(
        pipeline.start({ track: mockTrack, audioContext: mockAudioContext })
      ).rejects.toThrow('stt.sttSocket or stt.streamingTransport is required when STT provider resolves to backend/remote');
    });

    // TASK-356 Phase 4 — the server-resolved transcriptionMode is authoritative
    // and overrides provider/location/sttSocket in resolveSTTRuntimeProvider.
    it('honors transcriptionMode=BACKEND over provider=local (resolves remote → fails fast without a socket)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: { enabled: false, location: 'browser' },
          stt: {
            enabled: true,
            location: 'browser',
            provider: 'local',
            transcriptionMode: 'BACKEND',
          },
        },
        mockLogger
      );

      await expect(
        pipeline.start({ track: mockTrack, audioContext: mockAudioContext })
      ).rejects.toThrow('stt.sttSocket or stt.streamingTransport is required when STT provider resolves to backend/remote');
    });

    it('honors transcriptionMode=LOCAL over provider=backend (resolves local → builds the local STT stage)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: false, location: 'skip' },
          vad: { enabled: false, location: 'browser' },
          stt: {
            enabled: true,
            location: 'backend',
            provider: 'backend',
            transcriptionMode: 'LOCAL',
          },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      // Resolved to local → the local @arcaai/stt stage is constructed and no
      // sttSocket-required error is thrown.
      expect(createSTT).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop and destroy all processors', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          vad: { enabled: true, location: 'browser' },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.stop();

      expect(pipeline.isInitialized).toBe(false);
      expect(pipeline.isRunning).toBe(false);
      expect(pipeline.state.status).toBe('IDLE');

      expect(mockNoiseFilter.destroy).toHaveBeenCalled();
      expect(mockVAD.destroy).toHaveBeenCalled();
    });

    it('should do nothing if already stopped', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.stop();

      expect(mockNoiseFilter.destroy).not.toHaveBeenCalled();
    });
  });

  describe('pause and resume', () => {
    it('should pause the pipeline', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          vad: { enabled: true, location: 'browser' },
        },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();

      expect(pipeline.state.status).toBe('PAUSED');
      expect(mockNoiseFilter.disable).toHaveBeenCalled();
      expect(mockVAD.disable).toHaveBeenCalled();
    });

    it('should resume the pipeline', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();
      await pipeline.resume();

      expect(pipeline.state.status).toBe('RUNNING');
      expect(mockNoiseFilter.enable).toHaveBeenCalled();
    });

    it('should not pause if not running', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      pipeline.pause();

      expect(pipeline.state.status).toBe('IDLE');
    });

    it('should not resume if not paused', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      pipeline.resume();

      // Should still be running, enable not called again
      expect(pipeline.state.status).toBe('RUNNING');
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      pipeline.updateConfig({
        vad: { enabled: true, sensitivity: 0.8, location: 'browser' },
      });

      const config = pipeline.getConfig();
      expect(config.vad.enabled).toBe(true);
      expect(config.vad.sensitivity).toBe(0.8);
    });

    it('should merge config deeply', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, level: 'low', location: 'browser' },
        },
        mockLogger
      );

      pipeline.updateConfig({
        noiseFilter: { level: 'high' } as TranscriptionPipelineConfig['noiseFilter'],
      });

      const config = pipeline.getConfig();
      expect(config.noiseFilter.enabled).toBe(true);
      expect(config.noiseFilter.level).toBe('high');
    });
  });

  describe('toggleStage', () => {
    it('should toggle stage enabled state', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.toggleStage('noiseFilter', false);

      expect(mockNoiseFilter.disable).toHaveBeenCalled();

      const config = pipeline.getConfig();
      expect(config.noiseFilter.enabled).toBe(false);
    });

    it('should enable stage after being disabled', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: false, location: 'browser' } },
        mockLogger
      );

      await pipeline.toggleStage('noiseFilter', true);

      const config = pipeline.getConfig();
      expect(config.noiseFilter.enabled).toBe(true);
    });
  });

  describe('getProcessor', () => {
    it('should return processor by name', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const processor = pipeline.getProcessor('noiseFilter');
      expect(processor).toBeDefined();
    });

    it('should return null for non-existent processor', () => {
      const pipeline = new TranscriptionPipeline();

      expect(pipeline.getProcessor('noiseFilter')).toBeNull();
    });
  });

  describe('getProcessedTrack', () => {
    it('should return original track when no processing', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const track = pipeline.getProcessedTrack();
      expect(track).toBe(mockTrack);
    });

    it('should return processed track when available', async () => {
      const processedTrack = {} as MediaStreamTrack;
      mockNoiseFilter.processedTrack = processedTrack;

      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const track = pipeline.getProcessedTrack();
      expect(track).toBe(processedTrack);

      // Cleanup
      mockNoiseFilter.processedTrack = null;
    });
  });

  describe('event handling', () => {
    it('should emit transcription events', async () => {
      const pipeline = new TranscriptionPipeline(
        { stt: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const transcriptionHandler = vi.fn();
      pipeline.on('transcription', transcriptionHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      // Get the data handler registered with the STT processor
      const dataHandler = mockSTT.on.mock.calls.find(
        (call) => call[0] === 'data'
      )?.[1] as (payload: unknown) => void;

      // Simulate STT transcription event
      dataHandler?.({
        type: 'stt-transcription',
        data: { text: 'Hello world', isFinal: true, confidence: 0.95 },
        timestamp: Date.now(),
      });

      expect(transcriptionHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello world', isFinal: true })
      );
    });

    it('should emit partialTranscription events', async () => {
      const pipeline = new TranscriptionPipeline(
        { stt: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const partialHandler = vi.fn();
      pipeline.on('partialTranscription', partialHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockSTT.on.mock.calls.find(
        (call) => call[0] === 'data'
      )?.[1] as (payload: unknown) => void;

      dataHandler?.({
        type: 'stt-transcription',
        data: { text: 'Hello', isFinal: false, confidence: 0.7 },
        timestamp: Date.now(),
      });

      expect(partialHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello', isFinal: false })
      );
    });

    it('should emit partialTranscription for stt-partial events', async () => {
      const pipeline = new TranscriptionPipeline(
        { stt: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const partialHandler = vi.fn();
      pipeline.on('partialTranscription', partialHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockSTT.on.mock.calls.find(
        (call) => call[0] === 'data'
      )?.[1] as (payload: unknown) => void;

      dataHandler?.({
        type: 'stt-partial',
        data: { text: 'Hello from partial event', isFinal: false, confidence: 0.5 },
        timestamp: Date.now(),
      });

      expect(partialHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Hello from partial event', isFinal: false })
      );
    });

    it('should emit VAD events', async () => {
      const pipeline = new TranscriptionPipeline(
        { vad: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const vadHandler = vi.fn();
      pipeline.on('vadEvent', vadHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockVAD.on.mock.calls.find(
        (call) => call[0] === 'data'
      )?.[1] as (payload: unknown) => void;

      dataHandler?.({
        type: 'vad-speech-start',
        data: {},
        timestamp: Date.now(),
      });

      expect(vadHandler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'speech-start' })
      );
    });

    it('should transcribe VAD speech-end segments when local STT is VAD-gated', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          vad: { enabled: true, location: 'browser' },
          stt: { enabled: true, location: 'browser', provider: 'local' },
        },
        mockLogger
      );

      const transcriptionHandler = vi.fn();
      pipeline.on('transcription', transcriptionHandler);

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const dataHandler = mockVAD.on.mock.calls.find(
        (call) => call[0] === 'data'
      )?.[1] as (payload: unknown) => void;

      const speechAudio = new Float32Array([0.2, -0.1, 0.4]);
      dataHandler?.({
        type: 'vad-speech-end',
        data: { audio: speechAudio },
        timestamp: Date.now(),
      });

      await Promise.resolve();

      expect(mockSTT.transcribeSegment).toHaveBeenCalledWith(speechAudio);
      expect(transcriptionHandler).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'speech segment', isFinal: true })
      );
    });
  });

  describe('destroy', () => {
    it('should destroy pipeline and clear resources', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.destroy();

      expect(pipeline.isInitialized).toBe(false);
      expect(pipeline.state.status).toBe('IDLE');
    });
  });

  // =========================================================================
  // BUG-02: AudioContext/MediaStream leak
  // =========================================================================

  describe('BUG-02: stop() should release audio resources', () => {
    it('should stop all MediaStream tracks when stopping', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const mockStop = vi.fn();
      const trackWithStop = { ...mockTrack, stop: mockStop };

      await pipeline.start({ track: trackWithStop as any, audioContext: mockAudioContext });
      await pipeline.stop();

      expect(mockStop).toHaveBeenCalled();
    });

    it('should close AudioContext when stopping (contextOwnership: owned)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          contextOwnership: 'owned',
        },
        mockLogger
      );

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxWithClose = { ...mockAudioContext, close: mockClose, state: 'running' };

      await pipeline.start({ track: mockTrack, audioContext: ctxWithClose as any });
      await pipeline.stop();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should NOT close AudioContext when contextOwnership is borrowed (default)', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxWithClose = { ...mockAudioContext, close: mockClose, state: 'running' };

      await pipeline.start({ track: mockTrack, audioContext: ctxWithClose as any });
      await pipeline.stop();

      expect(mockClose).not.toHaveBeenCalled();
    });

    it('should not close AudioContext if already closed (owned context)', async () => {
      const pipeline = new TranscriptionPipeline(
        {
          noiseFilter: { enabled: true, location: 'browser' },
          contextOwnership: 'owned',
        },
        mockLogger
      );

      const mockClose = vi.fn().mockResolvedValue(undefined);
      const ctxAlreadyClosed = { ...mockAudioContext, close: mockClose, state: 'closed' };

      await pipeline.start({ track: mockTrack, audioContext: ctxAlreadyClosed as any });
      await pipeline.stop();

      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // BUG-15: pause()/resume() should be async
  // =========================================================================

  describe('BUG-15: pause/resume should await processor operations', () => {
    it('pause() should return a Promise', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });

      const result = pipeline.pause();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('resume() should return a Promise', async () => {
      const pipeline = new TranscriptionPipeline(
        { noiseFilter: { enabled: true, location: 'browser' } },
        mockLogger
      );

      await pipeline.start({ track: mockTrack, audioContext: mockAudioContext });
      await pipeline.pause();

      const result = pipeline.resume();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
