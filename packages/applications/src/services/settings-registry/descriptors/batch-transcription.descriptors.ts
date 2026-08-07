// Batch (pre-recorded file) transcription limit descriptors (TASK-604 lane A).
//
// WHAT THESE REPLACE. The batch upload route enforced exactly one bound — a
// hardcoded `MAX_FILE_SIZE = 100 MB` in `apps/api/.../dto/transcription-job.dto.ts`.
// Size is a PROXY for duration, and a bad one: a valid 60-minute 16 kHz mono WAV
// (~115 MB) was rejected while a 3-hour 64 kbps MP3 (~86 MB) sailed through. The
// product requirement is stated in RECORDINGS and MINUTES, so those are the
// units that get declared, resolved, and enforced.
//
// WHY `global-kv` + `globalOnly` + `maxScope: 'system'`. These bound the work a
// single caller can push onto the STT batch workers — platform capacity, not a
// per-tenant preference. A tenant that could raise its own ceiling would be
// setting the platform's queue depth, so the tenant lane is closed on READ too
// (`TenantSettingsService` skips it for a system-scoped key). A per-tenant
// override is a deliberate DEFERRAL, not an oversight: it needs its own config
// table + clamp direction, and neither exists today.
//
// WHY `open-to-default` everywhere. A missing `GlobalSetting` row must degrade
// to the code defaults below — the same numbers the SDK ships — never to a
// failed upload. Nothing here is a SELECTION (no provider, model, or pipeline is
// chosen), so the fail-closed rule that governs `stt.fallback.pipelineSlug` does
// not apply. Nothing here is a kill-switch either: these bound enforcement, they
// do not turn it on or off.

import { SettingDescriptor } from '../registry.types';

/**
 * The batch-limit knob keys (WITHOUT the `stt.batch.` prefix) mapped to their
 * code defaults — the single source of truth shared by the descriptors, the
 * gateway enforcement, and the limits read surface the SDK consumes.
 */
export const BATCH_TRANSCRIPTION_DEFAULTS = {
  /** Recordings a client may submit as one batch (TASK-604 requirement: 5). */
  maxFilesPerBatch: 5,
  /** Per-recording duration ceiling in minutes (TASK-604 requirement: 60). */
  maxDurationMinutes: 60,
  /**
   * Per-file size ceiling in MB. Raised from the hardcoded 100 MB so that the
   * DURATION ceiling is the binding constraint: 60 min × 16 kHz × 16-bit mono
   * PCM ≈ 115 MB, and a stereo/24-bit capture more. Uploads are still bounded —
   * this is a ceiling, not its removal.
   */
  maxFileSizeMb: 250,
  /**
   * In-flight (QUEUED/PROCESSING) jobs one caller may hold. The server-side
   * counterpart of `maxFilesPerBatch`: without it, "5 per batch" is trivially
   * bypassed by submitting five batches.
   */
  maxActiveJobsPerUser: 5,
} as const;

export type BatchTranscriptionKnobKey = keyof typeof BATCH_TRANSCRIPTION_DEFAULTS;

/** The canonical registry key for a knob. */
export function batchTranscriptionKey(knob: BatchTranscriptionKnobKey): string {
  return `stt.batch.${knob}`;
}

const META: Record<BatchTranscriptionKnobKey, { label: string; description: string }> = {
  maxFilesPerBatch: {
    label: 'Batch transcription — max recordings per batch',
    description: 'How many pre-recorded files a client may submit as a single batch.',
  },
  maxDurationMinutes: {
    label: 'Batch transcription — max recording length (minutes)',
    description: 'Duration ceiling for one uploaded recording. Enforced on the gateway from the file’s own metadata.',
  },
  maxFileSizeMb: {
    label: 'Batch transcription — max file size (MB)',
    description: 'Size ceiling for one uploaded recording. Sized so the duration ceiling is the binding constraint.',
  },
  maxActiveJobsPerUser: {
    label: 'Batch transcription — max in-flight jobs per user',
    description: 'Queued or processing batch jobs one caller may hold at once. Further uploads are rejected with 429 until one finishes.',
  },
};

export const BATCH_TRANSCRIPTION_SETTINGS: SettingDescriptor[] = (Object.keys(BATCH_TRANSCRIPTION_DEFAULTS) as BatchTranscriptionKnobKey[]).map(
  (knob) => ({
    key: batchTranscriptionKey(knob),
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Platform capacity — a tenant must not be able to raise its own ceiling.
    maxScope: 'system',
    globalOnly: true,
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    default: BATCH_TRANSCRIPTION_DEFAULTS[knob],
    category: 'Speech',
    label: META[knob].label,
    description: META[knob].description,
  }),
);
