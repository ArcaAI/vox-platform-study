/**
 * Clinical Workflow Demonstration Playground — constants (TASK-330 P3).
 *
 * Endpoint path builders are mirrored locally (not imported from the SDK) so
 * the feature stays self-contained and unit-testable without the `@arcaai/vox`
 * runtime (the ui-playground vitest config stubs that package).
 */

/** Demo identities seeded for the clinical-workflow walkthrough. */
export const DEMO = {
  tenantId: '50000000-0000-0000-0000-000000000000',
  doctorId: '70000000-0000-0000-0000-000000000010',
  patientId: 'PAT-20250101-001',
} as const;

/**
 * Opening a consultation with this metadata routes it through the
 * clinical-documentation harness (auto-draft + provenance on stop).
 */
export const HARNESS_PIPELINE_METADATA = {
  pipelineConfig: { harnessEnabled: true },
} as const;

/** Storage bucket used for raw/processed audio + lab attachments. */
export const STORAGE_BUCKET = 'attachments';

/** Lab / exam attachments are tagged with this subtype on the context item. */
export const LAB_RESULT_SUBTYPE = 'LAB_RESULT';

/** SSE scope for the live-summary stream ticket. */
export function liveSummaryScope(consultationId: string): string {
  return `consultation_live_summary:${consultationId}`;
}

/** API path builders (relative to the SDK apiClient base URL). */
export const WORKSPACE_ENDPOINTS = {
  startRecording: (id: string) => `/consultations/${encodeURIComponent(id)}/recording/start`,
  stopRecording: (id: string) => `/consultations/${encodeURIComponent(id)}/recording/stop`,
  liveSummaryStream: (id: string) => `/consultations/${encodeURIComponent(id)}/live-summary/stream`,
  streamSession: '/audio/transcription-jobs/stream/session',
  streamTicket: '/auth/stream-ticket',
  context: (id: string) => `/consultations/${encodeURIComponent(id)}/context`,
  contextItem: (id: string, contextId: string) =>
    `/consultations/${encodeURIComponent(id)}/context/${encodeURIComponent(contextId)}`,
  recordings: (id: string) => `/consultations/${encodeURIComponent(id)}/recordings`,
  summaryProvenance: (id: string, ctxId: string) => `/consultations/${encodeURIComponent(id)}/summary/${encodeURIComponent(ctxId)}/provenance`,
  summaryApprove: (id: string, ctxId: string) => `/consultations/${encodeURIComponent(id)}/summary/${encodeURIComponent(ctxId)}/approve`,
  summaryUpdate: (id: string, summaryId: string) => `/consultations/${encodeURIComponent(id)}/summary/${encodeURIComponent(summaryId)}`,
  // TASK-344 Workstream B — manual doctor highlights.
  highlights: (id: string) => `/consultations/${encodeURIComponent(id)}/highlights`,
  highlight: (id: string, highlightId: string) =>
    `/consultations/${encodeURIComponent(id)}/highlights/${encodeURIComponent(highlightId)}`,
} as const;

/** Context item types that represent a drafted/signed clinical note. */
export const NOTE_CONTEXT_TYPES = ['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'SIGNED_NOTE'] as const;
