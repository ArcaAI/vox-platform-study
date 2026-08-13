import Decimal from 'decimal.js';

/**
 * Pure percentile computation for `getCostPerEncounter`.
 *
 * Nearest-rank method (no interpolation): for a sorted ascending sample of
 * size `n`, the p-th percentile is the value at index `ceil(p/100 * n) - 1`,
 * clamped into range. Deterministic, no floating-point interpolation drift —
 * appropriate for a money-adjacent distribution where "the p90 IS one of the
 * observed costs" is a stronger, simpler guarantee than an interpolated value
 * that no encounter actually cost.
 */
export interface CostDistribution {
  count: number;
  p50Micros: string;
  p90Micros: string;
  p99Micros: string;
  meanMicros: string;
  totalMicros: string;
}

const ZERO_DISTRIBUTION: CostDistribution = { count: 0, p50Micros: '0', p90Micros: '0', p99Micros: '0', meanMicros: '0', totalMicros: '0' };

function nearestRank(sortedAscending: readonly bigint[], percentile: number): bigint {
  const n = sortedAscending.length;
  const rank = Math.ceil((percentile / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAscending[index];
}

/** `values` need not be sorted or non-empty; an empty input returns the zero distribution. */
export function computeCostDistribution(values: readonly bigint[]): CostDistribution {
  if (values.length === 0) return ZERO_DISTRIBUTION;

  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = sorted.reduce((sum, value) => sum + value, 0n);
  const mean = new Decimal(total.toString()).dividedBy(sorted.length).toFixed(0, Decimal.ROUND_HALF_UP);

  return {
    count: sorted.length,
    p50Micros: nearestRank(sorted, 50).toString(),
    p90Micros: nearestRank(sorted, 90).toString(),
    p99Micros: nearestRank(sorted, 99).toString(),
    meanMicros: mean,
    totalMicros: total.toString(),
  };
}
