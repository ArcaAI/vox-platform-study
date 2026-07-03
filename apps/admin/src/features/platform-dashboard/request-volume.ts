/**
 * TASK-404 — Monitoring Request-volume chart view-model (P2-1 slice).
 *
 * Pure mapping from the TASK-386 E1 `PlatformMetrics.requestVolumeSeries`
 * (30-min Prometheus window, 60 s step; requests as rate/sec) into the
 * `MetricChart` rows the Monitoring page renders. Type-only SDK import keeps
 * this testable under the app's `@arcaai/vox` vitest stub.
 */

import { format } from 'date-fns';
import type { RequestVolumePoint } from '@arcaai/vox';

/** One `MetricChart` row: bucket time label + the two series values. */
export interface RequestVolumeRow {
  /** Bucket start in local time (`HH:mm`). */
  label: string;
  /** Requests per minute at this bucket (rate/sec × 60, rounded). */
  requests: number;
  /** Open sockets at this bucket (rounded). */
  sockets: number;
  /** Index signature so a row is directly assignable to `MetricChart` data. */
  [key: string]: string | number;
}

/** Chart series keys (must match the `MetricChart` `series[].key`). */
export const REQUEST_VOLUME_SERIES = [
  { key: 'requests', label: 'Requests / min' },
  { key: 'sockets', label: 'Open sockets' },
] as const;

/** Round a sample to an integer; non-finite samples become 0 (bucket kept). */
function roundSample(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** Map the E1 series to chart rows. Unparseable timestamps are skipped. */
export function buildRequestVolumeRows(series: RequestVolumePoint[] | null | undefined): RequestVolumeRow[] {
  const rows: RequestVolumeRow[] = [];
  for (const point of series ?? []) {
    const ts = new Date(point.t);
    if (Number.isNaN(ts.getTime())) continue;
    rows.push({
      label: format(ts, 'HH:mm'),
      requests: roundSample(point.requests * 60),
      sockets: roundSample(point.sockets),
    });
  }
  return rows;
}
