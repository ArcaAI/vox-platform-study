'use client';

/**
 * Real per-session generation metrics for the scribe footer (TASK-543).
 *
 * Folds the AD-1 generation stats that ride the live-summary SSE
 * (`LiveSummaryEventDto.metadata.stats`, one sample per flush) into the two
 * footer stats the design shows: note-generation throughput (latest
 * `tokens_per_second`) and a per-session latency p95 (nearest-rank percentile
 * over the accumulated `total_ms` samples). Values are REAL or absent —
 * a flush without stats (legacy idempotency-cache hit) contributes nothing,
 * mirroring the DTO's "never fabricated" contract. Fleet-wide Prometheus p95
 * exists on the platform dashboard; this is deliberately per-session.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import type { LiveSummarySnapshot } from '../api/types';

export interface UseLiveMetricsResult {
  /** Latest engine-reported decode throughput (tok/s); null until a flush carries one. */
  tokensPerSecond: number | null;
  /** Nearest-rank p95 of this session's per-flush `total_ms` samples; null with no samples. */
  latencyP95Ms: number | null;
  /** Number of latency samples accumulated this session. */
  sampleCount: number;
  /** Fold one live-summary snapshot (deduped per flush via `updatedAt`). */
  ingest: (snapshot: LiveSummarySnapshot) => void;
  /** Clear the session accumulation (new recording session). */
  reset: () => void;
}

/** Nearest-rank percentile (sorted ascending copy; rank = ceil(p × n)). */
function nearestRank(samples: readonly number[], percentile: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1]!;
}

export function useLiveMetrics(): UseLiveMetricsResult {
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);
  const [latencySamples, setLatencySamples] = useState<number[]>([]);
  const lastFlushRef = useRef<string | null>(null);

  const ingest = useCallback((snapshot: LiveSummarySnapshot) => {
    const stats = snapshot.metadata?.stats;
    if (!stats) return;
    // One sample per flush: the SSE republishes full-state snapshots, so key
    // dedup on the flush timestamp rather than object identity.
    if (lastFlushRef.current === snapshot.updatedAt) return;
    lastFlushRef.current = snapshot.updatedAt;

    if (typeof stats.tokens_per_second === 'number' && Number.isFinite(stats.tokens_per_second)) {
      setTokensPerSecond(stats.tokens_per_second);
    }
    if (typeof stats.total_ms === 'number' && Number.isFinite(stats.total_ms)) {
      const sample = stats.total_ms;
      setLatencySamples((previous) => [...previous, sample]);
    }
  }, []);

  const reset = useCallback(() => {
    lastFlushRef.current = null;
    setTokensPerSecond(null);
    setLatencySamples([]);
  }, []);

  return useMemo(
    () => ({
      tokensPerSecond,
      latencyP95Ms: latencySamples.length > 0 ? nearestRank(latencySamples, 0.95) : null,
      sampleCount: latencySamples.length,
      ingest,
      reset,
    }),
    [tokensPerSecond, latencySamples, ingest, reset],
  );
}
