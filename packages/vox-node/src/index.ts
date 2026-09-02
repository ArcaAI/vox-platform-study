/**
 * Public entry point for `@arcaai/vox-node` — the HOPE server-side Node SDK.
 *
 * This is a SEPARATE, non-browser package from `@arcaai/vox`
 * (`packages/agentic-sdk-v2`): no React, no audio/ML stack, no browser
 * globals — `fetch`, `AbortSignal`, Web Crypto, and `ReadableStream` only
 * (see `docs/implementation/TASK-632-HOPE-Node-SDK/README.md`). It
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
  ConsultationSummariesResource,
  ConsultationsResource,
  ConsultationWorkflowsResource,
  isTerminalJobStatus,
  JobsResource,
  SummarizationResource,
  TenantsResource,
  WORKFLOW_PLANE_ROUTES,
  WorkflowsResource,
} from './resources';
export type {
  AddContextOptions,
  ConsultationRequestOptions,
  ContextSchemaDiscoveryOptions,
  ConsultationSummaryRequestOptions,
  GenerateSummaryOptions,
  JobRequestOptions,
  StartRunOptions,
  StreamRunOptions,
  SummarizationRequestOptions,
  SummarizationStream,
  UpdateSummaryOptions,
  WaitForOptions,
} from './resources';

/**
 * The reserved run-identity keys a workflow `input` may never carry
 * (TASK-850). Exported so an integrator can validate a payload BEFORE it
 * reaches the SDK — e.g. while building it from user-supplied fields — rather
 * than catching {@link ReservedRunIdentityError} after the fact.
 */
export { RESERVED_RUN_IDENTITY_KEYS, reservedRunIdentityKeysIn } from './core/run-identity';

/**
 * The service-account credential shape (TASK-773 Phase C). Exported HERE, not
 * only from `core/`, because `HopeClientOptions.serviceAccount` is typed with
 * it: without this line an integrator can construct the client but cannot
 * NAME the type they are constructing it from — no `const creds:
 * ServiceAccountCredentials = …` in their own config module, and no way to
 * type a helper that returns one.
 */
export type { ServiceAccountCredentials } from './core/service-account-token';

/**
 * The `/api/v1/admin/**` surface (TASK-773): the hand-authored
 * {@link AdminResource} base, the {@link AdminNamespace} that `hope.admin` is
 * an instance of, and the 52 generated per-area resources.
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
  VersionConflictError,
} from './core/errors';
export type { HopeAPIErrorInit, RateLimitErrorInit, VersionConflictErrorInit } from './core/errors';

export { CONTEXT_CONTENT_MAX_LENGTH, CONTEXT_PRIMITIVES, TERMINAL_RUN_STATUSES, isTerminalRunStatus } from './types';

export type {
  AddContextRequest,
  AsyncJobResponse,
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
  WorkflowClaimCheckRef,
  WorkflowRunCancelResult,
  WorkflowRunEvent,
  WorkflowRunEventPayload,
  WorkflowRunEventType,
  WorkflowRunHandle,
  WorkflowRunStatus,
  WorkflowSummary,
} from './types';
