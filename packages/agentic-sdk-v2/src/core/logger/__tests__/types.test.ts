/**
 * SDK Logger Types Unit Tests
 *
 * Tests for the SDK logger type utilities and constants.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { LOG_LEVEL_VALUES, type LogLevel } from '../types';

describe('SDK Logger types', () => {
  describe('LOG_LEVEL_VALUES', () => {
    it('should have correct OpenTelemetry-aligned numeric values', () => {
      expect(LOG_LEVEL_VALUES.trace).toBe(1);
      expect(LOG_LEVEL_VALUES.debug).toBe(5);
      expect(LOG_LEVEL_VALUES.info).toBe(9);
      expect(LOG_LEVEL_VALUES.warn).toBe(13);
      expect(LOG_LEVEL_VALUES.error).toBe(17);
      expect(LOG_LEVEL_VALUES.fatal).toBe(21);
    });

    it('should have all expected log levels', () => {
      const expectedLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      const actualLevels = Object.keys(LOG_LEVEL_VALUES);

      expect(actualLevels).toHaveLength(expectedLevels.length);
      expectedLevels.forEach((level) => {
        expect(actualLevels).toContain(level);
      });
    });

    it('should have levels in ascending order of severity', () => {
      expect(LOG_LEVEL_VALUES.trace).toBeLessThan(LOG_LEVEL_VALUES.debug);
      expect(LOG_LEVEL_VALUES.debug).toBeLessThan(LOG_LEVEL_VALUES.info);
      expect(LOG_LEVEL_VALUES.info).toBeLessThan(LOG_LEVEL_VALUES.warn);
      expect(LOG_LEVEL_VALUES.warn).toBeLessThan(LOG_LEVEL_VALUES.error);
      expect(LOG_LEVEL_VALUES.error).toBeLessThan(LOG_LEVEL_VALUES.fatal);
    });

    it('should allow level comparison for filtering', () => {
      const minLevel: LogLevel = 'warn';
      const minValue = LOG_LEVEL_VALUES[minLevel];

      // Levels below warn should be filtered
      expect(LOG_LEVEL_VALUES.trace < minValue).toBe(true);
      expect(LOG_LEVEL_VALUES.debug < minValue).toBe(true);
      expect(LOG_LEVEL_VALUES.info < minValue).toBe(true);

      // Levels at or above warn should pass
      expect(LOG_LEVEL_VALUES.warn >= minValue).toBe(true);
      expect(LOG_LEVEL_VALUES.error >= minValue).toBe(true);
      expect(LOG_LEVEL_VALUES.fatal >= minValue).toBe(true);
    });
  });
});
