import { describe, expect, it } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';

import { validateTimeseriesRange } from '../range-bounds';

describe('validateTimeseriesRange', () => {
  it('accepts a 92-day daily range (the cap, inclusive)', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 92 * 24 * 60 * 60 * 1000);
    expect(() => validateTimeseriesRange('day', from, to)).not.toThrow();
  });

  it('rejects a daily range beyond 92 days', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 93 * 24 * 60 * 60 * 1000);
    expect(() => validateTimeseriesRange('day', from, to)).toThrow(ArgumentInvalidException);
  });

  it('accepts a 72-hour hourly range (the cap, inclusive)', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 72 * 60 * 60 * 1000);
    expect(() => validateTimeseriesRange('hour', from, to)).not.toThrow();
  });

  it('rejects an hourly range beyond 72 hours', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + 73 * 60 * 60 * 1000);
    expect(() => validateTimeseriesRange('hour', from, to)).toThrow(ArgumentInvalidException);
  });

  it('rejects `to` at or before `from`', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    expect(() => validateTimeseriesRange('day', from, from)).toThrow(ArgumentInvalidException);
    expect(() => validateTimeseriesRange('day', from, new Date(from.getTime() - 1))).toThrow(ArgumentInvalidException);
  });

  it('rejects invalid dates', () => {
    const invalid = new Date('not-a-date');
    const valid = new Date('2026-01-01T00:00:00.000Z');
    expect(() => validateTimeseriesRange('day', invalid, valid)).toThrow(ArgumentInvalidException);
    expect(() => validateTimeseriesRange('day', valid, invalid)).toThrow(ArgumentInvalidException);
  });
});
