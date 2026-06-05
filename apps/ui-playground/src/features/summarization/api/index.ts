export { SmrApiError, smrClient } from './smr-client';
// TASK-331 doc-09 — clinician-facing (end-user) prompt-template list. Use this
// instead of the admin `usePromptTemplates` for Pre-Summary / Summary selectors.
export { usePromptTemplatesAvailable, availablePromptKeys } from './prompts';
export type { PromptTemplate, PromptTemplateCategory } from './prompts';
export {
  summarizationKeys,
  useCancelTask,
  useGenerateAsync,
  useGeneratePreSummary,
  useGenerateSummary,
  useGenerateSummaryAssembled,
  useGenerateSync,
  useSmrHealth,
  useSmrProviders,
  useSmrTaskStatus,
} from './summarization';
export type {
  AssembledGenerateRequest,
  DnaStyleInfo,
  PreSummaryFormData,
  SmrGenerateRequest,
  SmrGenerateResponse,
  SmrHealthResponse,
  SmrProvider,
  SmrStreamingResponse,
  SmrTaskResponse,
  SummarizationTab,
  SummaryFormData,
  SummaryHistoryEntry,
  TokenUsage,
} from './types';
