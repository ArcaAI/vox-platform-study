/**
 * Latency and timing metrics for real-time transcription.
 *
 * Computes Final Transcript Latency (P50/P95/P99), First Partial Latency, and RTF.
 * All require wall-clock timestamps captured at WS frame receipt.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimestampedFinal {
  text: string;
  startTime: number;   // audio-seconds
  endTime: number;      // audio-seconds
  receivedAt: number;   // wall-clock ms (Date.now())
}

export interface TimestampedPartial {
  text: string;
  receivedAt: number;   // wall-clock ms (Date.now())
}

export interface PercentileSet {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  count: number;
  values: number[];
}

export interface FinalLatencyResult {
  /** Latency in ms for each final, computed as receivedAt - (streamStartedAt + endTime * 1000) */
  latencies: PercentileSet;
}

export interface FirstPartialResult {
  /** Time in ms from stream start to first partial transcript, or null if no partials received */
  latencyMs: number | null;
}

export interface RtfResult {
  /** Real-Time Factor: total processing wall-clock time / audio duration */
  rtf: number;
  /** Wall-clock span from stream start to last final received (ms) */
  wallClockMs: number;
  /** Audio duration in seconds */
  audioDurationSec: number;
}

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function computePercentiles(values: number[]): PercentileSet {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, count: 0, values: [] };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    count: sorted.length,
    values: sorted,
  };
}

// ---------------------------------------------------------------------------
// Final Transcript Latency
// ---------------------------------------------------------------------------

/**
 * Compute per-final latency: how long after the audio segment ended did we receive the final.
 *
 * latency_i = receivedAt_i - (streamStartedAt + endTime_i * 1000)
 *
 * @param finals - Timestamped final transcripts with receivedAt wall-clock.
 * @param streamStartedAt - Wall-clock ms when streaming started (audio T0).
 */
export function computeFinalTranscriptLatency(
  finals: TimestampedFinal[],
  streamStartedAt: number,
): FinalLatencyResult {
  const latencies = finals.map((f) => {
    const expectedDoneAt = streamStartedAt + f.endTime * 1000;
    return Math.max(0, f.receivedAt - expectedDoneAt);
  });

  return { latencies: computePercentiles(latencies) };
}

// ---------------------------------------------------------------------------
// First Partial Latency
// ---------------------------------------------------------------------------

/**
 * Compute time from stream start to first partial transcript received.
 */
export function computeFirstPartialLatency(
  partials: TimestampedPartial[],
  streamStartedAt: number,
): FirstPartialResult {
  if (partials.length === 0) {
    return { latencyMs: null };
  }

  const firstReceivedAt = Math.min(...partials.map((p) => p.receivedAt));
  return { latencyMs: firstReceivedAt - streamStartedAt };
}

// ---------------------------------------------------------------------------
// Real-Time Factor (RTF)
// ---------------------------------------------------------------------------

/**
 * Compute Real-Time Factor: wall-clock processing time / audio duration.
 *
 * RTF < 1.0 means faster-than-realtime processing.
 * RTF = 1.0 means exactly realtime.
 * RTF > 1.0 means slower than realtime.
 */
export function computeRtf(
  finals: TimestampedFinal[],
  audioDurationSec: number,
  streamStartedAt: number,
): RtfResult {
  if (finals.length === 0 || audioDurationSec <= 0) {
    return { rtf: 0, wallClockMs: 0, audioDurationSec };
  }

  const lastReceivedAt = Math.max(...finals.map((f) => f.receivedAt));
  const wallClockMs = lastReceivedAt - streamStartedAt;
  const rtf = wallClockMs / 1000 / audioDurationSec;

  return { rtf, wallClockMs, audioDurationSec };
}
