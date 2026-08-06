import { describe, expect, it } from 'vitest';
import { DRIFT_ALERT_THRESHOLD, computeDrift, computeDriftReport } from '../drift-math';

describe('computeDrift', () => {
  it('reports zero drift when expected equals actual', () => {
    const result = computeDrift({ label: 'exact', expected: 1000, actual: 1000 });
    expect(result.absoluteDiff).toBe(0);
    expect(result.relativeDrift).toBe(0);
    expect(result.breachesThreshold).toBe(false);
  });

  it('reports zero drift (not NaN) when both sides are zero', () => {
    const result = computeDrift({ label: 'empty', expected: 0, actual: 0 });
    expect(result.absoluteDiff).toBe(0);
    expect(result.relativeDrift).toBe(0);
    expect(result.breachesThreshold).toBe(false);
  });

  it('does not breach at exactly the 2% threshold (strict >)', () => {
    const result = computeDrift({ label: 'at-threshold', expected: 1000, actual: 1020 });
    expect(result.relativeDrift).toBeCloseTo(0.02);
    expect(result.breachesThreshold).toBe(false);
  });

  it('breaches just above the 2% threshold', () => {
    const result = computeDrift({ label: 'above-threshold', expected: 1000, actual: 1020.01 });
    expect(result.breachesThreshold).toBe(true);
  });

  it('breaches on negative drift beyond the threshold (actual under-counts)', () => {
    const result = computeDrift({ label: 'under-count', expected: 1000, actual: 950 });
    expect(result.relativeDrift).toBeCloseTo(-0.05);
    expect(result.breachesThreshold).toBe(true);
  });

  it('does not breach on a small negative drift within the threshold', () => {
    const result = computeDrift({ label: 'small-under-count', expected: 1000, actual: 995 });
    expect(result.breachesThreshold).toBe(false);
  });

  it('breaches with a null relativeDrift when expected is 0 but actual is not', () => {
    const result = computeDrift({ label: 'ledger-empty-surface-not', expected: 0, actual: 42 });
    expect(result.relativeDrift).toBeNull();
    expect(result.absoluteDiff).toBe(42);
    expect(result.breachesThreshold).toBe(true);
  });

  it('breaches with a null relativeDrift when expected is 0 and actual is negative-of-zero-base (defensive)', () => {
    const result = computeDrift({ label: 'ledger-empty-surface-negative', expected: 0, actual: -5 });
    expect(result.relativeDrift).toBeNull();
    expect(result.breachesThreshold).toBe(true);
  });

  it('exposes the alert threshold constant as 2%', () => {
    expect(DRIFT_ALERT_THRESHOLD).toBe(0.02);
  });

  it('preserves the comparison label and raw totals on the result', () => {
    const result = computeDrift({ label: 'llm-tokens', expected: 500, actual: 480 });
    expect(result.label).toBe('llm-tokens');
    expect(result.expected).toBe(500);
    expect(result.actual).toBe(480);
  });
});

describe('computeDriftReport', () => {
  it('partitions results into clean vs breaching', () => {
    const { results, breaches } = computeDriftReport([
      { label: 'clean', expected: 100, actual: 100 },
      { label: 'breach-high', expected: 100, actual: 200 },
      { label: 'breach-low', expected: 100, actual: 10 },
      { label: 'within-threshold', expected: 1000, actual: 1010 },
    ]);

    expect(results).toHaveLength(4);
    expect(breaches.map((b) => b.label)).toEqual(['breach-high', 'breach-low']);
  });

  it('returns an empty breach list for an empty comparison batch', () => {
    const { results, breaches } = computeDriftReport([]);
    expect(results).toEqual([]);
    expect(breaches).toEqual([]);
  });
});
