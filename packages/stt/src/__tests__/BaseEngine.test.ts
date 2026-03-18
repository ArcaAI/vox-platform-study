/**
 * @arcaai/stt - BaseEngine Tests
 *
 * Tests for the abstract base engine class functionality.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BaseEngine } from '../engines/BaseEngine.js';
import type { TranscriptionResult } from '../types/index.js';
import type { EngineConfig, TranscribeOptions } from '../engines/types.js';

// Concrete implementation for testing
class TestEngine extends BaseEngine {
  readonly name = 'test-engine';

  isSupported(): boolean {
    return true;
  }

  async init(config: EngineConfig): Promise<void> {
    this.config = config;
    this.modelLoadTimeMs = 500; // Simulate load time
    this.initialized = true;
  }

  async transcribe(
    audio: Float32Array,
    options?: TranscribeOptions
  ): Promise<TranscriptionResult> {
    this.transcribing = true;
    const startTime = performance.now();

    // Simulate transcription
    const result: TranscriptionResult = {
      text: 'Test transcription result',
      isFinal: true,
      language: options?.language ?? this.config?.language ?? 'en',
      duration: audio.length / 16000,
    };

    const latencyMs = performance.now() - startTime;
    this.recordTranscription(latencyMs);
    this.transcribing = false;

    return result;
  }

  async destroy(): Promise<void> {
    this.config = null;
    this.initialized = false;
    this.transcribing = false;
  }

  // Expose protected methods for testing
  public testRecordTranscription(latencyMs: number): void {
    this.recordTranscription(latencyMs);
  }

  public testGetModelId(
    model: string,
    language: string,
    quantized: boolean
  ): string {
    return this.getModelId(model, language, quantized);
  }

  // Expose protected state for testing
  public getConfig(): EngineConfig | null {
    return this.config;
  }

  public getTranscribing(): boolean {
    return this.transcribing;
  }
}

describe('BaseEngine', () => {
  let engine: TestEngine;

  beforeEach(() => {
    engine = new TestEngine();
  });

  describe('initial state', () => {
    it('should start uninitialized', () => {
      expect(engine.isReady()).toBe(false);
    });

    it('should have correct name', () => {
      expect(engine.name).toBe('test-engine');
    });
  });

  describe('isReady', () => {
    it('should return false before init', () => {
      expect(engine.isReady()).toBe(false);
    });

    it('should return true after init', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      expect(engine.isReady()).toBe(true);
    });

    it('should return false after destroy', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      await engine.destroy();

      expect(engine.isReady()).toBe(false);
    });
  });

  describe('isSupported', () => {
    it('should return true for test engine', () => {
      expect(engine.isSupported()).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = engine.getStats();

      expect(stats.isInitialized).toBe(false);
      expect(stats.isTranscribing).toBe(false);
      expect(stats.model).toBe('unknown');
      expect(stats.device).toBe('wasm');
      expect(stats.transcriptionCount).toBe(0);
      expect(stats.averageLatencyMs).toBe(0);
      expect(stats.modelLoadTimeMs).toBeUndefined();
    });

    it('should reflect initialized state', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'webgpu',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      const stats = engine.getStats();

      expect(stats.isInitialized).toBe(true);
      expect(stats.model).toBe('tiny');
      expect(stats.device).toBe('webgpu');
      expect(stats.modelLoadTimeMs).toBe(500);
    });

    it('should track transcription count', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      await engine.transcribe(new Float32Array(16000));
      await engine.transcribe(new Float32Array(16000));
      await engine.transcribe(new Float32Array(16000));

      const stats = engine.getStats();

      expect(stats.transcriptionCount).toBe(3);
    });

    it('should calculate average latency', () => {
      engine.testRecordTranscription(100);
      engine.testRecordTranscription(200);
      engine.testRecordTranscription(300);

      const stats = engine.getStats();

      expect(stats.averageLatencyMs).toBe(200);
      expect(stats.transcriptionCount).toBe(3);
    });

    it('should return 0 average latency when no transcriptions', () => {
      const stats = engine.getStats();

      expect(stats.averageLatencyMs).toBe(0);
    });
  });

  describe('recordTranscription', () => {
    it('should increment transcription count', () => {
      expect(engine.getStats().transcriptionCount).toBe(0);

      engine.testRecordTranscription(100);

      expect(engine.getStats().transcriptionCount).toBe(1);
    });

    it('should accumulate latency', () => {
      engine.testRecordTranscription(100);
      engine.testRecordTranscription(300);

      const stats = engine.getStats();

      expect(stats.transcriptionCount).toBe(2);
      expect(stats.averageLatencyMs).toBe(200);
    });

    it('should handle zero latency', () => {
      engine.testRecordTranscription(0);

      const stats = engine.getStats();

      expect(stats.transcriptionCount).toBe(1);
      expect(stats.averageLatencyMs).toBe(0);
    });

    it('should handle very large latency values', () => {
      engine.testRecordTranscription(10000);
      engine.testRecordTranscription(20000);

      const stats = engine.getStats();

      expect(stats.averageLatencyMs).toBe(15000);
    });
  });

  describe('getModelId', () => {
    it('should generate correct model ID for English', () => {
      const modelId = engine.testGetModelId('tiny', 'en', true);

      expect(modelId).toBe('onnx-community/whisper-tiny.en');
    });

    it('should generate correct model ID for English with locale', () => {
      const modelId = engine.testGetModelId('tiny', 'en-US', true);

      expect(modelId).toBe('onnx-community/whisper-tiny.en');
    });

    it('should generate correct model ID for non-English', () => {
      const modelId = engine.testGetModelId('tiny', 'es', true);

      expect(modelId).toBe('onnx-community/whisper-tiny');
    });

    it('should use Xenova prefix for non-quantized models', () => {
      const modelId = engine.testGetModelId('tiny', 'en', false);

      expect(modelId).toBe('Xenova/whisper-tiny.en');
    });

    it('should handle different model sizes', () => {
      expect(engine.testGetModelId('base', 'en', true)).toBe('onnx-community/whisper-base.en');
      expect(engine.testGetModelId('small', 'en', true)).toBe('onnx-community/whisper-small.en');
      expect(engine.testGetModelId('medium', 'en', true)).toBe('onnx-community/whisper-medium.en');
      expect(engine.testGetModelId('large', 'en', true)).toBe('onnx-community/whisper-large.en');
    });

    it('should handle different languages', () => {
      expect(engine.testGetModelId('tiny', 'fr', true)).toBe('onnx-community/whisper-tiny');
      expect(engine.testGetModelId('tiny', 'de', true)).toBe('onnx-community/whisper-tiny');
      expect(engine.testGetModelId('tiny', 'ja', true)).toBe('onnx-community/whisper-tiny');
      expect(engine.testGetModelId('tiny', 'zh', true)).toBe('onnx-community/whisper-tiny');
    });
  });

  describe('transcribe', () => {
    beforeEach(async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
    });

    it('should return transcription result', async () => {
      const audio = new Float32Array(16000);
      const result = await engine.transcribe(audio);

      expect(result.text).toBe('Test transcription result');
      expect(result.isFinal).toBe(true);
      expect(result.language).toBe('en');
      expect(result.duration).toBe(1);
    });

    it('should use config language by default', async () => {
      const audio = new Float32Array(16000);
      const result = await engine.transcribe(audio);

      expect(result.language).toBe('en');
    });

    it('should use options language if provided', async () => {
      const audio = new Float32Array(16000);
      const result = await engine.transcribe(audio, { language: 'es' });

      expect(result.language).toBe('es');
    });

    it('should track transcription in stats', async () => {
      const audio = new Float32Array(16000);
      await engine.transcribe(audio);

      const stats = engine.getStats();

      expect(stats.transcriptionCount).toBe(1);
    });

    it('should calculate duration based on audio length', async () => {
      const audio = new Float32Array(32000); // 2 seconds at 16kHz
      const result = await engine.transcribe(audio);

      expect(result.duration).toBe(2);
    });
  });

  describe('lifecycle', () => {
    it('should follow correct lifecycle', async () => {
      expect(engine.isReady()).toBe(false);

      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });
      expect(engine.isReady()).toBe(true);
      expect(engine.getConfig()).not.toBeNull();

      await engine.destroy();
      expect(engine.isReady()).toBe(false);
      expect(engine.getConfig()).toBeNull();
    });

    it('should preserve stats after destroy', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      await engine.transcribe(new Float32Array(16000));
      await engine.transcribe(new Float32Array(16000));

      await engine.destroy();

      const stats = engine.getStats();
      expect(stats.transcriptionCount).toBe(2);
    });
  });

  describe('config storage', () => {
    it('should store config after init', async () => {
      const config: EngineConfig = {
        model: 'small',
        language: 'fr',
        device: 'webgpu',
        quantized: false,
        chunkLengthS: 20,
        strideLengthS: 3,
        returnTimestamps: false,
      };

      await engine.init(config);

      expect(engine.getConfig()).toEqual(config);
    });

    it('should clear config after destroy', async () => {
      await engine.init({
        model: 'tiny',
        language: 'en',
        device: 'wasm',
        quantized: true,
        chunkLengthS: 30,
        strideLengthS: 5,
        returnTimestamps: true,
      });

      expect(engine.getConfig()).not.toBeNull();

      await engine.destroy();

      expect(engine.getConfig()).toBeNull();
    });
  });
});

// Test unsupported engine
describe('BaseEngine - Unsupported', () => {
  class UnsupportedEngine extends BaseEngine {
    readonly name = 'unsupported-engine';

    isSupported(): boolean {
      return false;
    }

    async init(_config: EngineConfig): Promise<void> {}

    async transcribe(_audio: Float32Array): Promise<TranscriptionResult> {
      return { text: '', isFinal: true, language: 'en' };
    }

    async destroy(): Promise<void> {}
  }

  it('should report unsupported', () => {
    const engine = new UnsupportedEngine();
    expect(engine.isSupported()).toBe(false);
  });
});
