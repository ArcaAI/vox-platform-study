/**
 * TASK-392 Phase 5 — shared field descriptors for the plan-matrix editor and
 * the per-tenant override dialog. Both edit the same numeric limits; keeping the
 * list here keeps the two dialogs in sync.
 */

export interface LimitField {
  key:
    | 'maxUsers'
    | 'maxDepartments'
    | 'maxPromptTemplates'
    | 'maxAsrPipelines'
    | 'maxApiKeys'
    | 'maxConcurrentSessions'
    | 'storageQuotaBytes'
    | 'monthlyConsultations'
    | 'monthlyTranscriptionMinutes'
    | 'monthlySummaries';
  label: string;
  /** Rendered/parsed as bytes (storage) rather than a plain count. */
  bytes?: boolean;
}

export const LIMIT_FIELDS: readonly LimitField[] = [
  { key: 'maxUsers', label: 'Max users / seats' },
  { key: 'maxDepartments', label: 'Max departments' },
  { key: 'maxPromptTemplates', label: 'Max prompt templates' },
  { key: 'maxAsrPipelines', label: 'Max ASR pipelines' },
  { key: 'maxApiKeys', label: 'Max API keys' },
  // TASK-392 — concurrency-based seat gating (live active STT sessions vs. cap).
  { key: 'maxConcurrentSessions', label: 'Max concurrent sessions' },
  { key: 'storageQuotaBytes', label: 'Storage quota (bytes)', bytes: true },
  { key: 'monthlyConsultations', label: 'Monthly consultations' },
  { key: 'monthlyTranscriptionMinutes', label: 'Monthly transcription minutes' },
  { key: 'monthlySummaries', label: 'Monthly summaries' },
] as const;

export interface FeatureField {
  key: 'featureDnaReports' | 'featureVoiceEnrollment' | 'featureMonitoringAccess';
  label: string;
}

export const FEATURE_FIELDS: readonly FeatureField[] = [
  { key: 'featureDnaReports', label: 'DNA reports' },
  { key: 'featureVoiceEnrollment', label: 'Voice enrollment' },
  { key: 'featureMonitoringAccess', label: 'Monitoring access' },
] as const;

export const MODEL_TIERS = ['base', 'full', 'full_custom'] as const;
export const RATE_LIMIT_TIERS = ['strict', 'default', 'heavy', 'relaxed'] as const;

/** Parse a text input into a limit value: blank = `null` (unlimited); else a non-negative int. */
export function parseLimitInput(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** Render a limit value for a text input: `null` → '' (unlimited placeholder). */
export function limitInputValue(value?: number | null): string {
  return value == null ? '' : String(value);
}
