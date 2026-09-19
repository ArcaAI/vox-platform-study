/**
 * Latency percentiles that survive being merged across worker threads.
 *
 * Virtual users are sharded over `worker_threads` so the CLIENT is not the
 * thing being measured, which means each worker produces its own latency
 * distribution and the report has to combine them. Shipping every raw sample
 * back over `postMessage` would cost ~250k structured-clone entries on a
 * five-minute run at the 10x100 target; a bounded histogram merges by adding
 * two arrays.
 *
 * Resolution is log-linear, chosen so the error at each percentile is smaller
 * than the difference anyone would act on:
 *   0-1_000 ms    1 ms buckets   (<0.1% error where p50/p95 normally sit)
 *   1-10 s       10 ms buckets   (<1% error)
 *   10-100 s    100 ms buckets   (<1% error)
 *   >100 s       overflow, counted and reported as such rather than clamped
 *
 * Everything here is pure and unit-tested.
 */

const BAND_1_MAX_MS = 1_000;
const BAND_2_MAX_MS = 10_000;
const BAND_3_MAX_MS = 100_000;
const BAND_1_BUCKETS = 1_000; //   1 ms each
const BAND_2_BUCKETS = 900; //  10 ms each
const BAND_3_BUCKETS = 900; // 100 ms each
export const HISTOGRAM_BUCKETS = BAND_1_BUCKETS + BAND_2_BUCKETS + BAND_3_BUCKETS + 1; // +1 overflow

/** A mergeable latency histogram. `counts` is plain enough to cross a worker boundary as-is. */
export interface Histogram {
  counts: number[];
  total: number;
  sum: number;
  min: number;
  max: number;
}

export function createHistogram(): Histogram {
  return { counts: new Array<number>(HISTOGRAM_BUCKETS).fill(0), total: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0 };
}

/** Bucket index for a latency. Monotonic in `ms`, which is what makes the percentile scan valid. */
export function bucketFor(ms: number): number {
  if (!(ms > 0)) return 0;
  if (ms < BAND_1_MAX_MS) return Math.min(BAND_1_BUCKETS - 1, Math.floor(ms));
  if (ms < BAND_2_MAX_MS) return BAND_1_BUCKETS + Math.min(BAND_2_BUCKETS - 1, Math.floor((ms - BAND_1_MAX_MS) / 10));
  if (ms < BAND_3_MAX_MS) return BAND_1_BUCKETS + BAND_2_BUCKETS + Math.min(BAND_3_BUCKETS - 1, Math.floor((ms - BAND_2_MAX_MS) / 100));
  return HISTOGRAM_BUCKETS - 1;
}

/** Upper edge of a bucket, in ms. The percentile reported is this edge, so it never UNDER-states latency. */
export function bucketUpperBoundMs(index: number): number {
  if (index < BAND_1_BUCKETS) return index + 1;
  if (index < BAND_1_BUCKETS + BAND_2_BUCKETS) return BAND_1_MAX_MS + (index - BAND_1_BUCKETS + 1) * 10;
  if (index < HISTOGRAM_BUCKETS - 1) return BAND_2_MAX_MS + (index - BAND_1_BUCKETS - BAND_2_BUCKETS + 1) * 100;
  return Number.POSITIVE_INFINITY;
}

export function record(histogram: Histogram, ms: number): void {
  const bucket = bucketFor(ms);
  const counts = histogram.counts;
  counts[bucket] = (counts[bucket] ?? 0) + 1;
  histogram.total += 1;
  histogram.sum += ms;
  if (ms < histogram.min) histogram.min = ms;
  if (ms > histogram.max) histogram.max = ms;
}

/** Fold `source` into `target`. Used once per worker when its shard finishes. */
export function merge(target: Histogram, source: Histogram): Histogram {
  for (let i = 0; i < HISTOGRAM_BUCKETS; i += 1) {
    const add = source.counts[i] ?? 0;
    if (add !== 0) target.counts[i] = (target.counts[i] ?? 0) + add;
  }
  target.total += source.total;
  target.sum += source.sum;
  target.min = Math.min(target.min, source.min);
  target.max = Math.max(target.max, source.max);
  return target;
}

/**
 * The value at `q` (0..1), as a bucket UPPER bound.
 *
 * Reports the pessimistic edge deliberately: a capacity report that rounds
 * latency down is worse than useless. Returns `NaN` for an empty histogram
 * rather than 0, so "no data" can never be read as "instant".
 */
export function quantile(histogram: Histogram, q: number): number {
  if (histogram.total === 0) return Number.NaN;
  const target = Math.ceil(q * histogram.total);
  let seen = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i += 1) {
    seen += histogram.counts[i] ?? 0;
    if (seen >= target) return bucketUpperBoundMs(i);
  }
  return histogram.max;
}

export function mean(histogram: Histogram): number {
  return histogram.total === 0 ? Number.NaN : histogram.sum / histogram.total;
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Samples that fell past the last finite bucket (>100 s). Non-zero invalidates `maxMs` as a bucket edge. */
  overflow: number;
}

export function summarize(histogram: Histogram): LatencySummary {
  return {
    count: histogram.total,
    meanMs: round(mean(histogram)),
    p50Ms: round(quantile(histogram, 0.5)),
    p95Ms: round(quantile(histogram, 0.95)),
    p99Ms: round(quantile(histogram, 0.99)),
    maxMs: round(histogram.total === 0 ? Number.NaN : histogram.max),
    overflow: histogram.counts[HISTOGRAM_BUCKETS - 1] ?? 0,
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}
