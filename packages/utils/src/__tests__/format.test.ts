/**
 * @arcaai/utils - Format Utilities Tests
 *
 * Comprehensive tests for formatting utility functions.
 */

import { describe, it, expect } from 'vitest';
import { formatFileSize, formatNumber, truncate, formatPercentage, formatTimecode, formatTimecodeHours } from '../format.js';

describe('format utilities', () => {
  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(500)).toBe('500.00 B');
      expect(formatFileSize(1023)).toBe('1023.00 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1.00 KB');
      expect(formatFileSize(1536)).toBe('1.50 KB');
      expect(formatFileSize(10240)).toBe('10.00 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.50 MB');
      expect(formatFileSize(100 * 1024 * 1024)).toBe('100.00 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
    });

    it('should format terabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe('1.00 TB');
    });

    it('should handle negative values', () => {
      expect(formatFileSize(-1)).toBe('Invalid size');
      expect(formatFileSize(-1024)).toBe('Invalid size');
    });
  });

  describe('formatNumber', () => {
    it('should format numbers with thousand separators', () => {
      expect(formatNumber(1000)).toBe('1,000');
      expect(formatNumber(1000000)).toBe('1,000,000');
      expect(formatNumber(1234567890)).toBe('1,234,567,890');
    });

    it('should handle small numbers without separators', () => {
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(999)).toBe('999');
      expect(formatNumber(100)).toBe('100');
    });

    it('should handle decimal numbers', () => {
      expect(formatNumber(1000.5)).toBe('1,000.5');
      expect(formatNumber(1234.567)).toBe('1,234.567');
    });

    it('should handle negative numbers', () => {
      expect(formatNumber(-1000)).toBe('-1,000');
      expect(formatNumber(-1234567)).toBe('-1,234,567');
    });

    it('should respect locale parameter', () => {
      expect(formatNumber(1000, 'de-DE')).toBe('1.000');
      expect(formatNumber(1000.5, 'de-DE')).toBe('1.000,5');
    });
  });

  describe('truncate', () => {
    it('should not truncate strings shorter than maxLength', () => {
      expect(truncate('hello', 10)).toBe('hello');
      expect(truncate('hi', 5)).toBe('hi');
      expect(truncate('', 10)).toBe('');
    });

    it('should truncate strings longer than maxLength', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
      expect(truncate('this is a long text', 10)).toBe('this is...');
    });

    it('should handle exact length strings', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });

    it('should use custom ellipsis', () => {
      expect(truncate('hello world', 8, '…')).toBe('hello w…');
      expect(truncate('hello world', 10, ' [more]')).toBe('hel [more]');
    });

    it('should handle empty ellipsis', () => {
      expect(truncate('hello world', 5, '')).toBe('hello');
    });

    it('should truncate when text length equals maxLength', () => {
      // text.length (5) <= maxLength (5), so no truncation
      expect(truncate('hello', 5)).toBe('hello');
      // text.length (11) > maxLength (8), truncate to 5 chars + ellipsis
      expect(truncate('hello world', 8)).toBe('hello...');
    });
  });

  describe('formatPercentage', () => {
    it('should format decimal to percentage', () => {
      expect(formatPercentage(0.5)).toBe('50%');
      expect(formatPercentage(1)).toBe('100%');
      expect(formatPercentage(0)).toBe('0%');
      expect(formatPercentage(0.25)).toBe('25%');
    });

    it('should handle values greater than 1', () => {
      expect(formatPercentage(1.5)).toBe('150%');
      expect(formatPercentage(2)).toBe('200%');
    });

    it('should handle decimal places parameter', () => {
      expect(formatPercentage(0.5, 2)).toBe('50.00%');
      expect(formatPercentage(0.333, 1)).toBe('33.3%');
      expect(formatPercentage(0.3333, 2)).toBe('33.33%');
    });

    it('should handle negative percentages', () => {
      expect(formatPercentage(-0.1)).toBe('-10%');
      expect(formatPercentage(-0.5, 1)).toBe('-50.0%');
    });

    it('should handle very small values', () => {
      expect(formatPercentage(0.001, 1)).toBe('0.1%');
      expect(formatPercentage(0.0001, 2)).toBe('0.01%');
    });
  });

  describe('formatTimecode', () => {
    it('should format seconds to MM:SS', () => {
      expect(formatTimecode(0)).toBe('00:00');
      expect(formatTimecode(30)).toBe('00:30');
      expect(formatTimecode(60)).toBe('01:00');
      expect(formatTimecode(90)).toBe('01:30');
    });

    it('should handle large values', () => {
      expect(formatTimecode(600)).toBe('10:00');
      expect(formatTimecode(3599)).toBe('59:59');
      expect(formatTimecode(3600)).toBe('60:00');
    });

    it('should handle decimal seconds by flooring', () => {
      expect(formatTimecode(30.5)).toBe('00:30');
      expect(formatTimecode(59.9)).toBe('00:59');
    });

    it('should pad single digits with zeros', () => {
      expect(formatTimecode(5)).toBe('00:05');
      expect(formatTimecode(65)).toBe('01:05');
    });
  });

  describe('formatTimecodeHours', () => {
    it('should format seconds to HH:MM:SS', () => {
      expect(formatTimecodeHours(0)).toBe('00:00:00');
      expect(formatTimecodeHours(30)).toBe('00:00:30');
      expect(formatTimecodeHours(60)).toBe('00:01:00');
      expect(formatTimecodeHours(3600)).toBe('01:00:00');
    });

    it('should handle complex times', () => {
      expect(formatTimecodeHours(3661)).toBe('01:01:01');
      expect(formatTimecodeHours(7325)).toBe('02:02:05');
      expect(formatTimecodeHours(86399)).toBe('23:59:59');
    });

    it('should handle times over 24 hours', () => {
      expect(formatTimecodeHours(86400)).toBe('24:00:00');
      expect(formatTimecodeHours(90000)).toBe('25:00:00');
    });

    it('should handle decimal seconds by flooring', () => {
      expect(formatTimecodeHours(3661.5)).toBe('01:01:01');
      expect(formatTimecodeHours(3661.9)).toBe('01:01:01');
    });

    it('should pad all components with zeros', () => {
      expect(formatTimecodeHours(5)).toBe('00:00:05');
      expect(formatTimecodeHours(65)).toBe('00:01:05');
      expect(formatTimecodeHours(3665)).toBe('01:01:05');
    });
  });
});
