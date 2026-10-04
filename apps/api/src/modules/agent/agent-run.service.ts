import { createHash } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IRedisCacheService,
  TenantSettingsService,
  WORKFLOW_RUNS_DEFAULTS,
  WORKFLOW_RUNS_EVENT_RETENTION_HOURS_KEY,
  WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY,
} from '@arcaai/applications';
import { generateId } from '@arcaai/domains';
import {
  AGENT_RUN_NODE_ID,
  RUN_RESULT_INLINE_MAX_BYTES,
  runErrorMessage,
  type RunError,
  type RunSnapshot,
  type RunTokens,
} from '@arcaai/async-contract';
import { AgentRunStore, AgentRunStoreUnavailableError, deterministicAgentRunId, type AgentRunState, type AgentRunTask } from './agent-run.store';

/** What one execution of the agent produced. */
export interface AgentRunOutcome {
  output: Record<string, unknown>;
  tokens: RunTokens;
}

/** Runs the agent once. Supplied by the controller, which owns the metering of the call it makes. */
export type AgentRunExecutor = () => Promise<AgentRunOutcome>;

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

/**
 * TASK-1038 OD-26 — `POST /agents/:slug/runs`: an agent invocation as a RUN.
 *
 * Start returns at once with `{ runId, status, links }`; the call executes in the background and
 * its outcome is read by polling (`GET …/runs/:runId`, `…/result`) or by following the run's v2
 * event stream (`…/events`). The events go through the ONE run sequencer, so a client resumes and
 * detects loss exactly as on a workflow run; an agent run has one step, `nodeId: 'agent'`
 * (`AGENT_RUN_NODE_ID`).
 *
 * Idempotency: with an `Idempotency-Key` the run id is DERIVED from `(tenant, slug, key)` and the
 * key is claimed with the body's hash. The same key with the same body joins the run it started;
 * the same key with a DIFFERENT body is a 409 — the caller is reusing a key for a second intent.
 *
 * Cancel is idempotent and races completion through a compare-and-set: whichever lands first
 * decides the terminal status. A model call already in flight is not interrupted (the text plane
 * has no abort), so its output is discarded — and it is still metered, because it was spent.
 */
@Injectable()
export class AgentRunService {
  private readonly logger = new Logger(AgentRunService.name);
  readonly store: AgentRunStore;

  constructor(
    @Optional() @Inject(IRedisCacheService) redis?: IRedisCacheService,
    @Optional() private readonly settings?: TenantSettingsService,
  ) {
    this.store = new AgentRunStore(redis);
  }

  async start(input: StartAgentRunInput): Promise<{ state: AgentRunState; created: boolean }> {
    if (!this.store.available()) throw this.unavailable();
    const bodyHash = input.idempotencyKey !== undefined ? agentRunBodyHash(input.body) : null;
    const runId = input.idempotencyKey !== undefined ? deterministicAgentRunId(input.tenantId, input.slug, input.idempotencyKey) : generateId();
    const resultTtl = this.resultRetentionSeconds(input.tenantId);

    try {
      if (input.idempotencyKey !== undefined && bodyHash !== null) {
        const owner = await this.store.claimIdempotencyKey(input.tenantId, input.slug, input.idempotencyKey, { runId, bodyHash }, resultTtl);
        if (owner.bodyHash !== bodyHash || owner.runId !== runId) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key already started a run with a different request body. Use a new key for a new request.',
            runId: owner.runId,
          });
        }
        const existing = await this.store.get(input.tenantId, runId);
        if (existing) return { state: existing, created: false };
      }

      const state: AgentRunState = {
        runId,
        tenantId: input.tenantId,
        slug: input.slug,
        agentVersionId: input.agentVersionId,
        versionNumber: input.versionNumber,
        task: input.task,
        status: 'RUNNING',
        createdAt: new Date().toISOString(),
        endedAt: null,
        durationMs: null,
        output: null,
        error: null,
        bodyHash,
      };
      await this.store.create(state, resultTtl);
      await this.store.append({
        runId,
        type: 'run.started',
        ts: state.createdAt,
        data: { kind: 'agent', slug: input.slug, versionNumber: input.versionNumber, mode: 'async' },
        dedupeKey: `wf:run:${runId}:started`,
      });
      await this.store.append({
        runId,
        type: 'node.started',
        ts: new Date().toISOString(),
        nodeId: AGENT_RUN_NODE_ID,
        data: { kind: 'core.agent', label: input.slug, attempt: 1 },
        dedupeKey: `wf:run:${runId}:node:${AGENT_RUN_NODE_ID}:1:started`,
      });
      void this.execute(state, input.execute);
      return { state, created: true };
    } catch (error) {
      if (error instanceof AgentRunStoreUnavailableError) throw this.unavailable();
      throw error;
    }
  }

  /** The run, by id, within the caller's tenant and this slug's lineage — else one 404. */
  async get(tenantId: string, slug: string, runId: string): Promise<AgentRunState> {
    if (!this.store.available()) throw this.unavailable();
    const state = await this.store.get(tenantId, runId);
    if (!state || state.slug !== slug || state.tenantId !== tenantId) throw new NotFoundException('Agent run not found');
    return state;
  }

  /** Idempotent: a terminal run is returned as it is; a RUNNING one becomes CANCELED. */
  async cancel(tenantId: string, slug: string, runId: string): Promise<AgentRunState> {
    const state = await this.get(tenantId, slug, runId);
    if (TERMINAL.has(state.status)) return state;
    const endedAt = new Date();
    const next: AgentRunState = { ...state, status: 'CANCELED', endedAt: endedAt.toISOString(), durationMs: this.elapsed(state, endedAt) };
    const won = await this.store.transition(next, this.resultRetentionSeconds(tenantId));
    if (!won) return this.get(tenantId, slug, runId);
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

  // ---------------------------------------------------------------------------------------------

  private async execute(state: AgentRunState, execute: AgentRunExecutor): Promise<void> {
    const startedAt = Date.parse(state.createdAt);
    let outcome: AgentRunOutcome;
    try {
      outcome = await execute();
    } catch (error) {
      await this.fail(state, error, startedAt);
      return;
    }
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt);
    const next: AgentRunState = { ...state, status: 'COMPLETED', endedAt: endedAt.toISOString(), durationMs, output: outcome.output };
    const won = await this.store.transition(next, this.resultRetentionSeconds(state.tenantId)).catch(() => false);
    if (!won) return; // cancelled first: the output is discarded.

    const ts = next.endedAt as string;
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

  private async fail(state: AgentRunState, cause: unknown, startedAt: number): Promise<void> {
    const code = agentRunErrorCode(cause);
    const status = code === 'RUN_TIMED_OUT' ? 'TIMED_OUT' : 'FAILED';
    const error: RunError = { code, message: runErrorMessage(code) };
    const endedAt = new Date();
    const durationMs = Math.max(0, endedAt.getTime() - startedAt);
    this.logger.warn({
      message: 'Agent run failed',
      runId: state.runId,
      agentSlug: state.slug,
      code,
      error: cause instanceof Error ? cause.name : 'unknown',
    });
    const next: AgentRunState = { ...state, status, endedAt: endedAt.toISOString(), durationMs, error };
    const won = await this.store.transition(next, this.resultRetentionSeconds(state.tenantId)).catch(() => false);
    if (!won) return;
    const ts = next.endedAt as string;
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
  }

  /** Protocol v2 §6.1: the stream mirrors the run and never fails it. */
  private async safeAppend(input: Parameters<AgentRunStore['append']>[0]): Promise<void> {
    try {
      await this.store.append(input);
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

  private elapsed(state: AgentRunState, at: Date): number {
    return Math.max(0, at.getTime() - Date.parse(state.createdAt));
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

  /** OD-25 — `workflowRuns.resultRetentionDays` (tenant → platform), in seconds: how long the run's state and result are kept. */
  private resultRetentionSeconds(tenantId: string): number {
    try {
      const value = this.settings?.resolve<number>(WORKFLOW_RUNS_RESULT_RETENTION_DAYS_KEY, tenantId).value;
      const days = typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : WORKFLOW_RUNS_DEFAULTS.resultRetentionDays;
      return days * 86_400;
    } catch {
      return WORKFLOW_RUNS_DEFAULTS.resultRetentionDays * 86_400;
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'AGENT_RUN_STORE_UNAVAILABLE',
      message: 'Agent runs are unavailable: the run store is not reachable.',
    });
  }
}
