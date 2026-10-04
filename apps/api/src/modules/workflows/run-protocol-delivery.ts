import { BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ASYNC_ENVELOPE_SCHEMA_VERSION,
  RUN_EVENTS_KEY,
  TERMINAL_RUN_EVENT_TYPES,
  decodeResumeToken,
  encodeResumeToken,
  parseStoredRunEvent,
  planRunResume,
  runErrorMessage,
  selectRunProtocol,
  toPublicRunEvent,
} from '@arcaai/async-contract';
import type { AsyncEnvelope, RunEventV2, RunNodeStatus, RunResult, RunResyncReason, RunSnapshot, RunStatus } from '@arcaai/async-contract';
import type { WorkflowRunStatusResponse } from '@arcaai/applications';
import type { RunCompletedCounts } from './run-completed-counts';
import { RunEventStreamHub, RunStreamEntry, storedSeqOf } from './run-event-stream-hub';
import { parseRunStreamEntry } from './run-stream-delivery';
import { RUN_EVENT_TRANSPORT, WORKFLOW_RUN_COMPLETED, buildWorkflowRunEventEnvelope, compareStreamIds, isTerminalRunStatus } from './workflow-run-event';

/**
 * TASK-1038 B3a — run protocol v2 DELIVERY (protocol-v2.md §2, §5, §6), shared by the three
 * readers of a run stream: the business-plane SSE route, the run WebSocket and the admin trace.
 *
 * One loop, so the three cannot drift in how they resume, filter, keep alive, or end:
 *
 * - **Protocol.** `x-hope-run-protocol: 2` / `?protocol=2` selects v2; neither selects the legacy
 *   frame shapes for one release (OD-23). Producers write v2 entries only, so the legacy frames
 *   are DERIVED here from the stored v2 events ({@link toLegacyEnvelope}); a pre-v2 entry still
 *   retained in an older run's stream is forwarded to a legacy client verbatim, and skipped by v2.
 * - **Audience.** The business plane receives {@link toPublicPlaneEvent} of every stored event —
 *   admin-audience events never, `error.detail` never, and `run.cancelled.reason` only as a fixed
 *   label. The admin trace receives every stored event unchanged.
 * - **Resume.** The client cursor is `seq` (`Last-Event-ID: <seq>` / `?after=<seq>`), planned with
 *   `planRunResume`. A legacy opaque Redis-id token is still accepted for one release.
 * - **Loss is signalled by the server only**, with `run.resync { reason, snapshot }`: `gap`,
 *   `expired`, `cursor_invalid`, `unavailable`. `ping.seq` is this connection's position — the
 *   last stored seq delivered OR filtered out — so a public client moves past admin events.
 * - **The end.** A terminal event closes the stream and starts its retention clock. A run that is
 *   terminal in the read model with no terminal event on its stream gets the §6.1 backstop
 *   (`EXPIRE … NX` on all three keys, which closes the stream to a late append) and a
 *   `run.resync { reason: 'gap' }` carrying the terminal snapshot — the stored stream is missing
 *   the event the client needs, which is what `gap` means.
 */

export type RunPlane = 'public' | 'admin';
export type RunProtocolVersion = 2 | 'legacy';

/** A client's resume position: a v2 `seq`, a legacy opaque stream token, or nothing. */
export type ClientCursor = { kind: 'seq'; after: number } | { kind: 'stream'; id: string } | { kind: 'start' };

const DECIMAL = /^[0-9]+$/;

/** §2 — the protocol a stream request selected, or a 400 (never a silent downgrade to legacy). */
export function resolveRunProtocol(input: { header?: string | string[] | null; query?: string | string[] | null }): RunProtocolVersion {
  const selected = selectRunProtocol({ header: first(input.header), query: first(input.query) });
  if ('problems' in selected) {
    throw new BadRequestException({ code: 'RUN_PROTOCOL_UNSUPPORTED', message: selected.problems.join('; ') });
  }
  return selected.version;
}

/**
 * The client cursor. `Last-Event-ID` wins over `?after=`, which wins over the legacy
 * `?lastEventId=` query. A decimal integer is a v2 `seq`; an opaque Redis-stream resume token is
 * the legacy cursor (accepted for one release). Anything else: a legacy request resumes from the
 * beginning of what is retained (its historical behaviour), a v2 request is a 400.
 */
export function parseClientCursor(
  input: { lastEventId?: string | string[] | null; after?: string | string[] | null; legacyQuery?: string | string[] | null },
  protocol: RunProtocolVersion,
): ClientCursor {
  const raw = [first(input.lastEventId), first(input.after), first(input.legacyQuery)].find((value) => typeof value === 'string' && value.length > 0);
  if (raw === undefined || raw === null) return { kind: 'start' };
  if (DECIMAL.test(raw) && Number.isSafeInteger(Number(raw))) {
    const after = Number(raw);
    return after === 0 ? { kind: 'start' } : { kind: 'seq', after };
  }
  const decoded = decodeResumeToken(raw);
  if (decoded !== null && decoded.transport === RUN_EVENT_TRANSPORT) return { kind: 'stream', id: decoded.cursor };
  if (protocol === 'legacy') return { kind: 'start' };
  throw new BadRequestException({
    code: 'RUN_CURSOR_INVALID',
    message: `resume cursor must be a non-negative decimal seq (received ${JSON.stringify(raw)})`,
  });
}

function first(value: string | string[] | null | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * The event as the BUSINESS PLANE receives it, or `null` when that plane must not see it:
 * `toPublicRunEvent` (audience + `error.detail`), plus the fixed-label rule for the free-text
 * `run.cancelled.reason` (protocol-v2.md §11): a SCREAMING_SNAKE code becomes its catalogue label,
 * anything else the `RUN_CANCELLED` label. The admin trace keeps the text.
 */
export function toPublicPlaneEvent(event: RunEventV2): RunEventV2 | null {
  const filtered = toPublicRunEvent(event);
  if (filtered === null || filtered.type !== 'run.cancelled' || filtered.data.reason === undefined) return filtered;
  const reason = filtered.data.reason;
  const label = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(reason) ? runErrorMessage(reason) : runErrorMessage('RUN_CANCELLED');
  return { ...filtered, data: { ...filtered.data, reason: label } } as RunEventV2;
}

export function forPlane(event: RunEventV2, plane: RunPlane): RunEventV2 | null {
  return plane === 'admin' ? event : toPublicPlaneEvent(event);
}

// =============================================================================================
// The fold — what a client would know after these events (snapshot, legacy counts, watcher)
// =============================================================================================

const NODE_STATUS: Record<string, RunNodeStatus> = { COMPLETED: 'completed', DEGRADED: 'degraded', SKIPPED: 'skipped' };

/**
 * Folds stored v2 events (already filtered for the plane they are folded FOR) into the run state
 * a snapshot carries (§5: outputs keyed by node, then field) and the four settled-node counts the
 * legacy `workflow.run.completed` and the read model carry (TASK-982).
 */
export class RunEventFold {
  readonly nodes: Record<string, { status: RunNodeStatus; durationMs?: number }> = {};
  readonly outputs: Record<string, Record<string, unknown>> = {};
  result?: RunResult;
  terminal?: { status: RunStatus; degraded?: boolean; reason?: string; ts: string };
  lastSeq = 0;
  /** Whether the fold started at seq 1 — only then are its counts the whole run's. */
  sawFirst = false;

  apply(event: RunEventV2): void {
    if (event.seq === 1) this.sawFirst = true;
    if (event.seq > this.lastSeq) this.lastSeq = event.seq;
    const nodeId = event.nodeId;
    switch (event.type) {
      case 'node.started':
        if (!nodeId) return;
        if ((event.data.attempt ?? 1) > 1) delete this.outputs[nodeId];
        this.nodes[nodeId] = { status: 'running' };
        return;
      case 'node.completed':
        if (!nodeId) return;
        this.nodes[nodeId] = { status: NODE_STATUS[event.data.status] ?? 'completed', durationMs: event.data.durationMs };
        return;
      case 'node.failed':
        if (!nodeId) return;
        this.nodes[nodeId] = { status: event.data.willRetry ? 'running' : 'failed', durationMs: event.data.durationMs };
        return;
      case 'output.text.delta': {
        if (!nodeId) return;
        const bag = (this.outputs[nodeId] ??= {});
        const prior = bag[event.data.field];
        bag[event.data.field] = (typeof prior === 'string' ? prior : '') + event.data.text;
        return;
      }
      case 'output.data':
        if (!nodeId) return;
        (this.outputs[nodeId] ??= {})[event.data.field] = event.data.value;
        return;
      case 'run.completed':
        this.result = event.data.result;
        this.terminal = { status: 'COMPLETED', degraded: event.data.degraded === true, ts: event.ts };
        return;
      case 'run.failed':
        this.terminal = { status: event.data.status, reason: event.data.error.code, ts: event.ts };
        return;
      case 'run.cancelled':
        this.terminal = { status: 'CANCELED', reason: event.data.reason, ts: event.ts };
        return;
      default:
        return;
    }
  }

  /** The TASK-982 counts — `undefined` unless the fold saw the whole run (a resumed or trimmed fold would undercount). */
  counts(): RunCompletedCounts | undefined {
    if (!this.sawFirst) return undefined;
    const statuses = Object.values(this.nodes).map((node) => node.status);
    return {
      nodeCount: statuses.length,
      failedNodeCount: statuses.filter((status) => status === 'failed').length,
      degradedNodeCount: statuses.filter((status) => status === 'degraded').length,
      skippedNodeCount: statuses.filter((status) => status === 'skipped').length,
    };
  }

  snapshot(status: WorkflowRunStatusResponse | null, lastSeq: number): RunSnapshot {
    const snapshot: { -readonly [K in keyof RunSnapshot]: RunSnapshot[K] } = {
      status: this.terminal?.status ?? readModelStatus(status?.status),
      lastSeq: Math.max(lastSeq, this.lastSeq),
      nodes: { ...this.nodes },
      outputs: Object.fromEntries(Object.entries(this.outputs).map(([nodeId, bag]) => [nodeId, { ...bag }])),
    };
    if (this.result !== undefined) snapshot.result = this.result;
    return snapshot;
  }
}

/** The read model's status → the protocol's `RunStatus` (anything not terminal is `RUNNING`). */
export function readModelStatus(status: string | undefined): RunStatus {
  switch (status) {
    case 'COMPLETED':
    case 'SUCCEEDED':
    case 'DEGRADED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    default:
      return 'RUNNING';
  }
}

export function isTerminalRunEvent(event: Pick<RunEventV2, 'type'>): boolean {
  return (TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * The terminal outcome ONE stored entry carries, whichever protocol wrote it: a v2
 * `run.completed|failed|cancelled`, or a pre-v2 `workflow.run.completed` envelope (runs that
 * started before the deploy). `null` for every other entry.
 */
export interface RunTerminalOutcome {
  /** The interpreter-vocabulary status (`terminalStatusOf` folds it). */
  status: string;
  occurredAt: string;
  reason?: string;
  /** The completed event's delivered result, unvalidated (the consumer validates it). */
  result?: unknown;
  /** Pre-v2 only: the payload carrying the TASK-982 counts. */
  legacyPayload?: Record<string, unknown>;
  /** v2 only: the event itself. */
  event?: RunEventV2;
}

export function terminalOutcomeOf(runId: string, fields: readonly string[]): RunTerminalOutcome | null {
  const parsed = parseStoredRunEvent(runId, fields);
  if (parsed.kind === 'legacy') {
    const envelope = parseRunStreamEntry([...fields]);
    if (envelope?.type !== WORKFLOW_RUN_COMPLETED) return null;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    return { status: String(payload.status), occurredAt: envelope.occurredAt, result: payload.result, legacyPayload: payload };
  }
  if (parsed.kind !== 'event') return null;
  const event = parsed.event;
  switch (event.type) {
    case 'run.completed':
      return { status: event.data.degraded ? 'DEGRADED' : 'COMPLETED', occurredAt: event.ts, result: event.data.result, event };
    case 'run.failed':
      return { status: event.data.status, occurredAt: event.ts, reason: event.data.error.code, event };
    case 'run.cancelled':
      return { status: 'CANCELED', occurredAt: event.ts, reason: event.data.reason, event };
    default:
      return null;
  }
}

// =============================================================================================
// Legacy frames DERIVED from stored v2 events (OD-23: one release)
// =============================================================================================

/** A UUID derived from intent (run + seq), so a replayed frame carries the same envelope id. */
function derivedEnvelopeId(runId: string, seq: number): string {
  const hex = createHash('sha256').update(`hope-run-legacy:${runId}:${seq}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const LEGACY_NODE_STATUS: Record<string, string> = { COMPLETED: 'SUCCEEDED', DEGRADED: 'DEGRADED', SKIPPED: 'SKIPPED' };

/**
 * The legacy async-contract envelope a pre-v2 client would have received for this (already
 * plane-filtered) event, or `null` when the legacy vocabulary has no such event (debug events,
 * outputs other than text deltas, audio).
 */
export function toLegacyEnvelope(event: RunEventV2, tenantId: string, fold?: RunEventFold): AsyncEnvelope<Record<string, unknown>> | null {
  let type: string;
  let payload: Record<string, unknown>;
  switch (event.type) {
    case 'node.started':
      type = 'workflow.node.started';
      payload = { nodeId: event.nodeId, nodeType: event.data.kind };
      break;
    case 'node.completed':
      type = 'workflow.node.completed';
      payload = { nodeId: event.nodeId, status: LEGACY_NODE_STATUS[event.data.status] ?? event.data.status };
      break;
    case 'node.failed':
      type = 'workflow.node.failed';
      payload = { nodeId: event.nodeId, status: 'FAILED', reason: event.data.error.code };
      break;
    case 'output.text.delta':
      type = 'workflow.token.delta';
      payload = { nodeId: event.nodeId, sequence: event.seq, text: event.data.text };
      break;
    case 'run.completed':
      type = WORKFLOW_RUN_COMPLETED;
      payload = { status: event.data.degraded ? 'DEGRADED' : 'SUCCEEDED', ...(fold?.counts() ?? {}) };
      if (event.data.result !== undefined) payload.result = event.data.result;
      break;
    case 'run.failed':
      type = WORKFLOW_RUN_COMPLETED;
      payload = { status: event.data.status, reason: event.data.error.code, ...(fold?.counts() ?? {}) };
      break;
    case 'run.cancelled':
      type = WORKFLOW_RUN_COMPLETED;
      payload = { status: 'CANCELLED', ...(event.data.reason !== undefined ? { reason: event.data.reason } : {}), ...(fold?.counts() ?? {}) };
      break;
    default:
      return null;
  }
  return {
    schemaVersion: ASYNC_ENVELOPE_SCHEMA_VERSION,
    id: derivedEnvelopeId(event.runId, event.seq),
    tenantId,
    type,
    occurredAt: new Date(event.ts).toISOString(),
    correlationId: event.runId,
    causationId: null,
    idempotencyKey: `wf:run:${event.runId}:seq:${event.seq}`,
    payload,
  };
}

// =============================================================================================
// The delivery loop
// =============================================================================================

/** Where frames go. Each resolves `false` once the client is gone (the loop then stops). */
export interface RunFrameSink {
  v2(event: RunEventV2): Promise<boolean>;
  legacy(envelope: AsyncEnvelope<unknown>, resumeToken?: string): Promise<boolean>;
}

export interface RunDeliveryOptions {
  hub: RunEventStreamHub | undefined;
  runId: string;
  tenantId: string;
  plane: RunPlane;
  protocol: RunProtocolVersion;
  cursor: ClientCursor;
  sink: RunFrameSink;
  signal: AbortSignal;
  /** The status read made BEFORE the stream opened (it is also the ownership check). */
  initialStatus: WorkflowRunStatusResponse;
  /** Re-read the run's status; `null` when the read failed. */
  readStatus: () => Promise<WorkflowRunStatusResponse | null>;
  terminalCheckMs: number;
  blockMs: number;
  heartbeatMs: number;
  /** WS backpressure: resolves once the client may receive more, `false` when it left. */
  beforeRead?: () => Promise<boolean>;
  logger: Logger;
}

type Step = 'continue' | 'stop';

/** Deliver one run's events until a terminal event, the client leaves, or the transport fails. */
export async function deliverRunEvents(options: RunDeliveryOptions): Promise<void> {
  await new RunDeliveryLoop(options).run();
}

class RunDeliveryLoop {
  private readonly key: string;
  private readonly fold = new RunEventFold();
  /** The last stored seq this connection processed (delivered OR filtered out) — `ping.seq`. */
  private position = 0;
  private cursorId = '0-0';
  private lastWriteAt = Date.now();

  constructor(private readonly o: RunDeliveryOptions) {
    this.key = RUN_EVENTS_KEY(o.runId);
  }

  async run(): Promise<void> {
    const o = this.o;
    const hub = o.hub;
    if (o.protocol === 'legacy') {
      // Snapshot-then-delta, exactly as before this ticket: the snapshot carries no `id:`.
      if (!(await o.sink.legacy(buildWorkflowRunEventEnvelope(o.tenantId, o.initialStatus)))) return;
      if (isTerminalRunStatus(o.initialStatus.status)) return;
      if (!hub?.available()) {
        o.logger.warn({ message: 'Redis unavailable — workflow run stream ends after snapshot', runId: o.runId });
        return;
      }
      if ((await this.startLegacy(hub)) === 'stop') return;
    } else {
      if (!hub?.available()) {
        await this.resync('unavailable', o.initialStatus, null);
        return;
      }
      if ((await this.startV2(hub)) === 'stop') return;
      if (isTerminalRunStatus(o.initialStatus.status)) {
        // A finished run publishes nothing more: drain what is retained, then end either way.
        if ((await this.drain(hub)) === 'stop') return;
        await this.backstop(hub, o.initialStatus);
        return;
      }
    }
    await this.follow(hub);
  }

  // -------------------------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------------------------

  private async startV2(hub: RunEventStreamHub): Promise<Step> {
    const o = this.o;
    let lastSeq: number | null;
    let oldest: RunStreamEntry | null;
    try {
      lastSeq = await hub.lastSeq(o.runId);
      oldest = await hub.oldestEntry(this.key);
    } catch (err) {
      o.logger.warn({ message: 'run stream resume planning failed — answering with a snapshot', runId: o.runId, error: errorText(err) });
      await this.resync('unavailable', o.initialStatus, null);
      return 'stop';
    }

    if (o.cursor.kind === 'stream') {
      // A legacy token on a v2 request (a client mid-upgrade): resume from it exactly, unless the
      // trim already evicted it.
      if (oldest && compareStreamIds(oldest.id, o.cursor.id) > 0) return this.resyncAndContinue(hub, 'gap', lastSeq);
      this.cursorId = o.cursor.id;
      return 'continue';
    }

    const after = o.cursor.kind === 'seq' ? o.cursor.after : 0;
    const oldestSeq = oldest ? storedSeqOf(oldest.fields) : null;
    const plan = planRunResume({ after, oldestSeq, lastSeq });
    if (plan.kind === 'resync') return this.resyncAndContinue(hub, plan.reason, lastSeq);
    this.position = plan.after;
    if (plan.after > 0 && oldestSeq !== null && plan.after >= oldestSeq) {
      // swallow-ok: an unmappable seq resumes from the retained beginning; the seq filter drops the replayed duplicates.
      this.cursorId = (await hub.entryIdForSeq(this.key, plan.after).catch(() => null)) ?? '0-0';
    }
    return 'continue';
  }

  private async startLegacy(hub: RunEventStreamHub): Promise<Step> {
    const o = this.o;
    const cursor = o.cursor;
    if (cursor.kind === 'start') return 'continue';
    let resumeAt: string | null = null;
    if (cursor.kind === 'stream') {
      // swallow-ok: an unreadable oldest id is treated as "no gap" (the historical posture).
      const oldest = await hub.oldestEntry(this.key).catch(() => null);
      resumeAt = oldest && compareStreamIds(oldest.id, cursor.id) > 0 ? null : cursor.id;
    } else {
      // swallow-ok: an unmappable seq is a gap answered with a resync snapshot below.
      resumeAt = await hub.entryIdForSeq(this.key, cursor.after).catch(() => null);
      if (resumeAt !== null) this.position = cursor.after;
    }
    if (resumeAt !== null) {
      this.cursorId = resumeAt;
      return 'continue';
    }
    // The client's position was evicted by the producer's MAXLEN trim: re-snapshot, never a silent hole.
    const resync = await o.readStatus();
    if (resync) {
      if (!(await o.sink.legacy(buildWorkflowRunEventEnvelope(o.tenantId, resync)))) return 'stop';
      if (isTerminalRunStatus(resync.status)) return 'stop';
    }
    return 'continue';
  }

  // -------------------------------------------------------------------------------------------
  // Follow
  // -------------------------------------------------------------------------------------------

  private async follow(hub: RunEventStreamHub): Promise<void> {
    const o = this.o;
    let lastCheck = Date.now();
    while (!o.signal.aborted) {
      if (o.beforeRead && !(await o.beforeRead())) return;
      const waitMs = Math.max(1, Math.min(o.blockMs, o.terminalCheckMs, o.protocol === 2 ? o.heartbeatMs : Number.POSITIVE_INFINITY));
      let entries: RunStreamEntry[];
      try {
        entries = await hub.read(this.key, this.cursorId, { timeoutMs: waitMs, signal: o.signal });
      } catch (err) {
        // Never forward the raw error (it may echo transport-internal detail): end the stream; the
        // client reconnects with its cursor and loses nothing.
        o.logger.warn({ message: 'Workflow run stream read failed — ending stream', runId: o.runId, error: errorText(err) });
        return;
      }

      if (entries.length > 0) {
        for (const entry of entries) if ((await this.process(hub, entry)) === 'stop') return;
        continue;
      }
      if (o.signal.aborted) return;

      if (o.protocol === 2 && Date.now() - this.lastWriteAt >= o.heartbeatMs) {
        if (!(await this.writeV2({ seq: this.position, runId: o.runId, type: 'ping', ts: new Date().toISOString(), data: {} } as RunEventV2))) return;
      }
      if (Date.now() - lastCheck < o.terminalCheckMs) continue;
      lastCheck = Date.now();
      // R-2 — the terminal fallback: a lost terminal event must not leave the stream open forever.
      const status = await o.readStatus();
      if (!status || !isTerminalRunStatus(status.status)) continue;
      if ((await this.drain(hub)) === 'stop') return;
      await this.backstop(hub, status);
      return;
    }
  }

  /** Deliver everything retained after the cursor, without blocking. */
  private async drain(hub: RunEventStreamHub): Promise<Step> {
    for (;;) {
      let tail: RunStreamEntry[];
      try {
        tail = await hub.readNow(this.key, this.cursorId);
      } catch {
        // swallow-ok: an unreadable tail still ends with the terminal snapshot, which is the truth the client needs.
        return 'continue';
      }
      for (const entry of tail) if ((await this.process(hub, entry)) === 'stop') return 'stop';
      if (tail.length === 0) return 'continue';
    }
  }

  /** §6.1 terminal backstop: close the stream (all three keys) and tell the client the terminal truth. */
  private async backstop(hub: RunEventStreamHub, status: WorkflowRunStatusResponse): Promise<void> {
    const o = this.o;
    // swallow-ok: an unreadable tail is treated as "no terminal event retained" — the backstop below is the safe answer.
    const newest = await hub.newestEntry(this.key).catch(() => null);
    if (newest && terminalOutcomeOf(o.runId, newest.fields) !== null && (storedSeqOf(newest.fields) ?? Number.POSITIVE_INFINITY) <= this.position) {
      // The stream HAS its terminal event and this client already holds it (a reconnect after
      // the end): nothing was lost, so nothing is sent.
      return;
    }
    o.logger.warn({ message: 'Run ended without a terminal event reaching its stream — closing with a terminal snapshot', runId: o.runId });
    await hub.expireAfterTerminal(o.runId);
    if (o.protocol === 'legacy') {
      await o.sink.legacy(buildWorkflowRunEventEnvelope(o.tenantId, status));
      return;
    }
    // swallow-ok: a counter that cannot be read leaves the snapshot at what is retained.
    const lastSeq = await hub.lastSeq(o.runId).catch(() => null);
    await this.resync(lastSeq === null ? 'expired' : 'gap', status, lastSeq, true, hub);
  }

  /** One stored entry. `stop` once a terminal event went out, or the client left. */
  private async process(hub: RunEventStreamHub, entry: RunStreamEntry): Promise<Step> {
    const o = this.o;
    this.cursorId = entry.id;
    const parsed = parseStoredRunEvent(o.runId, entry.fields);
    if (parsed.kind === 'legacy') {
      // A pre-v2 entry of a run that started before the deploy: legacy clients get it verbatim.
      if (o.protocol !== 'legacy') return 'continue';
      const envelope = parseRunStreamEntry(entry.fields);
      if (envelope === null) return 'continue';
      if (!(await this.writeLegacy(envelope, entry.id))) return 'stop';
      if (envelope.type === WORKFLOW_RUN_COMPLETED) {
        void hub.expireAfterTerminal(o.runId);
        return 'stop';
      }
      return 'continue';
    }
    if (parsed.kind === 'invalid') {
      o.logger.warn({ message: 'run stream entry is not a valid protocol v2 event — skipped', runId: o.runId, entryId: entry.id, problems: parsed.problems });
      return 'continue';
    }

    const event = parsed.event;
    if (event.seq <= this.position) return 'continue'; // a replayed duplicate
    this.position = event.seq;
    const out = o.protocol === 'legacy' ? toPublicPlaneEvent(event) : forPlane(event, o.plane);
    if (out !== null) this.fold.apply(out);
    else if (event.seq === 1) this.fold.sawFirst = true;

    if (out !== null) {
      if (o.protocol === 2) {
        if (!(await this.writeV2(out))) return 'stop';
      } else {
        const envelope = toLegacyEnvelope(out, o.tenantId, this.fold);
        if (envelope !== null && !(await this.writeLegacy(envelope, entry.id))) return 'stop';
      }
    }
    if (isTerminalRunEvent(event)) {
      void hub.expireAfterTerminal(o.runId);
      return 'stop';
    }
    return 'continue';
  }

  // -------------------------------------------------------------------------------------------
  // Resync
  // -------------------------------------------------------------------------------------------

  /** Answer a resume plan's resync, then continue live from the snapshot's position. */
  private async resyncAndContinue(hub: RunEventStreamHub, reason: RunResyncReason, lastSeq: number | null): Promise<Step> {
    const status = await this.o.readStatus();
    const sent = await this.resync(reason, status ?? this.o.initialStatus, lastSeq, true, hub);
    if (!sent) return 'stop';
    const snapshotStatus = this.fold.terminal?.status ?? readModelStatus((status ?? this.o.initialStatus).status);
    return snapshotStatus === 'RUNNING' ? 'continue' : 'stop';
  }

  /**
   * Send `run.resync { reason, snapshot }`. With `foldRetained`, the snapshot folds every retained
   * event first (read model + retained events, §6.2 step 4) and the cursor moves to the last one,
   * so the live stream continues at `snapshot.lastSeq + 1`.
   */
  private async resync(
    reason: RunResyncReason,
    status: WorkflowRunStatusResponse,
    lastSeq: number | null,
    foldRetained = false,
    hub?: RunEventStreamHub,
  ): Promise<boolean> {
    const o = this.o;
    if (foldRetained && hub) {
      const fold = new RunEventFold();
      let cursor = '0-0';
      try {
        for (;;) {
          const page = await hub.readNow(this.key, cursor);
          for (const entry of page) {
            cursor = entry.id;
            const parsed = parseStoredRunEvent(o.runId, entry.fields);
            if (parsed.kind !== 'event') continue;
            const visible = forPlane(parsed.event, o.plane);
            if (visible) fold.apply(visible);
            else if (parsed.event.seq > fold.lastSeq) fold.lastSeq = parsed.event.seq;
          }
          if (page.length === 0) break;
        }
      } catch (err) {
        o.logger.warn({ message: 'run stream could not be folded into a resync snapshot', runId: o.runId, error: errorText(err) });
      }
      Object.assign(this.fold, { result: fold.result, terminal: fold.terminal, lastSeq: fold.lastSeq, sawFirst: fold.sawFirst });
      Object.assign(this.fold.nodes, fold.nodes);
      Object.assign(this.fold.outputs, fold.outputs);
      this.cursorId = cursor;
    }
    const snapshot = this.fold.snapshot(status, lastSeq ?? 0);
    this.position = snapshot.lastSeq;
    const event = { seq: snapshot.lastSeq, runId: o.runId, type: 'run.resync', ts: new Date().toISOString(), data: { reason, snapshot } } as RunEventV2;
    return this.writeV2(event);
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  private async writeV2(event: RunEventV2): Promise<boolean> {
    this.lastWriteAt = Date.now();
    try {
      return await this.o.sink.v2(event);
    } catch (err) {
      // A frame that does not conform (RunProtocolError) is never sent; the stream continues.
      this.o.logger.warn({ message: 'run event could not be framed — skipped', runId: this.o.runId, type: event.type, error: errorText(err) });
      return !this.o.signal.aborted;
    }
  }

  private async writeLegacy(envelope: AsyncEnvelope<unknown>, entryId: string): Promise<boolean> {
    this.lastWriteAt = Date.now();
    return this.o.sink.legacy(envelope, encodeResumeToken(RUN_EVENT_TRANSPORT, entryId));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
