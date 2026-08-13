import { describe, expect, it } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';

import { parseBillingPeriod, truncateToUtcDay, utcDayCount } from '../billing-period';

/**
 * Billing-period arithmetic.
 *
 * A billing period is a HALF-OPEN UTC calendar month `[start, end)` — the same
 * window `TenantUsageMeter` and the rollup day buckets use, so allowances and
 * invoices can never disagree about which month a call fell in (D13).
 */
describe('parseBillingPeriod', () => {
  it('parses YYYY-MM into a half-open UTC month', () => {
    const period = parseBillingPeriod('2026-08');
    expect(period.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(period.label).toBe('2026-08');
  });

  it('rolls December into January of the next year', () => {
    const period = parseBillingPeriod('2026-12');
    expect(period.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles February in a leap year (29 days)', () => {
    const period = parseBillingPeriod('2028-02');
    expect(utcDayCount(period.start, period.end)).toBe(29);
  });

  it.each(['2026-8', '2026/08', '202608', '2026-13', '2026-00', 'aug-2026', ''])('rejects malformed period %j', (raw) => {
    expect(() => parseBillingPeriod(raw)).toThrow(ArgumentInvalidException);
  });
});

describe('utcDayCount', () => {
  it('counts the UTC days of a half-open month', () => {
    const period = parseBillingPeriod('2026-08');
    expect(utcDayCount(period.start, period.end)).toBe(31);
  });

  it('counts partial-day boundaries by day-bucket ownership: a segment owns the day it starts, not the day it ends', () => {
    // Upgrade at 2026-08-15T10:00Z: old plan owns [08-01 .. 08-15) = 14 days,
    // new plan owns [08-15 .. 09-01) = 17 days. 14 + 17 = 31 — no double-count,
    // no gap, whatever the intra-day change instant was.
    const changeAt = new Date('2026-08-15T10:00:00.000Z');
    expect(utcDayCount(new Date('2026-08-01T00:00:00.000Z'), changeAt)).toBe(14);
    expect(utcDayCount(changeAt, new Date('2026-09-01T00:00:00.000Z'))).toBe(17);
  });

  it('returns 0 for an empty or inverted range', () => {
    const at = new Date('2026-08-15T00:00:00.000Z');
    expect(utcDayCount(at, at)).toBe(0);
    expect(utcDayCount(new Date('2026-08-16T00:00:00.000Z'), at)).toBe(0);
  });
});

describe('truncateToUtcDay', () => {
  it('truncates to UTC midnight', () => {
    expect(truncateToUtcDay(new Date('2026-08-15T23:59:59.999Z')).toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });
});
