import type { QueueJobCounts, QueueStats } from '@arcaai/vox';

/**
 * TASK-403 — pure presentation logic for the Queues & Jobs surface (design
 * frame `15` v2): queue state derivation (dot+label, never color-only) and the
 * per-queue depth visualization split.
 */

export type QueueStateLabel = 'Running' | 'Backlogged' | 'Failing' | 'Paused';

export interface QueueState {
  label: QueueStateLabel;
  colorRole: 'success' | 'warning' | 'destructive' | 'neutral';
}

/** Waiting depth at which a running queue is presented as Backlogged (amber). */
export const QUEUE_BACKLOG_THRESHOLD = 50;

/**
 * Precedence: Paused (operator intent, overrides everything) → Failing
 * (failed>0, needs attention) → Backlogged (deep waiting) → Running.
 */
export function deriveQueueState(stats: QueueStats): QueueState {
  if (stats.isPaused) return { label: 'Paused', colorRole: 'neutral' };
  if (stats.counts.failed > 0) return { label: 'Failing', colorRole: 'destructive' };
  if (stats.counts.waiting >= QUEUE_BACKLOG_THRESHOLD) return { label: 'Backlogged', colorRole: 'warning' };
  return { label: 'Running', colorRole: 'success' };
}

export interface DepthSegments {
  waitingPct: number;
  activePct: number;
  failedPct: number;
  total: number;
}

/** Stacked-bar split (waiting/active/failed) for the depth visualization. */
export function depthSegments(counts: QueueJobCounts): DepthSegments {
  const total = counts.waiting + counts.active + counts.failed;
  if (total === 0) return { waitingPct: 0, activePct: 0, failedPct: 0, total: 0 };
  return {
    waitingPct: (counts.waiting / total) * 100,
    activePct: (counts.active / total) * 100,
    failedPct: (counts.failed / total) * 100,
    total,
  };
}

/** PING latency; `-1` is the service's unreachable sentinel. */
export function formatLatency(latencyMs: number): string {
  return latencyMs < 0 ? '—' : `${latencyMs} ms`;
}

/** Redis `uptime_in_seconds` → compact "6d 4h" / "1h 7m" / "59s". */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Throughput note under the depth bar: "N in flight" or "idle". */
export function formatBacklogged(counts: QueueJobCounts): string {
  const inFlight = counts.waiting + counts.active;
  return inFlight === 0 ? 'idle' : `${inFlight} in flight`;
}
