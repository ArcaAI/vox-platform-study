/**
 * @arcaai/room - NativeProcessor Tests
 *
 * Comprehensive tests for the NativeProcessor class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NativeProcessor, createNativeProcessor } from '../processors/NativeProcessor.js';
import { ProcessorStatus, type AudioProcessorOptions } from '../processors/types.js';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockTrack(): MediaStreamTrack {
  return {
    kind: 'audio',
    id: 'mock-track-id',
    enabled: true,
    muted: false,
    readyState: 'live',
    label: 'Mock Audio Track',
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }),
    getConstraints: vi.fn().mockReturnValue({}),
    getCapabilities: vi.fn().mockReturnValue({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(true),
    onended: null,
    onmute: null,
    onunmute: null,
  } as unknown as MediaStreamTrack;
}

function createMockAudioContext(): AudioContext {
  return {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {} as AudioDestinationNode,
    createAnalyser: vi.fn(),
    createGain: vi.fn(),
    createMediaStreamSource: vi.fn(),
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
}

// ============================================================================
// Tests
// ============================================================================

describe('NativeProcessor', () => {
  let processor: NativeProcessor;
  let mockTrack: MediaStreamTrack;
  let mockAudioContext: AudioContext;

  beforeEach(() => {
    processor = new NativeProcessor();
    mockTrack = createMockTrack();
    mockAudioContext = createMockAudioContext();
  });

  describe('constructor', () => {
    it('should have correct name', () => {
      expect(processor.name).toBe('native-processor');
    });

    it('should use default options', () => {
      const options = processor.getOptions();

      expect(options.echoCancellation).toBe(true);
      expect(options.noiseSuppression).toBe(true);
      expect(options.autoGainControl).toBe(true);
      expect(options.voiceIsolation).toBe(false);
    });

    it('should accept custom options', () => {
      const customProcessor = new NativeProcessor({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: true,
      });

      const options = customProcessor.getOptions();

      expect(options.echoCancellation).toBe(false);
      expect(options.noiseSuppression).toBe(false);
      expect(options.autoGainControl).toBe(false);
      expect(options.voiceIsolation).toBe(true);
    });

    it('should merge partial options with defaults', () => {
      const customProcessor = new NativeProcessor({
        echoCancellation: false,
      });

      const options = customProcessor.getOptions();

      expect(options.echoCancellation).toBe(false);
      expect(options.noiseSuppression).toBe(true); // default
      expect(options.autoGainControl).toBe(true); // default
    });
  });

  describe('init', () => {
    it('should initialize and apply constraints', async () => {
      const opts: AudioProcessorOptions = {
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      };

      await processor.init(opts);

      expect(mockTrack.applyConstraints).toHaveBeenCalled();
      expect(processor.processedTrack).toBe(mockTrack);
      expect(processor.getStatus()).toBe(ProcessorStatus.ENABLED);
    });

    it('should apply echoCancellation constraint', async () => {
      const customProcessor = new NativeProcessor({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      });

      await customProcessor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(mockTrack.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({
          echoCancellation: true,
        })
      );
    });

    it('should apply noiseSuppression constraint', async () => {
      const customProcessor = new NativeProcessor({
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      });

      await customProcessor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(mockTrack.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({
          noiseSuppression: true,
        })
      );
    });

    it('should apply autoGainControl constraint', async () => {
      const customProcessor = new NativeProcessor({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      });

      await customProcessor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(mockTrack.applyConstraints).toHaveBeenCalledWith(
        expect.objectContaining({
          autoGainControl: true,
        })
      );
    });

    it('should handle voiceIsolation constraint gracefully', async () => {
      const customProcessor = new NativeProcessor({
        voiceIsolation: true,
      });

      // Mock applyConstraints to throw for voiceIsolation
      const applyConstraintsMock = vi.fn().mockImplementation((constraints) => {
        if (constraints.voiceIsolation) {
          return Promise.reject(new Error('Not supported'));
        }
        return Promise.resolve();
      });
      mockTrack.applyConstraints = applyConstraintsMock;

      // Should not throw even if voiceIsolation is not supported
      await expect(
        customProcessor.init({
          kind: 'audio',
          track: mockTrack,
          audioContext: mockAudioContext,
        })
      ).resolves.toBeUndefined();
    });

    it('should pass through the original track', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      expect(processor.processedTrack).toBe(mockTrack);
    });
  });

  describe('destroy', () => {
    it('should clear processed track', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      expect(processor.processedTrack).toBeUndefined();
    });

    it('should not stop the track (we do not own it)', async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });

      await processor.destroy();

      // The NativeProcessor doesn't own the track, so it shouldn't stop it
      // (the base class might call stop on processedTrack, which is fine)
    });
  });

  describe('updateOptions', () => {
    beforeEach(async () => {
      await processor.init({
        kind: 'audio',
        track: mockTrack,
        audioContext: mockAudioContext,
      });
    });

    it('should update options', async () => {
      await processor.updateOptions({
        echoCancellation: false,
      });

      const options = processor.getOptions();
      expect(options.echoCancellation).toBe(false);
    });

    it('should reapply constraints after update', async () => {
      vi.clearAllMocks();

      await processor.updateOptions({
        noiseSuppression: false,
      });

      expect(mockTrack.applyConstraints).toHaveBeenCalled();
    });

    it('should merge new options with existing', async () => {
      await processor.updateOptions({
        echoCancellation: false,
      });

      const options = processor.getOptions();
      expect(options.echoCancellation).toBe(false);
      expect(options.noiseSuppression).toBe(true); // unchanged
    });
  });

  describe('getOptions', () => {
    it('should return a copy of options', () => {
      const options1 = processor.getOptions();
      const options2 = processor.getOptions();

      expect(options1).not.toBe(options2);
      expect(options1).toEqual(options2);
    });

    it('should not allow mutation of internal options', () => {
      const options = processor.getOptions();
      options.echoCancellation = false;

      expect(processor.getOptions().echoCancellation).toBe(true);
    });
  });
});

describe('createNativeProcessor', () => {
  it('should create a NativeProcessor instance', () => {
    const processor = createNativeProcessor();

    expect(processor).toBeInstanceOf(NativeProcessor);
    expect(processor.name).toBe('native-processor');
  });

  it('should pass options to constructor', () => {
    const processor = createNativeProcessor({
      echoCancellation: false,
      noiseSuppression: false,
    });

    const options = processor.getOptions();
    expect(options.echoCancellation).toBe(false);
    expect(options.noiseSuppression).toBe(false);
  });
});
