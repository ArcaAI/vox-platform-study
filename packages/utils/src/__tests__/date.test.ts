/**
 * @arcaai/utils - Date Utilities Tests
 *
 * Comprehensive tests for date and time utility functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDuration,
  formatDate,
  formatTime,
  formatDateTime,
  getRelativeTime,
  isToday,
  now,
} from '../date.js';

describe('date utilities', () => {
  describe('formatDuration', () => {
    it('should format seconds only', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(30)).toBe('30s');
      expect(formatDuration(59)).toBe('59s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(60)).toBe('1m');
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(125)).toBe('2m 5s');
    });

    it('should format hours, minutes, and seconds', () => {
      expect(formatDuration(3600)).toBe('1h');
      expect(formatDuration(3661)).toBe('1h 1m 1s');
      expect(formatDuration(7325)).toBe('2h 2m 5s');
    });

    it('should omit zero components', () => {
      expect(formatDuration(3600)).toBe('1h');
      expect(formatDuration(3660)).toBe('1h 1m');
      expect(formatDuration(60)).toBe('1m');
    });

    it('should handle negative values', () => {
      expect(formatDuration(-1)).toBe('0s');
      expect(formatDuration(-100)).toBe('0s');
    });

    it('should handle decimal seconds by flooring', () => {
      expect(formatDuration(30.5)).toBe('30s');
      expect(formatDuration(90.9)).toBe('1m 30s');
    });

    it('should handle large durations', () => {
      expect(formatDuration(86400)).toBe('24h');
      expect(formatDuration(90000)).toBe('25h');
    });
  });

  describe('formatDate', () => {
    it('should format date with default locale', () => {
      const timestamp = '2024-03-15T10:30:00Z';
      const result = formatDate(timestamp);
      expect(result).toContain('March');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('should format date with specific locale', () => {
      const timestamp = '2024-03-15T10:30:00Z';
      const result = formatDate(timestamp, 'de-DE');
      expect(result).toContain('März');
      expect(result).toContain('2024');
    });

    it('should handle numeric timestamps', () => {
      const timestamp = Date.UTC(2024, 2, 15, 10, 30, 0);
      const result = formatDate(timestamp);
      expect(result).toContain('March');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('should handle Date objects', () => {
      const date = new Date('2024-03-15T10:30:00Z');
      const result = formatDate(date.toISOString());
      expect(result).toContain('March');
      expect(result).toContain('2024');
    });
  });

  describe('formatTime', () => {
    it('should format time with default locale', () => {
      const timestamp = '2024-03-15T10:30:00Z';
      const result = formatTime(timestamp);
      // Result should contain hours and minutes
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should format time with specific locale', () => {
      const timestamp = '2024-03-15T14:30:00Z';
      const result = formatTime(timestamp, 'en-GB');
      // UK locale should show 24-hour time
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should handle numeric timestamps', () => {
      const timestamp = Date.UTC(2024, 2, 15, 10, 30, 0);
      const result = formatTime(timestamp);
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe('formatDateTime', () => {
    it('should include both date and time', () => {
      const timestamp = '2024-03-15T10:30:00Z';
      const result = formatDateTime(timestamp);
      expect(result).toContain('March');
      expect(result).toContain('15');
      expect(result).toContain('2024');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    it('should format with specific locale', () => {
      const timestamp = '2024-03-15T10:30:00Z';
      const result = formatDateTime(timestamp, 'de-DE');
      expect(result).toContain('März');
      expect(result).toContain('2024');
    });
  });

  describe('getRelativeTime', () => {
    it('should return a relative time string for past dates', () => {
      // Use a date from the past
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      const result = getRelativeTime(pastDate);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return a relative time string for future dates', () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 1 day in future
      const result = getRelativeTime(futureDate);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should work with different locales', () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const resultUS = getRelativeTime(pastDate, 'en-US');
      const resultDE = getRelativeTime(pastDate, 'de-DE');

      expect(typeof resultUS).toBe('string');
      expect(typeof resultDE).toBe('string');
      // Different locales should produce different output
      // (or same if the browser uses the same phrasing)
      expect(resultUS.length).toBeGreaterThan(0);
      expect(resultDE.length).toBeGreaterThan(0);
    });
  });

  describe('isToday', () => {
    it('should return true for today', () => {
      const today = new Date().toISOString();
      expect(isToday(today)).toBe(true);
    });

    it('should return true for different times today', () => {
      // Create timestamps from today at different hours
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const middleOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);

      expect(isToday(startOfDay.toISOString())).toBe(true);
      expect(isToday(middleOfDay.toISOString())).toBe(true);
    });

    it('should return false for yesterday', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      yesterday.setHours(12, 0, 0, 0); // Set to noon yesterday
      expect(isToday(yesterday.toISOString())).toBe(false);
    });

    it('should return false for tomorrow', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      tomorrow.setHours(12, 0, 0, 0); // Set to noon tomorrow
      expect(isToday(tomorrow.toISOString())).toBe(false);
    });

    it('should return false for last year', () => {
      const lastYear = new Date();
      lastYear.setFullYear(lastYear.getFullYear() - 1);
      expect(isToday(lastYear.toISOString())).toBe(false);
    });

    it('should handle numeric timestamps', () => {
      const todayNumeric = Date.now();
      expect(isToday(todayNumeric)).toBe(true);
    });
  });

  describe('now', () => {
    it('should return an ISO 8601 string', () => {
      const result = now();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });

    it('should return current time', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-03-15T12:00:00.000Z'));

      const result = now();
      expect(result).toBe('2024-03-15T12:00:00.000Z');

      vi.useRealTimers();
    });

    it('should be parseable as a Date', () => {
      const result = now();
      const parsed = new Date(result);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });
});
