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

export { ConsultationSummariesResource, ConsultationsResource, isTerminalJobStatus, JobsResource, SummarizationResource } from './resources';
export type {
  AddContextOptions,
  ConsultationRequestOptions,
  ConsultationSummaryRequestOptions,
  GenerateSummaryOptions,
  JobRequestOptions,
  SummarizationRequestOptions,
  SummarizationStream,
  UpdateSummaryOptions,
  WaitForOptions,
} from './resources';

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
  HopeAPIError,
  HopeStreamError,
  NotFoundError,
  PermissionError,
  PreconditionRequiredError,
  QuotaExceededError,
  RateLimitError,
  VersionConflictError,
} from './core/errors';
export type { HopeAPIErrorInit, RateLimitErrorInit, VersionConflictErrorInit } from './core/errors';

export { CONTEXT_CONTENT_MAX_LENGTH } from './types';

export type {
  AddContextRequest,
  AsyncJobResponse,
  ConsultationGetResponse,
  ConsultationSummaryResponse,
  ConsultationSummaryStructuredData,
  ContextItemResponse,
  ContextItemSource,
  ContextItemType,
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
} from './types';
