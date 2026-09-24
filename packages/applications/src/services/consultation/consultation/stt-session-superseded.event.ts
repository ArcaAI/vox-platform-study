/**
 * A consultation's recording was re-bound to a DIFFERENT STT streaming session while the previous
 * one was still bound. Exactly one live STT session belongs to a consultation (last writer wins),
 * so the previous one is superseded: the listener finalizes it through the normal teardown path
 * (flush, then upload), so its audio and transcript are stored like any other session's. It is
 * never cancelled or discarded.
 *
 * Emitted once per actual supersede, never for a re-sent session id.
 */
export const STT_SESSION_SUPERSEDED_EVENT = 'stt.session.superseded' as const;

export interface SttSessionSupersededEvent {
  tenantId: string;
  consultationId: string;
  /** The session that is no longer the consultation's recording. */
  supersededSessionId: string;
  /** The session the recording is now bound to. */
  supersedingSessionId: string;
}
