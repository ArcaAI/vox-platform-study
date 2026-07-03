import { describe, expect, it } from 'vitest';
import { buildRequestVolumeRows, REQUEST_VOLUME_SERIES } from '../request-volume';

/** Local-time ISO helper so label expectations are timezone-independent. */
function isoAtLocal(hours: number, minutes: number): string {
  return new Date(2026, 5, 30, hours, minutes, 0).toISOString();
}

describe('buildRequestVolumeRows (TASK-404 · TASK-386 E1 series)', () => {
  it('maps points to HH:mm labels with req/min and socket values', () => {
    const rows = buildRequestVolumeRows([
      { t: isoAtLocal(14, 5), requests: 2.5, sockets: 3 },
      { t: isoAtLocal(14, 6), requests: 0.4, sockets: 2 },
    ]);
    expect(rows).toEqual([
      { label: '14:05', requests: 150, sockets: 3 },
      { label: '14:06', requests: 24, sockets: 2 },
    ]);
  });

  it('rounds request/socket values to integers', () => {
    const rows = buildRequestVolumeRows([{ t: isoAtLocal(9, 0), requests: 0.011, sockets: 1.6 }]);
    // 0.011 req/s ≈ 0.66 req/min → 1; sockets 1.6 → 2
    expect(rows[0].requests).toBe(1);
    expect(rows[0].sockets).toBe(2);
  });

  it('zero-fills non-finite sample values instead of dropping the bucket', () => {
    const rows = buildRequestVolumeRows([{ t: isoAtLocal(10, 30), requests: Number.NaN, sockets: Number.POSITIVE_INFINITY }]);
    expect(rows).toEqual([{ label: '10:30', requests: 0, sockets: 0 }]);
  });

  it('skips points whose timestamp cannot be parsed', () => {
    const rows = buildRequestVolumeRows([
      { t: 'not-a-date', requests: 1, sockets: 1 },
      { t: isoAtLocal(11, 15), requests: 1, sockets: 1 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('11:15');
  });

  it('returns [] for an empty series', () => {
    expect(buildRequestVolumeRows([])).toEqual([]);
  });

  it('returns [] when the series is null/undefined (metrics unavailable)', () => {
    expect(buildRequestVolumeRows(null)).toEqual([]);
    expect(buildRequestVolumeRows(undefined)).toEqual([]);
  });

  it('exposes the two chart series keyed to the row fields', () => {
    expect(REQUEST_VOLUME_SERIES.map((s) => s.key)).toEqual(['requests', 'sockets']);
    for (const s of REQUEST_VOLUME_SERIES) expect(s.label.length).toBeGreaterThan(0);
  });
});
