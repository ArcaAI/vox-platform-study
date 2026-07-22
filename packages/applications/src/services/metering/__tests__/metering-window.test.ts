/**
 * Calendar-month window maths.
 *
 * The window must be the UTC month containing `now`, half-open
 * [1st 00:00:00Z, next-1st 00:00:00Z), tiling the timeline with no gap/overlap
 * and rolling correctly across the year boundary.
 */
import { describe, it, expect } from 'vitest';
import { currentMonthWindow } from '../metering-window';

describe('currentMonthWindow', () => {
  it('returns the UTC month bounds for a mid-month instant', () => {
    const { periodStart, periodEnd } = currentMonthWindow(new Date('2026-03-17T09:41:23.456Z'));
    expect(periodStart.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls the year over for December', () => {
    const { periodStart, periodEnd } = currentMonthWindow(new Date('2026-12-31T23:59:59.999Z'));
    expect(periodStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(periodEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('is inclusive of the exact start instant (start belongs to its own window)', () => {
    const start = new Date('2026-02-01T00:00:00.000Z');
    const { periodStart, periodEnd } = currentMonthWindow(start);
    expect(periodStart.getTime()).toBe(start.getTime());
    expect(periodEnd.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('tiles consecutive months with no gap (this.periodEnd === next.periodStart)', () => {
    const jan = currentMonthWindow(new Date('2026-01-10T00:00:00.000Z'));
    const feb = currentMonthWindow(new Date('2026-02-10T00:00:00.000Z'));
    expect(jan.periodEnd.getTime()).toBe(feb.periodStart.getTime());
  });
});
