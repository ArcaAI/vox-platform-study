/**
 * TASK-392 (Phase 3) — pure enforcement logic.
 *
 * These functions are the SENSITIVE core (Q10): the block-new comparison and
 * the newest-first soft-disable selection. They are covered exhaustively here
 * because a wrong selection would disable the wrong (or too many) resources.
 */
import { describe, it, expect } from 'vitest';
import { wouldExceedLimit, selectResourcesToDisable, isTrialExpired } from '../enforcement';

describe('wouldExceedLimit (Q10 block-new)', () => {
  it('never blocks an unlimited (null) limit', () => {
    expect(wouldExceedLimit(null, 1_000_000)).toBe(false);
  });

  it('blocks when the next create would cross the limit', () => {
    expect(wouldExceedLimit(5, 5)).toBe(true); // 5 used, +1 = 6 > 5
    expect(wouldExceedLimit(5, 4)).toBe(false); // 4 used, +1 = 5 == limit → allowed
  });

  it('blocks when already over the limit (grandfathered rows still block new)', () => {
    expect(wouldExceedLimit(5, 8)).toBe(true);
  });

  it('honors a custom increment (e.g. a bulk/meter submit)', () => {
    expect(wouldExceedLimit(100, 90, 10)).toBe(false); // 90+10 = 100 == limit
    expect(wouldExceedLimit(100, 91, 10)).toBe(true); // 101 > 100
  });
});

describe('selectResourcesToDisable (Q10 newest-first soft-disable)', () => {
  const r = (id: string, iso: string): { id: string; createdAt: Date } => ({ id, createdAt: new Date(iso) });

  it('returns nothing when within the limit', () => {
    const rows = [r('a', '2026-01-01'), r('b', '2026-01-02')];
    expect(selectResourcesToDisable(rows, 5)).toEqual([]);
    expect(selectResourcesToDisable(rows, 2)).toEqual([]);
  });

  it('returns nothing for an unlimited (null) or negative limit', () => {
    const rows = [r('a', '2026-01-01'), r('b', '2026-01-02')];
    expect(selectResourcesToDisable(rows, null)).toEqual([]);
    expect(selectResourcesToDisable(rows, -1)).toEqual([]);
  });

  it('keeps the oldest `limit` and disables the newest overflow', () => {
    const rows = [
      r('newest', '2026-03-01'),
      r('oldest', '2026-01-01'),
      r('middle', '2026-02-01'),
    ];
    // limit 1 → keep oldest, disable the two newest.
    expect(selectResourcesToDisable(rows, 1)).toEqual(['middle', 'newest']);
    // limit 2 → keep two oldest, disable only the newest.
    expect(selectResourcesToDisable(rows, 2)).toEqual(['newest']);
  });

  it('disables everything when the limit is zero', () => {
    const rows = [r('a', '2026-01-01'), r('b', '2026-01-02')];
    expect(selectResourcesToDisable(rows, 0).sort()).toEqual(['a', 'b']);
  });

  it('is deterministic under equal timestamps (tie-break on id)', () => {
    const rows = [r('b', '2026-01-01'), r('a', '2026-01-01'), r('c', '2026-01-01')];
    // All equal → oldest-first becomes id order [a,b,c]; limit 1 keeps 'a'.
    expect(selectResourcesToDisable(rows, 1)).toEqual(['b', 'c']);
  });
});

describe('isTrialExpired (Q4)', () => {
  const now = new Date('2026-03-10T00:00:00.000Z');

  it('is false for a null clock', () => {
    expect(isTrialExpired(null, now)).toBe(false);
    expect(isTrialExpired(undefined, now)).toBe(false);
  });

  it('is true once the clock is at/before now', () => {
    expect(isTrialExpired(new Date('2026-03-09T23:59:59.999Z'), now)).toBe(true);
    expect(isTrialExpired(new Date('2026-03-10T00:00:00.000Z'), now)).toBe(true);
  });

  it('is false while the clock is still in the future', () => {
    expect(isTrialExpired(new Date('2026-03-10T00:00:00.001Z'), now)).toBe(false);
  });
});
