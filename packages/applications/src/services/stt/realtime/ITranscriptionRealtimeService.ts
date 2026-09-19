import { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * Interface for the Transcription Realtime Service.
 *
 * Orchestrates the full flow: job creation, Dramatiq dispatch,
 * Redis Pub/Sub subscription, and SSE stream assembly.
 */
export interface ITranscriptionRealtimeService {
  /**
   * Create a transcription job and return an SSE Observable.
   *
   * Flow:
   * 1. Create TranscriptionJob in DB (status: QUEUED)
   * 2. Dispatch Dramatiq message to stt_batch queue via Redis HSET+RPUSH
   * 3. Subscribe to Redis channel stt:transcription:{jobId}
   * 4. Emit initial { type: "status", data: { status: "QUEUED" } }
   * 5. Forward all Redis messages as SSE MessageEvent objects
   * 6. Complete Observable when terminal status received (COMPLETED/FAILED/CANCELLED/DEAD)
   */
  createAndStream(params: {
    tenantId: string;
    pipelineId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    createdBy?: string;
    language?: string;
    codeSwitching?: boolean;
  }): Promise<{ jobId: string; events$: Observable<MessageEvent> }>;

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
    pipelineId: string;
    audioUri: string;
    consultationId?: string;
    mediaId?: string;
    language?: string;
    userId?: string;
    audioBucketName?: string;
    /** Tenant fallback pipeline the worker re-runs on if the primary ASR fails. */
    fallbackPipelineId?: string;
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
