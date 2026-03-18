/**
 * convertDateToUnixTimestamp Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { convertDateToUnixTimestamp } from './convertDateToUnixTimestamp';

describe('convertDateToUnixTimestamp', () => {
  it('should convert a valid Date to Unix timestamp', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const result = convertDateToUnixTimestamp(date);

    // January 1, 2024 00:00:00 UTC = 1704067200 seconds since epoch
    expect(result).toBe(1704067200);
  });

  it('should convert epoch date to 0', () => {
    const date = new Date('1970-01-01T00:00:00.000Z');
    const result = convertDateToUnixTimestamp(date);

    expect(result).toBe(0);
  });

  it('should handle dates with milliseconds by flooring', () => {
    const date = new Date('2024-01-01T00:00:00.500Z');
    const result = convertDateToUnixTimestamp(date);

    // Should floor, not round
    expect(result).toBe(1704067200);
  });

  it('should handle dates before epoch (negative timestamps)', () => {
    const date = new Date('1969-12-31T23:59:59.000Z');
    const result = convertDateToUnixTimestamp(date);

    expect(result).toBe(-1);
  });

  it('should throw error for invalid Date object', () => {
    const invalidDate = new Date('invalid');

    expect(() => convertDateToUnixTimestamp(invalidDate)).toThrow(
      'Invalid Date object provided.'
    );
  });

  it('should throw error for non-Date input', () => {
    // @ts-expect-error Testing invalid input
    expect(() => convertDateToUnixTimestamp('2024-01-01')).toThrow(
      'Invalid Date object provided.'
    );

    // @ts-expect-error Testing invalid input
    expect(() => convertDateToUnixTimestamp(1704067200)).toThrow(
      'Invalid Date object provided.'
    );

    // Test with null (cast to bypass TypeScript for runtime test)
    expect(() => convertDateToUnixTimestamp(null as unknown as Date)).toThrow(
      'Invalid Date object provided.'
    );

    // Test with undefined (cast to bypass TypeScript for runtime test)
    expect(() => convertDateToUnixTimestamp(undefined as unknown as Date)).toThrow(
      'Invalid Date object provided.'
    );
  });

  it('should handle current date', () => {
    const now = new Date();
    const result = convertDateToUnixTimestamp(now);

    // Result should be close to current time in seconds
    const expectedApprox = Math.floor(Date.now() / 1000);
    expect(result).toBeCloseTo(expectedApprox, -1); // Within 10 seconds
  });

  it('should handle far future dates', () => {
    const futureDate = new Date('2100-01-01T00:00:00.000Z');
    const result = convertDateToUnixTimestamp(futureDate);

    expect(result).toBeGreaterThan(0);
    expect(typeof result).toBe('number');
  });
});
