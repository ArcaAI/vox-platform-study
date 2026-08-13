import { ArgumentInvalidException } from '@arcaai/exceptions';

/**
 * Bounded-range validation for `getUsageTimeseries`.
 *
 * A tenant timeseries reads rollup buckets, not raw events, but an unbounded
 * range is still an unbounded query (and an unbounded response payload).
 * Hard caps: 92 days at daily granularity (~3 months, comfortably covers a
 * quarter view), 72 hours at hourly granularity (3 days — the hourly rollup's
 * useful horizon; daily is the multi-week/month read).
 *
 * PURE. Throws `ArgumentInvalidException` (maps to 400 via the global
 * exception interceptor, rule 05) rather than defaulting or clamping — a
 * silently-truncated range would be a wrong chart, not a helpful one.
 */
export type UsageTimeseriesGranularity = 'day' | 'hour';

export const MAX_RANGE_DAYS: Record<UsageTimeseriesGranularity, number> = {
  day: 92,
  hour: 3, // 72 hours
};

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function validateTimeseriesRange(granularity: UsageTimeseriesGranularity, from: Date, to: Date): void {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new ArgumentInvalidException('`from` must be a valid date.');
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new ArgumentInvalidException('`to` must be a valid date.');
  }
  if (to.getTime() <= from.getTime()) {
    throw new ArgumentInvalidException('`to` must be after `from`.');
  }

  const spanMs = to.getTime() - from.getTime();
  const maxSpanMs = granularity === 'day' ? MAX_RANGE_DAYS.day * MS_PER_DAY : MAX_RANGE_DAYS.hour * MS_PER_DAY;
  if (spanMs > maxSpanMs) {
    const maxLabel = granularity === 'day' ? `${MAX_RANGE_DAYS.day} days` : `${MAX_RANGE_DAYS.hour * 24} hours`;
    throw new ArgumentInvalidException(`Range exceeds the maximum for granularity "${granularity}" (${maxLabel}).`);
  }
}
