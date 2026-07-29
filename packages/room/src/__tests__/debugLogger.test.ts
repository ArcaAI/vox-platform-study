/**
 * @arcaai/room - Debug Logger Tests
 *
 * Tests for the debug logging utility functions.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debugLog, debugLogConfig, debugLogTranscript, type DebugTranscriptEntry } from '../utils/debugLogger.js';

describe('debugLogger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('debugLog', () => {
    it('should log with prefix and component', () => {
      debugLog('TestComponent', 'hello world');
      expect(consoleSpy).toHaveBeenCalledWith('[ARCAAI:DEBUG] [TestComponent]', 'hello world');
    });

    it('should log with data when provided', () => {
      const data = { key: 'value' };
      debugLog('TestComponent', 'with data', data);
      expect(consoleSpy).toHaveBeenCalledWith('[ARCAAI:DEBUG] [TestComponent]', 'with data', data);
    });

    it('should not pass data argument when undefined', () => {
      debugLog('TestComponent', 'no data');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy.mock.calls[0]).toHaveLength(2);
    });
  });

  describe('debugLogConfig', () => {
    it('should log config as formatted JSON', () => {
      const config = { enabled: true, level: 'high' };
      debugLogConfig('NoiseFilter', config);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0]![0] as string;
      expect(output).toContain('[ARCAAI:DEBUG] [NoiseFilter] Configuration:');
      expect(output).toContain('"enabled": true');
      expect(output).toContain('"level": "high"');
    });
  });

  describe('debugLogTranscript', () => {
    it('should format times to 3 decimal places', () => {
      const entry: DebugTranscriptEntry = {
        segment: 1,
        speaker: 'speaker-1',
        start: 1.23456,
        end: 3.56789,
        duration: 2.33333,
        inference: 0.12345678,
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.start).toBe(1.235);
      expect(parsed.end).toBe(3.568);
      expect(parsed.duration).toBe(2.333);
    });

    it('should format inference to 4 decimal places', () => {
      const entry: DebugTranscriptEntry = {
        segment: 1,
        speaker: 'speaker-1',
        start: 0,
        end: 1,
        duration: 1,
        inference: 0.12345678,
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.inference).toBe(0.1235);
    });

    it('should include words with correct precision when present', () => {
      const entry: DebugTranscriptEntry = {
        segment: 1,
        speaker: 'speaker-1',
        start: 1.0,
        end: 2.0,
        duration: 1.0,
        inference: 0.05,
        words: [
          { word: 'hello', confidence: 0.98765, start: 1.0001, end: 1.4999 },
          { word: 'world', confidence: 0.95432, start: 1.5001, end: 1.9999 },
        ],
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.words).toHaveLength(2);
      expect(parsed.words[0].word).toBe('hello');
      expect(parsed.words[0].confidence).toBe(0.988);
      expect(parsed.words[0].start).toBe(1.0);
      expect(parsed.words[0].end).toBe(1.5);
      expect(parsed.words[1].word).toBe('world');
      expect(parsed.words[1].confidence).toBe(0.954);
    });

    it('should omit words when not present', () => {
      const entry: DebugTranscriptEntry = {
        segment: 2,
        speaker: 'speaker-2',
        start: 5.0,
        end: 7.0,
        duration: 2.0,
        inference: 0.1,
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.words).toBeUndefined();
    });

    it('should omit words when array is empty', () => {
      const entry: DebugTranscriptEntry = {
        segment: 1,
        speaker: 'speaker-1',
        start: 0,
        end: 1,
        duration: 1,
        inference: 0.05,
        words: [],
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.words).toBeUndefined();
    });

    it('should preserve segment number and speaker string', () => {
      const entry: DebugTranscriptEntry = {
        segment: 42,
        speaker: 'Dr. Smith',
        start: 0,
        end: 1,
        duration: 1,
        inference: 0.01,
      };

      debugLogTranscript('STT', entry);

      const output = consoleSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(output.split('Transcript:\n')[1]!);
      expect(parsed.segment).toBe(42);
      expect(parsed.speaker).toBe('Dr. Smith');
    });
  });
});
