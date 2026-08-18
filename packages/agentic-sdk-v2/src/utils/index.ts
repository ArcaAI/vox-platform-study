/**
 * @arcaai/vox - Utilities
 */

export { formatDate, formatDateTime, getToday, isSameDay, parseDate, formatRelativeTime } from './dateUtils';

export {
  isAgenticError,
  getErrorCode,
  getErrorMessage,
  wrapError,
  isNetworkError,
  isAuthError,
  isRetriableError,
  classifyHttpError,
  classifyTextError,
} from './errorUtils';

// Secure storage (SEC-02)
export { SecureStorage } from './secureStorage';

// Diff utilities (SDK-207 WS-4)
export { computeDiff, computePromptDiff, computeSummaryDiff, createUnifiedPatch } from './diffUtils';

// Map backend PromptTestMetrics → display score map.
export { toPromptTestMetricScores } from './promptMetrics';

// Response utilities (incl. cursor normalizer)
export { extractArray, extractPaginated, extractCursorPaginated } from './responseUtils';
export type { CursorPageResult } from './responseUtils';

// URL utilities
export { appendPagination, appendFilters } from './urlUtils';

// Prompt template utilities (Stories 117-118, Gap G3)
export { substitutePromptVariables, extractPromptVariables, validatePromptVariables } from './promptUtils';

// Idempotency-Key utilities for side-effectful POSTs.
export { generateIdempotencyKey, withIdempotencyKey } from './idempotency';

// LOCAL voice-embedding math + provider selection.
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

// Provenance/citations helpers for the review UI.
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

// Optimistic-concurrency helpers for the note-content write routes (TASK-709).
export { ifMatchFor, requireExpectedVersion, findSummaryVersion, toOccError } from './occ';
