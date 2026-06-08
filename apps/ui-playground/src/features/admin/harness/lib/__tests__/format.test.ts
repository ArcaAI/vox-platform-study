/**
 * TASK-330 Phase 6 (polish) — relative/UTC timestamp helpers (rule §8).
 */
import { describe, it, expect } from 'vitest';
import { formatAbsoluteUtc, formatRelativeTime } from '../format';

describe('formatRelativeTime', () => {
  it('renders recent timestamps as relative time', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toMatch(/ago/);
  });

  it('falls back to an absolute local date-time for timestamps older than the recent window', () => {
    const old = '2000-01-01T00:00:00.000Z';
    const result = formatRelativeTime(old);
    expect(result).not.toMatch(/ago/);
    expect(result).toBe(new Date(old).toLocaleString());
  });

  it('returns an em-dash for empty or unparseable input', () => {
    expect(formatRelativeTime(undefined)).toBe('—');
    expect(formatRelativeTime(null)).toBe('—');
    expect(formatRelativeTime('not-a-date')).toBe('—');
  });
});

describe('formatAbsoluteUtc', () => {
  it('renders the exact UTC instant for the tooltip', () => {
    const iso = '2026-02-15T10:00:00.000Z';
    expect(formatAbsoluteUtc(iso)).toBe(new Date(iso).toUTCString());
  });

  it('returns an em-dash for empty or unparseable input', () => {
    expect(formatAbsoluteUtc(undefined)).toBe('—');
    expect(formatAbsoluteUtc('nope')).toBe('—');
  });
});
