import { describe, expect, it } from 'vitest';
import { formatDateTime, formatRelativeTime } from '../index';

describe('formatRelativeTime — future instants', () => {
  const now = new Date('2026-07-05T12:00:00Z');

  it('renders future times as "in …"', () => {
    expect(formatRelativeTime('2026-07-05T12:00:20Z', now)).toBe('in a moment');
    expect(formatRelativeTime('2026-07-05T12:12:00Z', now)).toBe('in 12 min');
    expect(formatRelativeTime('2026-07-06T00:00:00Z', now)).toBe('in 12 h');
    expect(formatRelativeTime('2026-07-08T12:00:00Z', now)).toBe('in 3 d');
  });

  it('falls back to an absolute date beyond a week ahead', () => {
    expect(formatRelativeTime('2026-08-01T12:00:00Z', now)).toBe(formatDateTime('2026-08-01T12:00:00Z', 'date'));
  });
});
