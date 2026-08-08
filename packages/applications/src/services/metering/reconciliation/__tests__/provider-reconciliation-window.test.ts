/**
 * Trailing reconciliation window (TASK-638 §6 rule 4).
 *
 * The rule these tests protect: NEVER reconcile a day the provider has not
 * finished counting. A drift alert that only means "the vendor is still
 * settling" trains an operator to ignore drift alerts.
 */

import { describe, expect, it } from 'vitest';

import { formatWindowLabel, RECONCILIATION_WINDOW_DEFAULTS, resolveReconciliationWindow } from '../provider-reconciliation-window';

const at = (iso: string) => new Date(iso);

describe('resolveReconciliationWindow', () => {
  it('reconciles a whole settled day, skipping the provider lag (defaults: lag 2, window 1)', () => {
    // Run at any hour on the 10th → the 8th, whole.
    const window = resolveReconciliationWindow(at('2026-08-10T06:30:00.000Z'));
    expect(window.start.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('never includes today or the lag days — the whole point of the rule', () => {
    const now = at('2026-08-10T23:59:59.000Z');
    const window = resolveReconciliationWindow(now);
    const todayMidnight = at('2026-08-10T00:00:00.000Z');
    expect(window.end.getTime()).toBeLessThanOrEqual(todayMidnight.getTime());
    expect(window.end.getTime()).toBe(todayMidnight.getTime() - RECONCILIATION_WINDOW_DEFAULTS.lagDays * 86_400_000);
  });

  it('is half-open and clock-independent — the run hour never changes the window', () => {
    const morning = resolveReconciliationWindow(at('2026-08-10T00:00:01.000Z'));
    const night = resolveReconciliationWindow(at('2026-08-10T23:00:00.000Z'));
    expect(morning).toEqual(night);
  });

  it('spans multiple days when asked, still ending before the lag', () => {
    const window = resolveReconciliationWindow(at('2026-08-10T00:00:00.000Z'), { lagDays: 3, windowDays: 3 });
    expect(window.start.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('crosses a month boundary correctly', () => {
    const window = resolveReconciliationWindow(at('2026-09-01T12:00:00.000Z'));
    expect(window.start.toISOString()).toBe('2026-08-29T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-08-30T00:00:00.000Z');
  });

  it('clamps nonsense config instead of throwing — a diagnostic job must not fail closed', () => {
    const negative = resolveReconciliationWindow(at('2026-08-10T00:00:00.000Z'), { lagDays: -5, windowDays: 0 });
    expect(negative.end.toISOString()).toBe('2026-08-10T00:00:00.000Z'); // lag clamped to 0
    expect(negative.start.toISOString()).toBe('2026-08-09T00:00:00.000Z'); // window clamped to >= 1 day
  });
});

describe('formatWindowLabel', () => {
  it('renders a single-day window as one date', () => {
    expect(formatWindowLabel(resolveReconciliationWindow(at('2026-08-10T00:00:00.000Z')))).toBe('2026-08-07');
  });

  it('renders a multi-day window as an INCLUSIVE range (the end is exclusive internally)', () => {
    const window = resolveReconciliationWindow(at('2026-08-10T00:00:00.000Z'), { lagDays: 3, windowDays: 3 });
    expect(formatWindowLabel(window)).toBe('2026-08-04..2026-08-06');
  });
});
