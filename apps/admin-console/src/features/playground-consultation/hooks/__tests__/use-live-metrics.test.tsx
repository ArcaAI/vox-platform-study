/**
 * real per-session generation metrics folded from the
 * live-summary SSE stats (`metadata.stats`). Contract: latest tok/s wins,
 * latency p95 is computed over the session's accumulated `total_ms` samples,
 * absent stats contribute nothing (never fabricated), and reset() clears the
 * session accumulation.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LiveSummarySnapshot, LiveSummaryStats } from '../../api/types';
import { useLiveMetrics } from '../use-live-metrics';

function snapshot(stats: LiveSummaryStats | undefined, updatedAt = '2026-07-22T00:00:00Z'): LiveSummarySnapshot {
  return {
    consultationId: 'c-1',
    runningSummary: '',
    sections: [],
    entities: [],
    metadata: stats ? { stats } : undefined,
    updatedAt,
  };
}

describe('useLiveMetrics', () => {
  it('starts empty (no fabricated values)', () => {
    const { result } = renderHook(() => useLiveMetrics());
    expect(result.current.tokensPerSecond).toBeNull();
    expect(result.current.latencyP95Ms).toBeNull();
    expect(result.current.sampleCount).toBe(0);
  });

  it('surfaces the latest tokens_per_second and accumulates latency samples', () => {
    const { result } = renderHook(() => useLiveMetrics());

    act(() => result.current.ingest(snapshot({ tokens_per_second: 120.4, total_ms: 900 }, '2026-07-22T00:00:01Z')));
    act(() => result.current.ingest(snapshot({ tokens_per_second: 142.2, total_ms: 1100 }, '2026-07-22T00:00:02Z')));

    expect(result.current.tokensPerSecond).toBeCloseTo(142.2);
    expect(result.current.sampleCount).toBe(2);
    // p95 of [900, 1100] → 1100 (nearest-rank)
    expect(result.current.latencyP95Ms).toBe(1100);
  });

  it('ignores snapshots without stats and null stat fields', () => {
    const { result } = renderHook(() => useLiveMetrics());

    act(() => result.current.ingest(snapshot(undefined)));
    act(() => result.current.ingest(snapshot({ tokens_per_second: null, total_ms: null })));

    expect(result.current.tokensPerSecond).toBeNull();
    expect(result.current.latencyP95Ms).toBeNull();
    expect(result.current.sampleCount).toBe(0);
  });

  it('does not re-ingest the same flush twice (keyed by updatedAt)', () => {
    const { result } = renderHook(() => useLiveMetrics());
    const flush = snapshot({ tokens_per_second: 100, total_ms: 800 }, '2026-07-22T00:00:03Z');

    act(() => result.current.ingest(flush));
    act(() => result.current.ingest(flush));

    expect(result.current.sampleCount).toBe(1);
  });

  it('computes nearest-rank p95 over many samples', () => {
    const { result } = renderHook(() => useLiveMetrics());

    act(() => {
      for (let index = 1; index <= 20; index += 1) {
        result.current.ingest(snapshot({ total_ms: index * 100 }, `2026-07-22T00:01:${String(index).padStart(2, '0')}Z`));
      }
    });

    expect(result.current.sampleCount).toBe(20);
    // nearest-rank p95 of 100..2000 (step 100) → ceil(0.95*20)=19th → 1900
    expect(result.current.latencyP95Ms).toBe(1900);
  });

  it('keeps the last tok/s when a later flush omits it but counts its latency', () => {
    const { result } = renderHook(() => useLiveMetrics());

    act(() => result.current.ingest(snapshot({ tokens_per_second: 90, total_ms: 700 }, '2026-07-22T00:02:01Z')));
    act(() => result.current.ingest(snapshot({ total_ms: 1300 }, '2026-07-22T00:02:02Z')));

    expect(result.current.tokensPerSecond).toBe(90);
    expect(result.current.sampleCount).toBe(2);
  });

  it('reset() clears the session accumulation', () => {
    const { result } = renderHook(() => useLiveMetrics());

    act(() => result.current.ingest(snapshot({ tokens_per_second: 100, total_ms: 800 }, '2026-07-22T00:03:01Z')));
    act(() => result.current.reset());

    expect(result.current.tokensPerSecond).toBeNull();
    expect(result.current.latencyP95Ms).toBeNull();
    expect(result.current.sampleCount).toBe(0);
  });
});
