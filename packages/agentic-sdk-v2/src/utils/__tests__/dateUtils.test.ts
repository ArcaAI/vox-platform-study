/**
 * @arcaai/vox - Date Utilities Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatDateTime,
  getToday,
  isSameDay,
  parseDate,
  formatRelativeTime,
} from '../dateUtils';

describe('dateUtils', () => {
  describe('formatDate', () => {
    it('should format Date object to YYYY-MM-DD', () => {
      const date = new Date('2026-01-27T15:30:00Z');
      expect(formatDate(date)).toBe('2026-01-27');
    });

    it('should format date string to YYYY-MM-DD', () => {
      expect(formatDate('2026-01-27T15:30:00Z')).toBe('2026-01-27');
    });

    it('should handle different date formats', () => {
      expect(formatDate('2026-12-31')).toBe('2026-12-31');
    });
  });

  describe('formatDateTime', () => {
    it('should format Date object to ISO string', () => {
      const date = new Date('2026-01-27T15:30:00.000Z');
      expect(formatDateTime(date)).toBe('2026-01-27T15:30:00.000Z');
    });

    it('should format date string to ISO string', () => {
      const result = formatDateTime('2026-01-27T15:30:00Z');
      expect(result).toBe('2026-01-27T15:30:00.000Z');
    });
  });

  describe('getToday', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-27T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return today date as YYYY-MM-DD', () => {
      expect(getToday()).toBe('2026-01-27');
    });
  });

  describe('isSameDay', () => {
    it('should return true for same day Date objects', () => {
      const date1 = new Date('2026-01-27T10:00:00Z');
      const date2 = new Date('2026-01-27T20:00:00Z');
      expect(isSameDay(date1, date2)).toBe(true);
    });

    it('should return true for same day strings', () => {
      expect(isSameDay('2026-01-27T10:00:00Z', '2026-01-27T20:00:00Z')).toBe(true);
    });

    it('should return false for different days', () => {
      const date1 = new Date('2026-01-27T10:00:00Z');
      const date2 = new Date('2026-01-28T10:00:00Z');
      expect(isSameDay(date1, date2)).toBe(false);
    });

    it('should handle mixed Date and string inputs', () => {
      const date1 = new Date('2026-01-27T10:00:00Z');
      expect(isSameDay(date1, '2026-01-27T20:00:00Z')).toBe(true);
    });
  });

  describe('parseDate', () => {
    it('should parse date string to Date object', () => {
      const result = parseDate('2026-01-27T15:30:00Z');
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2026-01-27T15:30:00.000Z');
    });

    it('should parse date-only string', () => {
      const result = parseDate('2026-01-27');
      expect(result).toBeInstanceOf(Date);
    });
  });

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-27T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return "just now" for less than 60 seconds ago', () => {
      const date = new Date('2026-01-27T11:59:30Z');
      expect(formatRelativeTime(date)).toBe('just now');
    });

    it('should return "1 minute ago" for 1 minute ago', () => {
      const date = new Date('2026-01-27T11:59:00Z');
      expect(formatRelativeTime(date)).toBe('1 minute ago');
    });

    it('should return "5 minutes ago" for 5 minutes ago', () => {
      const date = new Date('2026-01-27T11:55:00Z');
      expect(formatRelativeTime(date)).toBe('5 minutes ago');
    });

    it('should return "1 hour ago" for 1 hour ago', () => {
      const date = new Date('2026-01-27T11:00:00Z');
      expect(formatRelativeTime(date)).toBe('1 hour ago');
    });

    it('should return "3 hours ago" for 3 hours ago', () => {
      const date = new Date('2026-01-27T09:00:00Z');
      expect(formatRelativeTime(date)).toBe('3 hours ago');
    });

    it('should return "1 day ago" for 1 day ago', () => {
      const date = new Date('2026-01-26T12:00:00Z');
      expect(formatRelativeTime(date)).toBe('1 day ago');
    });

    it('should return "5 days ago" for 5 days ago', () => {
      const date = new Date('2026-01-22T12:00:00Z');
      expect(formatRelativeTime(date)).toBe('5 days ago');
    });

    it('should return formatted date for more than 7 days ago', () => {
      const date = new Date('2026-01-15T12:00:00Z');
      expect(formatRelativeTime(date)).toBe('2026-01-15');
    });

    it('should handle string input', () => {
      expect(formatRelativeTime('2026-01-27T11:59:30Z')).toBe('just now');
    });
  });
});
