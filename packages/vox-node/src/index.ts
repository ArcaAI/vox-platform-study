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
  ConsultationRequestOptions,
  ConsultationSummaryRequestOptions,
  GenerateSummaryOptions,
  JobRequestOptions,
  SummarizationRequestOptions,
  SummarizationStream,
  UpdateSummaryOptions,
  WaitForOptions,
} from './resources';

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

export type {
  AsyncJobResponse,
  ConsultationGetResponse,
  ConsultationSummaryResponse,
  ConsultationSummaryStructuredData,
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
