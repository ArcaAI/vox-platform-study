/**
 * @arcaai/stt - BaseSTTProvider Tests
 *
 * Tests for the abstract base provider class functionality.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseSTTProvider } from '../providers/BaseSTTProvider.js';
import type { TranscriptionResult, STTStats, ProviderConfig } from '../types/index.js';

// Concrete implementation for testing
class TestSTTProvider extends BaseSTTProvider {
  readonly name = 'test-provider';
  readonly type = 'local' as const;

  isSupported(): boolean {
    return true;
  }

  async init(_config: ProviderConfig): Promise<void> {
    this.initialized = true;
  }

  async start(): Promise<void> {
    this.processing = true;
  }

  async stop(): Promise<void> {
    this.processing = false;
  }

  async processAudio(_audio: Float32Array, _sampleRate: number): Promise<void> {
    // Implementation
  }

  async transcribeSegment(audio: Float32Array): Promise<TranscriptionResult> {
    return {
      text: 'test transcription',
      isFinal: true,
      language: 'en',
      duration: audio.length / 16000,
    };
  }

  async destroy(): Promise<void> {
    this.initialized = false;
    this.processing = false;
  }

  // Expose protected methods for testing
  public testEmitTranscription(result: TranscriptionResult): void {
    this.emitTranscription(result);
  }

  public testEmitError(error: Error): void {
    this.emitError(error);
  }

  public testRecordTranscription(latencyMs: number, audioSeconds: number): void {
    this.recordTranscription(latencyMs, audioSeconds);
  }

  // Expose protected state for testing
  public getInitialized(): boolean {
    return this.initialized;
  }

  public getProcessing(): boolean {
    return this.processing;
  }
}

describe('BaseSTTProvider', () => {
  let provider: TestSTTProvider;

  beforeEach(() => {
    provider = new TestSTTProvider();
  });

  describe('initial state', () => {
    it('should start uninitialized', () => {
      expect(provider.isReady()).toBe(false);
      expect(provider.getInitialized()).toBe(false);
    });

    it('should start not processing', () => {
      expect(provider.isProcessing()).toBe(false);
      expect(provider.getProcessing()).toBe(false);
    });
  });

  describe('isReady', () => {
    it('should return false before init', () => {
      expect(provider.isReady()).toBe(false);
    });

    it('should return true after init', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      expect(provider.isReady()).toBe(true);
    });

    it('should return false after destroy', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      await provider.destroy();

      expect(provider.isReady()).toBe(false);
    });
  });

  describe('isProcessing', () => {
    it('should return false before start', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      expect(provider.isProcessing()).toBe(false);
    });

    it('should return true after start', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
      await provider.start();

      expect(provider.isProcessing()).toBe(true);
    });

    it('should return false after stop', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
      await provider.start();
      await provider.stop();

      expect(provider.isProcessing()).toBe(false);
    });
  });

  describe('onTranscription', () => {
    it('should set transcription callback', () => {
      const callback = vi.fn();
      provider.onTranscription(callback);

      const result: TranscriptionResult = {
        text: 'Hello',
        isFinal: true,
        language: 'en',
      };

      provider.testEmitTranscription(result);

      expect(callback).toHaveBeenCalledWith(result);
    });

    it('should replace existing callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      provider.onTranscription(callback1);
      provider.onTranscription(callback2);

      const result: TranscriptionResult = {
        text: 'Test',
        isFinal: true,
        language: 'en',
      };

      provider.testEmitTranscription(result);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith(result);
    });

    it('should not throw if no callback set', () => {
      const result: TranscriptionResult = {
        text: 'Test',
        isFinal: true,
        language: 'en',
      };

      expect(() => provider.testEmitTranscription(result)).not.toThrow();
    });
  });

  describe('onError', () => {
    it('should set error callback', () => {
      const callback = vi.fn();
      provider.onError(callback);

      const error = new Error('Test error');
      provider.testEmitError(error);

      expect(callback).toHaveBeenCalledWith(error);
    });

    it('should replace existing callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      provider.onError(callback1);
      provider.onError(callback2);

      const error = new Error('Test');
      provider.testEmitError(error);

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith(error);
    });

    it('should not throw if no callback set', () => {
      const error = new Error('Test');
      expect(() => provider.testEmitError(error)).not.toThrow();
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = provider.getStats();

      expect(stats.isActive).toBe(false);
      expect(stats.isProcessing).toBe(false);
      expect(stats.totalAudioProcessed).toBe(0);
      expect(stats.transcriptionCount).toBe(0);
      expect(stats.averageLatencyMs).toBe(0);
      expect(stats.bufferSizeS).toBe(0);
      expect(stats.providerType).toBe('local');
      expect(stats.timestamp).toBeDefined();
    });

    it('should reflect initialized state', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      const stats = provider.getStats();

      expect(stats.isActive).toBe(true);
    });

    it('should reflect processing state', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
      await provider.start();

      const stats = provider.getStats();

      expect(stats.isProcessing).toBe(true);
    });

    it('should track transcription count', () => {
      provider.testRecordTranscription(100, 5);
      provider.testRecordTranscription(150, 5);
      provider.testRecordTranscription(200, 5);

      const stats = provider.getStats();

      expect(stats.transcriptionCount).toBe(3);
    });

    it('should calculate average latency', () => {
      provider.testRecordTranscription(100, 5);
      provider.testRecordTranscription(200, 5);
      provider.testRecordTranscription(300, 5);

      const stats = provider.getStats();

      expect(stats.averageLatencyMs).toBe(200); // (100 + 200 + 300) / 3
    });

    it('should track total audio processed', () => {
      provider.testRecordTranscription(100, 5);
      provider.testRecordTranscription(150, 10);
      provider.testRecordTranscription(200, 15);

      const stats = provider.getStats();

      expect(stats.totalAudioProcessed).toBe(30); // 5 + 10 + 15
    });

    it('should return current timestamp', () => {
      const before = Date.now();
      const stats = provider.getStats();
      const after = Date.now();

      expect(stats.timestamp).toBeGreaterThanOrEqual(before);
      expect(stats.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('recordTranscription', () => {
    it('should increment transcription count', () => {
      expect(provider.getStats().transcriptionCount).toBe(0);

      provider.testRecordTranscription(100, 5);

      expect(provider.getStats().transcriptionCount).toBe(1);
    });

    it('should accumulate latency', () => {
      provider.testRecordTranscription(100, 5);
      provider.testRecordTranscription(200, 5);

      const stats = provider.getStats();

      expect(stats.averageLatencyMs).toBe(150);
    });

    it('should accumulate audio processed', () => {
      provider.testRecordTranscription(100, 2.5);
      provider.testRecordTranscription(100, 3.5);

      const stats = provider.getStats();

      expect(stats.totalAudioProcessed).toBe(6);
    });

    it('should handle zero latency', () => {
      provider.testRecordTranscription(0, 5);

      const stats = provider.getStats();

      expect(stats.transcriptionCount).toBe(1);
      expect(stats.averageLatencyMs).toBe(0);
    });

    it('should handle zero audio seconds', () => {
      provider.testRecordTranscription(100, 0);

      const stats = provider.getStats();

      expect(stats.transcriptionCount).toBe(1);
      expect(stats.totalAudioProcessed).toBe(0);
    });
  });

  describe('provider name and type', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('test-provider');
    });

    it('should have correct type', () => {
      expect(provider.type).toBe('local');
    });
  });

  describe('lifecycle', () => {
    it('should follow correct lifecycle: init -> start -> stop -> destroy', async () => {
      expect(provider.isReady()).toBe(false);
      expect(provider.isProcessing()).toBe(false);

      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
      expect(provider.isReady()).toBe(true);
      expect(provider.isProcessing()).toBe(false);

      await provider.start();
      expect(provider.isReady()).toBe(true);
      expect(provider.isProcessing()).toBe(true);

      await provider.stop();
      expect(provider.isReady()).toBe(true);
      expect(provider.isProcessing()).toBe(false);

      await provider.destroy();
      expect(provider.isReady()).toBe(false);
      expect(provider.isProcessing()).toBe(false);
    });

    it('should allow multiple start/stop cycles', async () => {
      await provider.init({
        language: 'en',
        sampleRate: 16000,
        channels: 1,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      for (let i = 0; i < 3; i++) {
        await provider.start();
        expect(provider.isProcessing()).toBe(true);

        await provider.stop();
        expect(provider.isProcessing()).toBe(false);
      }
    });
  });

  describe('isSupported', () => {
    it('should return true for test provider', () => {
      expect(provider.isSupported()).toBe(true);
    });
  });

  describe('transcribeSegment', () => {
    it('should return transcription result', async () => {
      const audio = new Float32Array(16000); // 1 second at 16kHz
      const result = await provider.transcribeSegment(audio);

      expect(result.text).toBe('test transcription');
      expect(result.isFinal).toBe(true);
      expect(result.language).toBe('en');
      expect(result.duration).toBe(1);
    });
  });
});

// Test with backend type
describe('BaseSTTProvider - Backend Type', () => {
  class BackendTestProvider extends BaseSTTProvider {
    readonly name = 'backend-test';
    readonly type = 'backend' as const;

    isSupported(): boolean {
      return true;
    }

    async init(_config: ProviderConfig): Promise<void> {
      this.initialized = true;
    }

    async start(): Promise<void> {
      this.processing = true;
    }

    async stop(): Promise<void> {
      this.processing = false;
    }

    async processAudio(_audio: Float32Array, _sampleRate: number): Promise<void> {}

    async transcribeSegment(_audio: Float32Array): Promise<TranscriptionResult> {
      return {
        text: '',
        isFinal: true,
        language: 'en',
      };
    }

    async destroy(): Promise<void> {
      this.initialized = false;
    }
  }

  it('should report backend type in stats', () => {
    const backendProvider = new BackendTestProvider();
    const stats = backendProvider.getStats();

    expect(stats.providerType).toBe('backend');
  });
});
