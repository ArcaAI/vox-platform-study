/**
 * @arcaai/vox - Frontend capture-policy config types
 *
 * Per-tenant FRONTEND capture defaults applied to every user in the tenant.
 * Mirrors the backend `TenantFrontendConfigResponse` /
 * `UpsertTenantFrontendConfigRequest` DTOs and the typed `configJson` shape
 * (`FrontendPipelineConfigJson`).
 *
 * TASK-883 retired the client-AI switches (`asrModel` / `noiseCancel` / `vad` /
 * `voiceEnrollment` / `diarization`) and the four `configJson` knobs that tuned
 * them. Owner directive 2026-09-04: the browser never runs a model — VAD,
 * denoise, diarization and ASR selection are decisions the tenant's published
 * Agents make server-side. This is orthogonal to the SDK's hard-off gate
 * (`DEFAULT_AUDIO_CONFIG` + `audio.clientInference`), which is untouched: that
 * gate refuses to RUN a local stage, this removes the tenant-level switch that
 * could ask for one.
 */

/**
 * Typed shape of `TenantFrontendConfig.configJson` (Q5 — typed JSON, not `any`).
 * Advanced, fine-grained CAPTURE tuning. All fields optional; absent fields
 * fall back to client defaults.
 */
export interface FrontendPipelineConfigJson {
  /** Capture sample rate in Hz (e.g. 16000). */
  sampleRate?: number;
  /** Language hint (BCP-47) forwarded to the server-side ASR, or null to auto-detect. */
  language?: string | null;
}

/**
 * Tenant default transcription mode (mirrors the server
 * `TranscriptionMode` enum). The EFFECTIVE per-doctor mode is resolved
 * server-side and surfaced on the UserPreferences response.
 */
export type TranscriptionMode = 'LOCAL' | 'BACKEND';

/**
 * Tenant audio capture mode (mirrors the server `CaptureMode`
 * enum). `null` (no tenant override) falls back to the legacy `captureRawAudio`.
 */
export type CaptureMode = 'RAW_AND_PROCESSED' | 'RAW_ONLY' | 'PROCESSED_ONLY' | 'NONE';

/** A tenant's stored frontend capture policy (one row per tenant). */
export interface TenantFrontendConfig {
  id: string;
  tenantId: string;
  /**
   * Tenant toggle for local raw-stream audio capture (persisted).
   * Only takes effect when `platformRawCaptureCapable` is also true.
   */
  captureRawAudio: boolean;
  /**
   * Server-computed platform capability for local raw capture
   * (the locked `enable-local-raw-capture` GlobalSetting). Read-only; the admin
   * UI disables the `captureRawAudio` toggle when this is false.
   */
  platformRawCaptureCapable: boolean;
  /** Tenant default transcription mode (LOCAL | BACKEND). */
  transcriptionMode: TranscriptionMode;
  /** When true, doctors cannot override the transcription mode. */
  transcriptionModeLocked: boolean;
  /** Tenant audio capture mode (null = no override; legacy captureRawAudio applies). */
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

/** Create-or-update payload for the tenant frontend capture policy. */
export interface UpsertTenantFrontendConfigInput {
  /** Tenant toggle for local raw-stream audio capture. */
  captureRawAudio?: boolean;
  /** Tenant default transcription mode (LOCAL | BACKEND). */
  transcriptionMode?: TranscriptionMode;
  /** Lock the transcription mode so doctors cannot override it. */
  transcriptionModeLocked?: boolean;
  /** Tenant audio capture mode; `null` clears the override. */
  captureMode?: CaptureMode | null;
  configJson?: FrontendPipelineConfigJson | null;
  /** Required to UPDATE an existing config; omit on first-time create. */
  expectedVersion?: number;
}
