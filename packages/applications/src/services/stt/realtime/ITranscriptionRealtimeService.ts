import { MessageEvent } from '@nestjs/common';
import type { ResolvedAsrSpec } from '@arcaai/types';
import { Observable } from 'rxjs';

/**
 * Interface for the Transcription Realtime Service.
 *
 * Orchestrates the full flow: job creation, Dramatiq dispatch,
 * Redis Pub/Sub subscription, and SSE stream assembly.
 */
export interface ITranscriptionRealtimeService {
  /**
   * Subscribe to an existing job's SSE stream (reconnection).
   * Checks current job status first — if already terminal,
   * emits the final status and completes immediately.
   */
  subscribeToJob(jobId: string): Observable<MessageEvent>;

  /**
   * Emit a completion event to the SSE stream for a given job.
   */
  emitCompleteEvent(jobId: string): Promise<void>;

  /**
   * Emit an error event to the SSE stream for a given job.
   */
  emitErrorEvent(jobId: string, message: string): Promise<void>;

  /**
   * Dispatch a Dramatiq message to the stt_batch queue for a given job.
   */
  dispatchDramatiqJob(params: {
    jobId: string;
    tenantId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    language?: string;
    userId?: string;
    audioBucketName?: string;
    /** The gateway-resolved ASR spec the worker assembles the engine chain from — the job's one selector. */
    resolvedSpec: ResolvedAsrSpec;
    /** TASK-1004 — the effective spoken-language mode and its tier, sent as named kwargs. */
    languageMode?: string;
    languageModeSource?: 'request' | 'consultation' | 'agent' | 'default';
  }): Promise<void>;

  /**
   * TASK-992 FU-1 — retry a failed batch job by RE-PUBLISHING its Dramatiq
   * message, not merely flipping the row back to `QUEUED`.
   *
   * Creator-scoped: an unknown id and a same-tenant peer's job both 404.
   * Refuses (409 `RETRY_ENVELOPE_MISSING`) for a row dispatched before the
   * envelope existed — those jobs cannot be made runnable, and answering 200
   * would recreate the defect this closes.
   */
  retryAndDispatch(jobId: string, options: { ownerId: string }): Promise<unknown>;
}

export const ITranscriptionRealtimeService = Symbol('ITranscriptionRealtimeService');
