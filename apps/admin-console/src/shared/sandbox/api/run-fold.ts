/**
 * The Test tab's run state (TASK-1036 §10.2–§10.3): a PURE fold over the ordered protocol-v2
 * events of one run.
 *
 * "The context snapshot shown at event N is a pure fold over events 1..N" (§10.3), so time travel
 * is `foldRunEvents(events, n)` and nothing else — no second store, no replay engine. A
 * `run.resync` snapshot REPLACES the state (protocol-v2.md §6.3); the run's identity (slug,
 * version) survives it because the snapshot does not carry one.
 *
 * Every read of `data` is defensive: the server validates each event against its closed schema
 * before storing it, but a console that renders a debugging surface must never crash on the one
 * frame it did not expect.
 */
import type {
  BoundInput,
  GuardrailEventData,
  ModelRequestData,
  PhiClass,
  PromptComposedData,
  RunError,
  RunEvent,
  RunNodeStatus,
  RunGuardrailNotice,
  RunPausedReason,
  RunResult,
  RunTokens,
} from './run-protocol';
import { mergeGuardrailNotices, toGuardrailNotice, toGuardrailNotices } from '@/shared/guardrail/notice';

export type RunViewStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT';

export interface NodeGuardrailView extends GuardrailEventData {
  direction: 'inbound' | 'outbound';
  seq: number;
}

export interface NodeView {
  nodeId: string;
  status: RunNodeStatus;
  label?: string;
  kind?: string;
  attempt: number;
  startedAt?: string;
  durationMs?: number;
  tokens?: RunTokens;
  /** The producer's own warning count (`node.completed.warnings`). */
  warnings: number;
  inputs: BoundInput[];
  /** Declared outputs by field: the streamed text so far, then the final `output.data` value. */
  outputs: Record<string, unknown>;
  /** Fields still streaming (deltas seen, no final value yet). */
  streaming: string[];
  error?: RunError;
  willRetry?: boolean;
  bindingWarnings: Array<{ input: string; code: string; message: string }>;
  prompt?: PromptComposedData;
  modelRequests: ModelRequestData[];
  guardrails: NodeGuardrailView[];
  outputChecks: Array<{ valid: boolean; problems: string[]; field?: string }>;
  /** TASK-1050: the guardrail notices raised at this node, one per `noticeId`. */
  guardrailNotices?: RunGuardrailNotice[];
  /** TASK-1050: the run is paused at this node on a guardrail hold. */
  paused?: boolean;
}

/** TASK-1050 (README §9.8.1): the run waits durably at `nodeId` for a resolution of `noticeId`. */
export interface RunPausedView {
  reason: RunPausedReason;
  noticeId: string;
  nodeId: string;
  seq: number;
  ts: string;
}

export interface ConsultationFieldView {
  path: string;
  phiClass: PhiClass;
  value?: unknown;
  /** The step that read it (`nodeId`). */
  readBy: string;
  ts: string;
  snapshot: 'node-start' | 'run-start';
}

export interface TranscriptLineView {
  text: string;
  ts: string;
  nodeId?: string;
  utteranceIndex?: number;
  speaker?: string;
}

export interface RunView {
  runId: string | null;
  status: RunViewStatus;
  kind?: 'workflow' | 'agent';
  slug?: string;
  versionNumber?: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** `null` until a node or the run reports tokens: absent is never shown as zero. */
  tokens: RunTokens | null;
  degraded?: boolean;
  result?: RunResult;
  error?: RunError;
  cancelReason?: string;
  input: { valid: boolean; problems: string[]; schema?: { slug: string; versionNumber?: number } } | null;
  nodes: Record<string, NodeView>;
  /** Node ids in the order the run first touched them. */
  nodeOrder: string[];
  /** The step most recently started that is still running. */
  activeNodeId: string | null;
  transcript: { finals: TranscriptLineView[]; partial: TranscriptLineView | null };
  consultation: { consultationId: string | null; fields: ConsultationFieldView[] };
  lastSeq: number;
  eventCount: number;
  resync?: { reason: string; seq: number };
  /** TASK-1050: every guardrail notice the run raised (event or `run.completed`), one per `noticeId`. */
  guardrailNotices?: RunGuardrailNotice[];
  /** TASK-1050: set while the run is paused on a guardrail hold; cleared when the node re-runs or the run ends. */
  paused?: RunPausedView | null;
}

const NODE_STATUSES: ReadonlySet<string> = new Set(['waiting', 'running', 'completed', 'degraded', 'failed', 'skipped']);
const RUN_STATUSES: ReadonlySet<string> = new Set(['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

function emptyView(runId: string | null): RunView {
  return {
    runId,
    status: 'IDLE',
    tokens: null,
    input: null,
    nodes: {},
    nodeOrder: [],
    activeNodeId: null,
    transcript: { finals: [], partial: null },
    consultation: { consultationId: null, fields: [] },
    lastSeq: 0,
    eventCount: 0,
  };
}

function emptyNode(nodeId: string): NodeView {
  return { nodeId, status: 'waiting', attempt: 1, warnings: 0, inputs: [], outputs: {}, streaming: [], bindingWarnings: [], modelRequests: [], guardrails: [], outputChecks: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tokensOf(value: unknown): RunTokens | undefined {
  if (!isRecord(value)) return undefined;
  const tokensIn = typeof value.in === 'number' ? value.in : undefined;
  const tokensOut = typeof value.out === 'number' ? value.out : undefined;
  if (tokensIn === undefined && tokensOut === undefined) return undefined;
  return { in: tokensIn ?? 0, out: tokensOut ?? 0 };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

class Folder {
  view: RunView;
  /** Start order of the nodes, for `activeNodeId`. */
  private starts: string[] = [];
  private nodeTokenSum: RunTokens | null = null;
  private runTokens: RunTokens | null = null;

  constructor(runId: string | null) {
    this.view = emptyView(runId);
  }

  node(nodeId: string): NodeView {
    let node = this.view.nodes[nodeId];
    if (!node) {
      node = emptyNode(nodeId);
      this.view.nodes[nodeId] = node;
      this.view.nodeOrder.push(nodeId);
    }
    return node;
  }

  private running(): void {
    if (this.view.status === 'IDLE') this.view.status = 'RUNNING';
  }

  apply(event: RunEvent): void {
    this.view.eventCount += 1;
    if (this.view.runId === null) this.view.runId = event.runId;
    if (event.type !== 'ping') this.view.lastSeq = Math.max(this.view.lastSeq, event.seq);
    const data = event.data as Record<string, unknown>;
    const nodeId = event.nodeId;

    switch (event.type) {
      case 'run.started': {
        this.view.status = 'RUNNING';
        this.view.startedAt = event.ts;
        const d = event.data;
        if (d.kind === 'workflow' || d.kind === 'agent') this.view.kind = d.kind;
        if (typeof d.slug === 'string') this.view.slug = d.slug;
        if (typeof d.versionNumber === 'number') this.view.versionNumber = d.versionNumber;
        return;
      }
      case 'run.completed':
      case 'run.failed':
      case 'run.cancelled': {
        const status = typeof data.status === 'string' && RUN_STATUSES.has(data.status) ? (data.status as RunViewStatus) : 'COMPLETED';
        this.view.status = status;
        this.view.endedAt = event.ts;
        this.view.durationMs = numberOr(data.durationMs);
        const tokens = tokensOf(data.tokens);
        if (tokens) this.runTokens = tokens;
        if (event.type === 'run.completed') {
          if (isRecord(data.result)) this.view.result = data.result as RunResult;
          if (data.degraded === true) this.view.degraded = true;
          this.addRunNotices(toGuardrailNotices(data.guardrailNotices));
        }
        this.clearPause();
        if (event.type === 'run.failed' && isRecord(data.error)) this.view.error = data.error as unknown as RunError;
        if (event.type === 'run.cancelled' && typeof data.reason === 'string') this.view.cancelReason = data.reason;
        // A terminal run has no running step.
        for (const id of this.view.nodeOrder) {
          const node = this.view.nodes[id]!;
          if (node.status === 'running') node.status = status === 'COMPLETED' ? 'completed' : 'failed';
        }
        return;
      }
      case 'run.resync': {
        this.resync(event);
        return;
      }
      case 'ping':
        return;
      case 'guardrail.notice': {
        this.running();
        const notice = toGuardrailNotice<RunGuardrailNotice>(data);
        if (!notice) return;
        this.addRunNotices([notice]);
        if (nodeId) {
          const node = this.node(nodeId);
          node.guardrailNotices = [...mergeGuardrailNotices(node.guardrailNotices ?? [], [notice])];
        }
        return;
      }
      case 'run.paused': {
        this.running();
        if (typeof data.noticeId !== 'string' || typeof data.nodeId !== 'string') return;
        this.view.paused = { reason: 'guardrail_hold', noticeId: data.noticeId, nodeId: data.nodeId, seq: event.seq, ts: event.ts };
        this.node(data.nodeId).paused = true;
        return;
      }
      case 'input.validated': {
        this.running();
        const problems = Array.isArray(data.problems) ? data.problems.filter((p): p is string => typeof p === 'string') : [];
        this.view.input = {
          valid: data.valid === true,
          problems,
          ...(isRecord(data.schema) && typeof data.schema.slug === 'string'
            ? { schema: { slug: data.schema.slug, ...(typeof data.schema.versionNumber === 'number' ? { versionNumber: data.schema.versionNumber } : {}) } }
            : {}),
        };
        return;
      }
      case 'transcript.partial': {
        this.running();
        this.view.transcript.partial = { text: String(data.text ?? ''), ts: event.ts, ...(nodeId ? { nodeId } : {}) };
        return;
      }
      case 'transcript.final': {
        this.running();
        this.view.transcript.partial = null;
        this.view.transcript.finals = [
          ...this.view.transcript.finals,
          {
            text: String(data.text ?? ''),
            ts: event.ts,
            ...(nodeId ? { nodeId } : {}),
            ...(typeof data.utteranceIndex === 'number' ? { utteranceIndex: data.utteranceIndex } : {}),
            ...(typeof data.speaker === 'string' ? { speaker: data.speaker } : {}),
          },
        ];
        return;
      }
      default:
        break;
    }

    // Every remaining type is node-scoped.
    if (!nodeId) return;
    this.running();
    const node = this.node(nodeId);

    switch (event.type) {
      case 'node.started': {
        const attempt = typeof data.attempt === 'number' && data.attempt >= 1 ? data.attempt : 1;
        if (attempt > 1) {
          // protocol-v2.md §3: a retry discards that node's earlier partial outputs.
          node.outputs = {};
          node.streaming = [];
          node.inputs = [];
          node.error = undefined;
          node.willRetry = undefined;
        }
        node.attempt = attempt;
        node.status = 'running';
        // A resumed hold re-executes the paused node: the pause is over.
        if (node.paused) {
          node.paused = false;
          if (this.view.paused?.nodeId === nodeId) this.view.paused = null;
        }
        node.startedAt = event.ts;
        if (typeof data.label === 'string' && data.label.length > 0) node.label = data.label;
        if (typeof data.kind === 'string') node.kind = data.kind;
        this.starts = [...this.starts.filter((id) => id !== nodeId), nodeId];
        return;
      }
      case 'node.completed': {
        const status = data.status === 'DEGRADED' ? 'degraded' : data.status === 'SKIPPED' ? 'skipped' : 'completed';
        node.status = status;
        node.durationMs = numberOr(data.durationMs);
        const tokens = tokensOf(data.tokens);
        if (tokens) {
          node.tokens = tokens;
          this.nodeTokenSum = { in: (this.nodeTokenSum?.in ?? 0) + tokens.in, out: (this.nodeTokenSum?.out ?? 0) + tokens.out };
        }
        node.warnings = typeof data.warnings === 'number' ? data.warnings : node.warnings;
        node.streaming = [];
        return;
      }
      case 'node.failed': {
        node.status = 'failed';
        node.durationMs = numberOr(data.durationMs);
        if (isRecord(data.error)) node.error = data.error as unknown as RunError;
        node.willRetry = data.willRetry === true ? true : undefined;
        node.streaming = [];
        return;
      }
      case 'output.text.delta': {
        const field = typeof data.field === 'string' ? data.field : 'text';
        const previous = node.outputs[field];
        node.outputs = { ...node.outputs, [field]: `${typeof previous === 'string' ? previous : ''}${String(data.text ?? '')}` };
        if (!node.streaming.includes(field)) node.streaming = [...node.streaming, field];
        return;
      }
      case 'output.data': {
        const field = typeof data.field === 'string' ? data.field : 'value';
        node.outputs = { ...node.outputs, [field]: data.value };
        node.streaming = node.streaming.filter((name) => name !== field);
        return;
      }
      case 'output.audio.delta': {
        const field = typeof data.field === 'string' ? data.field : 'audio';
        const previous = node.outputs[field];
        const chunks = isRecord(previous) && typeof previous.chunks === 'number' ? previous.chunks : 0;
        node.outputs = { ...node.outputs, [field]: { format: data.format, chunks: chunks + 1 } };
        return;
      }
      case 'data.bound': {
        node.inputs = Array.isArray(data.inputs) ? (data.inputs.filter(isRecord) as unknown as BoundInput[]) : [];
        return;
      }
      case 'binding.warning': {
        node.bindingWarnings = [...node.bindingWarnings, { input: String(data.input ?? ''), code: String(data.code ?? ''), message: String(data.message ?? '') }];
        return;
      }
      case 'consultation.read': {
        if (typeof data.consultationId === 'string') this.view.consultation.consultationId = data.consultationId;
        const snapshot = data.snapshot === 'run-start' ? 'run-start' : 'node-start';
        const reads = Array.isArray(data.fields) ? data.fields.filter(isRecord) : [];
        let fields = this.view.consultation.fields;
        for (const read of reads) {
          if (typeof read.path !== 'string') continue;
          const entry: ConsultationFieldView = {
            path: read.path,
            phiClass: read.phiClass === 'NON_PHI' ? 'NON_PHI' : 'PHI',
            ...('value' in read ? { value: read.value } : {}),
            readBy: nodeId,
            ts: event.ts,
            snapshot,
          };
          fields = [...fields.filter((field) => !(field.path === entry.path && field.readBy === nodeId)), entry];
        }
        this.view.consultation.fields = fields;
        return;
      }
      case 'prompt.composed': {
        node.prompt = event.data;
        return;
      }
      case 'model.request': {
        node.modelRequests = [...node.modelRequests, event.data];
        return;
      }
      case 'guardrail.inbound':
      case 'guardrail.outbound': {
        node.guardrails = [...node.guardrails, { ...event.data, direction: event.type === 'guardrail.inbound' ? 'inbound' : 'outbound', seq: event.seq }];
        return;
      }
      case 'output.validated': {
        const problems = Array.isArray(data.problems) ? data.problems.filter((p): p is string => typeof p === 'string') : [];
        node.outputChecks = [...node.outputChecks, { valid: data.valid === true, problems, ...(typeof data.field === 'string' ? { field: data.field } : {}) }];
        return;
      }
      default:
        return;
    }
  }

  private addRunNotices(notices: readonly RunGuardrailNotice[]): void {
    if (notices.length === 0) return;
    this.view.guardrailNotices = [...mergeGuardrailNotices(this.view.guardrailNotices ?? [], notices)];
  }

  private clearPause(): void {
    if (!this.view.paused) return;
    const node = this.view.nodes[this.view.paused.nodeId];
    if (node) node.paused = false;
    this.view.paused = null;
  }

  private resync(event: RunEvent<'run.resync'>): void {
    const snapshot = isRecord(event.data.snapshot) ? event.data.snapshot : null;
    const kept = { kind: this.view.kind, slug: this.view.slug, versionNumber: this.view.versionNumber, startedAt: this.view.startedAt };
    const eventCount = this.view.eventCount;
    this.view = emptyView(this.view.runId ?? event.runId);
    this.starts = [];
    this.nodeTokenSum = null;
    this.runTokens = null;
    Object.assign(this.view, Object.fromEntries(Object.entries(kept).filter(([, value]) => value !== undefined)));
    this.view.eventCount = eventCount;
    this.view.lastSeq = event.seq;
    this.view.resync = { reason: String(event.data.reason ?? 'gap'), seq: event.seq };
    if (!snapshot) return;
    this.view.status = typeof snapshot.status === 'string' && RUN_STATUSES.has(snapshot.status) ? (snapshot.status as RunViewStatus) : 'RUNNING';
    const nodes = isRecord(snapshot.nodes) ? snapshot.nodes : {};
    const outputs = isRecord(snapshot.outputs) ? snapshot.outputs : {};
    for (const [id, entry] of Object.entries(nodes)) {
      const node = this.node(id);
      if (isRecord(entry)) {
        if (typeof entry.status === 'string' && NODE_STATUSES.has(entry.status)) node.status = entry.status as RunNodeStatus;
        node.durationMs = numberOr(entry.durationMs);
      }
      if (node.status === 'running') this.starts.push(id);
    }
    for (const [id, fields] of Object.entries(outputs)) {
      if (!isRecord(fields)) continue;
      this.node(id).outputs = { ...fields };
    }
    if (isRecord(snapshot.result)) this.view.result = snapshot.result as RunResult;
  }

  finish(): RunView {
    const active = [...this.starts].reverse().find((id) => this.view.nodes[id]?.status === 'running') ?? null;
    this.view.activeNodeId = active;
    this.view.tokens = this.runTokens ?? this.nodeTokenSum;
    return this.view;
  }
}

/**
 * Folds the first `upTo` events (all of them when omitted) into the run's view. Pure: the same
 * events always give the same view, which is what makes the time-travel cursor honest.
 */
export function foldRunEvents(events: readonly RunEvent[], upTo?: number, runId: string | null = null): RunView {
  const folder = new Folder(runId);
  const limit = upTo === undefined ? events.length : Math.max(0, Math.min(upTo, events.length));
  for (let index = 0; index < limit; index += 1) folder.apply(events[index]!);
  return folder.finish();
}

/** The inspector's Last run feed (`NodeLastRun` in `features/workflow-studio/components/inspector/last-run-tab.tsx`). */
export interface SandboxNodeLastRun {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  durationMs: number | null;
  status: string;
  tokens?: { in?: number; out?: number };
  error?: string;
}

const LAST_RUN_STATUS: Record<RunNodeStatus, string> = {
  waiting: 'WAITING',
  running: 'RUNNING',
  completed: 'SUCCEEDED',
  degraded: 'DEGRADED',
  failed: 'FAILED',
  skipped: 'SKIPPED',
};

export function nodeLastRunsOf(view: RunView): Record<string, SandboxNodeLastRun> {
  const out: Record<string, SandboxNodeLastRun> = {};
  for (const nodeId of view.nodeOrder) {
    const node = view.nodes[nodeId]!;
    out[nodeId] = {
      inputs: Object.fromEntries(node.inputs.map((input) => [input.input, input.value !== undefined ? input.value : input.empty ? '' : null])),
      outputs: { ...node.outputs },
      durationMs: node.durationMs ?? null,
      status: LAST_RUN_STATUS[node.status],
      ...(node.tokens ? { tokens: { in: node.tokens.in, out: node.tokens.out } } : {}),
      ...(node.error ? { error: `${node.error.code} — ${node.error.message}` } : {}),
    };
  }
  return out;
}
