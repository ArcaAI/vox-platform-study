/**
 * Run protocol v2 — ONE event envelope for every run stream, SSE and WS alike (TASK-1038 R6;
 * TASK-1036 OD-23, OD-24, OD-33; design record TASK-1036 README §8.7 and §10.3).
 *
 * Every agent invocation and workflow execution is a RUN with an id. While it runs it emits an
 * ordered stream of events, each carried in the same envelope:
 *
 * ```
 * { seq, runId, type, ts, nodeId?, data }
 * ```
 *
 * The SIX divergent frame shapes that exist today stay readable for one release: a stream
 * request selects this protocol with the header {@link RUN_PROTOCOL_HEADER} `: 2` or, where a
 * header cannot be set (browser `EventSource` / `WebSocket`), the query `?protocol=2`
 * ({@link selectRunProtocol}). The SDKs move to it in 5.0.0 (OD-23).
 *
 * ## Audiences
 *
 * {@link RUN_EVENT_VISIBILITY} splits the catalogue. Business-plane callers (API keys, service
 * accounts, the SDKs) receive the PUBLIC subset only. The console's admin trace (the Studio Test
 * tab) receives everything, including the debug events of §10.3; it never exists on the business
 * plane, and PHI inside it is shown to admins only (viewing is audited by the gateway).
 *
 * ## Ordering and resume
 *
 * - `seq` is per run, starts at 1, and is assigned by ONE sequencer (the append script
 *   {@link RUN_APPEND_LUA}): every STORED event gets the next integer, so the stored stream is
 *   contiguous on the server. It is the SSE `id:` line, so a browser `EventSource` (or the SDK)
 *   reconnects with `Last-Event-ID: <seq>`. A first connect may ask for `?after=<seq>` instead
 *   ({@link parseResumeCursor}: the header wins over the query, and both absent means "from the
 *   beginning", `after = 0`). The server replays every stored event with `seq > after` that the
 *   connection may see, then continues live. WS uses the same envelope as a JSON text frame and
 *   the same `?after=<seq>` on its URL.
 * - **For a client, `seq` is monotonic but NOT contiguous.** The PUBLIC plane is filtered out of
 *   the same stored sequence (admin debug events and admin-only outputs are dropped), so a jump
 *   from 3 to 7 is normal. A client NEVER infers loss from a jump; it keeps the highest `seq` it
 *   has seen as its cursor and drops anything at or below it as a replayed duplicate
 *   ({@link advanceRunCursor}).
 * - **Only the server signals loss**, with `run.resync { reason, snapshot }`
 *   ({@link RUN_RESYNC_REASONS}): `gap` (events the cursor needs were trimmed from the bounded
 *   stream), `expired` (the stream's retention elapsed), `cursor_invalid` (the cursor names a
 *   `seq` the run never stored), `unavailable` (the event transport is down; the snapshot comes
 *   from the read model). The server can detect every one of these exactly because the STORED
 *   stream is contiguous. A client receiving `run.resync` REPLACES its run state with the
 *   snapshot and sets its cursor to `seq`.
 * - Two types are SYNTHETIC — emitted to one connection, never stored, never advancing the
 *   sequencer: `ping` carries this connection's position (the last stored `seq` the server has
 *   delivered OR filtered out for it; 0 before the first event), so a client may move its cursor
 *   up to it; `run.resync` carries `seq === data.snapshot.lastSeq`, and the stream continues at
 *   `lastSeq + 1`.
 * - Retention (OD-25): a run's event stream EXPIRES `workflowRuns.eventRetentionHours` (24 h)
 *   after the run is terminal; its status and result survive in the read model for
 *   `workflowRuns.resultRetentionDays`. A cursor that points before the oldest retained event, or
 *   at an expired stream, is answered with `run.resync`: a snapshot of the run (status, per-node
 *   status, the outputs per node and field, and the result when terminal), after which the stream
 *   continues live from `lastSeq + 1`. A client that receives a terminal snapshot without an
 *   inline result reads `GET …/runs/:runId/result`.
 *
 * ## Deltas and results
 *
 * - Every delta names its node AND its output field (OD-33): `output.text.delta { field, text }`,
 *   `output.audio.delta { field, chunk, format }`, `output.data { field, value }`, each with
 *   `nodeId` on the envelope. On the PUBLIC plane (OD-24) outputs come only from nodes wired into
 *   the End node, plus any node flagged `stream`: text as deltas, other values as `output.data`.
 * - The ADMIN trace needs every node's outputs (the Test tab). At each node's completion the
 *   producer emits `output.data { field, value, visibility: 'admin' }` for every declared output
 *   of that node that has not already gone out as a public `output.data` — so a streamed text
 *   field also arrives once as its final value. Visibility is therefore EVENT-level, not only
 *   type-level: filter with {@link runEventAudience} / {@link toPublicRunEvent}, never with the
 *   type alone. `run.resync.snapshot.outputs` is keyed by `nodeId`, then `field`; the public
 *   plane's snapshot carries only public outputs.
 * - `run.completed.data.result` is either `{ kind: 'inline', value }` (the result serialises to at
 *   most {@link RUN_RESULT_INLINE_MAX_BYTES}) or `{ kind: 'ref', bucket, key, sizeBytes, sha256 }`
 *   (larger; the gateway serves it through a short-lived signed URL). Absent when the run produced
 *   no result. Lanes A1 (producer) and A2 (consumer) implement exactly these two shapes.
 *
 * ## Errors
 *
 * `run.failed.error` and `node.failed.error` carry a fixed SCREAMING_SNAKE `code` and the fixed
 * label of that code as `message` ({@link runErrorMessage}) — never interpolated text, which could
 * echo a patient value to a business caller. Free text is `error.detail`, on the stored event and
 * the admin trace only; {@link toPublicRunEvent} strips it.
 *
 * ## Validation
 *
 * Hand-written, dependency-free, like the rest of this package (`envelope.ts` explains why). The
 * per-type data shapes are DECLARED once in {@link RUN_EVENT_DATA_SCHEMAS} (a JSON-Schema subset:
 * `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minimum`,
 * `minLength`, `maxLength`, `pattern`, `anyOf`) and interpreted here; the Python mirror reads the
 * same declarations' fixture (`tests/contracts/run-protocol.fixture.json`).
 */

/** The protocol this module defines. A future version is a NEW constant, never a mutation of this one. */
export const RUN_PROTOCOL_VERSION = 2;

/** Request header selecting the protocol (`x-hope-run-protocol: 2`); absent ⇒ the legacy shapes for one release (OD-23). */
export const RUN_PROTOCOL_HEADER = 'x-hope-run-protocol';

/**
 * Query parameter selecting the protocol (`?protocol=2`). A browser `EventSource` cannot set a
 * header, and neither can a browser `WebSocket`, so both stream routes accept this too
 * ({@link selectRunProtocol}).
 */
export const RUN_PROTOCOL_QUERY_PARAM = 'protocol';

/**
 * Which frame shapes a stream request selected: the {@link RUN_PROTOCOL_HEADER} when present
 * (non-empty), else the {@link RUN_PROTOCOL_QUERY_PARAM}, else `legacy` (one release, OD-23). Any
 * value other than `"2"` is refused (the route answers 400) — never silently downgraded to the
 * legacy shapes, which a v2 client cannot parse.
 */
export function selectRunProtocol(input: {
  readonly header?: string | null;
  readonly query?: string | null;
}): { readonly version: typeof RUN_PROTOCOL_VERSION | 'legacy' } | { readonly problems: readonly string[] } {
  const raw = [input.header, input.query].find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (raw === undefined || raw === null) return { version: 'legacy' };
  if (raw === String(RUN_PROTOCOL_VERSION)) return { version: RUN_PROTOCOL_VERSION };
  return { problems: [`unsupported run protocol ${JSON.stringify(raw)} (supported: ${RUN_PROTOCOL_VERSION})`] };
}

/** A result whose JSON is at most this many bytes rides inline on `run.completed`; larger is a `ref` (D-I). */
export const RUN_RESULT_INLINE_MAX_BYTES = 64 * 1024;

// =============================================================================================
// Catalogue
// =============================================================================================

/** Events every caller may receive (§8.7). */
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
] as const);

/** The admin trace's debug events (§10.3) — console only, never the business plane. */
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

export const RUN_EVENT_TYPES: readonly RunEventType[] = Object.freeze([...PUBLIC_RUN_EVENT_TYPES, ...ADMIN_RUN_EVENT_TYPES]);

export type RunEventVisibility = 'public' | 'admin';

export const RUN_EVENT_VISIBILITY: Readonly<Record<RunEventType, RunEventVisibility>> = Object.freeze(
  Object.fromEntries([
    ...PUBLIC_RUN_EVENT_TYPES.map((type) => [type, 'public'] as const),
    ...ADMIN_RUN_EVENT_TYPES.map((type) => [type, 'admin'] as const),
  ]) as Record<RunEventType, RunEventVisibility>,
);

/**
 * Whether the envelope MUST carry `nodeId` (`required`), MAY (`optional`) or must NOT
 * (`forbidden`). Run-level events and `ping` belong to no node; `input.validated` validates the
 * RUN's input. Everything a step does — including every delta (OD-33) and every debug event of
 * §10.3 — names its node. Two conventions keep that rule honest where there is no graph node:
 *
 * - an AGENT run (`POST /agents/:slug/runs`) has exactly one step, whose `nodeId` is
 *   {@link AGENT_RUN_NODE_ID} (`runEventProblems(…, { runKind: 'agent' })` enforces it);
 * - `transcript.partial|final` is `optional`: a graph's ASR node names itself, but a transcript
 *   sourced by the consultation SESSION (the gateway's STT bridge, no ASR node in the graph)
 *   carries no `nodeId`.
 */
export const RUN_EVENT_NODE_SCOPE: Readonly<Record<RunEventType, RunEventNodeScope>> = Object.freeze(
  Object.fromEntries(
    RUN_EVENT_TYPES.map((type) => [
      type,
      type.startsWith('run.') || type === 'ping' || type === 'input.validated'
        ? 'forbidden'
        : type.startsWith('transcript.')
          ? 'optional'
          : 'required',
    ]),
  ) as Record<RunEventType, RunEventNodeScope>,
);

export type RunEventNodeScope = 'required' | 'optional' | 'forbidden';

/** The `nodeId` of the single step of an agent run (`POST /agents/:slug/runs`). */
export const AGENT_RUN_NODE_ID = 'agent';

/** What a validator knows about the run beyond the event itself. */
export interface RunEventValidationOptions {
  /** `agent`: every `nodeId` present must be {@link AGENT_RUN_NODE_ID}. Unknown ⇒ no run-kind rule. */
  readonly runKind?: 'agent' | 'workflow';
  /**
   * `public`: what a business-plane client may receive — no admin-audience event, no error
   * `detail`. `admin` (or absent): the stored / admin-trace form.
   */
  readonly plane?: 'public' | 'admin';
}

/** Emitted to one connection, never stored, never advancing `seq` (see the module doc). */
export const SYNTHETIC_RUN_EVENT_TYPES: readonly RunEventType[] = Object.freeze(['ping', 'run.resync'] as RunEventType[]);

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === 'string' && (RUN_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * TYPE-level: `true` for the types that MAY reach the public plane; `false` for admin-debug types
 * and anything unknown. A public type can still carry an admin-only instance (`output.data` with
 * `visibility: 'admin'`), so a stream filter uses {@link runEventAudience} / {@link toPublicRunEvent}.
 */
export function isPublicRunEvent(type: string): boolean {
  return isRunEventType(type) && RUN_EVENT_VISIBILITY[type] === 'public';
}

// =============================================================================================
// Data shapes (TS) — one per type
// =============================================================================================

export interface RunTokens {
  readonly in: number;
  readonly out: number;
}

/**
 * A run or step failure (fix 7). `code` is a fixed SCREAMING_SNAKE identifier and `message` is the
 * fixed label {@link runErrorMessage} gives that code — so nothing a producer interpolates (a model
 * error, a patient value) can reach a business caller. Free text lives only in `detail`, which the
 * public plane never carries ({@link toPublicRunEvent} strips it).
 */
export interface RunError {
  readonly code: string;
  /** Always `runErrorMessage(code)`. */
  readonly message: string;
  /** The node the failure is attributed to, when it is a step's failure. */
  readonly nodeId?: string;
  /** ADMIN TRACE ONLY: free-text diagnosis (may echo values; PHI shown to admins only, audited). */
  readonly detail?: string;
}

/**
 * The fixed labels. A producer may use a code that is not listed (it must still be SCREAMING_SNAKE);
 * its label is then {@link RUN_ERROR_FALLBACK_MESSAGE}. Adding a code here is a contract change
 * (fixture + Python mirror), never a per-call string.
 */
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

/** The one message a `RunError` with this code may carry. */
export function runErrorMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(RUN_ERROR_MESSAGES, code) ? (RUN_ERROR_MESSAGES[code] as string) : RUN_ERROR_FALLBACK_MESSAGE;
}

/** `run.completed.data.result` — EXACTLY these two shapes (lanes A1/A2). */
export type RunResult =
  | { readonly kind: 'inline'; readonly value: unknown }
  | {
      readonly kind: 'ref';
      readonly bucket: string;
      readonly key: string;
      readonly sizeBytes: number;
      readonly sha256: string;
      /** TASK-1038 E3: the object key lives under `<tenantId>/`; the gateway asserts it before signing. */
      readonly tenantPrefixed?: boolean;
    };

/** The persisted run status vocabulary (`GoverningRunSummary.status`). */
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

/**
 * Why the SERVER sent `run.resync` — the only loss signal a client ever acts on (see the module
 * doc). A client never derives one of these itself.
 */
export const RUN_RESYNC_REASONS = Object.freeze(['gap', 'expired', 'cursor_invalid', 'unavailable'] as const);
export type RunResyncReason = (typeof RUN_RESYNC_REASONS)[number];

export type RunNodeStatus = 'waiting' | 'running' | 'completed' | 'degraded' | 'failed' | 'skipped';

export interface RunSnapshot {
  readonly status: RunStatus;
  /** The last stored `seq` the snapshot reflects; the stream continues at `lastSeq + 1`. */
  readonly lastSeq: number;
  readonly nodes: Readonly<Record<string, { readonly status: RunNodeStatus; readonly durationMs?: number }>>;
  /**
   * Outputs so far, keyed by `nodeId`, then `field`: text accumulated from deltas, or the latest
   * `output.data` value. Two nodes may declare the same field name; they never collide. The public
   * plane's snapshot holds only the outputs that plane may see.
   */
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly result?: RunResult;
}

export type PhiClass = 'PHI' | 'NON_PHI';

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
    /** A COMPLETED run with at least one degraded node (the persisted vocabulary's flag). */
    readonly degraded?: boolean;
  };
  'run.failed': { readonly status: 'FAILED' | 'TIMED_OUT'; readonly durationMs: number; readonly error: RunError; readonly tokens?: RunTokens };
  /** `CANCELED` is the persisted status spelling; the event type keeps OD-23's `run.cancelled`. */
  'run.cancelled': { readonly status: 'CANCELED'; readonly durationMs: number; readonly reason?: string };
  'run.resync': { readonly reason: RunResyncReason; readonly snapshot: RunSnapshot };
  'node.started': { readonly kind: string; readonly label?: string; readonly attempt?: number };
  'node.completed': {
    readonly status: 'COMPLETED' | 'DEGRADED' | 'SKIPPED';
    readonly durationMs: number;
    readonly tokens?: RunTokens;
    readonly warnings?: number;
  };
  'node.failed': { readonly durationMs: number; readonly error: RunError; readonly attempt?: number; readonly willRetry?: boolean };
  'output.text.delta': { readonly field: string; readonly text: string };
  /** `chunk` is base64; `format` the TTS output formats. */
  'output.audio.delta': {
    readonly field: string;
    readonly chunk: string;
    readonly format: 'wav' | 'mp3' | 'ogg' | 'pcm';
    readonly sampleRate?: number;
  };
  'output.data': {
    readonly field: string;
    readonly value: unknown;
    /** `admin`: a trace-only output (fix 5) — the public plane never sees it. Absent ⇒ public. */
    readonly visibility?: 'admin';
  };
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
      /** An optional input that rendered `""` (OD-10). */
      readonly empty?: boolean;
      readonly phiClass?: PhiClass;
    }>;
  };
  'binding.warning': { readonly input: string; readonly code: string; readonly message: string };
  'consultation.read': {
    readonly consultationId: string;
    /** When the declared reads were snapshotted (OD-30). */
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
  /**
   * Layers and their SIZES only — the composed content is read through the Prompt Inspector
   * (`composedPromptId`). Characters are always counted; tokens only where the producer has a
   * tokenizer for the model (the harness has none), so `tokens` / `tokensTotal` are optional and a
   * consumer never estimates them from `chars`.
   */
  'prompt.composed': {
    readonly layers: ReadonlyArray<{
      readonly name: 'platformRules' | 'instruction' | 'outputLanguage' | 'outputContract' | 'data';
      readonly chars: number;
      readonly tokens?: number;
    }>;
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

/** Inbound screens only the EXTERNAL_DATA blocks; outbound screens the response (TASK-1036 OD-1). */
export interface GuardrailEventData {
  readonly action: 'ALLOW' | 'REDACT' | 'BLOCK';
  /** Findings detected (a detect-only local screen reports them with `ALLOW`). */
  readonly detected: number;
  readonly categories?: readonly string[];
  readonly mode?: 'detect' | 'redact';
  readonly latencyMs?: number;
}

/** The v2 envelope. Narrow on `type` to get the typed `data`. */
export type RunEventV2<T extends RunEventType = RunEventType> = T extends RunEventType
  ? {
      readonly seq: number;
      readonly runId: string;
      readonly type: T;
      /** ISO-8601 UTC, when the event happened (not when it was delivered). */
      readonly ts: string;
      /** Present when {@link RUN_EVENT_NODE_SCOPE} says `required`, absent when `forbidden`, either when `optional`. */
      readonly nodeId?: string;
      readonly data: RunEventDataMap[T];
    }
  : never;

// =============================================================================================
// Data shapes (declarative) — one schema per type
// =============================================================================================

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** The JSON-Schema subset this module interprets. */
export interface RunEventDataSchema {
  readonly type?: JsonType;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, RunEventDataSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false | RunEventDataSchema;
  readonly items?: RunEventDataSchema;
  readonly minimum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly anyOf?: readonly RunEventDataSchema[];
}

const ANY: RunEventDataSchema = Object.freeze({});
const STR: RunEventDataSchema = Object.freeze({ type: 'string' });
const STR1: RunEventDataSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 255 });
const INT0: RunEventDataSchema = Object.freeze({ type: 'integer', minimum: 0 });
const INT1: RunEventDataSchema = Object.freeze({ type: 'integer', minimum: 1 });
const NUM0: RunEventDataSchema = Object.freeze({ type: 'number', minimum: 0 });
const BOOL: RunEventDataSchema = Object.freeze({ type: 'boolean' });
const FIELD: RunEventDataSchema = Object.freeze({ type: 'string', minLength: 1, maxLength: 128 });
const PHI: RunEventDataSchema = Object.freeze({ type: 'string', enum: Object.freeze(['PHI', 'NON_PHI']) });
const STRINGS: RunEventDataSchema = Object.freeze({ type: 'array', items: STR });

function closed(properties: Record<string, RunEventDataSchema>, required: readonly string[] = []): RunEventDataSchema {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze(properties),
    required: Object.freeze([...required]),
  });
}

const TOKENS = closed({ in: INT0, out: INT0 }, ['in', 'out']);
const ERROR = closed(
  {
    code: Object.freeze({ type: 'string', pattern: '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$', maxLength: 64 }),
    message: STR,
    nodeId: STR1,
    detail: Object.freeze({ type: 'string', maxLength: 4000 }),
  },
  ['code', 'message'],
);
const SHA256: RunEventDataSchema = Object.freeze({ type: 'string', pattern: '^[0-9a-f]{64}$' });
const RESULT: RunEventDataSchema = Object.freeze({
  anyOf: Object.freeze([
    closed({ kind: Object.freeze({ const: 'inline' }), value: ANY }, ['kind', 'value']),
    closed(
      { kind: Object.freeze({ const: 'ref' }), bucket: STR1, key: Object.freeze({ type: 'string', minLength: 1 }), sizeBytes: INT0, sha256: SHA256, tenantPrefixed: Object.freeze({ type: 'boolean' }) },
      ['kind', 'bucket', 'key', 'sizeBytes', 'sha256'],
    ),
  ]),
});
const GUARDRAIL = closed(
  {
    action: Object.freeze({ type: 'string', enum: Object.freeze(['ALLOW', 'REDACT', 'BLOCK']) }),
    detected: INT0,
    categories: STRINGS,
    mode: Object.freeze({ type: 'string', enum: Object.freeze(['detect', 'redact']) }),
    latencyMs: NUM0,
  },
  ['action', 'detected'],
);
const BASE64 = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';

export const RUN_EVENT_DATA_SCHEMAS: Readonly<Record<RunEventType, RunEventDataSchema>> = Object.freeze({
  'run.started': closed(
    {
      kind: Object.freeze({ type: 'string', enum: Object.freeze(['workflow', 'agent']) }),
      slug: STR1,
      versionNumber: INT1,
      mode: Object.freeze({ type: 'string', enum: Object.freeze(['blocking', 'async', 'stream']) }),
    },
    ['kind', 'slug', 'versionNumber'],
  ),
  'run.completed': closed({ status: Object.freeze({ const: 'COMPLETED' }), durationMs: INT0, tokens: TOKENS, result: RESULT, degraded: BOOL }, [
    'status',
    'durationMs',
    'tokens',
  ]),
  'run.failed': closed(
    { status: Object.freeze({ type: 'string', enum: Object.freeze(['FAILED', 'TIMED_OUT']) }), durationMs: INT0, error: ERROR, tokens: TOKENS },
    ['status', 'durationMs', 'error'],
  ),
  'run.cancelled': closed({ status: Object.freeze({ const: 'CANCELED' }), durationMs: INT0, reason: STR }, ['status', 'durationMs']),
  'run.resync': closed(
    {
      reason: Object.freeze({ type: 'string', enum: RUN_RESYNC_REASONS }),
      snapshot: closed(
        {
          status: Object.freeze({ type: 'string', enum: Object.freeze(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']) }),
          lastSeq: INT0,
          nodes: Object.freeze({
            type: 'object',
            additionalProperties: closed(
              {
                status: Object.freeze({ type: 'string', enum: Object.freeze(['waiting', 'running', 'completed', 'degraded', 'failed', 'skipped']) }),
                durationMs: INT0,
              },
              ['status'],
            ),
          }),
          outputs: Object.freeze({ type: 'object', additionalProperties: Object.freeze({ type: 'object', additionalProperties: ANY }) }),
          result: RESULT,
        },
        ['status', 'lastSeq', 'nodes', 'outputs'],
      ),
    },
    ['reason', 'snapshot'],
  ),
  'node.started': closed({ kind: STR1, label: STR, attempt: INT1 }, ['kind']),
  'node.completed': closed(
    {
      status: Object.freeze({ type: 'string', enum: Object.freeze(['COMPLETED', 'DEGRADED', 'SKIPPED']) }),
      durationMs: INT0,
      tokens: TOKENS,
      warnings: INT0,
    },
    ['status', 'durationMs'],
  ),
  'node.failed': closed({ durationMs: INT0, error: ERROR, attempt: INT1, willRetry: BOOL }, ['durationMs', 'error']),
  'output.text.delta': closed({ field: FIELD, text: STR }, ['field', 'text']),
  'output.audio.delta': closed(
    {
      field: FIELD,
      chunk: Object.freeze({ type: 'string', minLength: 1, pattern: BASE64 }),
      format: Object.freeze({ type: 'string', enum: Object.freeze(['wav', 'mp3', 'ogg', 'pcm']) }),
      sampleRate: INT1,
    },
    ['field', 'chunk', 'format'],
  ),
  'output.data': closed({ field: FIELD, value: ANY, visibility: Object.freeze({ const: 'admin' }) }, ['field', 'value']),
  ping: closed({}),
  'input.validated': closed({ valid: BOOL, problems: STRINGS, schema: closed({ slug: STR1, versionNumber: INT1 }, ['slug']) }, ['valid', 'problems']),
  'data.bound': closed(
    {
      inputs: Object.freeze({
        type: 'array',
        items: closed(
          {
            input: FIELD,
            source: closed(
              { kind: Object.freeze({ type: 'string', enum: Object.freeze(['from', 'value', 'template']) }), path: STR1, template: STR },
              ['kind'],
            ),
            value: ANY,
            empty: BOOL,
            phiClass: PHI,
          },
          ['input', 'source'],
        ),
      }),
    },
    ['inputs'],
  ),
  'binding.warning': closed({ input: FIELD, code: STR1, message: STR }, ['input', 'code', 'message']),
  'consultation.read': closed(
    {
      consultationId: STR1,
      snapshot: Object.freeze({ type: 'string', enum: Object.freeze(['node-start', 'run-start']) }),
      fields: Object.freeze({ type: 'array', items: closed({ path: STR1, phiClass: PHI, value: ANY }, ['path', 'phiClass']) }),
    },
    ['consultationId', 'snapshot', 'fields'],
  ),
  'transcript.partial': closed({ text: STR, utteranceIndex: INT0, stableChars: INT0 }, ['text']),
  'transcript.final': closed({ text: STR, utteranceIndex: INT0, start: NUM0, end: NUM0, speaker: STR, language: STR }, ['text']),
  'prompt.composed': closed(
    {
      layers: Object.freeze({
        type: 'array',
        items: closed(
          {
            name: Object.freeze({
              type: 'string',
              enum: Object.freeze(['platformRules', 'instruction', 'outputLanguage', 'outputContract', 'data']),
            }),
            chars: INT0,
            tokens: INT0,
          },
          ['name', 'chars'],
        ),
      }),
      charsTotal: INT0,
      tokensTotal: INT0,
      selected: STRINGS,
      excluded: Object.freeze({
        type: 'array',
        items: closed({ key: STR1, reason: Object.freeze({ type: 'string', enum: Object.freeze(['condition_false', 'condition_error']) }) }, [
          'key',
          'reason',
        ]),
      }),
      blocks: Object.freeze({ type: 'array', items: closed({ key: STR1, chars: INT0, truncated: BOOL }, ['key', 'chars', 'truncated']) }),
      composedPromptId: STR1,
    },
    ['layers', 'charsTotal', 'selected', 'excluded', 'blocks'],
  ),
  'model.request': closed(
    {
      provider: STR1,
      model: STR1,
      attempt: INT1,
      fallback: BOOL,
      stream: BOOL,
      parameters: closed({ temperature: NUM0, maxTokens: INT1 }),
    },
    ['provider', 'model', 'attempt', 'fallback', 'stream'],
  ),
  'guardrail.inbound': GUARDRAIL,
  'guardrail.outbound': GUARDRAIL,
  'output.validated': closed({ valid: BOOL, problems: STRINGS, field: FIELD }, ['valid', 'problems']),
});

// =============================================================================================
// Validation
// =============================================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

/** Interpret the subset over `value`; problems are prefixed with the dotted `path`. */
function schemaProblems(schema: RunEventDataSchema, value: unknown, path: string): string[] {
  if (schema.anyOf !== undefined) return anyOfProblems(schema.anyOf, value, path);
  const problems: string[] = [];
  if ('const' in schema && schema.const !== value) problems.push(`${path} must be ${JSON.stringify(schema.const)}`);
  if (schema.type !== undefined && !matchesType(schema.type, value))
    return [...problems, `${path} must be a${/^[aeiou]/.test(schema.type) ? 'n' : ''} ${schema.type}`];
  if (schema.enum !== undefined && !schema.enum.includes(value)) problems.push(`${path} must be one of ${schema.enum.join(' | ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} must be at least ${schema.minLength} character(s)`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) problems.push(`${path} does not match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} must be ≥ ${schema.minimum}`);
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    value.forEach((entry, index) => problems.push(...schemaProblems(items, entry, `${path}[${index}]`)));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) problems.push(`${path}.${key} is required`);
    }
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (property !== undefined) problems.push(...schemaProblems(property, entry, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}: unexpected property '${key}'`);
      else if (isPlainObject(schema.additionalProperties)) problems.push(...schemaProblems(schema.additionalProperties, entry, `${path}.${key}`));
    }
  }
  return problems;
}

/**
 * `anyOf` whose branches are discriminated by a `kind` const (the result union) reports the
 * MATCHING branch's problems, so a caller reads "sha256 is required" rather than "matches no
 * branch". Without a discriminating `kind`, it reports that no branch matched.
 */
function anyOfProblems(branches: readonly RunEventDataSchema[], value: unknown, path: string): string[] {
  const kinds: unknown[] = branches.map((branch) => branch.properties?.kind?.const);
  if (kinds.every((kind) => kind !== undefined) && isPlainObject(value)) {
    const index = kinds.findIndex((kind) => kind === value.kind);
    if (index < 0) return [`${path}.kind must be one of ${kinds.join(' | ')}`];
    return schemaProblems(branches[index] as RunEventDataSchema, value, path);
  }
  if (branches.some((branch) => schemaProblems(branch, value, path).length === 0)) return [];
  return [`${path} matches none of its allowed shapes`];
}

const ENVELOPE_KEYS: readonly string[] = ['seq', 'runId', 'type', 'ts', 'nodeId', 'data'];
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Every problem with a candidate run event. Empty array = conforms. Never throws — the package's
 * house idiom (`asyncEnvelopeProblems`).
 */
export function runEventProblems(value: unknown, options: RunEventValidationOptions = {}): string[] {
  if (!isPlainObject(value)) return ['run event must be a JSON object'];
  const problems: string[] = [];

  for (const key of Object.keys(value)) {
    if (!ENVELOPE_KEYS.includes(key)) problems.push(`unexpected property '${key}'`);
  }

  const type = value.type;
  const known = isRunEventType(type);
  if (!known) problems.push(`type must be one of the run protocol v2 event types (received ${JSON.stringify(type)})`);
  const synthetic = known && SYNTHETIC_RUN_EVENT_TYPES.includes(type);

  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) {
    problems.push('seq must be a non-negative integer');
  } else if (known && !synthetic && value.seq < 1) {
    problems.push('seq must be ≥ 1 on a stored event (only ping and run.resync may carry 0)');
  }
  if (typeof value.runId !== 'string' || value.runId.length === 0 || value.runId.length > 255) {
    problems.push('runId must be a non-empty string of at most 255 characters');
  }
  if (typeof value.ts !== 'string' || !DATE_TIME_PATTERN.test(value.ts) || Number.isNaN(Date.parse(value.ts))) {
    problems.push('ts must be an ISO-8601 date-time string');
  }

  const hasNodeId = Object.prototype.hasOwnProperty.call(value, 'nodeId');
  if (hasNodeId && (typeof value.nodeId !== 'string' || value.nodeId.length === 0 || value.nodeId.length > 255)) {
    problems.push('nodeId must be a non-empty string of at most 255 characters');
  }
  if (known) {
    const scope = RUN_EVENT_NODE_SCOPE[type];
    if (scope === 'required' && !hasNodeId) problems.push(`nodeId is required on ${type}`);
    if (scope === 'forbidden' && hasNodeId) problems.push(`nodeId must be absent on ${type} (a run-level event)`);
    if (options.runKind === 'agent' && hasNodeId && value.nodeId !== AGENT_RUN_NODE_ID) {
      problems.push(`nodeId must be '${AGENT_RUN_NODE_ID}' on every step event of an agent run (received ${JSON.stringify(value.nodeId)})`);
    }
  }

  if (!isPlainObject(value.data)) {
    problems.push('data must be a JSON object');
  } else if (known) {
    problems.push(...schemaProblems(RUN_EVENT_DATA_SCHEMAS[type], value.data, 'data'));
    if (type === 'run.resync' && isPlainObject(value.data.snapshot) && value.data.snapshot.lastSeq !== value.seq) {
      problems.push('run.resync seq must equal data.snapshot.lastSeq (the stream continues at lastSeq + 1)');
    }
    const error = value.data.error;
    if ((type === 'run.failed' || type === 'node.failed') && isPlainObject(error) && typeof error.code === 'string') {
      const label = runErrorMessage(error.code);
      if (error.message !== label)
        problems.push(`data.error.message must be the fixed label of ${error.code} (${JSON.stringify(label)}); free text belongs in detail`);
      if (options.plane === 'public' && Object.prototype.hasOwnProperty.call(error, 'detail')) {
        problems.push('data.error.detail is admin-trace only and never reaches the public plane');
      }
    }
    if (options.plane === 'public' && runEventAudience({ type, data: value.data } as Pick<RunEventV2, 'type' | 'data'>) !== 'public') {
      problems.push(`${type} with this audience is admin-trace only and never reaches the public plane`);
    }
  }
  return problems;
}

/** Refuse-if-unknown parse: the event itself, or `null` for ANY problem (the caller must not proceed on `null`). */
export function parseRunEvent(value: unknown, options: RunEventValidationOptions = {}): RunEventV2 | null {
  return runEventProblems(value, options).length === 0 ? (value as RunEventV2) : null;
}

/** Thrown by {@link toSseFrame} for an event that does not conform — a producer never emits one. */
export class RunProtocolError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Not a run protocol v2 event: ${problems.join('; ')}`);
    this.name = 'RunProtocolError';
    this.problems = problems;
  }
}

/** The envelope with its keys in envelope order, so the bytes do not depend on how it was built. */
function ordered(event: RunEventV2): Record<string, unknown> {
  const out: Record<string, unknown> = { seq: event.seq, runId: event.runId, type: event.type, ts: event.ts };
  if (event.nodeId !== undefined) out.nodeId = event.nodeId;
  out.data = event.data;
  return out;
}

// =============================================================================================
// SSE
// =============================================================================================

/**
 * One SSE frame: `event: <type>`, `id: <seq>`, `data: <compact JSON of the WHOLE envelope>`, then
 * a blank line. The `data` line carries the full envelope (not just `data`) so SSE and WS deliver
 * the identical object. `JSON.stringify` never emits a raw newline, so the frame always has one
 * `data:` line. Throws {@link RunProtocolError} for a non-conforming event.
 */
export function toSseFrame(event: RunEventV2): string {
  const problems = runEventProblems(event);
  if (problems.length > 0) throw new RunProtocolError(problems);
  return `event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(ordered(event))}\n\n`;
}

export type ParsedSseFrame =
  | { readonly kind: 'event'; readonly event: RunEventV2 }
  | { readonly kind: 'comment' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

/**
 * Parse ONE SSE frame (the text between two blank lines). Lines starting with `:` are comments;
 * a frame with no `data:` line is a keep-alive (`comment`). Multiple `data:` lines are joined with
 * `\n` (the SSE rule). The `event:` and `id:` lines, when present, must agree with the envelope's
 * `type` and `seq` — a disagreement is `invalid`, never silently resolved either way.
 */
export function parseSseFrame(frame: string): ParsedSseFrame {
  const fields: Record<string, string[]> = {};
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let fieldValue = colon < 0 ? '' : line.slice(colon + 1);
    if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1);
    (fields[name] ??= []).push(fieldValue);
  }
  if (fields.data === undefined) return { kind: 'comment' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fields.data.join('\n'));
  } catch {
    return { kind: 'invalid', problems: ['data line is not JSON'] };
  }
  const problems = runEventProblems(parsed);
  if (problems.length > 0) return { kind: 'invalid', problems };
  const event = parsed as RunEventV2;
  const eventLine = fields.event?.[fields.event.length - 1];
  const idLine = fields.id?.[fields.id.length - 1];
  const mismatches: string[] = [];
  if (eventLine !== undefined && eventLine !== event.type) mismatches.push(`event line \`${eventLine}\` disagrees with type \`${event.type}\``);
  if (idLine !== undefined && idLine !== String(event.seq)) mismatches.push(`id line \`${idLine}\` disagrees with seq ${event.seq}`);
  return mismatches.length > 0 ? { kind: 'invalid', problems: mismatches } : { kind: 'event', event };
}

// =============================================================================================
// The ONE sequencer — the stored shape (F2 fix 2)
// =============================================================================================

/**
 * Every run's events live under three keys that share the `wf:run:<runId>:` prefix. The events key
 * is the literal the gateway (`runEventStreamKey`) and the harness (`run_event_stream_key`) already
 * use. Not Redis-Cluster-safe as spelled (no `{hash tag}`): HOPE runs one Redis; a cluster move is a
 * new protocol version, never a silent respelling.
 */
export const RUN_STREAM_KEY_PREFIX = 'wf:run:';
/** `INCR` counter — the last `seq` assigned. Never written except by {@link RUN_APPEND_LUA}. */
export const RUN_SEQ_KEY = (runId: string): string => `${RUN_STREAM_KEY_PREFIX}${runId}:seq`;
/** The Redis Stream of stored events. Never `XADD`ed except by {@link RUN_APPEND_LUA}. */
export const RUN_EVENTS_KEY = (runId: string): string => `${RUN_STREAM_KEY_PREFIX}${runId}:events`;
/** Hash `dedupeKey → "<seq> <streamId>"`: a retried append returns the first append's position. */
export const RUN_DEDUPE_KEY = (runId: string): string => `${RUN_STREAM_KEY_PREFIX}${runId}:dedupe`;

/** `XADD … MAXLEN ~` bound — the harness' existing `RUN_EVENT_STREAM_MAX_LEN`. Trimming past a cursor is a `gap` resync. */
export const RUN_STREAM_MAX_LEN = 10_000;

/** The stored entry's field order. `nodeId` is present only when the event has one. */
export const RUN_STREAM_FIELDS = Object.freeze(['seq', 'type', 'ts', 'nodeId', 'vis', 'body'] as const);

/** The error reply of an append to a stream whose terminal clock is already running. */
export const RUN_STREAM_CLOSED_ERROR = 'RUN_STREAM_CLOSED';

/** The events that end a run: the append that stores one starts the retention clock on every key. */
export const TERMINAL_RUN_EVENT_TYPES = Object.freeze(['run.completed', 'run.failed', 'run.cancelled'] as const);

/**
 * The append script. EVERY producer — the harness for graph events, the gateway for the events it
 * originates (consultation transcripts, run-level events of gateway-owned runs) — appends through
 * this script and nothing else, so one run has one sequence however many processes write to it.
 *
 * `KEYS`: {@link RUN_SEQ_KEY}, {@link RUN_EVENTS_KEY}, {@link RUN_DEDUPE_KEY}.
 * `ARGV[1]` the `MAXLEN ~` bound; `ARGV[2]` retention seconds (`'0'` unless the event is
 * terminal); `ARGV[3]` dedupe key (`''` for none); `ARGV[4..]` the field/value pairs AFTER `seq`,
 * in {@link RUN_STREAM_FIELDS} order. Returns `{ seq, streamId, duplicate }`.
 *
 * 1. A dedupe hit returns the first append's position and writes nothing (an activity retry).
 * 2. A stream whose events key already has an expiry is CLOSED (the run is terminal, or the
 *    gateway's terminal backstop ran): the append is refused with {@link RUN_STREAM_CLOSED_ERROR}.
 * 3. `INCR` then `XADD … MAXLEN ~ n * seq <n> …` — atomic, so stored seqs are contiguous.
 * 4. A terminal append (`ARGV[2] > 0`) sets the SAME expiry on all three keys, so they vanish
 *    together and a counter can never outlive its stream (or the reverse) and re-issue a `seq`.
 *
 * The harness loads these exact bytes from `tests/contracts/run-protocol.fixture.json`.
 */
export const RUN_APPEND_LUA = [
  '-- HOPE run protocol v2: the ONE run-event sequencer (TASK-1038).',
  '-- KEYS: [1] wf:run:<runId>:seq  [2] wf:run:<runId>:events  [3] wf:run:<runId>:dedupe',
  "-- ARGV: [1] maxLen  [2] retention seconds ('0' = not terminal)  [3] dedupe key ('' = none)",
  '--       [4..] field/value pairs after seq: type, ts, [nodeId], vis, body',
  'local dedupe = ARGV[3]',
  "if dedupe ~= '' then",
  "  local prior = redis.call('HGET', KEYS[3], dedupe)",
  '  if prior then',
  "    local s, id = string.match(prior, '^(%d+) (.+)$')",
  '    return {tonumber(s), id, 1}',
  '  end',
  'end',
  "if redis.call('PTTL', KEYS[2]) >= 0 then",
  "  return redis.error_reply('RUN_STREAM_CLOSED')",
  'end',
  "local seq = redis.call('INCR', KEYS[1])",
  "local xadd = {'XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], '*', 'seq', tostring(seq)}",
  'for i = 4, #ARGV do xadd[#xadd + 1] = ARGV[i] end',
  'local id = redis.call(unpack(xadd))',
  "if dedupe ~= '' then redis.call('HSET', KEYS[3], dedupe, seq .. ' ' .. id) end",
  'local ttl = tonumber(ARGV[2])',
  'if ttl > 0 then',
  "  for i = 1, 3 do redis.call('EXPIRE', KEYS[i], ttl) end",
  'end',
  'return {seq, id, 0}',
  '',
].join('\n');

/** What a producer hands {@link buildRunAppend}: one event WITHOUT its `seq` (the script assigns it). */
export interface RunAppendInput {
  readonly runId: string;
  readonly type: RunEventType;
  readonly ts: string;
  readonly nodeId?: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** A key derived from intent (run, node, attempt, …) — never a clock or a UUID. A retry with the same key appends nothing. */
  readonly dedupeKey?: string;
  /**
   * REQUIRED on a terminal event, refused on every other: `workflowRuns.eventRetentionHours × 3600`,
   * resolved by the gateway and passed to the harness with the run start (gateway-resolved
   * injection) — never a literal in the producer.
   */
  readonly retentionSeconds?: number;
  /** Defaults to {@link RUN_STREAM_MAX_LEN}. */
  readonly maxLen?: number;
}

/** `EVALSHA`/`EVAL` arguments for one append: `keys` and `args` exactly as the script reads them. */
export interface RunAppendCommand {
  readonly keys: readonly string[];
  readonly args: readonly string[];
}

/**
 * The audience of ONE event — what the stored `vis` field records and the public plane filters
 * on: the type's visibility, narrowed to `admin` for an admin-trace `output.data`.
 */
export function runEventAudience(event: Pick<RunEventV2, 'type' | 'data'>): RunEventVisibility {
  if (event.type === 'output.data' && (event.data as { visibility?: unknown }).visibility === 'admin') return 'admin';
  return RUN_EVENT_VISIBILITY[event.type];
}

/**
 * The event as the PUBLIC plane (business callers, the SDKs) receives it, or `null` when that
 * plane must not receive it at all. The gateway applies this to every stored event before it
 * writes a public frame; the admin trace sends events unchanged.
 */
export function toPublicRunEvent(event: RunEventV2): RunEventV2 | null {
  if (runEventAudience(event) !== 'public') return null;
  if (event.type !== 'run.failed' && event.type !== 'node.failed') return event;
  const { detail: _detail, ...error } = event.data.error;
  void _detail;
  return { ...event, data: { ...event.data, error } } as RunEventV2;
}

/**
 * Validate one event and build its append command. Throws {@link RunProtocolError} for a synthetic
 * type (never stored), a non-conforming event, or a retention on the wrong kind of event.
 */
export function buildRunAppend(input: RunAppendInput): RunAppendCommand {
  if (SYNTHETIC_RUN_EVENT_TYPES.includes(input.type)) throw new RunProtocolError([`${input.type} is synthetic and is never stored`]);
  const candidate: Record<string, unknown> = { seq: 1, runId: input.runId, type: input.type, ts: input.ts };
  if (input.nodeId !== undefined) candidate.nodeId = input.nodeId;
  candidate.data = input.data;
  const problems = runEventProblems(candidate);
  const terminal = (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(input.type);
  const retention = input.retentionSeconds;
  if (terminal && (retention === undefined || !Number.isSafeInteger(retention) || retention < 1)) {
    problems.push(`retentionSeconds (a positive integer) is required on the terminal event ${input.type}`);
  }
  if (!terminal && retention !== undefined) problems.push(`retentionSeconds is only allowed on a terminal event (received it on ${input.type})`);
  const maxLen = input.maxLen ?? RUN_STREAM_MAX_LEN;
  if (!Number.isSafeInteger(maxLen) || maxLen < 1) problems.push('maxLen must be a positive integer');
  if (input.dedupeKey !== undefined && input.dedupeKey.length === 0) problems.push('dedupeKey must be non-empty when given');
  if (problems.length > 0) throw new RunProtocolError(problems);

  const fields: string[] = ['type', input.type, 'ts', input.ts];
  if (input.nodeId !== undefined) fields.push('nodeId', input.nodeId);
  fields.push('vis', runEventAudience(candidate as unknown as RunEventV2), 'body', JSON.stringify(input.data));
  return {
    keys: [RUN_SEQ_KEY(input.runId), RUN_EVENTS_KEY(input.runId), RUN_DEDUPE_KEY(input.runId)],
    args: [String(maxLen), String(retention ?? 0), input.dedupeKey ?? '', ...fields],
  };
}

export type ParsedStoredRunEvent =
  | { readonly kind: 'event'; readonly event: RunEventV2; readonly visibility: RunEventVisibility }
  /** A pre-v2 entry (`data` = an async envelope, no `seq`): a v2 reader skips it. */
  | { readonly kind: 'legacy' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] };

const STORED_SEQ_PATTERN = /^[1-9][0-9]*$/;

/**
 * Read one stream entry (its flat field list, as `XRANGE`/`XREAD` return it) back into the
 * envelope. `runId` comes from the key, never from the entry. A broken entry is `invalid`, never
 * repaired; a reader logs it and moves past it.
 */
export function parseStoredRunEvent(runId: string, fields: readonly string[]): ParsedStoredRunEvent {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(fields[i] as string, fields[i + 1] as string);
  const rawSeq = map.get('seq');
  if (rawSeq === undefined) return { kind: 'legacy' };
  const problems: string[] = [];
  if (!STORED_SEQ_PATTERN.test(rawSeq) || !Number.isSafeInteger(Number(rawSeq)))
    problems.push(`stored seq must be a positive integer (received ${JSON.stringify(rawSeq)})`);
  let data: unknown;
  try {
    data = JSON.parse(map.get('body') ?? '');
  } catch {
    problems.push('stored body is not JSON');
  }
  if (problems.length > 0) return { kind: 'invalid', problems };
  const event: Record<string, unknown> = { seq: Number(rawSeq), runId, type: map.get('type'), ts: map.get('ts') };
  if (map.has('nodeId')) event.nodeId = map.get('nodeId');
  event.data = data;
  problems.push(...runEventProblems(event));
  if (isRunEventType(event.type) && SYNTHETIC_RUN_EVENT_TYPES.includes(event.type)) problems.push(`${event.type} is synthetic and is never stored`);
  if (problems.length > 0) return { kind: 'invalid', problems };
  const typed = event as unknown as RunEventV2;
  const visibility = runEventAudience(typed);
  if (map.get('vis') !== visibility)
    return { kind: 'invalid', problems: [`stored vis ${JSON.stringify(map.get('vis'))} disagrees with ${visibility}`] };
  return { kind: 'event', event: typed, visibility };
}

export type RunResumePlan =
  /** Replay every retained event with `seq > after` the connection may see, then continue live. */
  | { readonly kind: 'replay'; readonly after: number }
  /** Answer with `run.resync { reason }` and continue live from the snapshot's `lastSeq + 1`. */
  | { readonly kind: 'resync'; readonly reason: RunResyncReason };

/**
 * Where a (re)connect resumes. The STORED stream is contiguous (one sequencer, trimmed only from
 * the front), so the server can tell exactly whether everything after the cursor is retained:
 *
 * - `lastSeq` is `GET` {@link RUN_SEQ_KEY} (`null` when absent);
 * - `oldestSeq` is the `seq` field of `XRANGE <events> - + COUNT 1` (`null` when empty or absent).
 *
 * For `replay`, the gateway turns `after` into an `XREAD` id: `0-0` when `after < oldestSeq`,
 * otherwise the id of the entry whose `seq === after`, found by scanning back from the tail with
 * `XREVRANGE <events> + - COUNT <page>` (resumes are near the tail; the scan is bounded by
 * {@link RUN_STREAM_MAX_LEN}).
 */
export function planRunResume(input: { readonly after: number; readonly oldestSeq: number | null; readonly lastSeq: number | null }): RunResumePlan {
  const { after, oldestSeq, lastSeq } = input;
  if (lastSeq === null) return after === 0 ? { kind: 'replay', after: 0 } : { kind: 'resync', reason: 'expired' };
  if (after > lastSeq) return { kind: 'resync', reason: 'cursor_invalid' };
  if (oldestSeq === null) return after === lastSeq ? { kind: 'replay', after } : { kind: 'resync', reason: 'gap' };
  if (after + 1 < oldestSeq) return { kind: 'resync', reason: 'gap' };
  return { kind: 'replay', after };
}

// =============================================================================================
// Resume
// =============================================================================================

const CURSOR_PATTERN = /^[0-9]+$/;

/**
 * The resume cursor of a (re)connect: the `Last-Event-ID` header when present, else the `after`
 * query parameter, else `0` (from the beginning). Either must be a non-negative decimal integer —
 * the `seq` the client last stored. An empty value is treated as absent. The server replays every
 * stored event with `seq > after`; a cursor it can no longer serve is answered with `run.resync`.
 */
export function parseResumeCursor(input: {
  readonly lastEventId?: string | null;
  readonly after?: string | null;
}): { readonly after: number } | { readonly problems: readonly string[] } {
  const raw = [input.lastEventId, input.after].find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  if (raw === undefined || raw === null) return { after: 0 };
  const parsed = Number(raw);
  if (!CURSOR_PATTERN.test(raw) || !Number.isSafeInteger(parsed)) {
    return { problems: [`resume cursor must be a non-negative decimal integer (received ${JSON.stringify(raw)})`] };
  }
  return { after: parsed };
}

/** One step of a client's cursor — what {@link advanceRunCursor} decided for one received event. */
export interface RunCursorStep {
  /** The cursor to keep (and to send as `Last-Event-ID` / `?after=` on the next reconnect). */
  readonly cursor: number;
  /** Whether the event is new to this client and must be applied. */
  readonly deliver: boolean;
  /** `run.resync`: discard the run state and replace it with `data.snapshot`. */
  readonly reset: boolean;
}

/**
 * The client side of the gap rule (fix 1). `seq` is monotonic but NOT contiguous for a client, so
 * there is no "missed events" branch here at all:
 *
 * - a stored event with `seq > cursor` is delivered and becomes the cursor, however far it jumps;
 * - a stored event with `seq <= cursor` is a replayed duplicate and is dropped;
 * - `ping` is never delivered; it can only move the cursor forward;
 * - `run.resync` is delivered with `reset: true` and sets the cursor to its `seq`
 *   (`=== data.snapshot.lastSeq`), even when that is lower — the server's snapshot is the truth.
 */
export function advanceRunCursor(cursor: number, event: RunEventV2): RunCursorStep {
  if (event.type === 'run.resync') return { cursor: event.seq, deliver: true, reset: true };
  if (event.type === 'ping') return { cursor: Math.max(cursor, event.seq), deliver: false, reset: false };
  if (event.seq <= cursor) return { cursor, deliver: false, reset: false };
  return { cursor: event.seq, deliver: true, reset: false };
}
