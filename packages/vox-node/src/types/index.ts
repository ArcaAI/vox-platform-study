/**
 * Barrel for `@arcaai/vox-node` request/response types — the day-1
 * summarization surface (stateless v1-compat + v2 native consultation-bound).
 */

export type {
  ConversationSegment,
  TestResult,
  PreviousVisitRecord,
  SessionData,
  PreSummaryRequest,
  SyncSummaryRequest,
  TokenUsage,
  SummaryResponseMetadata,
  SummaryResponse,
  PreSummarySectionItem,
  PreSummarySection,
  StructuredPreSummary,
  PreSummaryResponse,
  SummaryStreamEvent,
  PreSummaryStreamEvent,
} from './summarization';

export { CONTEXT_CONTENT_MAX_LENGTH } from './consultation';

export type {
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  AddContextRequest,
  ContextItemResponse,
  ContextItemType,
  ContextItemSource,
  ConsultationGetResponse,
  ConsultationSummaryStructuredData,
  ConsultationSummaryResponse,
  JobStatusType,
  JobType,
  AsyncJobResponse,
  JobStatusResponse,
  JobStreamEvent,
} from './consultation';

export { CONTEXT_PRIMITIVES } from './consultation-context-schema';

export type {
  ConsultationSchemaBundle,
  ConsultationContextSchemaDefinition,
  ContextKindDeclaration,
  ContextKindDeprecation,
  ContextOutputDeclaration,
  ContextPrimitive,
} from './consultation-context-schema';

/** Workflow invocation plane — `hope.workflows.*` and `hope.consultations.workflows.*`. */
export { TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './workflow';

export type {
  StartWorkflowRunRequest,
  WorkflowClaimCheckRef,
  WorkflowRunCancelResult,
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunEventType,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSchemaDescription,
  WorkflowSummary,
} from './workflow';

/** Human-review plane — `hope.workflows.reviews.*` (TASK-890). */
export type { WorkflowReview, WorkflowReviewDecision, WorkflowReviewDecisionResult } from './workflow';

/** Published-Agent invocation plane — `hope.agents.*` (TASK-865). */
export type {
  AgentInvocationEvent,
  AgentInvocationEventPayload,
  AgentInvocationResult,
  AgentSummary,
  AgentTask,
  InvokeAgentRequest,
  SpeechRequest,
  SpeechSynthesis,
  TranscribeSource,
  TranscriptionJobHandle,
} from './agent';
