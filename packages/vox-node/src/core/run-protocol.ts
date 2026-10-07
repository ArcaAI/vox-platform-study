/**
 * Run protocol v2 — the pure, dependency-free half, copied for `@arcaai/vox-node` (TASK-1039).
 *
 * The source of truth is `packages/async-contract/src/run-protocol.ts` (with the cross-language
 * fixture `tests/contracts/run-protocol.fixture.json` and `docs/implementation/TASK-1038-…/
 * protocol-v2.md`). This package ships ZERO runtime dependencies — a workspace `dependencies`
 * entry is a runtime dependency however type-shaped its use looks — so the parts a CLIENT needs are
 * re-declared here: the event catalogue and its typed data, the fixed error labels, and the cursor
 * rule. `run-protocol.task1039.test.ts` asserts every constant against the fixture, which is what
 * keeps this copy from drifting.
 *
 * Deliberately NOT copied: the producer half (Lua sequencer, `buildRunAppend`, stored-entry
 * parsing, resume planning) and the declarative per-type data schemas. A client does not append,
 * and it cannot reject a frame the server already validated; {@link parseRunEvent} is a structural
 * guard that keeps a malformed frame out of typed code, not a second validator.
 */

/** The protocol this module defines. */
export const RUN_PROTOCOL_VERSION = 2;

/** Request header selecting the protocol (`x-hope-run-protocol: 2`). Absent ⇒ the legacy frame shapes, for one release. */
export const RUN_PROTOCOL_HEADER = 'x-hope-run-protocol';

/** Query parameter selecting the protocol (`?protocol=2`) for callers that cannot set a header. */
export const RUN_PROTOCOL_QUERY_PARAM = 'protocol';

/** A result at most this many bytes rides inline on `run.completed`; larger is a `ref`. */
export const RUN_RESULT_INLINE_MAX_BYTES = 64 * 1024;

/** An agent run has no graph; its one step is always this `nodeId`. */
export const AGENT_RUN_NODE_ID = 'agent';

/** Events every business-plane caller may receive. */
export const PUBLIC_RUN_EVENT_TYPES = Object.freeze([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.resync',
  'node.started',
  'node.completed',
  'node.failed',
  'output.text.delta',
  'output.audio.delta',
  'output.data',
  'ping',
  // TASK-1050: a guardrail hold pauses the run at the blocked node, and every warn / block / unverified
  // reaches the client as ONE standard notice.
  'run.paused',
  'guardrail.notice',
] as const);

/** The admin trace's debug events — console only. A business-plane stream never carries them; listed so a frame is recognised, not dropped as unknown. */
export const ADMIN_RUN_EVENT_TYPES = Object.freeze([
  'input.validated',
  'data.bound',
  'binding.warning',
  'consultation.read',
  'transcript.partial',
  'transcript.final',
  'prompt.composed',
  'model.request',
  'guardrail.inbound',
  'guardrail.outbound',
  'output.validated',
] as const);

export type PublicRunEventType = (typeof PUBLIC_RUN_EVENT_TYPES)[number];
export type AdminRunEventType = (typeof ADMIN_RUN_EVENT_TYPES)[number];
export type RunEventType = PublicRunEventType | AdminRunEventType;

/** All 25 types, public first. */
export const RUN_EVENT_TYPES: readonly RunEventType[] = Object.freeze([...PUBLIC_RUN_EVENT_TYPES, ...ADMIN_RUN_EVENT_TYPES]);

/** The three events that end a run. */
export const TERMINAL_RUN_EVENT_TYPES = Object.freeze(['run.completed', 'run.failed', 'run.cancelled'] as const);

const KNOWN_TYPES: ReadonlySet<string> = new Set(RUN_EVENT_TYPES);
const TERMINAL_TYPES: ReadonlySet<string> = new Set(TERMINAL_RUN_EVENT_TYPES);

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === 'string' && KNOWN_TYPES.has(value);
}

/** `true` for `run.completed` / `run.failed` / `run.cancelled`. */
export function isTerminalRunEventType(type: string): boolean {
  return TERMINAL_TYPES.has(type);
}

export interface RunTokens {
  readonly in: number;
  readonly out: number;
}

/**
 * A run or step failure. `code` is a fixed SCREAMING_SNAKE identifier and `message` the fixed
 * label {@link runErrorMessage} gives it, so nothing a producer interpolates can reach a business
 * caller. `detail` is the admin trace's free text; the public plane never carries it.
 */
export interface RunError {
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly detail?: string;
}

/** The fixed labels (fixture key `errorMessages`). A code not listed gets {@link RUN_ERROR_FALLBACK_MESSAGE}. */
export const RUN_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  RUN_TIMED_OUT: 'The run exceeded its time limit.',
  NODE_TIMED_OUT: 'The step exceeded its time limit.',
  RUN_CANCELLED: 'The run was cancelled.',
  INPUT_INVALID: 'The run input does not match its schema.',
  OUTPUT_INVALID: 'The output does not match its declared contract.',
  BINDING_UNRESOLVED: 'A required input of the step has no value.',
  PROMPT_VARIABLE_UNRESOLVED: 'A required prompt variable has no value.',
  PAYLOAD_TOO_LARGE: 'A payload exceeded the size limit.',
  MODEL_UNAVAILABLE: 'The model did not answer.',
  MODEL_ERROR: 'The model returned an error.',
  PROVIDER_NOT_CONFIGURED: 'No usable provider connection is configured.',
  AGENT_VERSION_UNAVAILABLE: 'The pinned agent version is not available.',
  GUARDRAIL_BLOCKED: 'A guardrail blocked the content.',
  CONSULTATION_READ_FAILED: 'Consultation data could not be read.',
  DOWNSTREAM_UNAVAILABLE: 'A downstream service did not answer.',
  INTERNAL_ERROR: 'An internal error occurred.',
});

/** The label of every code {@link RUN_ERROR_MESSAGES} does not list. */
export const RUN_ERROR_FALLBACK_MESSAGE = 'The step could not be completed.';

/** The one message a {@link RunError} with this code may carry. */
export function runErrorMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(RUN_ERROR_MESSAGES, code) ? (RUN_ERROR_MESSAGES[code] as string) : RUN_ERROR_FALLBACK_MESSAGE;
}

/** `run.completed.data.result` — exactly these two shapes. */
export type RunResult =
  | { readonly kind: 'inline'; readonly value: unknown }
  | { readonly kind: 'ref'; readonly bucket: string; readonly key: string; readonly sizeBytes: number; readonly sha256: string };

/** The persisted run status vocabulary. */
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** `true` when `status` is one a run never leaves. */
export function isTerminalRunStatusValue(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Why the SERVER sent `run.resync` — the only loss signal a client acts on. */
export const RUN_RESYNC_REASONS = Object.freeze(['gap', 'expired', 'cursor_invalid', 'unavailable'] as const);
export type RunResyncReason = (typeof RUN_RESYNC_REASONS)[number];

export type RunNodeStatus = 'waiting' | 'running' | 'completed' | 'degraded' | 'failed' | 'skipped';

export interface RunSnapshot {
  readonly status: RunStatus;
  /** The last stored `seq` the snapshot reflects; the stream continues at `lastSeq + 1`. */
  readonly lastSeq: number;
  readonly nodes: Readonly<Record<string, { readonly status: RunNodeStatus; readonly durationMs?: number }>>;
  /** Public outputs so far, keyed by `nodeId`, then `field`. */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly result?: RunResult;
}

export type PhiClass = 'PHI' | 'NON_PHI';

/** The guardrail action vocabulary on the admin trace (TASK-1036's three plus TASK-1050's `WARN` / `IGNORE`). */
export const RUN_GUARDRAIL_EVENT_ACTIONS = Object.freeze(['ALLOW', 'REDACT', 'BLOCK', 'WARN', 'IGNORE'] as const);
export type RunGuardrailEventAction = (typeof RUN_GUARDRAIL_EVENT_ACTIONS)[number];

/** One check of a screen on the admin trace — verdict, action and timing; never content or judge reasoning. */
export interface RunGuardrailCheck {
  readonly checkId: string;
  readonly verdict: 'pass' | 'flag' | 'undetermined' | 'skipped';
  readonly actionTaken: 'none' | 'ignore' | 'warn' | 'block' | 'unverified';
  readonly category?: string;
  readonly score?: number;
  readonly confidence?: number;
  readonly model?: string;
  readonly latencyMs?: number;
}

/** Inbound screens only the EXTERNAL_DATA blocks; outbound screens the response. */
export interface GuardrailEventData {
  readonly action: RunGuardrailEventAction;
  readonly detected: number;
  readonly categories?: readonly string[];
  readonly mode?: 'detect' | 'redact';
  readonly latencyMs?: number;
  /** TASK-1050: per-check outcomes. Absent on a producer that predates it. */
  readonly checks?: readonly RunGuardrailCheck[];
}

/** Why a run paused. Only the guardrail hold today. */
export const RUN_PAUSED_REASONS = Object.freeze(['guardrail_hold'] as const);
export type RunPausedReason = (typeof RUN_PAUSED_REASONS)[number];

/** The check ids a notice may name (`@arcaai/types` `GUARDRAIL_CHECK_IDS`, pinned by `guardrail-vocabulary.fixture.json`). */
export const RUN_GUARDRAIL_CHECK_IDS = Object.freeze([
  'jailbreak_detection',
  'prompt_safety',
  'prompt_toxicity',
  'response_safety',
  'response_toxicity',
  'response_refusal',
  'pii_leak',
  'containment_echo',
  'medical_validation',
  'injection_judge',
  'unsafe_content_judge',
  'clinical_safety_judge',
  'leakage_judge',
] as const);

/** The ONE action each notice type carries (`@arcaai/types` `GUARDRAIL_NOTICE_TYPE_ACTION`). */
export const RUN_GUARDRAIL_NOTICE_TYPE_ACTION: Readonly<Record<RunGuardrailNotice['type'], RunGuardrailNotice['action']>> = Object.freeze({
  'guardrail.warning': 'warn',
  'guardrail.blocked': 'block',
  'guardrail.unverified': 'warn',
});

/**
 * The fixed label of every notice `messageKey` (`@arcaai/types` `GUARDRAIL_NOTICE_DEFAULT_MESSAGES`). A notice's
 * `defaultMessage` is exactly its key's label, so nothing a producer interpolates can reach a client. Localise on `messageKey`.
 */
export const RUN_GUARDRAIL_NOTICE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'guardrail.warning.generic': 'A safety check flagged this content. Review it before you rely on it.',
  'guardrail.blocked.inbound': 'A safety check stopped this request. Review the flagged input to continue.',
  'guardrail.blocked.outbound': 'A safety check withheld the generated content. Review it to continue.',
  'guardrail.blocked.not_medical':
    'This content is outside clinical documentation, so it was not processed. Review the flagged input to continue.',
  'guardrail.blocked.redaction_unavailable':
    'Patient details could not be protected before sending to an external model, so processing is paused. Retry to continue.',
  'guardrail.unverified.generic': 'A safety check could not run, so this content was not verified. Review it before you rely on it.',
});

/** `GuardrailNotice` v1, structurally identical to `@arcaai/types` (no content, no judge reasoning). */
export interface RunGuardrailNotice {
  readonly schemaVersion: 1;
  readonly noticeId: string;
  readonly type: 'guardrail.warning' | 'guardrail.blocked' | 'guardrail.unverified';
  readonly direction: 'inbound' | 'outbound';
  readonly action: 'warn' | 'block';
  readonly checks: ReadonlyArray<{ readonly checkId: string; readonly category?: string; readonly severity: 'low' | 'medium' | 'high' }>;
  readonly consultationId?: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly itemIds: readonly string[];
  readonly messageKey: string;
  readonly defaultMessage: string;
  readonly requiresAcknowledgement: boolean;
  readonly resumable: boolean;
  readonly policyVersion: string;
  readonly occurredAt: string;
}

/**
 * The cross-field rules of a notice (`action` is the type's one action, `messageKey` belongs to the type,
 * `defaultMessage` is the key's fixed label, known check ids, schemaVersion 1, `policyVersion` present).
 * Empty when the notice is well-formed. A diagnostic for tests and tooling — {@link isRunGuardrailNotice} is the lenient runtime guard.
 */
export function guardrailNoticeProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['notice must be an object'];
  const problems: string[] = [];
  if (value.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (typeof value.noticeId !== 'string' || value.noticeId === '') problems.push('noticeId is required');
  if (typeof value.policyVersion !== 'string' || value.policyVersion === '') problems.push('policyVersion is required');
  const type = value.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RUN_GUARDRAIL_NOTICE_TYPE_ACTION, type)) {
    problems.push('type is not a known notice type');
    return problems;
  }
  const expected = RUN_GUARDRAIL_NOTICE_TYPE_ACTION[type as RunGuardrailNotice['type']];
  if (value.action !== expected) problems.push(`action must be ${expected} on a ${type} notice`);
  if (typeof value.messageKey !== 'string' || !value.messageKey.startsWith(`${type}.`)) problems.push(`messageKey must be a ${type}.* key`);
  else if (value.defaultMessage !== RUN_GUARDRAIL_NOTICE_MESSAGES[value.messageKey]) problems.push('defaultMessage must be the fixed label of messageKey');
  if (!Array.isArray(value.checks)) problems.push('checks must be an array');
  else {
    for (const check of value.checks) {
      if (!isRecord(check) || !(RUN_GUARDRAIL_CHECK_IDS as readonly unknown[]).includes(check.checkId)) problems.push('checks[].checkId is not a known check');
    }
  }
  if (!Array.isArray(value.itemIds)) problems.push('itemIds must be an array');
  return problems;
}

/**
 * The runtime guard the SDKs apply before a notice reaches a handler: a notice we can render by `noticeId`,
 * `type` and `messageKey`. Deliberately lenient about fields a newer server may add — a safety message is never
 * dropped for being newer than this client; {@link guardrailNoticeProblems} is the strict check.
 */
export function isRunGuardrailNotice(value: unknown): value is RunGuardrailNotice {
  return (
    isRecord(value) &&
    typeof value.noticeId === 'string' &&
    value.noticeId !== '' &&
    typeof value.type === 'string' &&
    Object.prototype.hasOwnProperty.call(RUN_GUARDRAIL_NOTICE_TYPE_ACTION, value.type) &&
    typeof value.messageKey === 'string'
  );
}

export interface RunEventDataMap {
  'run.started': {
    readonly kind: 'workflow' | 'agent';
    readonly slug: string;
    readonly versionNumber: number;
    readonly mode?: 'blocking' | 'async' | 'stream';
  };
  'run.completed': {
    readonly status: 'COMPLETED';
    readonly durationMs: number;
    readonly tokens: RunTokens;
    readonly result?: RunResult;
    readonly degraded?: boolean;
    /** TASK-1050: every warn / unverified notice the run raised (a block pauses or fails the run instead). */
    readonly guardrailNotices?: readonly RunGuardrailNotice[];
  };
  'run.failed': { readonly status: 'FAILED' | 'TIMED_OUT'; readonly durationMs: number; readonly error: RunError; readonly tokens?: RunTokens };
  /** The event type is spelled `cancelled`; the status keeps the persisted `CANCELED`. */
  'run.cancelled': { readonly status: 'CANCELED'; readonly durationMs: number; readonly reason?: string };
  'run.resync': { readonly reason: RunResyncReason; readonly snapshot: RunSnapshot };
  /** TASK-1050: the run waits durably at `nodeId` for a hold resolution. NOT terminal — keep following the stream. */
  'run.paused': { readonly reason: RunPausedReason; readonly noticeId: string; readonly nodeId: string };
  /** TASK-1050: the standard client message (`@arcaai/types` `GuardrailNotice` v1). */
  'guardrail.notice': RunGuardrailNotice;
  'node.started': { readonly kind: string; readonly label?: string; readonly attempt?: number };
  'node.completed': {
    readonly status: 'COMPLETED' | 'DEGRADED' | 'SKIPPED';
    readonly durationMs: number;
    readonly tokens?: RunTokens;
    readonly warnings?: number;
  };
  'node.failed': { readonly durationMs: number; readonly error: RunError; readonly attempt?: number; readonly willRetry?: boolean };
  'output.text.delta': { readonly field: string; readonly text: string };
  'output.audio.delta': {
    readonly field: string;
    readonly chunk: string;
    readonly format: 'wav' | 'mp3' | 'ogg' | 'pcm';
    readonly sampleRate?: number;
  };
  'output.data': { readonly field: string; readonly value: unknown; readonly visibility?: 'admin' };
  ping: Record<string, never>;
  'input.validated': {
    readonly valid: boolean;
    readonly problems: readonly string[];
    readonly schema?: { readonly slug: string; readonly versionNumber?: number };
  };
  'data.bound': {
    readonly inputs: ReadonlyArray<{
      readonly input: string;
      readonly source: { readonly kind: 'from' | 'value' | 'template'; readonly path?: string; readonly template?: string };
      readonly value?: unknown;
      readonly empty?: boolean;
      readonly phiClass?: PhiClass;
    }>;
  };
  'binding.warning': { readonly input: string; readonly code: string; readonly message: string };
  'consultation.read': {
    readonly consultationId: string;
    readonly snapshot: 'node-start' | 'run-start';
    readonly fields: ReadonlyArray<{ readonly path: string; readonly phiClass: PhiClass; readonly value?: unknown }>;
  };
  'transcript.partial': { readonly text: string; readonly utteranceIndex?: number; readonly stableChars?: number };
  'transcript.final': {
    readonly text: string;
    readonly utteranceIndex?: number;
    readonly start?: number;
    readonly end?: number;
    readonly speaker?: string;
    readonly language?: string;
  };
  'prompt.composed': {
    readonly layers: ReadonlyArray<{ readonly name: string; readonly chars: number; readonly tokens?: number }>;
    readonly charsTotal: number;
    readonly tokensTotal?: number;
    readonly selected: readonly string[];
    readonly excluded: ReadonlyArray<{ readonly key: string; readonly reason: 'condition_false' | 'condition_error' }>;
    readonly blocks: ReadonlyArray<{ readonly key: string; readonly chars: number; readonly truncated: boolean }>;
    readonly composedPromptId?: string;
  };
  'model.request': {
    readonly provider: string;
    readonly model: string;
    readonly attempt: number;
    readonly fallback: boolean;
    readonly stream: boolean;
    readonly parameters?: { readonly temperature?: number; readonly maxTokens?: number };
  };
  'guardrail.inbound': GuardrailEventData;
  'guardrail.outbound': GuardrailEventData;
  'output.validated': { readonly valid: boolean; readonly problems: readonly string[]; readonly field?: string };
}

/** The v2 envelope. Narrow on `type` to get the typed `data`. */
export type RunEventV2<T extends RunEventType = RunEventType> = T extends RunEventType
  ? {
      readonly seq: number;
      readonly runId: string;
      readonly type: T;
      /** ISO-8601, when the event happened (not when it was delivered). */
      readonly ts: string;
      readonly nodeId?: string;
      readonly data: RunEventDataMap[T];
    }
  : never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for one decoded envelope: a known `type`, a non-negative integer `seq`, string
 * `runId` / `ts`, an object `data`, and an optional string `nodeId`. Returns the value typed, or
 * `null`. It does NOT re-validate `data` per type — the gateway validated what it sent, and a
 * client that second-guessed it would drop frames a newer server legitimately added fields to.
 */
export function parseRunEvent(value: unknown): RunEventV2 | null {
  if (!isRecord(value)) return null;
  if (!isRunEventType(value.type)) return null;
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return null;
  if (typeof value.runId !== 'string' || value.runId.length === 0) return null;
  if (typeof value.ts !== 'string') return null;
  if (!isRecord(value.data)) return null;
  if (value.nodeId !== undefined && typeof value.nodeId !== 'string') return null;
  return value as unknown as RunEventV2;
}

/** One step of a client's cursor — what {@link advanceRunCursor} decided for one received event. */
export interface RunCursorStep {
  /** The cursor to keep (and to send as `Last-Event-ID` on the next reconnect). */
  readonly cursor: number;
  /** Whether the event is new to this client and must be applied. */
  readonly deliver: boolean;
  /** `run.resync`: discard the run state and replace it with `data.snapshot`. */
  readonly reset: boolean;
}

/**
 * The client side of the gap rule. `seq` is monotonic but NOT contiguous for a client (the public
 * plane is filtered out of one stored sequence), so there is no "missed events" branch at all:
 * only the server signals loss, with `run.resync`.
 *
 * - a stored event with `seq > cursor` is delivered and becomes the cursor, however far it jumps;
 * - a stored event with `seq <= cursor` is a replayed duplicate and is dropped;
 * - `ping` is never delivered; it can only move the cursor forward;
 * - `run.resync` is delivered with `reset: true` and sets the cursor to its `seq`, even when lower.
 */
export function advanceRunCursor(cursor: number, event: Pick<RunEventV2, 'seq' | 'type'>): RunCursorStep {
  if (event.type === 'run.resync') return { cursor: event.seq, deliver: true, reset: true };
  if (event.type === 'ping') return { cursor: Math.max(cursor, event.seq), deliver: false, reset: false };
  if (event.seq <= cursor) return { cursor, deliver: false, reset: false };
  return { cursor: event.seq, deliver: true, reset: false };
}
