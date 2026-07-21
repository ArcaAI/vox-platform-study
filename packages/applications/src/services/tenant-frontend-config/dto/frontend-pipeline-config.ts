/**
 * Typed shape of `TenantFrontendConfig.configJson`.
 *
 * The frozen Prisma column is `Json?`, but per the slice's typing rule the
 * advanced-config section is a TYPED object (never `any`): these are the
 * per-tenant *advanced* knobs that complement the first-class boolean
 * feature switches (`noiseCancel` / `vad` / `voiceEnrollment` / `diarization`).
 * All fields are optional so a partial advanced config round-trips cleanly.
 */
export interface FrontendPipelineConfigJson {
  /** Noise-cancellation aggressiveness applied when `noiseCancel` is on. */
  noiseCancelLevel?: 'low' | 'medium' | 'high';
  /** VAD speech-probability threshold (0..1) applied when `vad` is on. */
  vadThreshold?: number;
  /** Minimum trailing silence (ms) before VAD closes a speech segment. */
  vadMinSilenceMs?: number;
  /** Upper bound on speakers the diarizer separates when `diarization` is on. */
  diarizationMaxSpeakers?: number;
  /** Capture sample rate (Hz) the client requests from the microphone. */
  sampleRate?: number;
  /** BCP-47 language hint for the ASR model; `null` = auto-detect. */
  language?: string | null;
}
