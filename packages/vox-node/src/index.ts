/**
 * Public entry point for `@arcaai/vox-node` — the HOPE server-side Node SDK.
 *
 * This is a SEPARATE, non-browser package from `@arcaai/vox`
 * (`packages/agentic-sdk-v2`): no React, no audio/ML stack, no browser
 * globals — `fetch`, `AbortSignal`, Web Crypto, and `ReadableStream` only
 * (see). It
 * shares the "vox" brand with the browser SDK, not its runtime.
 *
 * Deliberately NOT exported: `core/transport.ts#Transport`,
 * `core/retry.ts`/`core/redact.ts`'s internals, and `core/sse.ts#parseSseStream`
 * — the transport is internal plumbing the resources layer builds on, not
 * part of this package's public contract.
 */

export { HopeClient } from './client';
export type { HopeClientOptions, HopeLogger } from './client';

export {
  AGENT_PLANE_ROUTES,
  AgentsResource,
  ConsultationRecordingResource,
  ConsultationStreamsResource,
  ConsultationSummariesResource,
  ConsultationsResource,
  ConsultationWorkflowsResource,
  isTerminalJobStatus,
  JobsResource,
  SttResource,
  SummarizationResource,
  TenantsResource,
  WORKFLOW_PLANE_ROUTES,
  WorkflowReviewsResource,
  WorkflowsResource,
} from './resources';
export type {
  AddContextOptions,
  ConsultationRequestOptions,
  InvokeAgentOptions,
  ContextSchemaDiscoveryOptions,
  ConsultationSummaryRequestOptions,
  GenerateSummaryOptions,
  JobRequestOptions,
  LiveSummaryHandlers,
  RecordingRequestOptions,
  StartRunOptions,
  StreamRunOptions,
  SttRequestOptions,
  SttSocketOptions,
  SummarizationRequestOptions,
  SummarizationStream,
  UpdateSummaryOptions,
  WaitForOptions,
} from './resources';

/**
 * The SUBSCRIPTION shape of an SSE read (TASK-933) — what
 * `hope.consultations.streams.*` and `hope.jobs.subscribe` hand back, and the
 * handler contracts they take. Exported so an integrator can hold a
 * {@link StreamHandle} in its own session bookkeeping and type the handlers it
 * passes; `subscribeToSse` itself stays internal, like the transport it builds
 * on.
 */
export type { StreamCloseReason, StreamHandle, StreamHandlers, StreamHandlersBase, SubscribeOptions } from './core/sse-subscription';

/**
 * The realtime STT socket (TASK-933, owner decision OD-2). Exported as a CLASS
 * because a server-side integrator legitimately constructs one directly — from
 * a session another process opened, say — rather than only through
 * `hope.stt.socket(session)`. It needs a ticket refresher either way: the
 * ticket it is handed is consumed at the first handshake.
 */
export { MAX_STT_METADATA_BYTES, RealtimeSttSocket } from './core/realtime-stt-socket';
export type {
  RealtimeSttCloseEvent,
  RealtimeSttEventName,
  RealtimeSttSocketEvents,
  RealtimeSttSocketOptions,
  RealtimeSttSocketSession,
} from './core/realtime-stt-socket';

/**
 * The reserved run-identity keys a workflow `input` may never carry
 * Exported so an integrator can validate a payload BEFORE it
 * reaches the SDK — e.g. while building it from user-supplied fields — rather
 * than catching {@link ReservedRunIdentityError} after the fact.
 */
export { RESERVED_RUN_IDENTITY_KEYS, reservedRunIdentityKeysIn } from './core/run-identity';

/**
 * The run-socket ticket shape (TASK-931). Exported because the ticket is minted over an
 * ordinary route: an integrator may want to mint one here and hand it to a socket somewhere
 * else — a browser, a worker — rather than iterate {@link WorkflowsResource.streamRun} in this
 * process. `resolveSocketUrl` is the other half of that hand-off.
 */
export { resolveSocketUrl } from './core/socket';
export type { SocketFrame, WorkflowRunStreamTicket } from './core/socket';

/**
 * Inbound-webhook signature verification. HOPE signs every
 * delivery `X-Hope-Webhook-Signature: sha256=<hex>` over the RAW body
 * (`services/webhook/webhook-delivery.processor.ts`); this is the receiver
 * half. Synchronous and zero-dependency, so it runs unchanged in Node, Bun,
 * Deno and edge runtimes.
 */
export { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from './core/webhook-signature';

/**
 * The OUTBOUND half of the webhook pair (TASK-890): sign an inbound workflow
 * trigger for `POST /hooks/workflows/{hookId}`.
 *
 * A different header and a different signed string from the delivery
 * signature above — the trigger folds the `X-Hope-Timestamp` value into the
 * HMAC, which is what makes the gateway's 300-second replay window mean
 * something. Same zero-dependency core.
 */
export { WEBHOOK_TRIGGER_SIGNATURE_HEADER, WEBHOOK_TRIGGER_TIMESTAMP_HEADER, signWebhookTrigger } from './core/webhook-signature';

/**
 * The service-account credential shape. Exported HERE, not
 * only from `core/`, because `HopeClientOptions.serviceAccount` is typed with
 * it: without this line an integrator can construct the client but cannot
 * NAME the type they are constructing it from — no `const creds:
 * ServiceAccountCredentials = …` in their own config module, and no way to
 * type a helper that returns one.
 */
export type { ServiceAccountCredentials } from './core/service-account-token';

/**
 * The `/api/v1/admin/**` surface: the hand-authored
 * {@link AdminResource} base, the {@link AdminNamespace} that `hope.admin` is
 * an instance of, and the 49 generated per-area resources.
 *
 * Five admin controllers are deliberately ABSENT and stay absent by owner
 * decision — see `resources/admin/index.ts` for the table naming each decision.
 */
export * from './resources/admin';
/** Request/response types for every generated admin method, derived from the gateway's DTOs. */
export type * from './resources/admin/schemas';

export {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  CredentialClassError,
  GatewayTimeoutError,
  HopeAPIError,
  HopeStreamError,
  NotFoundError,
  PermissionError,
  PreconditionRequiredError,
  QuotaExceededError,
  RateLimitError,
  ReservedRunIdentityError,
  SocketUnavailableError,
  VersionConflictError,
} from './core/errors';
export type { HopeAPIErrorInit, RateLimitErrorInit, VersionConflictErrorInit } from './core/errors';

export { CONTEXT_CONTENT_MAX_LENGTH, CONTEXT_PRIMITIVES, TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './types';

export type {
  AcceptedCorrectionProposal,
  AddContextRequest,
  AsyncJobResponse,
  ConsultationOpenResponse,
  CreateStreamSessionRequest,
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
  StreamSessionResponse,
  StreamTicketRefreshResponse,
  StreamingSessionStatus,
  SttAudioFrame,
  SttClientMessage,
  SttCloseMessage,
  SttErrorMessage,
  SttMetadataSpan,
  SttResumeFailedMessage,
  SttResumeRequest,
  SttResumedMessage,
  SttServerMessage,
  SttStatusMessage,
  SttStopMessage,
  SttTranscriptResult,
  SttWordTimestamp,
  ConsultationContextSchemaDefinition,
  ConsultationGetResponse,
  ConsultationSchemaBundle,
  ConsultationSummaryResponse,
  ConsultationSummaryStructuredData,
  ContextItemResponse,
  ContextItemSource,
  ContextItemType,
  ContextKindDeclaration,
  ContextKindDeprecation,
  ContextOutputDeclaration,
  ContextPrimitive,
  ConversationSegment,
  GeneratePreSummaryRequest,
  GenerateSummaryRequest,
  JobStatusResponse,
  JobStatusType,
  JobStreamEvent,
  JobType,
  PreSummaryRequest,
  PreSummaryResponse,
  PreSummarySection,
  PreSummarySectionItem,
  PreSummaryStreamEvent,
  PreviousVisitRecord,
  SessionData,
  StructuredPreSummary,
  SummaryResponse,
  SummaryResponseMetadata,
  SummaryStreamEvent,
  SyncSummaryRequest,
  TestResult,
  TokenUsage,
  UpdateSummaryRequest,
  StartWorkflowRunRequest,
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowReviewDecisionResult,
  WorkflowSchemaDescription,
  WorkflowClaimCheckRef,
  WorkflowRunCancelResult,
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunEventType,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSummary,
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
  TranscriptionJobHandle,
} from './types';
