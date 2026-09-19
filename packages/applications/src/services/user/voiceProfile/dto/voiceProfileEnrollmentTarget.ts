/**
 * TASK-887 — where an enrollment will land: the embedding model the resolved ASR agent
 * declares, and whether that agent actually diarizes with it.
 *
 * The console reads this to tell a user whose existing profiles were embedded by a DIFFERENT
 * model that they must re-enrol: a profile is only ever matched by an agent bound to the same
 * model, so a stale profile is invisible rather than wrong.
 */
export interface VoiceProfileEnrollmentTarget {
  /**
   * The lineage slug of the agent this enrollment will actually land in.
   *
   * The assigned agent when the caller named none — or, since TASK-991 (OD-1), the first
   * published speech-to-text agent of the tenant that HAS diarization enabled when the assigned
   * one does not. It is therefore not always the agent a session will run, which is why the
   * console shows it: the profile is keyed by `modelId`, and a user needs to know which agent's
   * space they enrolled into. A caller who named an agent explicitly always gets that one back.
   */
  agentSlug: string;
  /** `AiModel.slug` of the agent's speaker-embedding model. */
  modelId: string;
  /** The model's loader id (`sourceUri`) — informational; the gateway is what pushes it. */
  modelSourceUri: string;
  /**
   * Whether the agent has diarization switched on. Always `true` on a resolved target since
   * TASK-977: an agent with it off refuses the target with 409 `ASR_AGENT_DIARIZATION_DISABLED`.
   * Kept on the wire so existing clients keep parsing the same shape.
   */
  diarizationEnabled: boolean;
  /**
   * The agent's `audioFrontEnd.diarization.matchThreshold`, or `null` when it declared none.
   * Doubles as the enrollment consistency floor — the same confidence the agent will demand
   * before it attaches this profile's label to speech.
   */
  matchThreshold: number | null;
}
