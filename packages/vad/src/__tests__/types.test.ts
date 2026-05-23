/**
 * @arcaai/vad - Types Tests
 *
 * Tests for VAD type definitions, constants, and error classes.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  VADError,
  VADErrorCode,
  DEFAULT_VAD_OPTIONS,
  type VADModel,
  type VADOptions,
  type VADStats,
  type VADFramePayload,
  type VADSpeechStartPayload,
  type VADSpeechRealStartPayload,
  type VADSpeechEndPayload,
  type VADMisfirePayload,
  type VADBrowserSupport,
  type VADDataEventType,
} from '../types/index.js';

describe('VAD Types', () => {
  describe('VADErrorCode', () => {
    it('should have all expected error codes', () => {
      expect(VADErrorCode.MODEL_LOAD_FAILED).toBe('MODEL_LOAD_FAILED');
      expect(VADErrorCode.WASM_LOAD_FAILED).toBe('WASM_LOAD_FAILED');
      expect(VADErrorCode.WORKLET_REGISTRATION_FAILED).toBe('WORKLET_REGISTRATION_FAILED');
      expect(VADErrorCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR');
      expect(VADErrorCode.NOT_SUPPORTED).toBe('NOT_SUPPORTED');
      expect(VADErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
      expect(VADErrorCode.ALREADY_RUNNING).toBe('ALREADY_RUNNING');
      expect(VADErrorCode.NOT_INITIALIZED).toBe('NOT_INITIALIZED');
    });

    it('should have 8 error codes', () => {
      const errorCodes = Object.values(VADErrorCode);
      expect(errorCodes.length).toBe(8);
    });
  });

  describe('VADError', () => {
    it('should create error with code and message', () => {
      const error = new VADError(VADErrorCode.MODEL_LOAD_FAILED, 'Model failed to load');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(VADError);
      expect(error.code).toBe(VADErrorCode.MODEL_LOAD_FAILED);
      expect(error.message).toBe('Model failed to load');
      expect(error.name).toBe('VADError');
    });

    it('should create error with cause', () => {
      const cause = new Error('Network error');
      const error = new VADError(VADErrorCode.WASM_LOAD_FAILED, 'WASM failed', cause);

      expect(error.cause).toBe(cause);
      expect(error.code).toBe(VADErrorCode.WASM_LOAD_FAILED);
    });

    it('should be throwable and catchable', () => {
      expect(() => {
        throw new VADError(VADErrorCode.NOT_SUPPORTED, 'Not supported');
      }).toThrow(VADError);

      try {
        throw new VADError(VADErrorCode.NOT_SUPPORTED, 'Not supported');
      } catch (e) {
        expect(e).toBeInstanceOf(VADError);
        if (e instanceof VADError) {
          expect(e.code).toBe(VADErrorCode.NOT_SUPPORTED);
        }
      }
    });

    it('should have proper error prototype chain', () => {
      const error = new VADError(VADErrorCode.PROCESSING_ERROR, 'Processing failed');

      expect(error instanceof Error).toBe(true);
      expect(error instanceof VADError).toBe(true);
      expect(Object.getPrototypeOf(error)).toBe(VADError.prototype);
    });
  });

  describe('DEFAULT_VAD_OPTIONS', () => {
    it('should have correct default model', () => {
      expect(DEFAULT_VAD_OPTIONS.model).toBe('v5');
    });

    it('should have correct default thresholds', () => {
      expect(DEFAULT_VAD_OPTIONS.positiveSpeechThreshold).toBe(0.5);
      expect(DEFAULT_VAD_OPTIONS.negativeSpeechThreshold).toBe(0.35);
    });

    it('should have correct padding defaults', () => {
      expect(DEFAULT_VAD_OPTIONS.preSpeechPadMs).toBe(300);
      expect(DEFAULT_VAD_OPTIONS.postSpeechPadMs).toBe(300);
    });

    it('should have correct timing defaults', () => {
      expect(DEFAULT_VAD_OPTIONS.minSpeechMs).toBe(250);
      expect(DEFAULT_VAD_OPTIONS.redemptionMs).toBe(1400);
    });

    it('should have correct sample rate', () => {
      expect(DEFAULT_VAD_OPTIONS.sampleRate).toBe(16000);
    });

    it('should have correct stats defaults', () => {
      expect(DEFAULT_VAD_OPTIONS.enableStats).toBe(false);
      expect(DEFAULT_VAD_OPTIONS.statsInterval).toBe(1000);
    });

    it('should have submitUserSpeechOnPause default to false', () => {
      expect(DEFAULT_VAD_OPTIONS.submitUserSpeechOnPause).toBe(false);
    });

    it('should have all required fields', () => {
      const requiredFields = [
        'model',
        'positiveSpeechThreshold',
        'negativeSpeechThreshold',
        'preSpeechPadMs',
        'postSpeechPadMs',
        'minSpeechMs',
        'redemptionMs',
        'sampleRate',
        'enableStats',
        'statsInterval',
        'submitUserSpeechOnPause',
      ];

      requiredFields.forEach((field) => {
        expect(DEFAULT_VAD_OPTIONS).toHaveProperty(field);
      });
    });

    it('should have sensible threshold relationship', () => {
      // Positive threshold should be higher than negative
      expect(DEFAULT_VAD_OPTIONS.positiveSpeechThreshold).toBeGreaterThan(
        DEFAULT_VAD_OPTIONS.negativeSpeechThreshold
      );
    });

    it('should have thresholds within valid probability range', () => {
      expect(DEFAULT_VAD_OPTIONS.positiveSpeechThreshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_VAD_OPTIONS.positiveSpeechThreshold).toBeLessThanOrEqual(1);
      expect(DEFAULT_VAD_OPTIONS.negativeSpeechThreshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_VAD_OPTIONS.negativeSpeechThreshold).toBeLessThanOrEqual(1);
    });
  });

  describe('Type Shapes', () => {
    describe('VADStats', () => {
      it('should have correct shape', () => {
        const stats: VADStats = {
          isActive: true,
          isSpeaking: false,
          speechProbability: 0.5,
          currentSpeechDuration: 100,
          framesProcessed: 10,
          speechSegmentsDetected: 2,
          misfireCount: 1,
          averageSpeechProbability: 0.45,
          timestamp: Date.now(),
        };

        expect(stats.isActive).toBe(true);
        expect(stats.isSpeaking).toBe(false);
        expect(stats.speechProbability).toBe(0.5);
        expect(stats.currentSpeechDuration).toBe(100);
        expect(stats.framesProcessed).toBe(10);
        expect(stats.speechSegmentsDetected).toBe(2);
        expect(stats.misfireCount).toBe(1);
        expect(stats.averageSpeechProbability).toBe(0.45);
        expect(typeof stats.timestamp).toBe('number');
      });
    });

    describe('VADFramePayload', () => {
      it('should have correct shape', () => {
        const payload: VADFramePayload = {
          isSpeech: true,
          probability: 0.85,
          notSpeechProbability: 0.15,
          timestamp: Date.now(),
        };

        expect(payload.isSpeech).toBe(true);
        expect(payload.probability).toBe(0.85);
        expect(payload.notSpeechProbability).toBe(0.15);
        expect(typeof payload.timestamp).toBe('number');
      });

      it('probabilities should sum to approximately 1', () => {
        const payload: VADFramePayload = {
          isSpeech: true,
          probability: 0.85,
          notSpeechProbability: 0.15,
          timestamp: Date.now(),
        };

        expect(payload.probability + payload.notSpeechProbability).toBeCloseTo(1, 5);
      });
    });

    describe('VADSpeechStartPayload', () => {
      it('should have correct shape', () => {
        const payload: VADSpeechStartPayload = {
          timestamp: Date.now(),
        };

        expect(typeof payload.timestamp).toBe('number');
      });
    });

    describe('VADSpeechRealStartPayload', () => {
      it('should have correct shape', () => {
        const payload: VADSpeechRealStartPayload = {
          timestamp: Date.now(),
        };

        expect(typeof payload.timestamp).toBe('number');
      });
    });

    describe('VADSpeechEndPayload', () => {
      it('should have correct shape with stream-relative timing and duration (ms)', () => {
        const audio = new Float32Array([0.1, 0.2, 0.3]);
        const startTime = Date.now() - 1000;
        const endTime = Date.now();

        const payload: VADSpeechEndPayload = {
          audio,
          segmentNumber: 1,
          startTime,
          endTime,
          streamStartSec: 5.0,
          streamEndSec: 6.0,
          durationSec: 1.0,
          duration: 1000,
        };

        expect(payload.audio).toBe(audio);
        expect(payload.segmentNumber).toBe(1);
        expect(payload.startTime).toBe(startTime);
        expect(payload.endTime).toBe(endTime);
        expect(payload.streamStartSec).toBe(5.0);
        expect(payload.streamEndSec).toBe(6.0);
        expect(payload.durationSec).toBe(1.0);
        expect(payload.duration).toBe(1000);
      });

      it('should have valid duration calculation in seconds and ms', () => {
        const audio = new Float32Array(16000); // 1 second at 16kHz
        const startTime = 1000;
        const endTime = 2000;

        const payload: VADSpeechEndPayload = {
          audio,
          segmentNumber: 3,
          startTime,
          endTime,
          streamStartSec: 10.0,
          streamEndSec: 11.0,
          durationSec: 1.0,
          duration: 1000,
        };

        expect(payload.durationSec).toBe(payload.streamEndSec - payload.streamStartSec);
        expect(payload.duration).toBe(payload.endTime - payload.startTime);
      });
    });

    describe('VADMisfirePayload', () => {
      it('should have correct shape', () => {
        const payload: VADMisfirePayload = {
          duration: 150,
          timestamp: Date.now(),
        };

        expect(payload.duration).toBe(150);
        expect(typeof payload.timestamp).toBe('number');
      });
    });

    describe('VADBrowserSupport', () => {
      it('should have correct shape', () => {
        const support: VADBrowserSupport = {
          webAssembly: true,
          audioWorklet: true,
          sharedArrayBuffer: false,
          onnxRuntime: true,
          vadSupported: true,
          recommendedModel: 'v5',
        };

        expect(support.webAssembly).toBe(true);
        expect(support.audioWorklet).toBe(true);
        expect(support.sharedArrayBuffer).toBe(false);
        expect(support.onnxRuntime).toBe(true);
        expect(support.vadSupported).toBe(true);
        expect(support.recommendedModel).toBe('v5');
      });

      it('should allow optional unsupportedReason', () => {
        const supportWithReason: VADBrowserSupport = {
          webAssembly: false,
          audioWorklet: true,
          sharedArrayBuffer: false,
          onnxRuntime: false,
          vadSupported: false,
          recommendedModel: 'legacy',
          unsupportedReason: 'WebAssembly not supported',
        };

        expect(supportWithReason.unsupportedReason).toBe('WebAssembly not supported');
      });
    });

  });

  describe('VADModel type', () => {
    it('should accept v5', () => {
      const model: VADModel = 'v5';
      expect(model).toBe('v5');
    });

    it('should accept legacy', () => {
      const model: VADModel = 'legacy';
      expect(model).toBe('legacy');
    });
  });

  describe('VADDataEventType', () => {
    it('should include all event types', () => {
      const eventTypes: VADDataEventType[] = [
        'vad-frame',
        'vad-speech-start',
        'vad-speech-real-start',
        'vad-speech-end',
        'vad-misfire',
        'vad-stats',
      ];

      eventTypes.forEach((eventType) => {
        expect(typeof eventType).toBe('string');
      });
    });
  });

  describe('VADOptions', () => {
    it('should allow partial options', () => {
      const options: VADOptions = {
        model: 'legacy',
      };

      expect(options.model).toBe('legacy');
      expect(options.positiveSpeechThreshold).toBeUndefined();
    });

    it('should allow all options', () => {
      const options: VADOptions = {
        model: 'v5',
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        preSpeechPadMs: 200,
        postSpeechPadMs: 200,
        minSpeechMs: 300,
        redemptionMs: 1000,
        sampleRate: 16000,
        enableStats: true,
        statsInterval: 500,
        submitUserSpeechOnPause: true,
        baseAssetPath: 'https://example.com/assets/',
        onnxWASMBasePath: 'https://example.com/wasm/',
        additionalAudioConstraints: {
          echoCancellation: true,
        },
      };

      expect(options.model).toBe('v5');
      expect(options.baseAssetPath).toBe('https://example.com/assets/');
      expect(options.additionalAudioConstraints?.echoCancellation).toBe(true);
    });
  });
});
