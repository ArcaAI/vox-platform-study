/**
 * Wire types mirroring the own-account voice-profiles plane
 * (VoiceProfileController + VoiceProfileResponse — the console cannot import
 * the gateway packages, so the shapes are declared here once). Rows are
 * strictly user-owned (`user-profile-own`, userId = ${user.id}); there is
 * deliberately NO admin surface over other users' voice biometrics.
 */

/** VoiceProfileResponse — GET /voice-profiles rows, enroll/delete payloads. */
export interface VoiceProfile {
  id: string;
  userId: string;
  /** Active profiles auto-attach to live-transcription sessions (voiceProfileSeeded). */
  isActive: boolean;
  label: string | null;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /voice-profiles/enroll multipart input (field `files`, optional `label`). */
export interface EnrollVoiceProfileInput {
  /** 1..3 audio samples (`audio/*`, ≤10 MB each — gateway-validated). */
  files: File[];
  /** Optional human label, ≤100 chars (EnrollBodyDto). */
  label?: string;
  /**
   * TASK-887 — the SPEECH_TO_TEXT agent to enroll FOR. Omitted here on purpose: a clinician
   * enrols for the agent their sessions actually run, which is the tenant's assigned one, and
   * the gateway resolves that same cascade. The field exists for a caller that has a reason
   * to name a different agent.
   */
  agentSlug?: string;
}

/**
 * GET /voice-profiles/enrollment-target — the speaker-embedding model a new enrollment would
 * land in (TASK-887).
 *
 * Diarization is a declared ASR-agent option: the agent names the model, and a profile is only
 * ever matched by an agent bound to the SAME model. A profile whose `modelId` differs is
 * therefore invisible to that agent, not merely less accurate — which is why the screen can
 * tell "not enrolled" from "enrolled for a model this agent no longer uses".
 */
export interface VoiceProfileEnrollmentTarget {
  agentSlug: string;
  modelId: string;
  diarizationEnabled: boolean;
}

/** PATCH :id/activate | :id/deactivate acknowledgement. */
export interface VoiceProfileToggleResponse {
  success: boolean;
}
