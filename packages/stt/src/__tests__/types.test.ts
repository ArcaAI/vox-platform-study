/**
 * @arcaai/stt - Types Tests
 *
 * Tests for type definitions, error classes, and constants.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  STTError,
  STTErrorCode,
  DEFAULT_STT_OPTIONS,
  DEFAULT_AUDIO_CONFIG,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_LANGUAGE_LOCALE,
  generateSessionId,
  getLanguageCode,
  getCountryCode,
  isWhisperModelSize,
  parseModelId,
  type STTOptions,
  type TranscriptionResult,
  type STTStats,
  type STTBrowserSupport,
  type ModelLoadProgress,
  type WSInboundMessage,
  type WSOutboundMessage,
} from '../types/index.js';

describe('STTError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new STTError(
        STTErrorCode.MODEL_LOAD_FAILED,
        'Failed to load model'
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(STTError);
      expect(error.code).toBe(STTErrorCode.MODEL_LOAD_FAILED);
      expect(error.message).toBe('Failed to load model');
      expect(error.name).toBe('STTError');
      expect(error.cause).toBeUndefined();
    });

    it('should create error with cause', () => {
      const originalError = new Error('Network error');
      const error = new STTError(
        STTErrorCode.WEBSOCKET_ERROR,
        'WebSocket connection failed',
        originalError
      );

      expect(error.cause).toBe(originalError);
    });

    it('should be throwable and catchable', () => {
      const throwError = () => {
        throw new STTError(
          STTErrorCode.NOT_SUPPORTED,
          'Browser not supported'
        );
      };

      expect(throwError).toThrow(STTError);
      expect(throwError).toThrow('Browser not supported');
    });
  });

  describe('error codes', () => {
    it('should have all defined error codes', () => {
      expect(STTErrorCode.MODEL_LOAD_FAILED).toBe('MODEL_LOAD_FAILED');
      expect(STTErrorCode.WEBSOCKET_ERROR).toBe('WEBSOCKET_ERROR');
      expect(STTErrorCode.SESSION_ERROR).toBe('SESSION_ERROR');
      expect(STTErrorCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR');
      expect(STTErrorCode.NOT_SUPPORTED).toBe('NOT_SUPPORTED');
      expect(STTErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
      expect(STTErrorCode.TRANSCRIPTION_FAILED).toBe('TRANSCRIPTION_FAILED');
      expect(STTErrorCode.PROVIDER_INIT_FAILED).toBe('PROVIDER_INIT_FAILED');
    });

    it('should allow using error codes in switch statements', () => {
      const error = new STTError(STTErrorCode.MODEL_LOAD_FAILED, 'Test');

      let handled = false;
      switch (error.code) {
        case STTErrorCode.MODEL_LOAD_FAILED:
          handled = true;
          break;
        default:
          handled = false;
      }

      expect(handled).toBe(true);
    });
  });
});

describe('DEFAULT_STT_OPTIONS', () => {
  it('should have all required default values', () => {
    expect(DEFAULT_STT_OPTIONS.enableStats).toBe(false);
    expect(DEFAULT_STT_OPTIONS.statsInterval).toBe(1000);
  });

  it('should be immutable in terms of structure', () => {
    // Verify the shape is correct - this is more of a compile-time check
    const options = { ...DEFAULT_STT_OPTIONS };

    expect(options).toEqual(DEFAULT_STT_OPTIONS);
  });
});

describe('DEFAULT_AUDIO_CONFIG', () => {
  it('should have all required default values', () => {
    expect(DEFAULT_AUDIO_CONFIG.language).toBe('en-US');
    expect(DEFAULT_AUDIO_CONFIG.sampleRate).toBe(16000);
    expect(DEFAULT_AUDIO_CONFIG.channels).toBe(1);
    expect(DEFAULT_AUDIO_CONFIG.chunkLengthS).toBe(30);
    expect(DEFAULT_AUDIO_CONFIG.overlapLengthS).toBe(5);
  });
});

describe('DEFAULT_FEATURE_FLAGS', () => {
  it('should have all required default values', () => {
    expect(DEFAULT_FEATURE_FLAGS.provider).toBe('remote');
    expect(DEFAULT_FEATURE_FLAGS.diarization).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.numSpeakers).toBe(2);
    expect(DEFAULT_FEATURE_FLAGS.returnTimestamps).toBe(true);
    expect(DEFAULT_FEATURE_FLAGS.device).toBe('auto');
    expect(DEFAULT_FEATURE_FLAGS.quantized).toBe(true);
  });
});

describe('DEFAULT_LANGUAGE_LOCALE', () => {
  it('should be en-US', () => {
    expect(DEFAULT_LANGUAGE_LOCALE).toBe('en-US');
  });
});

describe('generateSessionId', () => {
  it('should generate unique IDs', () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^stt-[a-z0-9]+-[a-z0-9]+$/);
    expect(id2).toMatch(/^stt-[a-z0-9]+-[a-z0-9]+$/);
  });
});

describe('Language utilities', () => {
  describe('getLanguageCode', () => {
    it('should extract language code from locale', () => {
      expect(getLanguageCode('en-US')).toBe('en');
      expect(getLanguageCode('fr-FR')).toBe('fr');
      expect(getLanguageCode('zh-CN')).toBe('zh');
    });

    it('should return input if no country code', () => {
      expect(getLanguageCode('en')).toBe('en');
    });
  });

  describe('getCountryCode', () => {
    it('should extract country code from locale', () => {
      expect(getCountryCode('en-US')).toBe('US');
      expect(getCountryCode('fr-FR')).toBe('FR');
      expect(getCountryCode('zh-CN')).toBe('CN');
    });

    it('should return undefined if no country code', () => {
      expect(getCountryCode('en')).toBeUndefined();
    });
  });
});

describe('Model utilities', () => {
  describe('isWhisperModelSize', () => {
    it('should return true for valid model sizes', () => {
      expect(isWhisperModelSize('tiny')).toBe(true);
      expect(isWhisperModelSize('base')).toBe(true);
      expect(isWhisperModelSize('small')).toBe(true);
      expect(isWhisperModelSize('medium')).toBe(true);
      expect(isWhisperModelSize('large')).toBe(true);
    });

    it('should return false for invalid model sizes', () => {
      expect(isWhisperModelSize('custom')).toBe(false);
      expect(isWhisperModelSize('huggingface/model')).toBe(false);
    });
  });

  describe('parseModelId', () => {
    it('should return model size for valid sizes', () => {
      expect(parseModelId('tiny')).toBe('tiny');
      expect(parseModelId('base')).toBe('base');
    });

    it('should return undefined for custom paths', () => {
      expect(parseModelId('huggingface/custom-model')).toBeUndefined();
    });
  });
});

describe('Type Definitions', () => {
  describe('STTOptions', () => {
    it('should allow valid options', () => {
      const options: STTOptions = {
        sttSocket: 'wss://example.com/ws',
        audio: {
          language: 'en-US',
          sampleRate: 16000,
          channels: 1,
          chunkLengthS: 30,
          overlapLengthS: 5,
        },
        features: {
          provider: 'local',
          modelId: 'tiny',
          device: 'webgpu',
          quantized: true,
          returnTimestamps: true,
          diarization: false,
          numSpeakers: 2,
        },
        enableStats: false,
        statsInterval: 1000,
      };

      expect(options.features?.provider).toBe('local');
    });

    it('should allow partial options', () => {
      const options: STTOptions = {
        audio: {
          language: 'es-ES',
        },
      };

      expect(options.audio?.language).toBe('es-ES');
      expect(options.features).toBeUndefined();
    });

    it('should allow remote-specific options', () => {
      const options: STTOptions = {
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        features: {
          provider: 'remote',
          diarization: true,
          numSpeakers: 3,
        },
        prompt: 'Medical transcription',
      };

      expect(options.sttSocket).toBe('wss://example.com/ws');
    });

    it('should allow local-specific options', () => {
      const options: STTOptions = {
        features: {
          provider: 'local',
          modelId: 'huggingface/custom-model',
        },
        onModelProgress: (_progress) => {},
      };

      expect(options.features?.modelId).toBe('huggingface/custom-model');
    });
  });

  describe('TranscriptionResult', () => {
    it('should require minimum fields', () => {
      const result: TranscriptionResult = {
        text: 'Hello world',
        isFinal: true,
        language: 'en',
      };

      expect(result.text).toBe('Hello world');
      expect(result.isFinal).toBe(true);
      expect(result.language).toBe('en');
    });

    it('should allow optional fields', () => {
      const result: TranscriptionResult = {
        text: 'Hello world',
        isFinal: true,
        language: 'en',
        confidence: 0.95,
        timestamps: [
          { start: 0, end: 0.5, text: 'Hello' },
          { start: 0.5, end: 1.0, text: 'world' },
        ],
        speakerId: 'speaker-1',
        duration: 1.0,
        latencyMs: 150,
      };

      expect(result.confidence).toBe(0.95);
      expect(result.timestamps).toHaveLength(2);
      expect(result.speakerId).toBe('speaker-1');
      expect(result.duration).toBe(1.0);
      expect(result.latencyMs).toBe(150);
    });
  });

  describe('STTStats', () => {
    it('should have all required fields', () => {
      const stats: STTStats = {
        isActive: true,
        isProcessing: false,
        totalAudioProcessed: 120.5,
        transcriptionCount: 15,
        averageLatencyMs: 200,
        bufferSizeS: 2.5,
        providerType: 'local',
        timestamp: Date.now(),
      };

      expect(stats.isActive).toBe(true);
      expect(stats.transcriptionCount).toBe(15);
    });

    it('should allow optional fields', () => {
      const stats: STTStats = {
        isActive: true,
        isProcessing: true,
        totalAudioProcessed: 60,
        transcriptionCount: 5,
        averageLatencyMs: 180,
        bufferSizeS: 1.5,
        providerType: 'local',
        model: 'tiny',
        device: 'webgpu',
        timestamp: Date.now(),
      };

      expect(stats.model).toBe('tiny');
      expect(stats.device).toBe('webgpu');
    });

    it('should allow remote-specific stats', () => {
      const stats: STTStats = {
        isActive: true,
        isProcessing: true,
        totalAudioProcessed: 60,
        transcriptionCount: 5,
        averageLatencyMs: 100,
        bufferSizeS: 0.5,
        providerType: 'remote',
        connectionStatus: 'connected',
        timestamp: Date.now(),
      };

      expect(stats.connectionStatus).toBe('connected');
    });
  });

  describe('STTBrowserSupport', () => {
    it('should have all required fields', () => {
      const support: STTBrowserSupport = {
        webAssembly: true,
        webGPU: true,
        audioWorklet: true,
        webSocket: true,
        sharedArrayBuffer: true,
        transformersJsSupported: true,
        recommendedDevice: 'webgpu',
        recommendedProvider: 'local',
        localSupported: true,
        backendSupported: true,
      };

      expect(support.webAssembly).toBe(true);
      expect(support.localSupported).toBe(true);
    });

    it('should allow unsupportedReason', () => {
      const support: STTBrowserSupport = {
        webAssembly: false,
        webGPU: false,
        audioWorklet: false,
        webSocket: false,
        sharedArrayBuffer: false,
        transformersJsSupported: false,
        recommendedDevice: 'wasm',
        recommendedProvider: 'local',
        localSupported: false,
        backendSupported: false,
        unsupportedReason: 'WebAssembly is not supported',
      };

      expect(support.unsupportedReason).toBe('WebAssembly is not supported');
    });
  });

  describe('ModelLoadProgress', () => {
    it('should support downloading status', () => {
      const progress: ModelLoadProgress = {
        status: 'downloading',
        progress: 0.5,
        file: 'model.bin',
        loaded: 50000000,
        total: 100000000,
      };

      expect(progress.status).toBe('downloading');
      expect(progress.progress).toBe(0.5);
    });

    it('should support loading status', () => {
      const progress: ModelLoadProgress = {
        status: 'loading',
        progress: 0.8,
      };

      expect(progress.status).toBe('loading');
    });

    it('should support ready status', () => {
      const progress: ModelLoadProgress = {
        status: 'ready',
        progress: 1,
      };

      expect(progress.status).toBe('ready');
    });

    it('should support error status', () => {
      const progress: ModelLoadProgress = {
        status: 'error',
        progress: 0,
        error: 'Network timeout',
      };

      expect(progress.status).toBe('error');
      expect(progress.error).toBe('Network timeout');
    });
  });

  describe('WebSocket Messages', () => {
    describe('WSOutboundMessage', () => {
      it('should support audio message', () => {
        const message: WSOutboundMessage = {
          type: 'audio',
          data: [0, 1, 2, 3],
          metadata: {
            sampleRate: 16000,
            channels: 1,
          },
        };

        expect(message.type).toBe('audio');
      });

      it('should support stop message', () => {
        const message: WSOutboundMessage = {
          type: 'stop',
        };

        expect(message.type).toBe('stop');
      });

      it('should support ping message', () => {
        const message: WSOutboundMessage = {
          type: 'ping',
        };

        expect(message.type).toBe('ping');
      });
    });

    describe('WSInboundMessage', () => {
      it('should support connected message', () => {
        const message: WSInboundMessage = {
          type: 'connected',
          session_id: 'session-123',
          audio_config: { sample_rate: 16000 },
          timestamp: '2024-01-01T00:00:00Z',
        };

        expect(message.type).toBe('connected');
        expect(message.session_id).toBe('session-123');
      });

      it('should support transcription message', () => {
        const message: WSInboundMessage = {
          type: 'transcription',
          text: 'Hello world',
          is_final: true,
          speaker_id: 'speaker-1',
          session_id: 'session-123',
          language: 'en',
        };

        expect(message.type).toBe('transcription');
        expect(message.text).toBe('Hello world');
        expect(message.is_final).toBe(true);
      });

      it('should support keepalive message', () => {
        const message: WSInboundMessage = {
          type: 'keepalive',
          session_id: 'session-123',
          timestamp: '2024-01-01T00:00:00Z',
        };

        expect(message.type).toBe('keepalive');
      });

      it('should support pong message', () => {
        const message: WSInboundMessage = {
          type: 'pong',
          session_id: 'session-123',
          timestamp: '2024-01-01T00:00:00Z',
        };

        expect(message.type).toBe('pong');
      });

      it('should support stopped message', () => {
        const message: WSInboundMessage = {
          type: 'stopped',
          session_id: 'session-123',
          timestamp: '2024-01-01T00:00:00Z',
        };

        expect(message.type).toBe('stopped');
      });

      it('should support error message', () => {
        const message: WSInboundMessage = {
          type: 'error',
          message: 'Session expired',
          session_id: 'session-123',
        };

        expect(message.type).toBe('error');
        expect(message.message).toBe('Session expired');
      });
    });
  });
});

describe('Type Guards and Validation', () => {
  it('should validate provider types', () => {
    const validProviders: Array<'local' | 'remote'> = ['local', 'remote'];

    validProviders.forEach((provider) => {
      const options: STTOptions = {
        features: { provider },
      };
      expect(options.features?.provider).toBe(provider);
    });
  });

  it('should validate model sizes via isWhisperModelSize', () => {
    const validModels = ['tiny', 'base', 'small', 'medium', 'large'];

    validModels.forEach((model) => {
      expect(isWhisperModelSize(model)).toBe(true);
    });
  });

  it('should validate compute devices', () => {
    const validDevices: Array<'webgpu' | 'wasm' | 'auto'> = ['webgpu', 'wasm', 'auto'];

    validDevices.forEach((device) => {
      const options: STTOptions = {
        features: { device },
      };
      expect(options.features?.device).toBe(device);
    });
  });

  it('should validate return timestamps options', () => {
    const validOptions: Array<boolean | 'word'> = [true, false, 'word'];

    validOptions.forEach((returnTimestamps) => {
      const options: STTOptions = {
        features: { returnTimestamps },
      };
      expect(options.features?.returnTimestamps).toBe(returnTimestamps);
    });
  });
});
