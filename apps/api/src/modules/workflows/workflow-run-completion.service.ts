import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { HarnessInternalService, IConfigService, IWorkflowRunService, createWorkerSession, interpreterSessionId } from '@arcaai/applications';
import type { IActiveUserContext } from '@arcaai/applications';
import { RESUME_FROM_BEGINNING, parseAsyncEnvelope } from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import { WORKFLOW_RUN_COMPLETED, runEventStreamKey } from './workflow-run-event';

/** How long ONE watcher stays attached before giving up — a run's own ceiling, not a poll interval. */
export const RUN_COMPLETION_WATCH_CEILING_MS = 6 * 60 * 60 * 1000;
/** A single blocking `XREAD` parks this long before re-checking liveness. */
const RUN_COMPLETION_BLOCK_MS = 15_000;
/** Watchers per process. A run past the cap is reconciled by the next status read, as before. */
export const RUN_COMPLETION_MAX_WATCHERS = 256;

/** The interpreter's `workflow.run.completed` status vocabulary → the read model's. */
export function terminalStatusOf(status: unknown): 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT' | null {
  switch (status) {
    case 'SUCCEEDED':
    case 'DEGRADED':
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
    case 'CANCELED':
      return 'CANCELED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    default:
      return null;
  }
}

/**
 * `WorkflowRunCompletionService` — TASK-864 §3.3, the fix for finding G9.
 *
 * Until now a run's TERMINAL status reached the read model only when someone READ it
 * (`getRunStatus` → `syncTerminalStatus`): a fire-and-forget `mode=async` run with no reader
 * stayed `RUNNING` forever, and no run-completed webhook could ever fire. This service is the
 * background consumer that closes that: after every invoke it attaches a watcher to the run's
 * event stream (`wf:run:<runId>:events`, the SAME transport the SSE route reads — one producer,
 * one terminal definition), detached from any HTTP connection, and on `workflow.run.completed`
 * calls `recordRunFinished` inside a CLS context carrying the run's tenant — which is what makes
 * the resulting `WorkflowRun` sys-event fan out to that tenant's webhooks.
 *
 * Process-local and bounded rather than a BullMQ job: the transport is already durable
 * (Temporal + the retained stream), a watcher is one blocking `XREAD` on a dedicated connection,
 * and a run that outlives the ceiling or a restart is still reconciled by the next status read,
 * exactly as before. Recorded as a deviation from the ticket's "BullMQ processor" wording.
 */
@Injectable()
export class WorkflowRunCompletionService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowRunCompletionService.name);
  private readonly watching = new Map<string, Promise<void>>();
  private redis: Redis | null = null;
  private redisUnavailable = false;
  private closed = false;

  constructor(
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    // TASK-946 OD-4 — the consultation lifecycle's single writer for this outcome. `@Optional()`
    // so a Nest context without the harness-internal plane still records run terminality; absent
    // ⇒ a failed consultation run leaves the consultation to the 24h timeout sweep, which is the
    // pre-existing behaviour rather than a new failure.
    @Optional() private readonly harnessInternal?: HarnessInternalService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.redis) {
      await this.redis.quit().catch(() => {});
      this.redis = null;
    }
  }

  /** Attach a watcher for `runId`. Idempotent; never throws; returns whether one is attached. */
  watch(tenantId: string, runId: string, consultationId?: string | null): boolean {
    if (this.closed || this.watching.has(runId)) return this.watching.has(runId);
    if (this.watching.size >= RUN_COMPLETION_MAX_WATCHERS) return false;
    const redis = this.reader();
    if (redis === null) return false;
    const task = this.consume(redis, tenantId, runId, consultationId ?? null)
      .catch((err) => this.logger.warn({ message: 'run completion watcher failed', runId, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.watching.delete(runId));
    this.watching.set(runId, task);
    return true;
  }

  /** Exposed for tests and the status route's own reconciliation. */
  get activeWatchers(): number {
    return this.watching.size;
  }

  private async consume(redis: Redis, tenantId: string, runId: string, consultationId: string | null): Promise<void> {
    const streamKey = runEventStreamKey(runId);
    const deadline = Date.now() + RUN_COMPLETION_WATCH_CEILING_MS;
    let cursor = RESUME_FROM_BEGINNING;
    while (!this.closed && Date.now() < deadline) {
      const result = await redis.xread('COUNT', 200, 'BLOCK', RUN_COMPLETION_BLOCK_MS, 'STREAMS', streamKey, cursor);
      if (!result) continue;
      for (const [entryId, fields] of result[0][1] as [string, string[]][]) {
        cursor = entryId;
        const envelope = this.parse(fields);
        if (envelope?.type !== WORKFLOW_RUN_COMPLETED) continue;
        const status = terminalStatusOf((envelope.payload as { status?: unknown } | undefined)?.status);
        if (status === null) return;
        await this.recordTerminal(
          tenantId,
          runId,
          status,
          String((envelope.payload as { status?: unknown }).status),
          envelope.occurredAt,
          consultationId,
        );
        return;
      }
    }
  }

  /**
   * Apply ONE run's terminal outcome. The watcher loop's only side effect, and the seam this
   * service's tests drive directly (there is no other way to reach it without a live Redis).
   *
   * TWO INDEPENDENT WRITES, deliberately. The read-model row and the consultation's lifecycle
   * are different systems of record, and on 2026-09-10 the failure of the first is exactly what
   * left the second stranded. Each is therefore attempted and logged on its own: a run row that
   * cannot be resolved must not stop a consultation from reaching a terminal state, and a
   * consultation that refuses the transition must not lose the run's terminal status.
   *
   * Node counts (`nodeCount`/`failedNodeCount`/`degradedNodeCount`) are NOT reported here. The
   * interpreter's `workflow.run.completed` payload carries `status` and an optional `reason` and
   * nothing else (`apps/harness/.../interpreter/activities.py::_envelope_for`), so passing a
   * count would mean inventing one; the columns are left untouched instead.
   */
  async recordTerminal(
    tenantId: string,
    runId: string,
    status: 'COMPLETED' | 'FAILED' | 'CANCELED' | 'TIMED_OUT',
    reason: string,
    endedAt: string,
    consultationId: string | null,
  ): Promise<void> {
    // A CLS context carrying the run's tenant: `broadcastSysEvent` stamps `tenantId` from CLS,
    // and the webhook matcher finds a tenant's subscriptions by it. Without this the event would
    // carry the SYSTEM tenant and fan out to no one — the same reason the delivery processor
    // opens a worker session.
    await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ tenantId, kind: 'workflow-run-completion' }));

      try {
        await this.workflowRunService.recordRunFinished({
          tenantId,
          // `recordRunFinished` resolves BOTH conventional session keys (TASK-946 D3), so a
          // consultation-dispatched run — anchored as `wf-<runId>` — reaches its own row.
          sessionId: interpreterSessionId(runId),
          runId,
          status,
          endedAt: new Date(endedAt),
          terminalReason: reason,
          consultationId,
        });
      } catch (err) {
        this.logger.warn({
          message: 'run terminal status could not be recorded on the run read model',
          runId,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // TASK-946 OD-4 — a governed consultation whose run ended with no clinical result reaches
      // `CLOSED_INCOMPLETE` instead of sitting in `DRAINING` until the 24h sweep. `COMPLETED`
      // (SUCCEEDED/DEGRADED) changes nothing: `persistDraft`/`finalizeAssurance` own success.
      // `CANCELED` is likewise left alone — whoever cancelled the run owns what happens next.
      if (consultationId && (status === 'FAILED' || status === 'TIMED_OUT')) {
        try {
          await this.harnessInternal?.failGovernedRun(consultationId, { tenantId, runId, status, reason, at: new Date(endedAt) });
        } catch (err) {
          this.logger.warn({
            message: 'governed consultation could not be closed after its run failed — it falls back to the session-timeout sweep',
            runId,
            consultationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }

  private parse(fields: string[]): ReturnType<typeof parseAsyncEnvelope> {
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] !== 'data') continue;
      try {
        return parseAsyncEnvelope(JSON.parse(fields[i + 1]));
      } catch {
        return null;
      }
    }
    return null;
  }

  private reader(): Redis | null {
    if (this.redis) return this.redis;
    if (this.redisUnavailable) return null;
    if (!this.configService?.isRedisConfigured()) {
      this.redisUnavailable = true;
      return null;
    }
    const config = this.configService.getRedisConfig();
    // Dedicated: a blocking XREAD occupies its connection for the whole BLOCK window.
    this.redis = new Redis({ host: config.host, port: config.port, password: config.password, maxRetriesPerRequest: null, lazyConnect: false });
    return this.redis;
  }
}
