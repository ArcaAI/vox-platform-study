/**
 * TASK-380 — Tenant Dashboard consultation-volume chart bucketing.
 *
 * Pure functions that turn a date range + a consultation list into the
 * `MetricChart` per-bucket new/revisit series. Granularity is daily for
 * week/month and monthly for year (custom adapts by span). Type-only SDK
 * import keeps this testable under the app's `@arcaai/vox` vitest stub.
 *
 * LIMITATION: `useAdminConsultations.list()` has no date filter or aggregate
 * endpoint, so the page buckets the most-recent page client-side. Full
 * server-side range aggregation is a TARGET (see README §3 / getUsageStats gap).
 */

import {
    differenceInCalendarDays,
    eachDayOfInterval,
    eachMonthOfInterval,
    endOfDay,
    endOfMonth,
    format,
    startOfDay,
    startOfMonth,
} from 'date-fns';
import type { AdminConsultation } from '@arcaai/vox';
import { isRevisitConsultation } from './consultations';

/** Range preset, structurally compatible with `@arcaai/ui`'s `DateRange`. */
export type DashboardRangePreset = 'week' | 'month' | 'year' | 'custom';

export interface DashboardRange {
    from: Date;
    to: Date;
    preset: DashboardRangePreset;
}

export type BucketGranularity = 'day' | 'month';

export interface RangeBucket {
    /** Stable key (`yyyy-MM-dd` or `yyyy-MM`). */
    key: string;
    /** Axis label (`MMM d` for days, `MMM` for months). */
    label: string;
    start: Date;
    end: Date;
    granularity: BucketGranularity;
}

/** One `MetricChart` row: the bucket label + the two series values. */
export interface ConsultationChartRow {
    label: string;
    newVisits: number;
    revisits: number;
    /** Index signature so a row is directly assignable to `MetricChart`'s `Record<string, string | number>` data. */
    [key: string]: string | number;
}

/** Chart series keys (must match the `MetricChart` `series[].key`). */
export const CHART_SERIES = [
    { key: 'newVisits', label: 'New' },
    { key: 'revisits', label: 'Re-visit' },
] as const;

/** Daily for week/month; monthly for year; custom adapts to its span. */
function granularityFor(range: DashboardRange): BucketGranularity {
    if (range.preset === 'year') return 'month';
    if (range.preset === 'custom') return differenceInCalendarDays(range.to, range.from) > 70 ? 'month' : 'day';
    return 'day';
}

/** Build the ordered, zero-fillable buckets that span a range. */
export function buildRangeBuckets(range: DashboardRange): RangeBucket[] {
    if (granularityFor(range) === 'month') {
        return eachMonthOfInterval({ start: startOfMonth(range.from), end: endOfMonth(range.to) }).map((d) => ({
            key: format(d, 'yyyy-MM'),
            label: format(d, 'MMM'),
            start: startOfMonth(d),
            end: endOfMonth(d),
            granularity: 'month' as const,
        }));
    }
    return eachDayOfInterval({ start: startOfDay(range.from), end: endOfDay(range.to) }).map((d) => ({
        key: format(d, 'yyyy-MM-dd'),
        label: format(d, 'MMM d'),
        start: startOfDay(d),
        end: endOfDay(d),
        granularity: 'day' as const,
    }));
}

/** Bucket consultations into per-bucket new/revisit counts (zero-filled). */
export function bucketConsultations(consultations: AdminConsultation[], range: DashboardRange): ConsultationChartRow[] {
    const buckets = buildRangeBuckets(range);
    const counts = buckets.map(() => ({ newVisits: 0, revisits: 0 }));

    for (const c of consultations) {
        if (!c.createdAt) continue;
        const ts = new Date(c.createdAt);
        if (Number.isNaN(ts.getTime())) continue;
        const idx = buckets.findIndex((b) => ts >= b.start && ts <= b.end);
        if (idx === -1) continue;
        if (isRevisitConsultation(c)) counts[idx].revisits += 1;
        else counts[idx].newVisits += 1;
    }

    return buckets.map((b, i) => ({ label: b.label, newVisits: counts[i].newVisits, revisits: counts[i].revisits }));
}

/** Absolute window spanned by a bucket list (first start → last end); null when empty. */
export function rangeWindow(buckets: RangeBucket[]): { start: Date; end: Date } | null {
    if (buckets.length === 0) return null;
    return { start: buckets[0].start, end: buckets[buckets.length - 1].end };
}
