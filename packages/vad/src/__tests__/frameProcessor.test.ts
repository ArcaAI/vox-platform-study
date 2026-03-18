/**
 * @arcaai/vad - Frame Processor Tests
 *
 * Comprehensive tests for frame processing utilities.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import {
  FRAME_SIZE_V5,
  FRAME_SIZE_LEGACY,
  FrameAccumulator,
  AudioRingBuffer,
  durationToSamples,
  samplesToDuration,
  durationToFrames,
  framesToDuration,
} from '../utils/frameProcessor.js';

describe('frameProcessor utilities', () => {
  describe('Constants', () => {
    it('FRAME_SIZE_V5 should be 512', () => {
      expect(FRAME_SIZE_V5).toBe(512);
    });

    it('FRAME_SIZE_LEGACY should be 1536', () => {
      expect(FRAME_SIZE_LEGACY).toBe(1536);
    });
  });

  describe('FrameAccumulator', () => {
    describe('constructor', () => {
      it('should create accumulator with v5 frame size', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);
        expect(accumulator.getFrameSize()).toBe(512);
      });

      it('should create accumulator with legacy frame size', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('legacy', callback);
        expect(accumulator.getFrameSize()).toBe(1536);
      });
    });

    describe('process', () => {
      it('should not call callback until frame is full', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);

        // Feed less than 512 samples
        accumulator.process(new Float32Array(256));
        expect(callback).not.toHaveBeenCalled();
      });

      it('should call callback when frame is full', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);

        // Feed exactly 512 samples
        accumulator.process(new Float32Array(512));
        expect(callback).toHaveBeenCalledTimes(1);
      });

      it('should call callback multiple times for large input', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);

        // Feed 1024 samples (2 frames)
        accumulator.process(new Float32Array(1024));
        expect(callback).toHaveBeenCalledTimes(2);
      });

      it('should accumulate samples across multiple calls', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);

        // Feed 128 samples at a time (typical AudioWorklet chunk size)
        for (let i = 0; i < 4; i++) {
          accumulator.process(new Float32Array(128));
        }
        expect(callback).toHaveBeenCalledTimes(1);
      });

      it('should pass correct frame data to callback', () => {
        const callback = vi.fn();
        const accumulator = new FrameAccumulator('v5', callback);

        const input = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
          input[i] = i / 512;
        }

        accumulator.process(input);

        const frame = callback.mock.calls[0][0];
        expect(frame.length).toBe(512);
        expect(frame[0]).toBeCloseTo(0, 5);
        expect(frame[511]).toBeCloseTo(511 / 512, 5);
      });
    });

    describe('getBufferLevel', () => {
      it('should return 0 initially', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());
        expect(accumulator.getBufferLevel()).toBe(0);
      });

      it('should track buffer level correctly', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        accumulator.process(new Float32Array(128));
        expect(accumulator.getBufferLevel()).toBe(128);

        accumulator.process(new Float32Array(128));
        expect(accumulator.getBufferLevel()).toBe(256);
      });

      it('should reset to 0 after frame is emitted', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        accumulator.process(new Float32Array(512));
        expect(accumulator.getBufferLevel()).toBe(0);
      });
    });

    describe('getBufferFillPercentage', () => {
      it('should return 0 initially', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());
        expect(accumulator.getBufferFillPercentage()).toBe(0);
      });

      it('should return correct percentage', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        accumulator.process(new Float32Array(256));
        expect(accumulator.getBufferFillPercentage()).toBe(0.5);
      });
    });

    describe('reset', () => {
      it('should clear buffer', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        accumulator.process(new Float32Array(256));
        expect(accumulator.getBufferLevel()).toBe(256);

        accumulator.reset();
        expect(accumulator.getBufferLevel()).toBe(0);
      });
    });

    describe('flush', () => {
      it('should return null when buffer is empty', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());
        expect(accumulator.flush()).toBeNull();
      });

      it('should return zero-padded frame', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        const input = new Float32Array(256);
        input.fill(0.5);
        accumulator.process(input);

        const frame = accumulator.flush();

        expect(frame).not.toBeNull();
        expect(frame!.length).toBe(512);
        expect(frame![0]).toBe(0.5);
        expect(frame![255]).toBe(0.5);
        expect(frame![256]).toBe(0); // Zero-padded
        expect(frame![511]).toBe(0);
      });

      it('should reset buffer after flush', () => {
        const accumulator = new FrameAccumulator('v5', vi.fn());

        accumulator.process(new Float32Array(256));
        accumulator.flush();

        expect(accumulator.getBufferLevel()).toBe(0);
      });
    });
  });

  describe('AudioRingBuffer', () => {
    describe('constructor', () => {
      it('should create buffer with specified capacity', () => {
        const buffer = new AudioRingBuffer(1000);
        expect(buffer.getCapacity()).toBe(1000);
      });
    });

    describe('write and readAll', () => {
      it('should store and retrieve samples', () => {
        const buffer = new AudioRingBuffer(100);
        const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);

        buffer.write(samples);

        const result = buffer.readAll();
        expect(result.length).toBe(5);
        for (let i = 0; i < 5; i++) {
          expect(result[i]).toBeCloseTo([0.1, 0.2, 0.3, 0.4, 0.5][i], 5);
        }
      });

      it('should handle multiple writes', () => {
        const buffer = new AudioRingBuffer(100);

        buffer.write(new Float32Array([0.1, 0.2]));
        buffer.write(new Float32Array([0.3, 0.4]));

        const result = buffer.readAll();
        expect(result.length).toBe(4);
        for (let i = 0; i < 4; i++) {
          expect(result[i]).toBeCloseTo([0.1, 0.2, 0.3, 0.4][i], 5);
        }
      });

      it('should overwrite oldest samples when full', () => {
        const buffer = new AudioRingBuffer(5);

        buffer.write(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
        buffer.write(new Float32Array([0.6, 0.7]));

        const result = buffer.readAll();
        expect(result.length).toBe(5);
        const expected = [0.3, 0.4, 0.5, 0.6, 0.7];
        for (let i = 0; i < 5; i++) {
          expect(result[i]).toBeCloseTo(expected[i], 5);
        }
      });
    });

    describe('readLast', () => {
      it('should return last N samples', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));

        const result = buffer.readLast(3);
        expect(result.length).toBe(3);
        const expected = [0.3, 0.4, 0.5];
        for (let i = 0; i < 3; i++) {
          expect(result[i]).toBeCloseTo(expected[i], 5);
        }
      });

      it('should return all samples if N > count', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array([0.1, 0.2, 0.3]));

        const result = buffer.readLast(10);
        expect(result.length).toBe(3);
      });

      it('should work after wrap-around', () => {
        const buffer = new AudioRingBuffer(5);
        buffer.write(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]));
        buffer.write(new Float32Array([0.6, 0.7]));

        const result = buffer.readLast(3);
        expect(result.length).toBe(3);
        const expected = [0.5, 0.6, 0.7];
        for (let i = 0; i < 3; i++) {
          expect(result[i]).toBeCloseTo(expected[i], 5);
        }
      });
    });

    describe('getCount', () => {
      it('should return 0 initially', () => {
        const buffer = new AudioRingBuffer(100);
        expect(buffer.getCount()).toBe(0);
      });

      it('should track count correctly', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array(50));
        expect(buffer.getCount()).toBe(50);
      });

      it('should not exceed capacity', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array(150));
        expect(buffer.getCount()).toBe(100);
      });
    });

    describe('isFull', () => {
      it('should return false when not full', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array(50));
        expect(buffer.isFull()).toBe(false);
      });

      it('should return true when full', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array(100));
        expect(buffer.isFull()).toBe(true);
      });
    });

    describe('clear', () => {
      it('should reset buffer', () => {
        const buffer = new AudioRingBuffer(100);
        buffer.write(new Float32Array(50));

        buffer.clear();

        expect(buffer.getCount()).toBe(0);
        expect(buffer.readAll().length).toBe(0);
      });
    });
  });

  describe('durationToSamples', () => {
    it('should calculate samples from milliseconds', () => {
      expect(durationToSamples(1000, 16000)).toBe(16000);
      expect(durationToSamples(500, 16000)).toBe(8000);
      expect(durationToSamples(100, 48000)).toBe(4800);
    });

    it('should ceil the result', () => {
      expect(durationToSamples(1, 16000)).toBe(16);
      expect(durationToSamples(0.5, 16000)).toBe(8);
    });
  });

  describe('samplesToDuration', () => {
    it('should calculate milliseconds from samples', () => {
      expect(samplesToDuration(16000, 16000)).toBe(1000);
      expect(samplesToDuration(8000, 16000)).toBe(500);
      expect(samplesToDuration(4800, 48000)).toBe(100);
    });
  });

  describe('durationToFrames', () => {
    it('should calculate frames for v5 model', () => {
      // v5 frame = 512 samples at 16kHz = 32ms
      expect(durationToFrames(32, 'v5', 16000)).toBe(1);
      expect(durationToFrames(64, 'v5', 16000)).toBe(2);
      expect(durationToFrames(100, 'v5', 16000)).toBe(4); // Ceil
    });

    it('should calculate frames for legacy model', () => {
      // legacy frame = 1536 samples at 16kHz = 96ms
      expect(durationToFrames(96, 'legacy', 16000)).toBe(1);
      expect(durationToFrames(192, 'legacy', 16000)).toBe(2);
    });
  });

  describe('framesToDuration', () => {
    it('should calculate duration for v5 model', () => {
      // v5 frame = 512 samples at 16kHz = 32ms
      expect(framesToDuration(1, 'v5', 16000)).toBe(32);
      expect(framesToDuration(2, 'v5', 16000)).toBe(64);
    });

    it('should calculate duration for legacy model', () => {
      // legacy frame = 1536 samples at 16kHz = 96ms
      expect(framesToDuration(1, 'legacy', 16000)).toBe(96);
      expect(framesToDuration(2, 'legacy', 16000)).toBe(192);
    });
  });
});
