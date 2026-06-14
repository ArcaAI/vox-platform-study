/**
 * @arcaai/vox - Frontend pipeline config types (TASK-328 A6)
 *
 * Per-tenant FRONTEND audio-pipeline defaults applied to every user in the
 * tenant. Mirrors the backend `TenantFrontendConfigResponse` /
 * `UpsertTenantFrontendConfigRequest` DTOs and the typed `configJson` shape
 * (`FrontendPipelineConfigJson`).
 */

/**
 * Typed shape of `TenantFrontendConfig.configJson` (Q5 — typed JSON, not `any`).
 * Advanced, fine-grained capture tuning that complements the boolean feature
 * switches. All fields optional; absent fields fall back to client defaults.
 */
export interface FrontendPipelineConfigJson {
  /** Noise-cancellation aggressiveness when `noiseCancel` is on. */
  noiseCancelLevel?: 'low' | 'medium' | 'high';
  /** VAD speech-probability threshold (0–1) when `vad` is on. */
  vadThreshold?: number;
  /** Minimum trailing silence (ms) before VAD closes a segment. */
  vadMinSilenceMs?: number;
  /** Upper bound on speakers when `diarization` is on. */
  diarizationMaxSpeakers?: number;
  /** Capture sample rate in Hz (e.g. 16000). */
  sampleRate?: number;
  /** Forced ASR language (BCP-47), or null to auto-detect. */
  language?: string | null;
}

/**
 * TASK-356 Phase 4 — tenant default transcription mode (mirrors the server
 * `TranscriptionMode` enum). The EFFECTIVE per-doctor mode is resolved
 * server-side and surfaced on the UserPreferences response.
 */
export type TranscriptionMode = 'LOCAL' | 'BACKEND';

/**
 * TASK-356 Phase 4 — tenant audio capture mode (mirrors the server `CaptureMode`
 * enum). `null` (no tenant override) falls back to the legacy `captureRawAudio`.
 */
export type CaptureMode = 'RAW_AND_PROCESSED' | 'RAW_ONLY' | 'PROCESSED_ONLY' | 'NONE';

/** A tenant's stored frontend pipeline config (one row per tenant). */
export interface TenantFrontendConfig {
  id: string;
  tenantId: string;
  asrModel?: string | null;
  noiseCancel: boolean;
  vad: boolean;
  voiceEnrollment: boolean;
  diarization: boolean;
  /**
   * TASK-332 — tenant toggle for local raw-stream audio capture (persisted).
   * Only takes effect when `platformRawCaptureCapable` is also true.
   */
  captureRawAudio: boolean;
  /**
   * TASK-332 — server-computed platform capability for local raw capture
   * (the locked `enable-local-raw-capture` GlobalSetting). Read-only; the admin
   * UI disables the `captureRawAudio` toggle when this is false.
   */
  platformRawCaptureCapable: boolean;
  /** TASK-356 — tenant default transcription mode (LOCAL | BACKEND). */
  transcriptionMode: TranscriptionMode;
  /** TASK-356 — when true, doctors cannot override the transcription mode. */
  transcriptionModeLocked: boolean;
  /** TASK-356 — tenant audio capture mode (null = no override; legacy captureRawAudio applies). */
  captureMode?: CaptureMode | null;
  configJson?: FrontendPipelineConfigJson | null;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic-concurrency version (`_version`). Echo back as `If-Match`
   * (or `expectedVersion`) on the next save; the server fails the PUT with
   * `412` if the row drifted.
   */
  version: number;
}

/** Create-or-update payload for the tenant frontend pipeline config. */
export interface UpsertTenantFrontendConfigInput {
  asrModel?: string | null;
  noiseCancel?: boolean;
  vad?: boolean;
  voiceEnrollment?: boolean;
  diarization?: boolean;
  /** TASK-332 — tenant toggle for local raw-stream audio capture. */
  captureRawAudio?: boolean;
  /** TASK-356 — tenant default transcription mode (LOCAL | BACKEND). */
  transcriptionMode?: TranscriptionMode;
  /** TASK-356 — lock the transcription mode so doctors cannot override it. */
  transcriptionModeLocked?: boolean;
  /** TASK-356 — tenant audio capture mode; `null` clears the override. */
  captureMode?: CaptureMode | null;
  configJson?: FrontendPipelineConfigJson | null;
  /** Required to UPDATE an existing config; omit on first-time create. */
  expectedVersion?: number;
}
