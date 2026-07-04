/**
 * Harness-progress helpers (TASK-345 — live harness activity feed).
 *
 * Pure transforms used by `useHarnessProgress` and the review panel:
 *   - `reduceHarnessProgressMessage` classifies a raw SSE `message` payload
 *     into a progress event, the terminal (closed) event, a heartbeat, or invalid.
 *   - `normalizeHarnessProgressEvent` coerces the payload defensively so the
 *     stage checklist can never render malformed entries.
 *
 * Each SSE message is FULL-STATE (the complete accumulated stage list), so the
 * client stays stateless: render the latest event, nothing to merge. Mirrors
 * `lib/live-summary.ts` (no `@arcaai/vox` runtime dependency).
 */

export type HarnessProgressStageStatus = 'completed' | 'active' | 'pending' | 'failed';

export interface HarnessProgressStage {
  stage: string;
  label: string;
  ordinal: number;
  status: HarnessProgressStageStatus;
  /** How many times the stage has been (re)entered — >1 communicates a regen pass. */
  attempt: number;
  /** ISO timestamp of the stage's last activation ('' when absent). */
  at: string;
}

export interface HarnessProgressEvent {
  consultationId: string;
  jobId?: string;
  /** Total number of stages in the run (when the harness reported it). */
  total?: number;
  stages: HarnessProgressStage[];
  updatedAt: string;
  closed: boolean;
}

/** Classification of a raw SSE `message` payload. */
export type HarnessProgressMessage =
  { kind: 'event'; event: HarnessProgressEvent } | { kind: 'closed'; event: HarnessProgressEvent } | { kind: 'heartbeat' } | { kind: 'invalid' };

// 'failed' arrives on the failure terminal event (TASK-348 / MAJ-1 contract:
// stage key "failed", closed:true). Unknown statuses still coerce to pending.
const STAGE_STATUSES: ReadonlySet<string> = new Set(['completed', 'active', 'pending', 'failed']);

function isHeartbeat(value: Record<string, unknown>): boolean {
  if (value.type === 'heartbeat' || value.heartbeat === true) return true;
  // A bare {} or a payload with no progress content is treated as a keep-alive.
  const hasContent = Array.isArray(value.stages) || typeof value.consultationId === 'string';
  return !hasContent && value.closed !== true;
}

/** Coerce a parsed payload into a well-formed `HarnessProgressEvent`. */
export function normalizeHarnessProgressEvent(raw: Record<string, unknown>): HarnessProgressEvent {
  // Dedupe-last keyed on `stage` (MIN-7): duplicate keys in a malformed payload
  // would otherwise become duplicate React keys in the checklist.
  const byStage = new Map<string, HarnessProgressStage>();
  if (Array.isArray(raw.stages)) {
    (raw.stages as unknown[]).forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) return;
      const s = entry as Record<string, unknown>;
      if (typeof s.stage !== 'string' || !s.stage) return;
      byStage.set(s.stage, {
        stage: s.stage,
        label: typeof s.label === 'string' && s.label ? s.label : s.stage,
        ordinal: typeof s.ordinal === 'number' && Number.isFinite(s.ordinal) ? s.ordinal : index + 1,
        status: typeof s.status === 'string' && STAGE_STATUSES.has(s.status) ? (s.status as HarnessProgressStageStatus) : 'pending',
        attempt: typeof s.attempt === 'number' && Number.isFinite(s.attempt) && s.attempt >= 1 ? s.attempt : 1,
        at: typeof s.at === 'string' ? s.at : '',
      });
    });
  }
  const stages: HarnessProgressStage[] = [...byStage.values()].sort((a, b) => a.ordinal - b.ordinal);

  return {
    consultationId: typeof raw.consultationId === 'string' ? raw.consultationId : '',
    jobId: typeof raw.jobId === 'string' ? raw.jobId : undefined,
    total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : undefined,
    stages,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    closed: raw.closed === true,
  };
}

/**
 * Classify a raw SSE data string. Heartbeats and parse failures never throw —
 * the stream hook simply ignores them.
 */
export function reduceHarnessProgressMessage(rawData: string): HarnessProgressMessage {
  const trimmed = rawData?.trim();
  if (!trimmed) return { kind: 'heartbeat' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid' };
  }

  const value = parsed as Record<string, unknown>;
  if (isHeartbeat(value)) return { kind: 'heartbeat' };

  const event = normalizeHarnessProgressEvent(value);
  return event.closed ? { kind: 'closed', event } : { kind: 'event', event };
}
