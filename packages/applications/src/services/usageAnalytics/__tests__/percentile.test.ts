import { describe, expect, it } from 'vitest';

import { computeCostDistribution } from '../percentile';

describe('computeCostDistribution', () => {
  it('returns the zero distribution for an empty sample', () => {
    expect(computeCostDistribution([])).toEqual({ count: 0, p50Micros: '0', p90Micros: '0', p99Micros: '0', meanMicros: '0', totalMicros: '0' });
  });

  it('a single-value sample reports that value at every percentile', () => {
    const dist = computeCostDistribution([500n]);
    expect(dist).toEqual({ count: 1, p50Micros: '500', p90Micros: '500', p99Micros: '500', meanMicros: '500', totalMicros: '500' });
  });

  it('computes nearest-rank percentiles over 10 evenly-spaced values', () => {
    const values = Array.from({ length: 10 }, (_, i) => BigInt((i + 1) * 100)); // 100..1000
    const dist = computeCostDistribution(values);
    expect(dist.count).toBe(10);
    // nearest-rank: ceil(0.5*10)=5 -> index 4 -> 500
    expect(dist.p50Micros).toBe('500');
    // ceil(0.9*10)=9 -> index 8 -> 900
    expect(dist.p90Micros).toBe('900');
    // ceil(0.99*10)=10 -> index 9 -> 1000
    expect(dist.p99Micros).toBe('1000');
    expect(dist.totalMicros).toBe('5500');
    expect(dist.meanMicros).toBe('550');
  });

  it('is order-independent (unsorted input sorts internally)', () => {
    const sorted = computeCostDistribution([100n, 200n, 300n]);
    const shuffled = computeCostDistribution([300n, 100n, 200n]);
    expect(shuffled).toEqual(sorted);
  });

  it('every reported percentile IS one of the observed values (nearest-rank, no interpolation)', () => {
    const values = [17n, 42n, 3n, 999n, 256n];
    const dist = computeCostDistribution(values);
    const asStrings = values.map((v) => v.toString());
    expect(asStrings).toContain(dist.p50Micros);
    expect(asStrings).toContain(dist.p90Micros);
    expect(asStrings).toContain(dist.p99Micros);
  });

  it('rounds the mean half-up to an integer micros string', () => {
    const dist = computeCostDistribution([1n, 2n]); // mean 1.5 -> 2
    expect(dist.meanMicros).toBe('2');
  });
});
