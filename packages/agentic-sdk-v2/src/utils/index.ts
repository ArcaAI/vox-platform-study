/**
 * @arcaai/vox - Utilities
 */

export { formatDate, formatDateTime, getToday, isSameDay, parseDate, formatRelativeTime } from './dateUtils';

export { isAgenticError, getErrorCode, getErrorMessage, wrapError, isNetworkError, isAuthError, isRetriableError, classifyHttpError, classifySmrError } from './errorUtils';

// Secure storage (SEC-02)
export { SecureStorage } from './secureStorage';

// Diff utilities (SDK-207 WS-4)
export { computeDiff, computePromptDiff, computeSummaryDiff, createUnifiedPatch } from './diffUtils';

// TASK-389 #15 (AG12/A5) — map backend PromptTestMetrics → display score map.
export { toPromptTestMetricScores } from './promptMetrics';

// Response utilities (TASK-215; cursor normalizer TASK-373 client follow-up)
export { extractArray, extractPaginated, extractCursorPaginated } from './responseUtils';
export type { CursorPageResult } from './responseUtils';

// URL utilities (TASK-039)
export { appendPagination, appendFilters } from './urlUtils';

// Prompt template utilities (Stories 117-118, Gap G3)
export { substitutePromptVariables, extractPromptVariables, validatePromptVariables } from './promptUtils';

// TASK-299 D-9 — Idempotency-Key utilities for side-effectful POSTs.
export { generateIdempotencyKey, withIdempotencyKey } from './idempotency';

// TASK-329 P4 — LOCAL voice-embedding math + provider selection.
export {
  DEFAULT_VOICE_MATCH_THRESHOLD,
  VOICE_ENROLLMENT_PROVIDERS,
  DEFAULT_VOICE_ENROLLMENT_PROVIDER,
  cosineSimilarity,
  l2Normalize,
  averageEmbeddings,
  bestMatch,
  isVoiceEnrollmentProvider,
  resolveVoiceEnrollmentProvider,
} from './voiceEmbedding';
export type { VoiceEnrollmentProvider, EnrolledEmbeddingRef, VoiceMatchResult } from './voiceEmbedding';

// TASK-330 Phase 1 (Lane J) — provenance/citations helpers for the review UI.
export {
  SOAP_SECTIONS,
  SOAP_SECTION_LABELS,
  isNeedsAttention,
  sortClaimsByAttention,
  selectClaimsNeedingAttention,
  groupClaimsBySection,
  buildTranscriptHighlights,
  confidencePercent,
} from './citations';
