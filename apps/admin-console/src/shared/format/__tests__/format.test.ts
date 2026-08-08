import { describe, expect, it } from 'vitest';
import { formatBytes, formatDateTime, formatMicros, formatNumber, formatRelativeTime, formatUnitRate } from '../index';

describe('formatMicros', () => {
  it('renders integer-micros strings as USD currency', () => {
    expect(formatMicros('199029940')).toBe('$199.03'); // the TASK-615 live-evidence total
    expect(formatMicros('0')).toBe('$0.00');
    expect(formatMicros('3000')).toBe('$0.00'); // 3000 micros rounds to a cent
    expect(formatMicros('999000000')).toBe('$999.00');
  });

  it('honours a non-USD currency', () => {
    expect(formatMicros('1500000', 'EUR')).toContain('1.50');
  });

  it('renders an em-dash for nullish/empty/NaN values', () => {
    expect(formatMicros(null)).toBe('—');
    expect(formatMicros(undefined)).toBe('—');
    expect(formatMicros('')).toBe('—');
    expect(formatMicros('not-a-number')).toBe('—');
  });
});

describe('formatUnitRate', () => {
  // REGRESSION (found in live verification of the TASK-638 rate card): unit
  // rates are sub-cent by nature, so formatMicros — correct for invoice totals,
  // see the '3000' case above — collapsed the ENTIRE card to "$0.00". The 6µ
  // self-hosted baseline and the 1,390µ managed-ASR premium rendered
  // identically, hiding the one distinction the screen exists to show.
  it('keeps sub-cent unit rates distinguishable', () => {
    expect(formatUnitRate('1390')).toBe('$0.00139');
    expect(formatUnitRate('6')).toBe('$0.000006');
    expect(formatUnitRate('2')).toBe('$0.000002');
    // The two rates the bug conflated must not be equal.
    expect(formatUnitRate('6')).not.toBe(formatUnitRate('1390'));
  });

  it('still renders whole-currency amounts conventionally', () => {
    expect(formatUnitRate('50000000')).toBe('$50.00');
    expect(formatUnitRate('0')).toBe('$0.00');
  });

  it('honours a non-USD currency and renders an em-dash for nullish/NaN', () => {
    expect(formatUnitRate('1500000', 'EUR')).toContain('1.50');
    expect(formatUnitRate(null)).toBe('—');
    expect(formatUnitRate('')).toBe('—');
    expect(formatUnitRate('not-a-number')).toBe('—');
  });
});

describe('formatNumber', () => {
  it('groups thousands', () => {
    expect(formatNumber(1284)).toBe('1,284');
    expect(formatNumber(0)).toBe('0');
  });

  it('renders an em-dash for nullish values', () => {
    expect(formatNumber(null)).toBe('\u2014');
    expect(formatNumber(undefined)).toBe('\u2014');
  });
});

describe('formatBytes', () => {
  it('scales binary units with one decimal above KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(612 * 1024 ** 3)).toBe('612 GB');
    expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.5 TB');
  });

  it('renders an em-dash for nullish values', () => {
    expect(formatBytes(null)).toBe('\u2014');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-05T12:00:00Z');

  it('describes recent instants relative to now', () => {
    expect(formatRelativeTime('2026-07-05T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-05T11:55:00Z', now)).toBe('5 min ago');
    expect(formatRelativeTime('2026-07-05T10:00:00Z', now)).toBe('2 h ago');
  });

  it('falls back to an absolute date beyond a week', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00Z', now)).toBe(formatDateTime('2026-06-01T12:00:00Z', 'date'));
  });

  it('renders an em-dash for nullish or invalid input', () => {
    expect(formatRelativeTime(null, now)).toBe('\u2014');
    expect(formatRelativeTime('not-a-date', now)).toBe('\u2014');
  });
});

describe('formatDateTime', () => {
  it('renders an em-dash for nullish input', () => {
    expect(formatDateTime(null)).toBe('\u2014');
  });

  it('renders date-only and date-time variants', () => {
    const iso = '2026-03-02T09:30:00Z';
    expect(formatDateTime(iso, 'date')).toMatch(/2026/);
    expect(formatDateTime(iso)).toMatch(/\d{2}:\d{2}/);
  });
});
