/**
 * Stable keys shared by the transcript record, the lifecycle stop flow and the run-record
 * reader. Each is derived, never stored elsewhere, so two writers always agree.
 */

/** Idempotency key of one final utterance (`ContextItem.segmentKey`). */
export function segmentKeyOf(sttSessionId: string, utteranceIndex: number): string {
  return `${sttSessionId}:${utteranceIndex}`;
}

/** `AiActivityRun.runKey` of a streaming STT session; stamped as `metaData.sttRunKey` on its items. */
export function sttStreamRunKey(sttSessionId: string): string {
  return `stt-stream:${sttSessionId}:${sttSessionId}:0`;
}

/** `AiActivityRun.runKey` of a batch STT job; stamped as `metaData.sttRunKey` on its transcript item. */
export function sttBatchRunKey(jobId: string): string {
  return `stt-batch:${jobId}:${jobId}:0`;
}

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
