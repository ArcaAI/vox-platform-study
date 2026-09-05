/**
 * Typed shape of `TenantFrontendConfig.configJson`.
 *
 * The frozen Prisma column is `Json?`, but per the slice's typing rule the
 * advanced-config section is a TYPED object (never `any`): these are the
 * per-tenant *advanced* CAPTURE knobs that complement the first-class capture
 * fields. All fields are optional so a partial advanced config round-trips
 * cleanly.
 *
 * TASK-883 dropped `noiseCancelLevel` / `vadThreshold` / `vadMinSilenceMs` /
 * `diarizationMaxSpeakers` along with the toggles they tuned — the browser runs
 * no model, so there is no stage left for them to parameterise. Nothing read
 * them (the SDK's `audio.vadThreshold` is an unrelated `ConfigSchema` field).
 */
export interface FrontendPipelineConfigJson {
  /** Capture sample rate (Hz) the client requests from the microphone. */
  sampleRate?: number;
  /** BCP-47 language hint forwarded to the server-side ASR; `null` = auto-detect. */
  language?: string | null;
}
