/**
 * @arcaai/vox - Utilities
 */

export {
  formatDate,
  formatDateTime,
  getToday,
  isSameDay,
  parseDate,
  formatRelativeTime,
} from './dateUtils';

export {
  isAgenticError,
  getErrorCode,
  getErrorMessage,
  wrapError,
  isNetworkError,
  isAuthError,
  isRetriableError,
} from './errorUtils';

// Secure storage (SEC-02)
export { SecureStorage } from './secureStorage';

// Diff utilities (SDK-207 WS-4)
export {
  computeDiff,
  computePromptDiff,
  computeSummaryDiff,
  createUnifiedPatch,
} from './diffUtils';

// Response utilities (TASK-215)
export { extractArray, extractPaginated } from './responseUtils';

// URL utilities (TASK-039)
export { appendPagination, appendFilters } from './urlUtils';

// Prompt template utilities (Stories 117-118, Gap G3)
export {
  substitutePromptVariables,
  extractPromptVariables,
  validatePromptVariables,
} from './promptUtils';
