import { createHash } from 'node:crypto';
import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IRedisCacheService,
  TenantSettingsService,
  WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
  WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY,
  readPersistedRunResult,
  type PersistedRunResult,
} from '@arcaai/applications';
import { WorkflowRunEntity, WorkflowRunFactory, WorkflowRunKind, WorkflowRunRepository, WorkflowRunStatus, generateId } from '@arcaai/domains';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AGENT_RUN_NODE_ID,
  RUN_RESULT_INLINE_MAX_BYTES,
  runErrorMessage,
  type RunError,
  type RunSnapshot,
  type RunStatus,
  type RunTokens,
} from '@arcaai/async-contract';
import { AgentRunEventStream, deterministicAgentRunId } from './agent-run.events';

export type AgentRunTask = 'TEXT_GENERATION' | 'NAMED_ENTITY_RECOGNITION';

/**
 * One agent run as the routes answer it — a READ of the `WorkflowRun` row (`kind = AGENT`), never
 * a document of its own. `output` is the inline result while it is retained; `result` is what the
 * row's `resultRef` means (`inline`, or the OD-25 `expired` tombstone), `null` when there is none.
 */
export interface AgentRunState {
  runId: string;
  tenantId: string;
  slug: string;
  agentVersionId: string;
  versionNumber: number;
  task: AgentRunTask | null;
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** The agent's output (`{ text }` / `{ entities }`) once COMPLETED and retained; `null` otherwise. */
  output: Record<string, unknown> | null;
  result: PersistedRunResult | null;
  /** The PUBLIC error of a FAILED / TIMED_OUT run (fixed label, no detail). */
  error: RunError | null;
  /** sha-256 of the canonical request body, when the run was started with an `Idempotency-Key`. */
  bodyHash: string | null;
}

/** What one execution of the agent produced. */
export interface AgentRunOutcome {
  output: Record<string, unknown>;
  tokens: RunTokens;
}

/**
 * Runs the agent once. Supplied by the controller, which owns the metering of the call it makes.
 * TASK-1038 E2 (fix 4, R2) — `signal` aborts when the run is cancelled or reaches its ceiling; the
 * executor passes it to the model call so in-flight work actually stops.
 */
export type AgentRunExecutor = (signal: AbortSignal) => Promise<AgentRunOutcome>;

export interface StartAgentRunInput {
  tenantId: string;
  slug: string;
  agentVersionId: string;
  versionNumber: number;
  task: AgentRunTask;
  body: unknown;
  idempotencyKey?: string;
  execute: AgentRunExecutor;
}

/** The run resource's links (OD-26) — the same four on every answer about a run. */
export function agentRunLinks(slug: string, runId: string): { self: string; events: string; result: string; cancel: string } {
  const self = `/api/v1/agents/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}`;
  return { self, events: `${self}/events`, result: `${self}/result`, cancel: `${self}/cancel` };
}

/** Deterministic JSON (sorted keys) — what the idempotency body hash is taken over. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function agentRunBodyHash(body: unknown): string {
  return createHash('sha256')
    .update(stableJson(body ?? {}), 'utf8')
    .digest('hex');
}

/**
 * The fixed-label error code for a failed execution (protocol v2 §8): never the exception's own
 * text, which may echo a model error or a patient value.
 */
export function agentRunErrorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const code = typeof response === 'object' && response !== null ? (response as { code?: unknown }).code : undefined;
    if (code === 'PROMPT_VARIABLE_UNRESOLVED') return 'PROMPT_VARIABLE_UNRESOLVED';
    if (code === 'AGENT_CONNECTION_UNAVAILABLE' || code === 'AGENT_MODEL_WIRE_ID_MISSING') return 'PROVIDER_NOT_CONFIGURED';
    if (status === 504) return 'RUN_TIMED_OUT';
    if (status === 502 || status === 503) return 'MODEL_UNAVAILABLE';
    if (status === 413) return 'PAYLOAD_TOO_LARGE';
    if (status >= 400 && status < 500) return 'INPUT_INVALID';
    return 'MODEL_ERROR';
  }
  return 'INTERNAL_ERROR';
}

const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** A terminal write re-reads after an OCC conflict at most this many times in total. */
const TRANSITION_ATTEMPTS = 3;

/** Stale AGENT rows one sweep reads; a larger backlog finishes on the next sweep (every minute). */
export const AGENT_RUN_SWEEP_PAGE = 500;

/** Why an in-flight execution was aborted. */
type AbortReason = 'cancelled' | 'timeout';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The row → the run as the routes answer it. */
export function agentRunStateOf(entity: WorkflowRunEntity): AgentRunState {
  const meta: Record<string, unknown> = entity.metaData ?? {};
  const result = readPersistedRunResult(entity.resultRef);
  const status = String(entity.status) as RunStatus;
  const code = entity.firstErrorCode;
  const task = meta.agentTask;
  const bodyHash = meta.requestBodyHash;
  return {
    runId: entity.runId,
    tenantId: entity.tenantId,
    slug: entity.agentSlug ?? '',
    agentVersionId: entity.agentVersionId ?? '',
    versionNumber: entity.agentVersionNumber ?? 0,
    task: task === 'TEXT_GENERATION' || task === 'NAMED_ENTITY_RECOGNITION' ? task : null,
    status,
    createdAt: entity.startedAt.toISOString(),
    endedAt: entity.endedAt ? entity.endedAt.toISOString() : null,
    durationMs: entity.durationMs ?? null,
    output: result?.kind === 'inline' && isRecord(result.value) ? result.value : null,
    result,
    error: code && (status === 'FAILED' || status === 'TIMED_OUT') ? { code, message: runErrorMessage(code) } : null,
    bodyHash: typeof bodyHash === 'string' ? bodyHash : null,
  };
}

/**
 * TASK-1038 OD-26 — `POST /agents/:slug/runs`: an agent invocation as a RUN.
 *
 * Start returns at once with `{ runId, status, links }`; the call executes in the background and
 * its outcome is read by polling (`GET …/runs/:runId`, `…/result`) or by following the run's v2
 * event stream (`…/events`). The events go through the ONE run sequencer, so a client resumes and
 * detects loss exactly as on a workflow run; an agent run has one step, `nodeId: 'agent'`
 * (`AGENT_RUN_NODE_ID`).
 *
 * The run's STATE and RESULT are a Postgres row of the run read model (`WorkflowRun`,
 * `kind = AGENT`, anchored at `agent-run-<runId>`; lane B6a), so a run outlives a restart and its
 * output is the A2-purgeable `resultRef = { kind: 'inline', value }` — expired after
 * `workflowRuns.resultRetentionDays` by `WorkflowRunResultRetentionService` like any workflow
 * result. Redis carries only the event stream (`AgentRunEventStream`), best effort.
 *
 * Idempotency: with an `Idempotency-Key` the run id is DERIVED from `(tenant, slug, key)`, and the
 * row's unique key `(tenantId, sessionId, runId)` admits ONE start: a concurrent or later start of
 * the same key finds (or collides with) that row. The same key with the same body joins the run it
 * started; the same key with a DIFFERENT body is a 409 — the caller is reusing a key for a second
 * intent. The body hash rides in the row's `_metadata`.
 *
 * Cancel is idempotent and races completion through the row's `_version` compare-and-set:
 * whichever lands first decides the terminal status.
 *
 * TASK-1038 E2 (fix 4, R2) — every run is BOUNDED and cancel STOPS work:
 * - the executor gets an `AbortSignal`, which the model call carries. A cancel aborts it at once
 *   on the instance executing the run; any other instance's cancel is noticed at the executing
 *   instance's next status re-check (`workflowRuns.streamTerminalCheckSeconds`). Whatever the
 *   provider already spent is still metered by the caller when it reports usage;
 * - a run still executing at `workflowRuns.agentRunMaxSeconds` (platform-only) is aborted and ends
 *   TIMED_OUT (`RUN_TIMED_OUT`);
 * - `sweepStaleRuns` (every minute) moves a `kind = AGENT` row left RUNNING past that ceiling by a
 *   process that is gone to TIMED_OUT, with `node.failed` + `run.failed` on its stream.
 */
@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);
  readonly events: AgentRunEventStream;
  /** The runs THIS instance is executing, by runId — what a cancel or the ceiling aborts. */
  private readonly inFlight = new Map<string, AbortController>();
  now: () => Date = () => new Date();

  constructor(
    private readonly runs: WorkflowRunRepository,
    @Optional() @Inject(IRedisCacheService) redis?: IRedisCacheService,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {
    this.events = new AgentRunEventStream(redis);
  }

  /**
   * TASK-1038 E2 (fix 10) — the run an `Idempotency-Key` already started, JOINED, or `null` when the
   * key has started nothing. The controller asks this BEFORE its prechecks (validation, quota,
   * spend): a retry of an accepted request must reach its run, never a meter it already passed.
   * A different body under the key is the 409 `IDEMPOTENCY_KEY_REUSED`.
   */
  async joinExisting(input: { tenantId: string; slug: string; idempotencyKey: string; body: unknown }): Promise<AgentRunState | null> {
    const runId = deterministicAgentRunId(input.tenantId, input.slug, input.idempotencyKey);
    const existing = await this.runs.findAgentRun(input.tenantId, runId);
    return existing ? this.join(existing, input.slug, agentRunBodyHash(input.body)) : null;
  }

  /**
   * TASK-1038 E2 (fix 8) — the §6.1 terminal backstop on THIS run's stream (agent runs own their
   * stream, so the gateway closes it with the run's own retention). Best effort.
   */
  async closeStreamAfterTerminal(runId: string): Promise<void> {
    if (!this.events.available()) return;
    try {
      await this.events.closeAfterTerminal(runId, this.eventRetentionSeconds());
    } catch (error) {
      this.logger.warn({ message: 'Agent run stream could not be closed', runId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async start(input: StartAgentRunInput): Promise<{ state: AgentRunState; created: boolean }> {
    const bodyHash = input.idempotencyKey !== undefined ? agentRunBodyHash(input.body) : null;
    const runId = input.idempotencyKey !== undefined ? deterministicAgentRunId(input.tenantId, input.slug, input.idempotencyKey) : generateId();

    if (bodyHash !== null) {
      const existing = await this.runs.findAgentRun(input.tenantId, runId);
      if (existing) return { state: this.join(existing, input.slug, bodyHash), created: false };
    }

    const entity = WorkflowRunFactory.CreateAgentRun({
      tenantId: input.tenantId,
      runId,
      agentSlug: input.slug,
      agentVersionId: input.agentVersionId,
      agentVersionNumber: input.versionNumber,
      startedAt: new Date(),
      metaData: { agentTask: input.task, ...(bodyHash !== null ? { requestBodyHash: bodyHash } : {}) },
    });
    let saved: WorkflowRunEntity;
    try {
      saved = await this.runs.create(entity);
    } catch (error) {
      // Lost the race for this key's row to a concurrent start: join (or refuse) that one.
      if (bodyHash !== null && isUniqueViolation(error)) {
        const existing = await this.runs.findAgentRun(input.tenantId, runId);
        if (existing) return { state: this.join(existing, input.slug, bodyHash), created: false };
      }
      throw error;
    }

    const state = agentRunStateOf(saved);
    await this.safeAppend({
      runId,
      type: 'run.started',
      ts: state.createdAt,
      data: { kind: 'agent', slug: input.slug, versionNumber: input.versionNumber, mode: 'async' },
      dedupeKey: `wf:run:${runId}:started`,
    });
    await this.safeAppend({
      runId,
      type: 'node.started',
      ts: new Date().toISOString(),
      nodeId: AGENT_RUN_NODE_ID,
      data: { kind: 'core.agent', label: input.slug, attempt: 1 },
      dedupeKey: `wf:run:${runId}:node:${AGENT_RUN_NODE_ID}:1:started`,
    });
    void this.execute(state, input.execute).catch((error) =>
      this.logger.error({
        message: 'Agent run could not record its outcome',
        runId,
        agentSlug: input.slug,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return { state, created: true };
  }

  /** The run, by id, within the caller's tenant and this slug's lineage — else one 404. */
  async get(tenantId: string, slug: string, runId: string): Promise<AgentRunState> {
    const entity = await this.runs.findAgentRun(tenantId, runId);
    if (!entity || entity.tenantId !== tenantId || entity.agentSlug !== slug) throw new NotFoundException('Agent run not found');
    return agentRunStateOf(entity);
  }

  /** Idempotent: a terminal run is returned as it is; a RUNNING one becomes CANCELED. */
  async cancel(tenantId: string, slug: string, runId: string): Promise<AgentRunState> {
    const state = await this.get(tenantId, slug, runId);
    if (TERMINAL.has(state.status)) return state;
    const endedAt = new Date();
    const saved = await this.transition(tenantId, runId, (entity) => {
      entity.status = WorkflowRunStatus.CANCELED;
      entity.endedAt = endedAt;
      entity.durationMs = Math.max(0, endedAt.getTime() - entity.startedAt.getTime());
    });
    if (!saved) return this.get(tenantId, slug, runId);
    // R2 — stop the model call this instance is making for it (another instance notices at its
    // next status re-check).
    this.abortInFlight(runId, 'cancelled');
    const next = agentRunStateOf(saved);
    await this.safeAppend({
      runId,
      type: 'run.cancelled',
      ts: next.endedAt as string,
      data: { status: 'CANCELED', durationMs: next.durationMs as number, reason: 'cancelled' },
      dedupeKey: `wf:run:${runId}:cancelled`,
      retentionSeconds: this.eventRetentionSeconds(),
    });
    return next;
  }

  /**
   * The run's state as a `run.resync` snapshot (public plane: the agent's output is public — it
   * is the run's End-wired output by construction, one step and nothing else).
   */
  snapshotOf(state: AgentRunState, lastSeq: number): RunSnapshot {
    const nodeStatus =
      state.status === 'COMPLETED' ? 'completed' : state.status === 'RUNNING' ? 'running' : state.status === 'CANCELED' ? 'skipped' : 'failed';
    return {
      status: state.status,
      lastSeq,
      nodes: { [AGENT_RUN_NODE_ID]: { status: nodeStatus, ...(state.durationMs !== null ? { durationMs: state.durationMs } : {}) } },
      outputs: state.output ? { [AGENT_RUN_NODE_ID]: state.output } : {},
      ...(state.status === 'COMPLETED' && state.output && this.fitsInline(state.output) ? { result: { kind: 'inline', value: state.output } } : {}),
    };
  }

  /**
   * TASK-1038 E2 (fix 4, R2) — the backstop for a run nothing is executing any more (its process
   * died, its promise was lost): every `kind = AGENT` row RUNNING longer than
   * `workflowRuns.agentRunMaxSeconds` becomes TIMED_OUT (`RUN_TIMED_OUT`), with `node.failed` +
   * `run.failed` on its stream. Idempotent and safe on every instance at once: each move is the
   * row's `_version` compare-and-set out of RUNNING, and the events carry dedupe keys. Outside a
   * request the tenant-scope extension sees no CLS tenant, so the read spans tenants (the
   * retention purges' posture).
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'agent-run-ceiling-sweep' })
  async sweep(): Promise<void> {
    await this.sweepStaleRuns().catch((error) =>
      this.logger.error({ message: 'Agent run ceiling sweep failed', error: error instanceof Error ? error.name : 'unknown' }),
    );
  }

  async sweepStaleRuns(): Promise<{ timedOut: number }> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - this.maxRunSeconds() * 1000);
    const rows: WorkflowRunEntity[] = await this.runs.findAll({
      where: { kind: WorkflowRunKind.AGENT, status: WorkflowRunStatus.RUNNING, startedAt: { lt: cutoff } } as never,
      sort: [{ startedAt: 'asc' }, { id: 'asc' }],
      limit: AGENT_RUN_SWEEP_PAGE,
    });
    let timedOut = 0;
    for (const row of rows) {
      const state = agentRunStateOf(row);
      this.abortInFlight(state.runId, 'timeout');
      if (await this.fail(state, null, row.startedAt.getTime(), { code: 'RUN_TIMED_OUT', endedAt: now })) timedOut += 1;
    }
    if (timedOut > 0) this.logger.warn({ message: 'Agent runs past their ceiling were timed out', timedOut });
    return { timedOut };
  }

  // ---------------------------------------------------------------------------------------------

  private async execute(state: AgentRunState, execute: AgentRunExecutor): Promise<void> {
    const startedAt = Date.parse(state.createdAt);
    const controller = new AbortController();
    this.inFlight.set(state.runId, controller);
    // R2 — the ceiling, measured from the run's start.
    const deadline = setTimeout(
      () => this.abortInFlight(state.runId, 'timeout'),
      Math.max(0, startedAt + this.maxRunSeconds() * 1000 - Date.now()),
    );
    // R2 — a cancel decided on ANOTHER instance: re-read the row and stop when it left RUNNING.
    const recheck = setInterval(() => void this.stopIfNoLongerRunning(state), this.recheckSeconds() * 1000);
    deadline.unref?.();
    recheck.unref?.();
    let outcome: AgentRunOutcome;
    try {
      outcome = await execute(controller.signal);
    } catch (error) {
      const reason = controller.signal.aborted ? (controller.signal.reason as AbortReason | undefined) : undefined;
      // Cancelled (here or elsewhere): the row already says so — nothing to record, nothing to warn.
      if (reason === 'cancelled') return;
      await this.fail(state, error, startedAt, reason === 'timeout' ? { code: 'RUN_TIMED_OUT' } : undefined);
      return;
    } finally {
      clearTimeout(deadline);
      clearInterval(recheck);
      if (this.inFlight.get(state.runId) === controller) this.inFlight.delete(state.runId);
    }
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt);
    const saved = await this.transition(state.tenantId, state.runId, (entity) => {
      entity.status = WorkflowRunStatus.COMPLETED;
      entity.endedAt = endedAt;
      entity.durationMs = durationMs;
      // The run's result, in the shape workflow results use, so the OD-25 purge expires it.
      entity.resultRef = { kind: 'inline', value: outcome.output } as never;
    });
    if (!saved) return; // cancelled first: the output is discarded.

    const ts = endedAt.toISOString();
    const text = outcome.output.text;
    if (typeof text === 'string' && text.length > 0) {
      await this.safeAppend({ runId: state.runId, type: 'output.text.delta', ts, nodeId: AGENT_RUN_NODE_ID, data: { field: 'text', text } });
    }
    for (const [field, value] of Object.entries(outcome.output)) {
      if (field === 'text') continue;
      await this.safeAppend({
        runId: state.runId,
        type: 'output.data',
        ts,
        nodeId: AGENT_RUN_NODE_ID,
        data: { field, value },
        dedupeKey: `wf:run:${state.runId}:node:${AGENT_RUN_NODE_ID}:1:output:${field}`,
      });
    }
    await this.safeAppend({
      runId: state.runId,
      type: 'node.completed',
      ts,
      nodeId: AGENT_RUN_NODE_ID,
      data: { status: 'COMPLETED', durationMs, tokens: outcome.tokens },
      dedupeKey: `wf:run:${state.runId}:node:${AGENT_RUN_NODE_ID}:1:completed`,
    });
    await this.safeAppend({
      runId: state.runId,
      type: 'run.completed',
      ts,
      data: {
        status: 'COMPLETED',
        durationMs,
        tokens: outcome.tokens,
        // ≤ 64 KiB rides inline; a larger output is read from `GET …/result`, never truncated here.
        ...(this.fitsInline(outcome.output) ? { result: { kind: 'inline', value: outcome.output } } : {}),
      },
      dedupeKey: `wf:run:${state.runId}:completed`,
      retentionSeconds: this.eventRetentionSeconds(),
    });
  }

  /**
   * Move the run to FAILED / TIMED_OUT and append `node.failed` + `run.failed`. `override.code`
   * replaces the code derived from `cause` (the ceiling, the sweep). `true` when THIS call decided
   * the transition.
   */
  private async fail(state: AgentRunState, cause: unknown, startedAt: number, override?: { code?: string; endedAt?: Date }): Promise<boolean> {
    const code = override?.code ?? agentRunErrorCode(cause);
    const status = code === 'RUN_TIMED_OUT' ? WorkflowRunStatus.TIMED_OUT : WorkflowRunStatus.FAILED;
    const error: RunError = { code, message: runErrorMessage(code) };
    const endedAt = override?.endedAt ?? new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt);
    this.logger.warn({
      message: 'Agent run failed',
      runId: state.runId,
      agentSlug: state.slug,
      code,
      error: cause instanceof Error ? cause.name : 'unknown',
    });
    const saved = await this.transition(state.tenantId, state.runId, (entity) => {
      entity.status = status;
      entity.endedAt = endedAt;
      entity.durationMs = durationMs;
      // The fixed-label code only — the public message is `runErrorMessage(code)`; never the cause.
      entity.firstErrorCode = code;
      entity.failedNodeCount = 1;
    });
    if (!saved) return false;
    const ts = endedAt.toISOString();
    await this.safeAppend({
      runId: state.runId,
      type: 'node.failed',
      ts,
      nodeId: AGENT_RUN_NODE_ID,
      data: { durationMs, error: { ...error, nodeId: AGENT_RUN_NODE_ID }, attempt: 1, willRetry: false },
      dedupeKey: `wf:run:${state.runId}:node:${AGENT_RUN_NODE_ID}:1:failed`,
    });
    await this.safeAppend({
      runId: state.runId,
      type: 'run.failed',
      ts,
      data: { status, durationMs, error },
      dedupeKey: `wf:run:${state.runId}:failed`,
      retentionSeconds: this.eventRetentionSeconds(),
    });
    return true;
  }

  /** Abort the execution THIS instance runs for `runId`, if any. */
  private abortInFlight(runId: string, reason: AbortReason): void {
    const controller = this.inFlight.get(runId);
    if (controller && !controller.signal.aborted) controller.abort(reason);
  }

  /** A cancel decided elsewhere: the row left RUNNING, so the call this instance makes is moot. */
  private async stopIfNoLongerRunning(state: AgentRunState): Promise<void> {
    try {
      const row = await this.runs.findAgentRun(state.tenantId, state.runId);
      if (row && row.status !== WorkflowRunStatus.RUNNING) this.abortInFlight(state.runId, 'cancelled');
    } catch {
      // swallow-ok: a failed re-read means "ask again next interval"; the ceiling still bounds the run.
    }
  }

  /** R2 — `workflowRuns.agentRunMaxSeconds` (platform). */
  private maxRunSeconds(): number {
    return this.platformWholeNumber(WORKFLOW_RUNS_AGENT_RUN_MAX_SECONDS_KEY, WORKFLOW_RUNS_DEFAULTS.agentRunMaxSeconds, 1);
  }

  /** The status re-check cadence the delivery plane already uses (`workflowRuns.streamTerminalCheckSeconds`). */
  private recheckSeconds(): number {
    return this.platformWholeNumber(WORKFLOW_RUNS_TERMINAL_CHECK_SECONDS_KEY, WORKFLOW_RUNS_DEFAULTS.streamTerminalCheckSeconds, 1);
  }

  private platformWholeNumber(key: string, fallback: number, min: number): number {
    try {
      const value = this.settings?.resolvePlatform<number>(key).value;
      return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Move a RUNNING run to its terminal state through the row's `_version` compare-and-set.
   * Returns the saved row when THIS call decided the transition, `null` when the run was already
   * terminal (a cancel or the completion got there first). An OCC conflict re-reads and decides
   * again — the row is only ever moved out of RUNNING once.
   */
  private async transition(tenantId: string, runId: string, apply: (entity: WorkflowRunEntity) => void): Promise<WorkflowRunEntity | null> {
    for (let attempt = 0; attempt < TRANSITION_ATTEMPTS; attempt++) {
      const entity = await this.runs.findAgentRun(tenantId, runId);
      if (!entity || entity.status !== WorkflowRunStatus.RUNNING) return null;
      apply(entity);
      try {
        return await this.runs.updateWithVersion(entity.id, entity, entity.version);
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyException)) throw error;
      }
    }
    return null;
  }

  /** An `Idempotency-Key` that already started a run: join it, or refuse a different body (409). */
  private join(existing: WorkflowRunEntity, slug: string, bodyHash: string): AgentRunState {
    const state = agentRunStateOf(existing);
    if (state.slug !== slug || state.bodyHash !== bodyHash) {
      // TASK-1038 E2 (fix 11) — no `runId`: the key's first request may be someone else's, and its
      // run id is a handle to that run. The caller learns only that the key is taken.
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key already started a run with a different request body. Use a new key for a new request.',
      });
    }
    return state;
  }

  /** Protocol v2 §6.1: the stream mirrors the run and never fails it. */
  private async safeAppend(input: Parameters<AgentRunEventStream['append']>[0]): Promise<void> {
    // No Redis: the run is still recorded (Postgres) and readable; a follower gets a resync snapshot.
    if (!this.events.available()) return;
    try {
      await this.events.append(input);
    } catch (error) {
      this.logger.warn({
        message: 'Agent run event append failed',
        runId: input.runId,
        type: input.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private fitsInline(output: Record<string, unknown>): boolean {
    return Buffer.byteLength(JSON.stringify(output), 'utf8') <= RUN_RESULT_INLINE_MAX_BYTES;
  }

  /** OD-25 — `workflowRuns.eventRetentionHours` (platform), in seconds. */
  private eventRetentionSeconds(): number {
    try {
      const value = this.settings?.resolvePlatform<number>(WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY).value;
      const hours = typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.eventRetentionHours;
      return hours * 3600;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.eventRetentionHours * 3600;
    }
  }
}
