/**
 * @arcaai/stt - AudioBufferManager Tests
 *
 * Comprehensive tests for the AudioBufferManager class.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioBufferManager, DEFAULT_BUFFER_OPTIONS, type AudioBufferManagerOptions } from '../core/AudioBufferManager.js';
import { WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';

describe('AudioBufferManager', () => {
  let bufferManager: AudioBufferManager;

  beforeEach(() => {
    bufferManager = new AudioBufferManager();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      expect(bufferManager.getSampleRate()).toBe(DEFAULT_BUFFER_OPTIONS.sampleRate);
      expect(bufferManager.getChunkDuration()).toBe(DEFAULT_BUFFER_OPTIONS.chunkLengthS);
      expect(bufferManager.getChunkSamples()).toBe(DEFAULT_BUFFER_OPTIONS.chunkLengthS * DEFAULT_BUFFER_OPTIONS.sampleRate);
    });

    it('should accept custom options', () => {
      const options: AudioBufferManagerOptions = {
        sampleRate: 48000,
        chunkLengthS: 10,
        overlapLengthS: 2,
        minBufferS: 0.5,
      };
      const customManager = new AudioBufferManager(options);

      expect(customManager.getSampleRate()).toBe(48000);
      expect(customManager.getChunkDuration()).toBe(10);
      expect(customManager.getChunkSamples()).toBe(10 * 48000);
      expect(customManager.getOverlapSamples()).toBe(2 * 48000);
    });

    it('should merge custom options with defaults', () => {
      const customManager = new AudioBufferManager({ chunkLengthS: 15 });

      expect(customManager.getChunkDuration()).toBe(15);
      expect(customManager.getSampleRate()).toBe(DEFAULT_BUFFER_OPTIONS.sampleRate);
    });
  });

  describe('append', () => {
    it('should add audio samples to buffer', () => {
      const samples = new Float32Array(1600); // 100ms at 16kHz
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getSampleCount()).toBe(1600);
      expect(bufferManager.hasAudio()).toBe(true);
    });

    it('should accumulate multiple appends', () => {
      const samples1 = new Float32Array(1600);
      const samples2 = new Float32Array(3200);

      bufferManager.append(samples1, WHISPER_SAMPLE_RATE);
      bufferManager.append(samples2, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getSampleCount()).toBe(4800);
    });

    it('should resample audio from different sample rate', () => {
      // Create 4800 samples at 48kHz (100ms)
      const samples = new Float32Array(4800);

      bufferManager.append(samples, 48000);

      // Should be resampled to 16kHz (1600 samples)
      expect(bufferManager.getSampleCount()).toBe(1600);
    });

    it('should use default sample rate when not provided', () => {
      const samples = new Float32Array(1600);
      bufferManager.append(samples);

      expect(bufferManager.getSampleCount()).toBe(1600);
    });
  });

  describe('hasChunk / hasAudio / hasMinBuffer', () => {
    it('should return false for empty buffer', () => {
      expect(bufferManager.hasChunk()).toBe(false);
      expect(bufferManager.hasAudio()).toBe(false);
      expect(bufferManager.hasMinBuffer()).toBe(false);
    });

    it('should return true for hasAudio with any samples', () => {
      bufferManager.append(new Float32Array(100), WHISPER_SAMPLE_RATE);

      expect(bufferManager.hasAudio()).toBe(true);
      expect(bufferManager.hasChunk()).toBe(false);
    });

    it('should return true for hasMinBuffer when above minimum', () => {
      // Default minBufferS is 1 second = 16000 samples
      const samples = new Float32Array(16000);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.hasMinBuffer()).toBe(true);
      expect(bufferManager.hasChunk()).toBe(false);
    });

    it('should return true for hasChunk when buffer reaches chunk size', () => {
      // Default chunkLengthS is 30 seconds = 480000 samples
      const chunkSamples = bufferManager.getChunkSamples();
      const samples = new Float32Array(chunkSamples);

      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.hasChunk()).toBe(true);
    });
  });

  describe('getChunk', () => {
    it('should return null if no chunk available', () => {
      const samples = new Float32Array(1600);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getChunk()).toBeNull();
    });

    it('should return chunk of correct size', () => {
      const chunkSamples = bufferManager.getChunkSamples();
      const samples = new Float32Array(chunkSamples);

      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const chunk = bufferManager.getChunk();

      expect(chunk).not.toBeNull();
      expect(chunk!.length).toBe(chunkSamples);
    });

    it('should retain overlap samples after getting chunk', () => {
      const chunkSamples = bufferManager.getChunkSamples();
      const overlapSamples = bufferManager.getOverlapSamples();

      // Add exactly one chunk worth of samples
      const samples = new Float32Array(chunkSamples);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      bufferManager.getChunk();

      // Should retain overlap samples for context
      expect(bufferManager.getSampleCount()).toBe(overlapSamples);
    });

    it('should handle multiple chunks with overlap', () => {
      const chunkSamples = bufferManager.getChunkSamples();
      const overlapSamples = bufferManager.getOverlapSamples();

      // Add 2 chunks worth of samples
      const samples = new Float32Array(chunkSamples * 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = i / samples.length;
      }

      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      // Get first chunk
      const chunk1 = bufferManager.getChunk();
      expect(chunk1!.length).toBe(chunkSamples);

      // After first chunk, remaining = totalSamples - chunkSamples + overlapSamples
      // = 2*chunkSamples - chunkSamples + overlapSamples
      // = chunkSamples + overlapSamples
      // Should still have enough for second chunk
      expect(bufferManager.hasChunk()).toBe(true);

      // Get second chunk
      const chunk2 = bufferManager.getChunk();
      expect(chunk2!.length).toBe(chunkSamples);

      // After second chunk, remaining samples should be:
      // (chunkSamples + overlapSamples) - chunkSamples + overlapSamples = 2 * overlapSamples
      expect(bufferManager.getSampleCount()).toBe(overlapSamples * 2);
    });
  });

  describe('flush', () => {
    it('should return null for empty buffer', () => {
      expect(bufferManager.flush()).toBeNull();
    });

    it('should return all samples and clear buffer', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const flushed = bufferManager.flush();

      expect(flushed).not.toBeNull();
      expect(flushed!.length).toBe(5);
      expect(bufferManager.getSampleCount()).toBe(0);
      expect(bufferManager.hasAudio()).toBe(false);
    });

    it('should return correct samples after multiple appends', () => {
      const samples1 = new Float32Array([0.1, 0.2]);
      const samples2 = new Float32Array([0.3, 0.4]);

      bufferManager.append(samples1, WHISPER_SAMPLE_RATE);
      bufferManager.append(samples2, WHISPER_SAMPLE_RATE);

      const flushed = bufferManager.flush();

      expect(flushed!.length).toBe(4);
      expect(flushed![0]).toBeCloseTo(0.1, 5);
      expect(flushed![1]).toBeCloseTo(0.2, 5);
      expect(flushed![2]).toBeCloseTo(0.3, 5);
      expect(flushed![3]).toBeCloseTo(0.4, 5);
    });
  });

  describe('peek', () => {
    it('should return null for empty buffer', () => {
      expect(bufferManager.peek()).toBeNull();
    });

    it('should return current buffer without consuming', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const peeked = bufferManager.peek();

      expect(peeked).not.toBeNull();
      expect(peeked!.length).toBe(3);
      expect(bufferManager.getSampleCount()).toBe(3); // Not consumed
    });

    it('should return same content on multiple peeks', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const peek1 = bufferManager.peek();
      const peek2 = bufferManager.peek();

      expect(peek1!.length).toBe(peek2!.length);
      for (let i = 0; i < peek1!.length; i++) {
        expect(peek1![i]).toBeCloseTo(peek2![i]!, 5);
      }
    });
  });

  describe('clear', () => {
    it('should clear the buffer', () => {
      const samples = new Float32Array(1600);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      bufferManager.clear();

      expect(bufferManager.getSampleCount()).toBe(0);
      expect(bufferManager.hasAudio()).toBe(false);
      expect(bufferManager.flush()).toBeNull();
    });

    it('should work on already empty buffer', () => {
      bufferManager.clear();

      expect(bufferManager.getSampleCount()).toBe(0);
      expect(bufferManager.hasAudio()).toBe(false);
    });
  });

  describe('getDuration', () => {
    it('should return 0 for empty buffer', () => {
      expect(bufferManager.getDuration()).toBe(0);
    });

    it('should calculate correct duration in seconds', () => {
      // Add 1 second of audio at 16kHz
      const samples = new Float32Array(16000);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getDuration()).toBeCloseTo(1, 5);
    });

    it('should calculate fractional durations correctly', () => {
      // Add 0.5 seconds of audio at 16kHz
      const samples = new Float32Array(8000);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getDuration()).toBeCloseTo(0.5, 5);
    });
  });

  describe('getStats', () => {
    it('should return correct stats for empty buffer', () => {
      const stats = bufferManager.getStats();

      expect(stats.sampleCount).toBe(0);
      expect(stats.durationS).toBe(0);
      expect(stats.chunkReady).toBe(false);
      expect(stats.bufferCount).toBe(0);
      expect(stats.chunkSamples).toBe(bufferManager.getChunkSamples());
      expect(stats.overlapSamples).toBe(bufferManager.getOverlapSamples());
    });

    it('should return correct stats with data', () => {
      const samples = new Float32Array(16000);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const stats = bufferManager.getStats();

      expect(stats.sampleCount).toBe(16000);
      expect(stats.durationS).toBeCloseTo(1, 5);
      expect(stats.chunkReady).toBe(false);
      expect(stats.bufferCount).toBe(1);
    });

    it('should show chunk ready when buffer is full', () => {
      const chunkSamples = bufferManager.getChunkSamples();
      const samples = new Float32Array(chunkSamples);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      const stats = bufferManager.getStats();

      expect(stats.chunkReady).toBe(true);
    });

    it('should track buffer count with multiple appends', () => {
      bufferManager.append(new Float32Array(100), WHISPER_SAMPLE_RATE);
      bufferManager.append(new Float32Array(100), WHISPER_SAMPLE_RATE);
      bufferManager.append(new Float32Array(100), WHISPER_SAMPLE_RATE);

      const stats = bufferManager.getStats();

      expect(stats.bufferCount).toBe(3);
    });
  });

  describe('custom configuration scenarios', () => {
    it('should work with small chunk size for real-time processing', () => {
      const realtimeManager = new AudioBufferManager({
        chunkLengthS: 2,
        overlapLengthS: 0.5,
        minBufferS: 0.5,
      });

      // Add 2 seconds of audio
      const samples = new Float32Array(32000);
      realtimeManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(realtimeManager.hasChunk()).toBe(true);

      const chunk = realtimeManager.getChunk();
      expect(chunk!.length).toBe(32000);
    });

    it('should handle zero overlap', () => {
      const noOverlapManager = new AudioBufferManager({
        chunkLengthS: 5,
        overlapLengthS: 0,
      });

      const chunkSamples = 5 * WHISPER_SAMPLE_RATE;
      const samples = new Float32Array(chunkSamples);
      noOverlapManager.append(samples, WHISPER_SAMPLE_RATE);

      noOverlapManager.getChunk();

      // With zero overlap, buffer should be empty after getting chunk
      expect(noOverlapManager.getSampleCount()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty array append', () => {
      const samples = new Float32Array(0);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.getSampleCount()).toBe(0);
    });

    it('should handle very large sample counts', () => {
      // 5 minutes of audio
      const samples = new Float32Array(5 * 60 * WHISPER_SAMPLE_RATE);
      bufferManager.append(samples, WHISPER_SAMPLE_RATE);

      expect(bufferManager.hasChunk()).toBe(true);

      // Should be able to get multiple chunks
      let chunkCount = 0;
      while (bufferManager.hasChunk()) {
        const chunk = bufferManager.getChunk();
        expect(chunk).not.toBeNull();
        chunkCount++;
      }

      expect(chunkCount).toBeGreaterThan(1);
    });

    it('should preserve sample values through buffer operations', () => {
      const originalSamples = new Float32Array([0.1, 0.25, 0.5, 0.75, 0.9]);
      bufferManager.append(originalSamples, WHISPER_SAMPLE_RATE);

      const retrieved = bufferManager.flush();

      for (let i = 0; i < originalSamples.length; i++) {
        expect(retrieved![i]).toBeCloseTo(originalSamples[i]!, 5);
      }
    });
  });
});
