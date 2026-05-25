/**
 * @arcaai/noise-filter - Types Tests
 *
 * Tests for type definitions, constants, and error classes.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  // Constants
  DEFAULT_NOISE_FILTER_OPTIONS,

  // Error types
  NoiseFilterErrorCode,
  NoiseFilterError,

  // Types (for type checking, not runtime)
  type NoiseFilterOptions,
  type NoiseCancellationLevel,
  type ProcessingMode,
  type NoiseFilterStats,
  type NoiseFilterBrowserSupport,
  type RNNoiseResult,
  type WorkletInboundMessage,
  type WorkletOutboundMessage,
} from '../types/index.js';

describe('DEFAULT_NOISE_FILTER_OPTIONS', () => {
  it('should have all required properties', () => {
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('noiseCancellation');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('noiseCancellationLevel');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('echoCancellation');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('autoGainControl');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('processingMode');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('sampleRate');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('enableStats');
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toHaveProperty('statsInterval');
  });

  it('should have correct default values', () => {
    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellation).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellationLevel).toBe('medium');
    expect(DEFAULT_NOISE_FILTER_OPTIONS.echoCancellation).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.autoGainControl).toBe(true);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.processingMode).toBe('quality');
    expect(DEFAULT_NOISE_FILTER_OPTIONS.sampleRate).toBe(48000);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.enableStats).toBe(false);
    expect(DEFAULT_NOISE_FILTER_OPTIONS.statsInterval).toBe(1000);
  });

  it('should not include wasmPath (optional property)', () => {
    expect(DEFAULT_NOISE_FILTER_OPTIONS).not.toHaveProperty('wasmPath');
  });

  it('should be frozen or immutable pattern', () => {
    // Test that modifications don't affect the original
    const copy = { ...DEFAULT_NOISE_FILTER_OPTIONS };
    copy.noiseCancellation = false;

    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellation).toBe(true);
  });

  // TASK-304 (MED-9): defaults are now frozen so accidental mutation throws in strict mode
  // and is silently ignored in sloppy mode. Either way, the canonical value never changes.
  it('is frozen via Object.freeze() (TASK-304 MED-9)', () => {
    expect(Object.isFrozen(DEFAULT_NOISE_FILTER_OPTIONS)).toBe(true);
  });

  it('does not allow mutation of properties on the frozen defaults', () => {
    const original = DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellationLevel;
    // Assignment is a silent no-op in sloppy mode, throws in strict mode. Either way,
    // the canonical value must remain unchanged.
    try {
      // @ts-expect-error - intentional violation to verify runtime freezing
      DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellationLevel = 'high';
    } catch {
      // strict mode TypeError is expected
    }
    expect(DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellationLevel).toBe(original);
  });
});

describe('NoiseFilterErrorCode', () => {
  it('should have WASM_LOAD_FAILED code', () => {
    expect(NoiseFilterErrorCode.WASM_LOAD_FAILED).toBe('WASM_LOAD_FAILED');
  });

  it('should have WORKLET_REGISTRATION_FAILED code', () => {
    expect(NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED).toBe(
      'WORKLET_REGISTRATION_FAILED'
    );
  });

  it('should have PROCESSING_ERROR code', () => {
    expect(NoiseFilterErrorCode.PROCESSING_ERROR).toBe('PROCESSING_ERROR');
  });

  it('should have NOT_SUPPORTED code', () => {
    expect(NoiseFilterErrorCode.NOT_SUPPORTED).toBe('NOT_SUPPORTED');
  });

  it('should have INVALID_CONFIG code', () => {
    expect(NoiseFilterErrorCode.INVALID_CONFIG).toBe('INVALID_CONFIG');
  });

  it('should have exactly 5 error codes', () => {
    const codes = Object.values(NoiseFilterErrorCode);
    expect(codes).toHaveLength(5);
  });
});

describe('NoiseFilterError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.NOT_SUPPORTED,
        'Browser not supported'
      );

      expect(error.code).toBe(NoiseFilterErrorCode.NOT_SUPPORTED);
      expect(error.message).toBe('Browser not supported');
      expect(error.cause).toBeUndefined();
    });

    it('should create error with cause', () => {
      const originalError = new Error('Original error');
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.WASM_LOAD_FAILED,
        'Failed to load WASM',
        originalError
      );

      expect(error.code).toBe(NoiseFilterErrorCode.WASM_LOAD_FAILED);
      expect(error.message).toBe('Failed to load WASM');
      expect(error.cause).toBe(originalError);
    });
  });

  describe('properties', () => {
    it('should have name "NoiseFilterError"', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.PROCESSING_ERROR,
        'Processing failed'
      );

      expect(error.name).toBe('NoiseFilterError');
    });

    it('should extend Error', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.PROCESSING_ERROR,
        'Processing failed'
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NoiseFilterError);
    });

    it('should have stack trace', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.PROCESSING_ERROR,
        'Processing failed'
      );

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('NoiseFilterError');
    });
  });

  describe('error codes in context', () => {
    it('should use WASM_LOAD_FAILED for WASM errors', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.WASM_LOAD_FAILED,
        'WebAssembly module failed to compile'
      );

      expect(error.code).toBe('WASM_LOAD_FAILED');
    });

    it('should use WORKLET_REGISTRATION_FAILED for worklet errors', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.WORKLET_REGISTRATION_FAILED,
        'AudioWorklet registration failed'
      );

      expect(error.code).toBe('WORKLET_REGISTRATION_FAILED');
    });

    it('should use NOT_SUPPORTED for browser compatibility errors', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.NOT_SUPPORTED,
        'AudioContext not supported'
      );

      expect(error.code).toBe('NOT_SUPPORTED');
    });

    it('should use INVALID_CONFIG for configuration errors', () => {
      const error = new NoiseFilterError(
        NoiseFilterErrorCode.INVALID_CONFIG,
        'Invalid sample rate: -1'
      );

      expect(error.code).toBe('INVALID_CONFIG');
    });
  });
});

describe('Type definitions (compile-time checks)', () => {
  // These tests verify that types are properly exported and usable

  describe('NoiseCancellationLevel', () => {
    it('should accept valid levels', () => {
      const levels: NoiseCancellationLevel[] = ['low', 'medium', 'high'];
      expect(levels).toHaveLength(3);
    });
  });

  describe('ProcessingMode', () => {
    it('should accept valid modes', () => {
      const modes: ProcessingMode[] = ['quality', 'performance'];
      expect(modes).toHaveLength(2);
    });
  });

  describe('NoiseFilterOptions', () => {
    it('should be assignable from partial object', () => {
      const options: NoiseFilterOptions = {
        noiseCancellation: true,
      };
      expect(options.noiseCancellation).toBe(true);
    });

    it('should accept all properties', () => {
      const fullOptions: NoiseFilterOptions = {
        noiseCancellation: true,
        noiseCancellationLevel: 'high',
        echoCancellation: false,
        autoGainControl: true,
        wasmPath: '/custom/path.wasm',
        processingMode: 'performance',
        sampleRate: 44100,
        enableStats: true,
        statsInterval: 500,
      };

      expect(fullOptions.noiseCancellation).toBe(true);
      expect(fullOptions.noiseCancellationLevel).toBe('high');
    });
  });

  describe('NoiseFilterStats', () => {
    it('should have correct structure', () => {
      const stats: NoiseFilterStats = {
        isActive: true,
        noiseReductionDb: 12,
        vadProbability: 0.95,
        latencyMs: 10,
        framesProcessed: 100,
        framesDropped: 0,
        cpuLoad: 0.15,
        timestamp: Date.now(),
      };

      expect(stats.isActive).toBe(true);
      expect(stats.noiseReductionDb).toBe(12);
      expect(stats.vadProbability).toBe(0.95);
      expect(stats.framesProcessed).toBe(100);
    });
  });

  describe('NoiseFilterBrowserSupport', () => {
    it('should have correct structure', () => {
      const support: NoiseFilterBrowserSupport = {
        webAssembly: true,
        audioWorklet: true,
        sharedArrayBuffer: true,
        rnnoiseSupported: true,
        nativeFallbackAvailable: true,
      };

      expect(support.webAssembly).toBe(true);
      expect(support.rnnoiseSupported).toBe(true);
    });

    it('should accept optional unsupportedReason', () => {
      const support: NoiseFilterBrowserSupport = {
        webAssembly: false,
        audioWorklet: false,
        sharedArrayBuffer: false,
        rnnoiseSupported: false,
        nativeFallbackAvailable: false,
        unsupportedReason: 'WebAssembly not available',
      };

      expect(support.unsupportedReason).toBe('WebAssembly not available');
    });
  });

  describe('RNNoiseResult', () => {
    it('should have correct structure', () => {
      const result: RNNoiseResult = {
        samples: new Float32Array(480),
        vadProbability: 0.8,
      };

      expect(result.samples).toBeInstanceOf(Float32Array);
      expect(result.vadProbability).toBe(0.8);
    });
  });

  describe('WorkletInboundMessage', () => {
    it('should accept init message', () => {
      const message: WorkletInboundMessage = {
        type: 'init',
        wasmBinary: new ArrayBuffer(1024),
      };
      expect(message.type).toBe('init');
    });

    it('should accept setEnabled message', () => {
      const message: WorkletInboundMessage = {
        type: 'setEnabled',
        enabled: true,
      };
      expect(message.type).toBe('setEnabled');
    });

    it('should accept setLevel message', () => {
      const message: WorkletInboundMessage = {
        type: 'setLevel',
        level: 'high',
      };
      expect(message.type).toBe('setLevel');
    });

    it('should accept getStats message', () => {
      const message: WorkletInboundMessage = {
        type: 'getStats',
      };
      expect(message.type).toBe('getStats');
    });

    it('should accept destroy message', () => {
      const message: WorkletInboundMessage = {
        type: 'destroy',
      };
      expect(message.type).toBe('destroy');
    });
  });

  describe('WorkletOutboundMessage', () => {
    it('should accept ready message', () => {
      const message: WorkletOutboundMessage = {
        type: 'ready',
      };
      expect(message.type).toBe('ready');
    });

    it('should accept stats message', () => {
      const message: WorkletOutboundMessage = {
        type: 'stats',
        stats: {
          isActive: true,
          noiseReductionDb: 12,
          vadProbability: 0.9,
          latencyMs: 10,
          framesProcessed: 50,
          framesDropped: 0,
          cpuLoad: 0.1,
          timestamp: Date.now(),
        },
      };
      expect(message.type).toBe('stats');
    });

    it('should accept error message', () => {
      const message: WorkletOutboundMessage = {
        type: 'error',
        message: 'Processing failed',
      };
      expect(message.type).toBe('error');
    });

    it('should accept destroyed message', () => {
      const message: WorkletOutboundMessage = {
        type: 'destroyed',
      };
      expect(message.type).toBe('destroyed');
    });
  });
});

describe('Type exports from types/index.js', () => {
  it('should export all required types and constants', () => {
    // Verify that types are properly exported from types/index.js
    // Note: Main index.js includes React hooks, so we test types/index.js directly
    expect(DEFAULT_NOISE_FILTER_OPTIONS).toBeDefined();
    expect(NoiseFilterErrorCode).toBeDefined();
    expect(NoiseFilterError).toBeDefined();
  });
});
