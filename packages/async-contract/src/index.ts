/**
 * @arcaai/async-contract
 *
 * the normative async task/event envelope, plus the idempotency-key
 * and resume-token conventions, plus a reusable conformance suite. Zero
 * runtime dependencies. Full prose contract:
 * docs/programs/agentic-workflow-platform/async-contract.md.
 */
export { ASYNC_ENVELOPE_SCHEMA_VERSION, asyncEnvelopeProblems, parseAsyncEnvelope } from './envelope';
export type { AsyncEnvelope } from './envelope';

export { claimCheckRefProblems } from './claim-check-ref';
export type { ClaimCheckRef } from './claim-check-ref';

export { MAX_IDEMPOTENCY_KEY_LENGTH, idempotencyKeyProblems, AsyncIdempotencyKey } from './idempotency';

export { encodeResumeToken, decodeResumeToken, RESUME_FROM_BEGINNING } from './resume-token';

export { assertAsyncConformance } from './conformance/index';
export type { AsyncProducerUnderTest } from './conformance/index';

// ── TASK-1038: run protocol v2 (one envelope for SSE and WS; public + admin-debug events) ──
export {
  RUN_PROTOCOL_VERSION,
  RUN_PROTOCOL_HEADER,
  RUN_RESULT_INLINE_MAX_BYTES,
  PUBLIC_RUN_EVENT_TYPES,
  ADMIN_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RUN_EVENT_VISIBILITY,
  RUN_EVENT_NODE_SCOPE,
  SYNTHETIC_RUN_EVENT_TYPES,
  RUN_EVENT_DATA_SCHEMAS,
  isRunEventType,
  isPublicRunEvent,
  runEventProblems,
  parseRunEvent,
  toSseFrame,
  parseSseFrame,
  parseResumeCursor,
  RunProtocolError,
  RUN_PROTOCOL_QUERY_PARAM,
  selectRunProtocol,
  RUN_RESYNC_REASONS,
  advanceRunCursor,
  AGENT_RUN_NODE_ID,
  RUN_ERROR_MESSAGES,
  RUN_ERROR_FALLBACK_MESSAGE,
  runErrorMessage,
  runEventAudience,
  toPublicRunEvent,
  RUN_STREAM_KEY_PREFIX,
  RUN_SEQ_KEY,
  RUN_EVENTS_KEY,
  RUN_DEDUPE_KEY,
  RUN_STREAM_MAX_LEN,
  RUN_STREAM_FIELDS,
  RUN_STREAM_CLOSED_ERROR,
  TERMINAL_RUN_EVENT_TYPES,
  RUN_APPEND_LUA,
  buildRunAppend,
  parseStoredRunEvent,
  planRunResume,
  // TASK-1050: guardrail notice / hold additions.
  RUN_GUARDRAIL_EVENT_ACTIONS,
  RUN_GUARDRAIL_CHECK_IDS,
  RUN_GUARDRAIL_NOTICE_TYPE_ACTION,
  RUN_GUARDRAIL_NOTICE_MESSAGES,
  RUN_PAUSED_REASONS,
} from './run-protocol';
export type {
  RunGuardrailNotice,
  RunGuardrailCheck,
  RunGuardrailEventAction,
  RunPausedReason,
  RunEventV2,
  RunEventType,
  PublicRunEventType,
  AdminRunEventType,
  RunEventVisibility,
  RunEventDataMap,
  RunEventDataSchema,
  RunResult,
  RunTokens,
  RunError,
  RunStatus,
  RunNodeStatus,
  RunSnapshot,
  PhiClass,
  GuardrailEventData,
  ParsedSseFrame,
  RunResyncReason,
  RunCursorStep,
  RunEventNodeScope,
  RunEventValidationOptions,
  RunAppendInput,
  RunAppendCommand,
  ParsedStoredRunEvent,
  RunResumePlan,
} from './run-protocol';
