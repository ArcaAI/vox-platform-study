/**
 * The percentiles a capacity report is read off, and the merge that makes them
 * valid across worker threads.
 *
 * The one property that matters: merging N workers' histograms must give the
 * same answer as one histogram fed every sample. If it does not, a multi-worker
 * run reports a different p99 from a single-worker run of the same load, and
 * neither number can be trusted.
 */
import { describe, expect, it } from 'vitest';
import { bucketFor, bucketUpperBoundMs, createHistogram, merge, quantile, record, summarize } from '../src/stats';

describe('bucketing', () => {
  it('is monotonic, which is what makes the percentile scan correct', () => {
    let previous = -1;
    for (const ms of [0, 0.4, 1, 17, 999, 1_000, 1_005, 9_999, 10_000, 10_150, 99_999, 100_000, 500_000]) {
      const bucket = bucketFor(ms);
      expect(bucket).toBeGreaterThanOrEqual(previous);
      previous = bucket;
    }
  });

  it('reports the UPPER bound, so a percentile is never understated', () => {
    const histogram = createHistogram();
    record(histogram, 17.2);
    expect(quantile(histogram, 0.5)).toBe(18);
    expect(bucketUpperBoundMs(bucketFor(17.2))).toBe(18);
  });

  it('keeps sub-1% error in each band', () => {
    for (const ms of [250, 999, 4_000, 9_990, 40_000, 99_000]) {
      const upper = bucketUpperBoundMs(bucketFor(ms));
      expect((upper - ms) / ms).toBeLessThan(0.011);
    }
  });

  it('counts anything past 100s in the overflow bucket instead of clamping it away', () => {
    const histogram = createHistogram();
    record(histogram, 1);
    record(histogram, 250_000);
    expect(summarize(histogram).overflow).toBe(1);
    expect(summarize(histogram).maxMs).toBe(250_000);
  });
});

describe('quantile', () => {
  it('returns NaN for an empty histogram — "no data" must never read as "instant"', () => {
    expect(Number.isNaN(quantile(createHistogram(), 0.5))).toBe(true);
    expect(Number.isNaN(summarize(createHistogram()).p99Ms)).toBe(true);
  });

  it('puts p99 in the tail, not the body', () => {
    const histogram = createHistogram();
    for (let i = 0; i < 980; i += 1) record(histogram, 10);
    for (let i = 0; i < 20; i += 1) record(histogram, 4_000);
    expect(quantile(histogram, 0.5)).toBe(11);
    expect(quantile(histogram, 0.99)).toBeGreaterThan(3_000);
  });

  // NEAREST-RANK, and the boundary is worth pinning because a reader WILL hit
  // it: with exactly 1% of samples slow, rank ceil(0.99*n) still lands on the
  // last fast sample, so p99 reads fast. That is the standard definition, not a
  // rounding bug — but it means "p99 is fine" at exactly 1% failure is not the
  // reassurance it looks like, and the report's max/overflow columns exist for
  // precisely this case.
  it('is nearest-rank: exactly 1% slow leaves p99 in the body', () => {
    const histogram = createHistogram();
    for (let i = 0; i < 990; i += 1) record(histogram, 10);
    for (let i = 0; i < 10; i += 1) record(histogram, 4_000);
    expect(quantile(histogram, 0.99)).toBe(11);
    expect(quantile(histogram, 0.995)).toBeGreaterThan(3_000);
    expect(histogram.max).toBe(4_000);
  });
});

describe('merge', () => {
  it('gives the same distribution as a single histogram fed every sample', () => {
    const samples = Array.from({ length: 5_000 }, (_, i) => (i % 97) * 3 + (i % 11) * 120);

    const single = createHistogram();
    for (const ms of samples) record(single, ms);

    const shards = [createHistogram(), createHistogram(), createHistogram(), createHistogram()];
    samples.forEach((ms, i) => record(shards[i % shards.length]!, ms));
    const merged = shards.reduce((target, shard) => merge(target, shard), createHistogram());

    expect(summarize(merged)).toEqual(summarize(single));
  });

  it('carries min, max and count across the boundary', () => {
    const a = createHistogram();
    record(a, 5);
    const b = createHistogram();
    record(b, 900);
    const merged = merge(a, b);
    expect(merged.total).toBe(2);
    expect(merged.min).toBe(5);
    expect(merged.max).toBe(900);
  });
});
