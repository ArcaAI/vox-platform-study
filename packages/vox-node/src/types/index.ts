/**
 * Barrel for `@arcaai/vox-node` request/response types — the v2 native,
 * consultation-bound surface (`hope.consultations.*`, `hope.agents.*`, `hope.workflows.*`, ...).
 *
 * The v1-compat, stateless summarization types (`SummaryResponse`, `PreSummaryResponse`, ...)
 * were removed outright with `hope.summarization.*` (TASK-1004 D-8, zero traffic in production) —
 * use `hope.consultations.summaries.*` instead.
 */

export { CONTEXT_CONTENT_MAX_LENGTH } from './consultation';

/** The spoken-language selection contract shared with `apps/stt`, `@arcaai/vox`, and ALaaS (TASK-1004). */
export type {
  LanguageModeId,
  LanguageResolution,
  LanguageResolutionDegradeReason,
  LanguageResolutionParams,
  LanguageResolutionSource,
} from './language';

export type {
  GenerateSummaryRequest,
  GeneratePreSummaryRequest,
  UpdateSummaryRequest,
  ApproveSummaryRequest,
  SummaryApprovalResponse,
  AddContextRequest,
  ContextItemResponse,
  ContextItemType,
  ContextItemSource,
  ConsultationGetResponse,
  ConsultationSummaryStructuredData,
  ConsultationSummaryResponse,
  ConsultationSummarySection,
  ConsultationSummaryDuplicateAnnotation,
  JobStatusType,
  JobType,
  AsyncJobResponse,
  JobStatusResponse,
  JobStreamEvent,
} from './consultation';

/** The consultation REALTIME lifecycle — open, recording, and the live planes (TASK-933). */
export type {
  AcceptedCorrectionProposal,
  CloseConsultationRequest,
  ConsultationOpenResponse,
  DocumentSection,
  HarnessProgressEvent,
  HarnessProgressStage,
  LiveAssistEvent,
  LiveSummaryEntity,
  LiveSummaryEvent,
  LiveSummaryGroundedness,
  LiveSummaryGroundednessSegment,
  LiveSummarySection,
  LiveSummaryStreamEvent,
  LiveSummaryVitals,
  LoopEvent,
  OpenConsultationRequest,
  PreSummaryEvent,
  PreSummaryStatus,
  RecordingStateResponse,
  SectionAnnotation,
  SectionAnnotationKind,
  SectionPatchEvent,
  SectionProvenance,
  StartRecordingRequest,
  StopRecordingRequest,
  UpdateConsultationLanguageRequest,
} from './consultation-realtime';

/** The STT streaming session and the `/ws/stt/stream` wire protocol (TASK-933). */
export type {
  CreateStreamSessionRequest,
  SttAudioFrame,
  SttClientMessage,
  SttCloseMessage,
  SttErrorMessage,
  SttResumeFailedMessage,
  SttResumeRequest,
  SttResumedMessage,
  SttServerMessage,
  SttStatusMessage,
  // TASK-985 M-22/M-43 — the readiness signal and the discarded-results signal.
  SttReadyMessage,
  SttGapMessage,
  SttStopMessage,
  SttMetadataSpan,
  SttTranscriptResult,
  SttWordTimestamp,
  StreamSessionResponse,
  StreamTicketRefreshResponse,
  StreamingSessionStatus,
} from './stt';

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
  NamedEntityRecognitionInput,
  NamedEntityRecognitionOutput,
  RecognizedEntity,
  SpeechRequest,
  SpeechSynthesis,
  TranscribeSource,
  TranscriptionJobEvent,
  TranscriptionJobHandle,
  TranscriptionJobStatus,
} from './agent';

/** DNA writing-style ingest — `hope.dnaWritingStyle.*` (TASK-974). */
export type {
  DnaIngestJobResponse,
  DnaIngestJobStatus,
  DnaWritingSample,
  DnaWritingSampleKind,
  DnaWritingSamplesIngestRequest,
} from './dna-writing-style';
