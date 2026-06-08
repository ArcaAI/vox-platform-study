/**
 * Draft-ready polling decision logic (TASK-339 FU2).
 *
 * After `POST /consultations/:id/recording/stop` the documentation harness
 * drafts the SOAP note asynchronously (status → PENDING_REVIEW, a RAW_SUMMARY
 * context item appears). Rather than relying on a manual refresh, the review
 * surface polls until the draft is found. These pure helpers centralise the two
 * decisions so they can be unit-tested in isolation:
 *
 *   - `nextDraftPollInterval` → the TanStack Query `refetchInterval` (ms to wait,
 *     or `false` to STOP polling). It stops on draft-ready, when not waiting, and
 *     after a hard timeout, and gently backs off the longer it waits.
 *   - `draftWaitStatus` → the coarse status the UI renders
 *     (`idle` | `generating` | `ready` | `timed-out`).
 */

export type DraftWaitStatus = 'idle' | 'generating' | 'ready' | 'timed-out';

export interface DraftPollConfig {
  /** Base poll interval right after stopping. */
  intervalMs: number;
  /** Upper bound the backoff ramps toward. */
  maxIntervalMs: number;
  /** Give up (stop polling) once this much time has elapsed without a draft. */
  timeoutMs: number;
}

export const DEFAULT_DRAFT_POLL_CONFIG: DraftPollConfig = {
  intervalMs: 3500,
  maxIntervalMs: 8000,
  timeoutMs: 150_000, // 2.5 minutes — generous for harness + SMR latency
};

export interface DraftPollInput {
  /** True while we expect a draft but none has arrived (recording stopped, none yet). */
  waiting: boolean;
  /** True once the harness draft (RAW_SUMMARY) has been found. */
  draftReady: boolean;
  /** Epoch ms when polling began (null before it starts). */
  startedAt: number | null;
  /** Current epoch ms. */
  now: number;
  config?: Partial<DraftPollConfig>;
}

function resolveConfig(config?: Partial<DraftPollConfig>): DraftPollConfig {
  return { ...DEFAULT_DRAFT_POLL_CONFIG, ...config };
}

function elapsedMs({ startedAt, now }: Pick<DraftPollInput, 'startedAt' | 'now'>): number {
  if (startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}

/**
 * Next poll interval in ms, or `false` to stop polling. Stops on draft-ready,
 * when not waiting, and once the timeout elapses; otherwise backs off linearly
 * from `intervalMs` toward `maxIntervalMs`.
 */
export function nextDraftPollInterval(input: DraftPollInput): number | false {
  if (input.draftReady || !input.waiting) return false;

  const config = resolveConfig(input.config);
  const elapsed = elapsedMs(input);
  if (elapsed >= config.timeoutMs) return false;

  // Slow down by one step (1.5s) every 30s of waiting, capped at maxIntervalMs.
  const step = Math.floor(elapsed / 30_000);
  return Math.min(config.maxIntervalMs, config.intervalMs + step * 1_500);
}

/** Coarse status for the review surface to render. */
export function draftWaitStatus(input: DraftPollInput): DraftWaitStatus {
  if (input.draftReady) return 'ready';
  if (!input.waiting) return 'idle';

  const config = resolveConfig(input.config);
  return elapsedMs(input) >= config.timeoutMs ? 'timed-out' : 'generating';
}
