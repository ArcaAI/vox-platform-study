/**
 * @arcaai/utils - Validation Utilities Tests
 *
 * Comprehensive tests for validation utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  isValidUrl,
  isEmpty,
  isDefined,
  isValidUUID,
  isInRange,
  isValidLength,
} from '../validation.js';

describe('validation utilities', () => {
  describe('isValidEmail', () => {
    it('should return true for valid email addresses', () => {
      expect(isValidEmail('test@example.com')).toBe(true);
      expect(isValidEmail('user.name@domain.org')).toBe(true);
      expect(isValidEmail('user+tag@example.co.uk')).toBe(true);
      expect(isValidEmail('simple@test.io')).toBe(true);
    });

    it('should return false for invalid email addresses', () => {
      expect(isValidEmail('')).toBe(false);
      expect(isValidEmail('invalid')).toBe(false);
      expect(isValidEmail('invalid@')).toBe(false);
      expect(isValidEmail('@domain.com')).toBe(false);
      expect(isValidEmail('user@')).toBe(false);
      expect(isValidEmail('user@domain')).toBe(false);
      expect(isValidEmail('user name@domain.com')).toBe(false);
    });

    it('should handle edge cases', () => {
      expect(isValidEmail('a@b.co')).toBe(true);
      expect(isValidEmail('test@sub.domain.com')).toBe(true);
    });
  });

  describe('isValidUrl', () => {
    it('should return true for valid URLs', () => {
      expect(isValidUrl('https://example.com')).toBe(true);
      expect(isValidUrl('http://example.com')).toBe(true);
      expect(isValidUrl('https://example.com/path')).toBe(true);
      expect(isValidUrl('https://example.com/path?query=value')).toBe(true);
      expect(isValidUrl('https://example.com:8080')).toBe(true);
      expect(isValidUrl('ftp://files.example.com')).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      expect(isValidUrl('')).toBe(false);
      expect(isValidUrl('not-a-url')).toBe(false);
      expect(isValidUrl('example.com')).toBe(false);
      expect(isValidUrl('://example.com')).toBe(false);
      expect(isValidUrl('http://')).toBe(false);
    });

    it('should handle special characters in URLs', () => {
      expect(isValidUrl('https://example.com/path with spaces')).toBe(true);
      expect(isValidUrl('https://example.com/path#anchor')).toBe(true);
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty strings', () => {
      expect(isEmpty('')).toBe(true);
    });

    it('should return true for whitespace-only strings', () => {
      expect(isEmpty(' ')).toBe(true);
      expect(isEmpty('  ')).toBe(true);
      expect(isEmpty('\t')).toBe(true);
      expect(isEmpty('\n')).toBe(true);
      expect(isEmpty('  \t\n  ')).toBe(true);
    });

    it('should return false for non-empty strings', () => {
      expect(isEmpty('a')).toBe(false);
      expect(isEmpty('hello')).toBe(false);
      expect(isEmpty(' a ')).toBe(false);
      expect(isEmpty('hello world')).toBe(false);
    });
  });

  describe('isDefined', () => {
    it('should return true for defined values', () => {
      expect(isDefined(0)).toBe(true);
      expect(isDefined('')).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined([])).toBe(true);
      expect(isDefined({})).toBe(true);
      expect(isDefined('value')).toBe(true);
      expect(isDefined(123)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isDefined(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isDefined(undefined)).toBe(false);
    });

    it('should work as type guard', () => {
      const value: string | null | undefined = 'test';
      if (isDefined(value)) {
        // TypeScript should know value is string here
        expect(value.length).toBe(4);
      }
    });
  });

  describe('isValidUUID', () => {
    it('should return true for valid UUID v4', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
      expect(isValidUUID('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    });

    it('should return true for lowercase UUIDs', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('should return true for uppercase UUIDs', () => {
      expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('should return false for invalid UUIDs', () => {
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false);
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
      expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false);
      expect(isValidUUID('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')).toBe(false);
    });

    it('should validate UUID version character', () => {
      // Version must be 1-5
      expect(isValidUUID('550e8400-e29b-61d4-a716-446655440000')).toBe(false);
      expect(isValidUUID('550e8400-e29b-01d4-a716-446655440000')).toBe(false);
    });
  });

  describe('isInRange', () => {
    it('should return true when value is within range', () => {
      expect(isInRange(5, 0, 10)).toBe(true);
      expect(isInRange(0, 0, 10)).toBe(true);
      expect(isInRange(10, 0, 10)).toBe(true);
      expect(isInRange(50, 0, 100)).toBe(true);
    });

    it('should return false when value is outside range', () => {
      expect(isInRange(-1, 0, 10)).toBe(false);
      expect(isInRange(11, 0, 10)).toBe(false);
      expect(isInRange(100, 0, 50)).toBe(false);
    });

    it('should handle negative ranges', () => {
      expect(isInRange(-5, -10, 0)).toBe(true);
      expect(isInRange(-10, -10, -5)).toBe(true);
      expect(isInRange(-15, -10, 0)).toBe(false);
    });

    it('should handle decimal values', () => {
      expect(isInRange(5.5, 0, 10)).toBe(true);
      expect(isInRange(0.001, 0, 1)).toBe(true);
      expect(isInRange(0.999, 0, 1)).toBe(true);
    });

    it('should handle equal min and max', () => {
      expect(isInRange(5, 5, 5)).toBe(true);
      expect(isInRange(4, 5, 5)).toBe(false);
    });
  });

  describe('isValidLength', () => {
    it('should return true when string length is within range', () => {
      expect(isValidLength('hello', 1, 10)).toBe(true);
      expect(isValidLength('a', 1, 10)).toBe(true);
      expect(isValidLength('1234567890', 1, 10)).toBe(true);
    });

    it('should return false when string is too short', () => {
      expect(isValidLength('', 1, 10)).toBe(false);
      expect(isValidLength('ab', 3, 10)).toBe(false);
    });

    it('should return false when string is too long', () => {
      expect(isValidLength('hello world', 1, 5)).toBe(false);
      expect(isValidLength('12345678901', 1, 10)).toBe(false);
    });

    it('should trim whitespace before checking length', () => {
      expect(isValidLength('  hello  ', 1, 5)).toBe(true);
      expect(isValidLength('   ', 1, 10)).toBe(false);
    });

    it('should use MAX_SAFE_INTEGER as default max', () => {
      const longString = 'a'.repeat(1000);
      expect(isValidLength(longString, 1)).toBe(true);
    });

    it('should handle minimum length only', () => {
      expect(isValidLength('password', 8)).toBe(true);
      expect(isValidLength('short', 8)).toBe(false);
    });
  });
});
