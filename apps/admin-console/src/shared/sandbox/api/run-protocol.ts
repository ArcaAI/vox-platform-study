/**
 * Run protocol v2 — the console's mirror (TASK-1036 §10.3, TASK-1038 `protocol-v2.md`).
 *
 * The source of truth is `packages/async-contract/src/run-protocol.ts` plus the cross-language
 * fixture `tests/contracts/run-protocol.fixture.json`. The console does not depend on
 * `@arcaai/async-contract` (it cannot import server packages), so the vocabulary the Test tab reads
 * is re-declared here — the same convention every console wire type follows — and
 * `__tests__/run-protocol.test.ts` pins it to the fixture so the two cannot drift silently.
 *
 * What a client may conclude (protocol-v2.md §6.3): `seq` is monotonic but NOT contiguous for a
 * client, so a jump is never loss. Only the server signals loss, with `run.resync`, whose snapshot
 * REPLACES the client's run state.
 */
import type { GuardrailNotice } from '@arcaai/types';

/**
 * Every event type of the admin trace: the public plane's fourteen plus the eleven debug events.
 * TASK-1050 adds the public `run.paused` (a guardrail hold parks the run at its node) and
 * `guardrail.notice` (the standard `GuardrailNotice` v1) — frozen by the OVERLAY fixture
 * `tests/contracts/guardrail-run-events.fixture.json`.
 */
export const RUN_TRACE_EVENT_TYPES = [
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.resync',
  'run.paused',
  'guardrail.notice',
  'node.started',
  'node.completed',
  'node.failed',
  'output.text.delta',
  'output.audio.delta',
  'output.data',
  'ping',
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
] as const;

export type RunEventType = (typeof RUN_TRACE_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUN_TRACE_EVENT_TYPES);

export interface RunTokens {
  in: number;
  out: number;
}

export interface RunError {
  code: string;
  message: string;
  nodeId?: string;
  /** Admin trace only: free-text diagnosis, may echo values (PHI). */
  detail?: string;
}

export type RunResult = { kind: 'inline'; value: unknown } | { kind: 'ref'; bucket: string; key: string; sizeBytes: number; sha256: string };

export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

export type RunNodeStatus = 'waiting' | 'running' | 'completed' | 'degraded' | 'failed' | 'skipped';

export interface RunSnapshot {
  status: RunStatus;
  lastSeq: number;
  nodes: Record<string, { status: RunNodeStatus; durationMs?: number }>;
  /** Keyed by `nodeId`, then output `field`. */
  outputs: Record<string, Record<string, unknown>>;
  result?: RunResult;
}

export type PhiClass = 'PHI' | 'NON_PHI';

export interface BindingSource {
  kind: 'from' | 'value' | 'template';
  path?: string;
  template?: string;
}

export interface BoundInput {
  input: string;
  source: BindingSource;
  value?: unknown;
  /** An optional input that rendered `""` (OD-10). */
  empty?: boolean;
  phiClass?: PhiClass;
}

/**
 * The guardrail action vocabulary on the admin trace. `ALLOW` / `REDACT` / `BLOCK` are TASK-1036's;
 * TASK-1050 adds `WARN` (a warn violation, the run continued) and `IGNORE` (a violation recorded only).
 */
export const RUN_GUARDRAIL_EVENT_ACTIONS = ['ALLOW', 'REDACT', 'BLOCK', 'WARN', 'IGNORE'] as const;
export type RunGuardrailEventAction = (typeof RUN_GUARDRAIL_EVENT_ACTIONS)[number];

/** One check of a screen on the admin trace — verdict, action and timing; never content or judge reasoning. */
export interface RunGuardrailCheck {
  checkId: string;
  verdict: 'pass' | 'flag' | 'undetermined' | 'skipped';
  actionTaken: 'none' | 'ignore' | 'warn' | 'block' | 'unverified';
  category?: string;
  score?: number;
  confidence?: number;
  model?: string;
  latencyMs?: number;
}

export interface GuardrailEventData {
  action: RunGuardrailEventAction;
  detected: number;
  categories?: string[];
  mode?: 'detect' | 'redact';
  latencyMs?: number;
  /** TASK-1050: per-check outcomes. Absent on a producer that predates it. */
  checks?: RunGuardrailCheck[];
}

/** Why a run paused. Only the guardrail hold today. */
export const RUN_PAUSED_REASONS = ['guardrail_hold'] as const;
export type RunPausedReason = (typeof RUN_PAUSED_REASONS)[number];

/** `GuardrailNotice` v1 — the `@arcaai/types` type itself (structurally the contract's `RunGuardrailNotice`). */
export type RunGuardrailNotice = GuardrailNotice;

export interface PromptComposedData {
  layers: Array<{ name: string; chars: number; tokens?: number }>;
  charsTotal: number;
  tokensTotal?: number;
  selected: string[];
  excluded: Array<{ key: string; reason: string }>;
  blocks: Array<{ key: string; chars: number; truncated: boolean }>;
  composedPromptId?: string;
}

export interface ModelRequestData {
  provider: string;
  model: string;
  attempt: number;
  fallback: boolean;
  stream: boolean;
  parameters?: { temperature?: number; maxTokens?: number };
}

export interface RunEventDataMap {
  'run.started': { kind: 'workflow' | 'agent'; slug: string; versionNumber: number; mode?: string };
  'run.completed': {
    status: 'COMPLETED';
    durationMs: number;
    tokens: RunTokens;
    result?: RunResult;
    degraded?: boolean;
    /** TASK-1050: every warn / unverified notice the run raised (a block pauses or fails the run instead). */
    guardrailNotices?: RunGuardrailNotice[];
  };
  'run.failed': { status: 'FAILED' | 'TIMED_OUT'; durationMs: number; error: RunError; tokens?: RunTokens };
  'run.cancelled': { status: 'CANCELED'; durationMs: number; reason?: string };
  'run.resync': { reason: 'gap' | 'expired' | 'cursor_invalid' | 'unavailable'; snapshot: RunSnapshot };
  /** TASK-1050: the run waits durably at `nodeId` for a hold resolution (README §9.8.1). Not terminal. */
  'run.paused': { reason: RunPausedReason; noticeId: string; nodeId: string };
  /** TASK-1050: the standard client message. Envelope `nodeId` is optional (a consultation-level notice has none). */
  'guardrail.notice': RunGuardrailNotice;
  'node.started': { kind: string; label?: string; attempt?: number };
  'node.completed': { status: 'COMPLETED' | 'DEGRADED' | 'SKIPPED'; durationMs: number; tokens?: RunTokens; warnings?: number };
  'node.failed': { durationMs: number; error: RunError; attempt?: number; willRetry?: boolean };
  'output.text.delta': { field: string; text: string };
  'output.audio.delta': { field: string; chunk: string; format: string; sampleRate?: number };
  'output.data': { field: string; value: unknown; visibility?: 'admin' };
  ping: Record<string, never>;
  'input.validated': { valid: boolean; problems: string[]; schema?: { slug: string; versionNumber?: number } };
  'data.bound': { inputs: BoundInput[] };
  'binding.warning': { input: string; code: string; message: string };
  'consultation.read': {
    consultationId: string;
    snapshot: 'node-start' | 'run-start';
    fields: Array<{ path: string; phiClass: PhiClass; value?: unknown }>;
  };
  'transcript.partial': { text: string; utteranceIndex?: number; stableChars?: number };
  'transcript.final': { text: string; utteranceIndex?: number; start?: number; end?: number; speaker?: string; language?: string };
  'prompt.composed': PromptComposedData;
  'model.request': ModelRequestData;
  'guardrail.inbound': GuardrailEventData;
  'guardrail.outbound': GuardrailEventData;
  'output.validated': { valid: boolean; problems: string[]; field?: string };
}

/** The v2 envelope, narrowed by `type`. */
export type RunEvent<T extends RunEventType = RunEventType> = T extends RunEventType
  ? { seq: number; runId: string; type: T; ts: string; nodeId?: string; data: RunEventDataMap[T] }
  : never;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One SSE `data:` line (the WHOLE envelope, protocol-v2.md §1) → a typed event, or `null` for a
 * frame this client cannot read. The envelope is checked; the per-type data shapes are the
 * server's to enforce (it refuses anything outside `RUN_EVENT_DATA_SCHEMAS` before storing it), so
 * the fold below reads them defensively instead of re-validating every property here.
 */
export function parseRunEventFrame(raw: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;
  const { seq, runId, type, ts, nodeId, data } = value;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type)) return null;
  if (typeof ts !== 'string') return null;
  if (nodeId !== undefined && typeof nodeId !== 'string') return null;
  if (!isPlainObject(data)) return null;
  return { seq, runId, type, ts, data, ...(nodeId !== undefined ? { nodeId } : {}) } as RunEvent;
}

export interface RunCursorStep {
  cursor: number;
  deliver: boolean;
  reset: boolean;
}

/** `advanceRunCursor` of the contract (protocol-v2.md §6.3) — the whole client rule. */
export function advanceRunCursor(cursor: number, event: RunEvent): RunCursorStep {
  if (event.type === 'run.resync') return { cursor: event.seq, deliver: true, reset: true };
  if (event.type === 'ping') return { cursor: Math.max(cursor, event.seq), deliver: false, reset: false };
  if (event.seq <= cursor) return { cursor, deliver: false, reset: false };
  return { cursor: event.seq, deliver: true, reset: false };
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** A run's last event: its terminal event, or a resync whose snapshot is already terminal. */
export function isTerminalRunEvent(event: RunEvent): boolean {
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') return true;
  if (event.type === 'run.resync') return TERMINAL_STATUSES.has(String(event.data.snapshot?.status ?? ''));
  return false;
}
