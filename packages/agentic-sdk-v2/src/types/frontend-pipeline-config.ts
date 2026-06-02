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

/** A tenant's stored frontend pipeline config (one row per tenant). */
export interface TenantFrontendConfig {
  id: string;
  tenantId: string;
  asrModel?: string | null;
  noiseCancel: boolean;
  vad: boolean;
  voiceEnrollment: boolean;
  diarization: boolean;
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
  configJson?: FrontendPipelineConfigJson | null;
  /** Required to UPDATE an existing config; omit on first-time create. */
  expectedVersion?: number;
}
