/**
 * `hope.consultations.recording.*` — the capture lifecycle (TASK-933).
 *
 * Two routes, one state machine. The ORDER is the contract, and getting it
 * wrong is the most common way a realtime integration ends up with a silent
 * consultation:
 *
 * 1. `hope.stt.createStreamSession({ consultationId })` — the session exists
 *    BEFORE recording starts.
 * 2. `recording.start(consultationId, { sessionId })` — hands the live
 *    documentation layer the session to subscribe to.
 * 3. stream PCM16 over {@link RealtimeSttSocket}; read the live planes.
 * 4. `recording.stop(consultationId, …)` — tears the session down, signals the
 *    consultation loop, and lets the finalized note be generated.
 *
 * Start WITHOUT a `sessionId` still works — the service falls back to a
 * debounced re-read of accumulated transcript content — but it is slower and
 * coarser, and it is not what the console does.
 */

import type { Transport } from '../core/transport';
import { encodePathSegment } from '../core/url';
import type { RecordingStateResponse, StartRecordingRequest, StopRecordingRequest } from '../types/consultation-realtime';

/** Per-call options for the recording routes. */
export interface RecordingRequestOptions {
  signal?: AbortSignal;
}

export class ConsultationRecordingResource {
  constructor(private readonly transport: Transport) {}

  /**
   * `POST /api/v1/consultations/:id/recording/start` (HTTP 200, not 201).
   *
   * Gated by CONSENT — the route carries `@RequiresConsent(AI_DOCUMENTATION)`,
   * so a patient with no recorded consent for AI documentation is a refusal
   * here rather than a silently un-recorded visit.
   *
   * **Never retried** (no idempotency key on the route). A second start against
   * an already-recording consultation is answered by the state machine, not by
   * this SDK.
   */
  async start(consultationId: string, request: StartRecordingRequest = {}, options: RecordingRequestOptions = {}): Promise<RecordingStateResponse> {
    return this.transport.request<RecordingStateResponse>({
      method: 'POST',
      path: `consultations/${encodePathSegment(consultationId)}/recording/start`,
      body: request,
      signal: options.signal,
    });
  }

  /**
   * `POST /api/v1/consultations/:id/recording/stop` (HTTP 200).
   *
   * Does three things, and the second is easy to miss: it stops the live
   * session, it SIGNALS the consultation loop that the recording ended (which
   * is what makes the ending actions and the finalize run), and it reverts the
   * consultation status.
   *
   * `persistSnapshot: true` saves the last running-summary snapshot as a
   * `PRE_SUMMARY` context item before teardown — worth it when the finalize may
   * fail and you want the live text preserved.
   *
   * `acceptedProposals` carries the corrections the CLINICIAN accepted off the
   * `live-assist` feed, so the endpoint stage can promote them over the raw
   * transcript. Send them only when a human actually accepted them: they are
   * re-verified server-side, and a proposal still marked `PROPOSED` stays
   * advisory whatever this SDK sends.
   */
  async stop(consultationId: string, request: StopRecordingRequest = {}, options: RecordingRequestOptions = {}): Promise<RecordingStateResponse> {
    return this.transport.request<RecordingStateResponse>({
      method: 'POST',
      path: `consultations/${encodePathSegment(consultationId)}/recording/stop`,
      body: request,
      signal: options.signal,
    });
  }
}
