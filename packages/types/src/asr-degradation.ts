/**
 * TASK-1048 — speech-to-text optional stages DEGRADE, they never refuse the session.
 *
 * Owner rule (2026-10-06): the CORE path (audio in → ASR → transcript out) must always run. An
 * optional stage whose prerequisite is missing — diarization with no speaker-embedding model, VAD
 * with no VAD model, a fallback that cannot resolve, zero enrolled voices — is switched OFF for
 * that session and REPORTED, never turned into a 409. This file is the shared vocabulary for the
 * three places that report it:
 *
 * 1. The gateway, at session/job creation — {@link AsrSessionWarning} on the stream-session and
 *    batch-job responses (`warnings`), produced while `buildResolvedAsrSpec` resolves the agent.
 * 2. `apps/stt`, mid-session — a `status` frame `{ status: 'degraded', reason }` where `reason` is
 *    one of {@link ASR_RUNTIME_DEGRADED_REASONS} (no protocol change: the bridge already relays it).
 * 3. Agent validate/publish — WARNING findings (`ASR_*` codes in `agent-findings.ts`), so the
 *    admin sees the gap when configuring, not when a clinician records.
 *
 * Carries NO PHI: codes, agent identity and a fixed human sentence only.
 */

/** Gateway-side degradations — what `buildResolvedAsrSpec` switched off instead of refusing. */
export const ASR_DEGRADATION_CODES = [
  // diarization enabled, but neither the agent nor the platform default names a usable
  // SPEAKER_EMBEDDING model visible to the tenant → diarization off for this session.
  'DIARIZATION_MODEL_MISSING',
  // diarization enabled with a stored backend this platform cannot run (retired `sortformer`) →
  // diarization off for this session.
  'DIARIZATION_BACKEND_UNSUPPORTED',
  // VAD enabled, but no VAD model resolves → the runtime segments on energy.
  'VAD_MODEL_MISSING',
  // a configured fallback (agent or model) cannot be built → that fallback is skipped.
  'FALLBACK_UNRUNNABLE',
] as const;
export type AsrDegradationCode = (typeof ASR_DEGRADATION_CODES)[number];

/** The optional stage a degradation switched off. */
export type AsrDegradedStage = 'diarization' | 'vad' | 'fallback';

/** One non-fatal warning on a stream-session or batch-job creation response. */
export interface AsrSessionWarning {
  readonly code: AsrDegradationCode;
  readonly stage: AsrDegradedStage;
  /** Always `'WARNING'` — a refusal is an HTTP error, never an entry here. */
  readonly severity: 'WARNING';
  /** Fixed, PHI-free sentence a UI may show verbatim ("Speaker diarization is off for this session: …"). */
  readonly message: string;
  /** The agent whose configuration caused it (the primary, or the fallback that was skipped). */
  readonly agentSlug: string;
  readonly agentVersionNumber?: number;
}

/**
 * `apps/stt` runtime degradations — the `reason` of a `status: 'degraded'` frame.
 *
 * `script_mismatch` predates TASK-1048 (TASK-946). `denoise_degraded` is NOT here: it keeps its own
 * `status` value (TASK-1030) and a client should treat both as "a stage is off".
 */
export const ASR_RUNTIME_DEGRADED_REASONS = [
  'script_mismatch',
  // the speaker-embedding model failed to load / raised → no diarization, no speaker matching
  'diarization_unavailable',
  // enrolled voice profiles could not be seeded → diarization runs with anonymous labels
  'voice_profiles_unavailable',
  // the VAD model failed to load → energy-based segmentation
  'vad_unavailable',
  // segmentation refinement failed to load → unrefined turns
  'segmentation_unavailable',
  // hotword/lexicon correction raised → raw ASR text is emitted
  'lexicon_unavailable',
  // English gloss pipeline failed to load → no gloss
  'gloss_unavailable',
] as const;
export type AsrRuntimeDegradedReason = (typeof ASR_RUNTIME_DEGRADED_REASONS)[number];

/**
 * OD-2 — the platform default speaker-embedding model (tenant → SYSTEM `GlobalSetting`, widened on
 * ABSENCE only). Consulted ONLY when an agent enables diarization and names no
 * `audioFrontEnd.diarization.embeddingModelSlug`. Absent/unusable → `DIARIZATION_MODEL_MISSING`.
 * There is no code default: the SYSTEM row is seeded.
 */
export const STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY = 'stt.diarization.defaultEmbeddingModelSlug' as const;
