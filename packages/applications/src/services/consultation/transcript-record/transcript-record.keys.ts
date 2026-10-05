/**
 * Stable keys shared by the transcript record, the lifecycle stop flow and the run-record
 * reader. Each is derived, never stored elsewhere, so two writers always agree.
 */

/** Idempotency key of one final utterance (`ContextItem.segmentKey`). */
export function segmentKeyOf(sttSessionId: string, utteranceIndex: number): string {
  return `${sttSessionId}:${utteranceIndex}`;
}

/**
 * STT run keys are `stt:<sttSessionId>:<runId>:<seq>` — four colon parts, the last numeric. The
 * SAME string is the `AiActivityRun.runKey` and the items' `metaData.sttRunKey`; the run-record
 * reader matches it exactly.
 */

/** A streaming STT session (no run id): `stt:<sttSessionId>::0`. */
export function sttStreamRunKey(sttSessionId: string): string {
  return `stt:${sttSessionId}::0`;
}

/** A batch STT job (no session; the job is the run): `stt::<jobId>:0`. */
export function sttBatchRunKey(jobId: string): string {
  return `stt::${jobId}:0`;
}

/**
 * CLS key under which `CoreUnitOfWorkService.runInTransaction` exposes its transaction client.
 * Repositories cache their client at construction, so a caller already inside that transaction
 * must hand the client to each write explicitly.
 */
export const AMBIENT_TRANSACTION_CLS_KEY = 'coreTransactionClient';

/** Set once a session's final transcript has been folded into FULL_TRANSCRIPT (`awaitFinal` polls it). */
export function sttFinalRedisKey(consultationId: string, sttSessionId: string): string {
  return `consultation:stt-final:${consultationId}:${sttSessionId}`;
}

/**
 * Claimed (SET NX) by whichever writer emits `EncounterStopped` for an encounter first — the
 * lifecycle `stop()` or the session final that completes a pending stop — so it fires once.
 */
export function encounterStoppedRedisKey(consultationId: string, encounterSeq: number): string {
  return `consultation:encounter-stopped:${consultationId}:${encounterSeq}`;
}

/** TTL of both markers above: longer than any stop wait or outbox redrive window. */
export const TRANSCRIPT_RECORD_MARKER_TTL_SECONDS = 86_400;
