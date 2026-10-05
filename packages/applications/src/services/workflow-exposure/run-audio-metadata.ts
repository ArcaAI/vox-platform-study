import { RUN_STARTED_BY_KEY, readRunStartedBy, type RunPrincipal } from '../workflow-run/run-principal-access';

/**
 * TASK-1042 (C8) — the two `_metadata` keys a STREAMING `TranscriptionJob` row carries, and their
 * readers. A LEAF module (it imports only the OD-35 principal helper) so the STT job service can
 * stamp the owner without importing the run-audio binding service and the workflow plane behind it.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `_metadata` key a streaming job records its opener under (C8). */
export const STREAM_SESSION_OWNER_KEY = 'owner';
/** The `_metadata` key a streaming job records the standalone run it feeds under (C8). */
export const RUN_AUDIO_BOUND_RUN_KEY = 'boundRun';

export interface BoundRun {
  runId: string;
  workflowSlug: string | null;
  versionNumber: number | null;
  /** ISO-8601 instant the binding was written; the C5 `timeout` clock starts here. */
  boundAt: string | null;
}

/** The session's opener (C8), or `null` — none recorded (a session opened before C8), or malformed. */
export function readSessionOwner(metaData: unknown): RunPrincipal | null {
  if (!isPlainObject(metaData)) return null;
  return readRunStartedBy({ [RUN_STARTED_BY_KEY]: metaData[STREAM_SESSION_OWNER_KEY] });
}

/** The standalone run a streaming job is bound to, or `null`. */
export function readBoundRun(metaData: unknown): BoundRun | null {
  const value = isPlainObject(metaData) ? metaData[RUN_AUDIO_BOUND_RUN_KEY] : undefined;
  if (!isPlainObject(value) || typeof value.runId !== 'string' || value.runId.length === 0) return null;
  return {
    runId: value.runId,
    workflowSlug: typeof value.workflowSlug === 'string' ? value.workflowSlug : null,
    versionNumber: typeof value.versionNumber === 'number' ? value.versionNumber : null,
    boundAt: typeof value.boundAt === 'string' ? value.boundAt : null,
  };
}
