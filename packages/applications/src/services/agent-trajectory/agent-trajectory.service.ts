import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Counter } from 'prom-client';
import { ClsService } from 'nestjs-cls';
import {
  AgentStepType,
  AgentTrajectoryStepEntity,
  AgentTrajectoryStepFactory,
  AgentTrajectoryStepRepository,
  AiCapability,
  AiDeploymentKind,
  AiUsageUnit,
  CorePrisma,
  CoreUnitOfWorkService,
  ResourceType,
} from '@arcaai/domains';
import Decimal from 'decimal.js';
import { BaseService, assertEqualTenants } from '../../common';
import { clampCursorLimit, decodeCursor, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { IMetricsService } from '../baseServices/metrics/IMetricsService';
import { IRedisCacheService } from '../baseServices/redis';
import {
  IComputeDeviceResolver,
  IUsageLedgerService,
  UsageIdempotencyKey,
  USAGE_TRIGGERS,
  type ComputeDevice,
  type UsageEventBatchInput,
  type UsageOperation,
  type UsageTrigger,
} from '../usageLedger';
import { AgentTrajectoryDtoMapper } from './agent-trajectory.dto.mapper';
import {
  AgentTrajectorySessionResponse,
  AgentTrajectorySessionsListResponse,
  AgentTrajectoryStepsPageResponse,
  ComputeSampleInput,
  CreateAgentTrajectoryStepInput,
  GenerationMetricsAggregateResponse,
} from './dto';
import { buildHarnessUsageBatches } from './harness-usage.mapper';
import {
  AggregateGenerationStatsFilters,
  IAgentTrajectoryService,
  ListTrajectorySessionsFilters,
  ListTrajectorySessionsOptions,
  ListTrajectoryStepsOptions,
} from './IAgentTrajectoryService';

/**
 * The emission retry budget (TASK-957 F-5, gateway half).
 *
 * THREE attempts, jittered, and then the counter. Bounded because this runs
 * inside a request the harness is waiting on: a longer budget converts a
 * Postgres blip into a trajectory POST timeout, which the harness then retries
 * WHOLE — including the steps that already landed. Three attempts over a few
 * hundred milliseconds covers the failure this is actually for (a transient
 * deadlock or a connection recycle) and gives up on the one it cannot fix (the
 * database is down), where the harness's own spool is the right answer.
 */
const USAGE_EMIT_ATTEMPTS = 3;
const USAGE_EMIT_BACKOFF_MS = 50;
const USAGE_EMIT_JITTER_MS = 50;

/**
 * Emissions that exhausted the retry budget — the row is LOST, and this is the
 * only place that says so out loud.
 *
 * A `warn` line is invisible to an alert and indistinguishable from noise at
 * request volume; F-5's whole finding was that unbilled revenue "surfaces only
 * as a warn line". Labelled by `operation` and `trigger` so the workflow lane
 * and the consultation lane alert apart.
 */
export const USAGE_EMISSION_FAILED_METRIC = 'hope_usage_emission_failed_total';

/** Provider id of the durable-function server itself (TASK-959 §3.4). */
const HARNESS_WORKER_PROVIDER = 'harness';

/** Default / cap for the offset-paginated session list. */
const DEFAULT_SESSION_PAGE = 20;
const MAX_SESSION_PAGE = 100;

/** Default lookback when callers omit from/to. */
const DEFAULT_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap — never scan unbounded tenant history for metrics. */
const MAX_GENERATION_METRICS_ROWS = 5000;

/**
 * AgentTrajectoryService.
 *
 * Ingest + read surface over the `AgentTrajectoryStep` operational-telemetry
 * table. INTENTIONAL posture (differs from clinical CRUD services):
 *   - NO sys-event on write — the trajectory IS the event stream, so a per-step
 *     sys-event would be circular (documented exemption from rule 04's
 *     mutation → `broadcastSysEvent` rule).
 *   - `recordSteps` is IDEMPOTENT on the composite unique
 *     `(tenantId, sessionId, runId, seq)` via `createMany({ skipDuplicates })`,
 *     so a re-delivered duplicate batch persists nothing new.
 *   - `pruneOlderThan` is the ONLY hard-delete path in the service and operates
 *     EXCLUSIVELY on `AgentTrajectoryStep` (soft-delete-exempt, hard retention).
 *   - `recordSteps` co-emits usage-ledger rows for LLM_CALL steps that carry
 *     billable AD-1 `GenerationStats` — see `emitUsage` below.
 *
 * Extends `BaseService` for the CLS tenant getter; a placeholder
 * `ResourceType` is passed only to satisfy the base constructor — this service
 * never calls `broadcastSysEvent`, so the resource type is unused.
 */
@Injectable()
export class AgentTrajectoryService extends BaseService implements IAgentTrajectoryService {
  private readonly logger = new Logger(AgentTrajectoryService.name);

  private readonly TRAJECTORY_CHANNEL_PREFIX = 'consultation:trajectory:';

  constructor(
    private readonly agentTrajectoryStepRepository: AgentTrajectoryStepRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so unit fixtures can construct without a cache; production DI
    // (@Global RedisCacheModule) supplies it for the live-view republish.
    @Optional() @Inject(IRedisCacheService) private readonly cacheService?: IRedisCacheService,
    // Optional for the same reason: production DI (UsageLedgerServiceModule,
    // imported by this service's own module) always supplies it; a fixture
    // that omits it simply gets no ledger emission (see `emitUsage`).
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
    // Optional + trailing (arity-preserving). This is the
    // DOMAINS `CoreUnitOfWorkService` (its `runInTransaction` is the one
    // production callers actually use — see the outbox drainer / sttInternal
    //  precedent), NOT the identically-named, unwired class under
    // `services/baseServices`. When wired, `recordSteps` folds the
    // `createMany` batch insert and the usage-ledger emission into ONE
    // transaction (upgrading the "sanctioned no-tx fallback" now that
    // `Repository.createMany` accepts a `tx` client). Unwired fixtures fall
    // back to the pre-upgrade sequential (no-tx) calls, unchanged.
    @Optional() private readonly unitOfWorkService?: CoreUnitOfWorkService,
    // TASK-957 F-5 — a signal ABOUT the emission path, never a precondition FOR
    // it: an unregisterable counter must not stop usage being recorded.
    @Optional() @Inject(IMetricsService) metrics?: IMetricsService,
    // TASK-959 §3.1 — which device a self-hosted LLM engine ran on. Optional
    // for the same reason the ledger is: a fixture without it meters every
    // self-hosted step as CPU_SECOND, the cheaper unit, never nothing.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDeviceResolver?: IComputeDeviceResolver,
  ) {
    // Telemetry exemption — never broadcasts, so the ResourceType is inert.
    super(eventEmitter, clsService, ResourceType.SummaryMeta);
    this.emissionFailedCounter = this.registerEmissionFailedCounter(metrics);
  }

  /** See {@link USAGE_EMISSION_FAILED_METRIC}. `null` when unavailable. */
  private readonly emissionFailedCounter: Counter<string> | null;

  private registerEmissionFailedCounter(metrics?: IMetricsService): Counter<string> | null {
    if (!metrics) return null;
    try {
      return metrics.createCounter({
        name: USAGE_EMISSION_FAILED_METRIC,
        help: 'Usage-ledger emissions that exhausted their retry budget. Non-zero means metered work was NOT billed.',
        labelNames: ['operation', 'trigger'],
      });
    } catch (err) {
      this.logger.warn({
        message: 'Could not register the usage-emission failure counter — lost emissions will only be visible in logs',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async recordSteps(steps: CreateAgentTrajectoryStepInput[]): Promise<void> {
    if (!steps || steps.length === 0) return;

    // Tenant scoping (house tenant-guard): every step must carry a tenantId and
    // the whole batch must be single-tenant. When a request tenant context is
    // present (CLS), each step must also match it — a step for another tenant is
    // a cross-tenant write (assertEqualTenants throws 404-over-403 on mismatch).
    const batchTenantId = steps[0].tenantId;
    const contextTenantId = this.tenantId;
    for (const step of steps) {
      if (!step.tenantId) {
        throw new BadRequestException('AgentTrajectoryStep tenantId is required');
      }
      assertEqualTenants({ tenantId: batchTenantId }, { tenantId: step.tenantId });
      if (contextTenantId) {
        assertEqualTenants({ tenantId: contextTenantId }, { tenantId: step.tenantId });
      }
    }

    const entities = steps.map((step) =>
      AgentTrajectoryStepFactory.CreateStep({
        tenantId: step.tenantId,
        consultationId: step.consultationId ?? undefined,
        sessionKind: step.sessionKind,
        sessionId: step.sessionId,
        // Non-null "" sentinel for non-Temporal sessions — the composite unique
        // idempotency depends on runId never being null (factory also defaults).
        runId: step.runId ?? '',
        seq: step.seq,
        stepType: step.stepType,
        name: step.name,
        status: step.status,
        startedAt: step.startedAt,
        endedAt: step.endedAt ?? undefined,
        durationMs: step.durationMs ?? undefined,
        stats: step.stats ?? undefined,
        payloadRef: step.payloadRef ?? undefined,
        errorCode: step.errorCode ?? undefined,
        correlationId: step.correlationId ?? undefined,
      }),
    );

    // IDEMPOTENT batch insert: `skipDuplicates` maps to `ON CONFLICT DO NOTHING`,
    // so a re-delivered duplicate batch (same composite unique) persists nothing.
    // NO sys-event here — telemetry exemption (see class header).
    //
    // When the unit-of-work is wired, the batch insert and the
    // usage-ledger emission (see `emitUsage`) share ONE transaction — upgrading
    // the "sanctioned no-tx fallback" now that `Repository.createMany`
    // accepts a `tx` client. Unwired fixtures keep the pre-upgrade sequential
    // (no-tx) calls, byte-identical to before. Either way `emitUsage` catches
    // its OWN per-row failures (see below), so a metering hiccup never rolls
    // back — or blocks — the step persistence.
    let count: number;
    if (this.unitOfWorkService) {
      ({ count } = await this.unitOfWorkService.runInTransaction(async (tx) => {
        const result = await this.agentTrajectoryStepRepository.createMany(entities, true, tx);
        // Attempted for EVERY entity, deliberately NOT gated on `count` — see `emitUsage`.
        await this.emitUsage(entities, tx);
        return result;
      }));
    } else {
      ({ count } = await this.agentTrajectoryStepRepository.createMany(entities, true));
      await this.emitUsage(entities);
    }

    // Only republish when at least one row was actually persisted — a fully
    // duplicate re-delivered batch stays a no-op on the live view too.
    if (count > 0) {
      await this.republishToLiveView(entities);
    }
  }

  /**
   * The durable worker's own CPU, one `CPU_SECOND` row per activity execution
   * (TASK-959 §3.4).
   *
   * Deliberately NOT folded into `recordSteps`: a sample is not a trajectory
   * step and has no row in `AgentTrajectoryStep` to join a transaction with.
   * It shares the POST because the worker already had a channel to the gateway,
   * and nothing more.
   *
   * BEST-EFFORT, PER SAMPLE. One malformed sample (a blank tenant, a run id the
   * interceptor could not read) is skipped with a warning and the rest of the
   * batch still bills — the alternative is that one activity's missing input
   * loses a whole flush's worth of a run's CPU.
   */
  async recordComputeSamples(samples: ComputeSampleInput[]): Promise<void> {
    if (!this.usageLedgerService || !samples || samples.length === 0) return;

    for (const sample of samples) {
      let batch: UsageEventBatchInput | null;
      try {
        batch = buildComputeSampleUsage(sample);
      } catch (error) {
        // The key builders throw on a blank id rather than collapsing every
        // sample of a run onto one key. Losing this one sample is the cheap
        // half of that trade.
        this.logger.warn({
          message: 'Skipped an unattributable worker compute sample',
          sessionId: sample?.sessionId,
          runId: sample?.runId,
          activityId: sample?.activityId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!batch) continue;

      await this.emitWithRetry(batch, 'workflow.step', pickSampleTrigger(sample), {
        sessionId: sample.sessionId,
        runId: sample.runId,
        activityId: sample.activityId,
        attempt: sample.attempt,
      });
    }
  }

  async listSessions(
    tenantId: string,
    filters: ListTrajectorySessionsFilters = {},
    options: ListTrajectorySessionsOptions = {},
  ): Promise<AgentTrajectorySessionsListResponse> {
    // S2 — DB-level groupBy via listSessionSummaries (no full step scan).
    const summaryFilters: {
      consultationId?: string;
      sessionKind?: string;
      createdAt?: { gte?: Date; lte?: Date };
    } = {};
    if (filters.consultationId) summaryFilters.consultationId = filters.consultationId;
    if (filters.kind) summaryFilters.sessionKind = filters.kind;
    const createdAt = buildDateRange(filters.from, filters.to);
    if (createdAt) summaryFilters.createdAt = createdAt;

    const summaries = await this.agentTrajectoryStepRepository.listSessionSummaries(tenantId, summaryFilters);

    // Newest activity first, then offset-paginate the distinct sessions.
    const all: AgentTrajectorySessionResponse[] = summaries
      .map((s) => ({
        sessionId: s.sessionId,
        runId: s.runId,
        sessionKind: s.sessionKind,
        consultationId: s.consultationId,
        stepCount: s.stepCount,
        firstStepAt: toDate(s.firstStepAt).toISOString(),
        lastStepAt: toDate(s.lastStepAt).toISOString(),
      }))
      .sort((a, b) => b.lastStepAt.localeCompare(a.lastStepAt));
    const total = all.length;
    const limit = clamp(options.limit ?? DEFAULT_SESSION_PAGE, 1, MAX_SESSION_PAGE);
    const page = Math.max(options.page ?? 1, 1);
    const start = (page - 1) * limit;
    return { items: all.slice(start, start + limit), total };
  }

  async listSteps(tenantId: string, sessionId: string, options: ListTrajectoryStepsOptions = {}): Promise<AgentTrajectoryStepsPageResponse> {
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (options.cursor && !cursor) {
      throw new BadRequestException('Invalid trajectory cursor');
    }
    const limit = clampCursorLimit(options.limit);

    const baseWhere: Record<string, unknown> = { tenantId, sessionId };
    if (options.runId !== undefined) baseWhere.runId = options.runId;

    // Keyset over (seq, id) — this table grows unbounded, so no offset scan.
    // seq is an integer, so the generic (timestamp) buildCursorFindAllProps is
    // not reused verbatim; the encode/decode/page-envelope helpers are.
    const sort: { [key: string]: 'asc' | 'desc' }[] = [{ seq: 'asc' }, { id: 'asc' }];
    let where: Record<string, unknown> = baseWhere;
    if (cursor) {
      const seqValue = Number(cursor.k);
      where = {
        AND: [baseWhere, { OR: [{ seq: { gt: seqValue } }, { AND: [{ seq: seqValue }, { id: { gt: cursor.id } }] }] }],
      };
    }

    const rows = await this.agentTrajectoryStepRepository.findAll({ page: 1, limit: limit + 1, sort, where });

    // 404-over-403: an empty FIRST page means the session does not exist for
    // this tenant (nonexistent OR cross-tenant) — both 404, no existence leak.
    // A cursor'd empty page is simply end-of-data, not a 404.
    if (!cursor && rows.length === 0) {
      throw new NotFoundException('Trajectory session not found');
    }

    const paged = toCursorPage(rows, limit, (row) => String(row.seq));
    return {
      items: paged.data.map(AgentTrajectoryDtoMapper.toStepResponse),
      nextCursor: paged.nextCursor,
      hasMore: paged.hasMore,
      limit: paged.limit,
    };
  }

  async aggregateGenerationStats(tenantId: string, filters: AggregateGenerationStatsFilters = {}): Promise<GenerationMetricsAggregateResponse> {
    const createdAt = resolveMetricsCreatedAtRange(filters.from, filters.to);
    const where: Record<string, unknown> = {
      tenantId,
      stepType: AgentStepType.LLM_CALL,
      createdAt,
    };
    if (filters.consultationId) where.consultationId = filters.consultationId;

    // Bounded scan — LLM_CALL + window + hard max rows. No full-tenant history.
    const rows = await this.agentTrajectoryStepRepository.findAll({
      page: 1,
      limit: MAX_GENERATION_METRICS_ROWS,
      sort: [{ createdAt: 'desc' }, { id: 'desc' }],
      where,
    });

    return rollupGenerationStats(
      rows.map((row) => row.stats),
      filters.pricing,
    );
  }

  /**
   * Token spend for one run, summed from its LLM_CALL steps.
   *
   * A "run" is the tuple `(tenantId, sessionId, runId)` — there is no run row in
   * the schema, and this needs none: the counts are already on the steps. `runId`
   * is `""` for live-doc / job sessions, which is a real value here, not a wildcard.
   */
  async getRunTokenSpend(tenantId: string, sessionId: string, runId: string): Promise<RunTokenSpend> {
    const rows = await this.agentTrajectoryStepRepository.findAll({
      page: 1,
      limit: MAX_GENERATION_METRICS_ROWS,
      sort: [{ seq: 'asc' }],
      where: { tenantId, sessionId, runId, stepType: AgentStepType.LLM_CALL },
    });

    let promptTokens = 0;
    let completionTokens = 0;
    for (const row of rows) {
      const stats = parseGenerationStats(row.stats);
      promptTokens += stats?.promptTokens ?? 0;
      completionTokens += stats?.completionTokens ?? 0;
    }
    // Zero, never null: a budget comparison needs a number, and "no spend
    // recorded" and "spent nothing" are the same answer for that purpose.
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  /**
   * Evaluate a run against its per-run token budget.
   *
   * `perRunBudget = 0` means UNBOUNDED — the shipped default, and the reason this
   * check is byte-for-byte inert until a super admin sets a budget through
   * `agentic.context.tokenBudget.perRun`.
   */
  async checkRunBudget(tenantId: string, sessionId: string, runId: string, perRunBudget: number): Promise<RunBudgetStatus> {
    const spend = await this.getRunTokenSpend(tenantId, sessionId, runId);
    return {
      ...spend,
      usedTokens: spend.totalTokens,
      perRunBudget,
      exceeded: perRunBudget > 0 && spend.totalTokens >= perRunBudget,
    };
  }

  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000);

    // GUARDED HARD DELETE — the ONLY hard-delete path in this service, and it
    // operates EXCLUSIVELY on AgentTrajectoryStep (soft-delete-exempt ops
    // telemetry with hard retention). Runs unscoped/system-wide, so the caller
    // (nightly retention job) supplies a platform/system context.
    const aged = await this.agentTrajectoryStepRepository.findAll({
      where: { createdAt: { lt: cutoff } },
      sort: [{ createdAt: 'asc' }],
    });

    let deleted = 0;
    for (const row of aged) {
      await this.agentTrajectoryStepRepository.delete(row.id);
      deleted += 1;
    }
    return deleted;
  }

  /**
   * Republish each persisted step that carries a `consultationId` to the live
   * view (`consultation:trajectory:{consultationId}`), mirroring how
   * `LiveDocumentationService` publishes to Redis. Best-effort — a Redis blip
   * never fails the ingest.
   */
  private async republishToLiveView(entities: AgentTrajectoryStepEntity[]): Promise<void> {
    if (!this.cacheService) return;
    for (const entity of entities) {
      if (!entity.consultationId) continue;
      try {
        await this.cacheService.publish(
          `${this.TRAJECTORY_CHANNEL_PREFIX}${entity.consultationId}`,
          JSON.stringify(AgentTrajectoryDtoMapper.toStepResponse(entity)),
        );
      } catch (error) {
        this.logger.warn({
          message: 'Failed to republish trajectory step to live view',
          consultationId: entity.consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Co-emit usage-ledger rows for every LLM_CALL step that
   * carries billable AD-1 `GenerationStats` — `buildHarnessUsageEvent` maps
   * the step, `null` for anything else (wrong step type, no stats, no
   * positive token count, no provider).
   *
   * Attempted for EVERY entity in the batch, deliberately NOT gated on
   * whether `createMany` actually inserted it. A Temporal activity retry
   * re-POSTs the identical step, which the composite unique
   * `(tenantId, sessionId, runId, seq)` makes a no-op at the trajectory
   * table — but `harness-usage.mapper.ts` derives the ledger's idempotency
   * key from that SAME tuple (`harness:step:<sessionId>:<runId>:<seq>`, NOT
   * the entity's freshly-generated row id), so a retry converges to one
   * ledger row by KEY. Gating this on the trajectory insert outcome would
   * mean a retry after a first-attempt ledger failure (outbox write down,
   * say) never gets a second chance to emit, because the trajectory insert
   * itself no-ops on the retry.
   *
   * Best-effort like `republishToLiveView`: an emission failure is logged
   * and swallowed, never allowed to fail trajectory persistence — metering is
   * a side effect of work already done (WS-B contract
   *
   * NOT wrapped in the same DB transaction as `createMany` today:
   * `AgentTrajectoryStepRepository.createMany` has no `tx` parameter (only
   * `create`/`updateWithVersion` do — see `packages/domains/src/common/repository.ts`),
   * and extending it is outside this service's boundary. See the
   * report for the recommended follow-up.
   */
  private async emitUsage(entities: AgentTrajectoryStepEntity[], tx?: CorePrisma.TransactionClient): Promise<void> {
    if (!this.usageLedgerService) return;
    for (const entity of entities) {
      const device = await this.resolveStepDevice(entity);
      const event = buildHarnessUsageBatches(entity, { device });
      if (!event) continue;

      const operation = event.batch.common.operation;
      const trigger = event.batch.common.attributesJson?.trigger ?? undefined;
      const context = { tenantId: entity.tenantId, sessionId: entity.sessionId, runId: entity.runId, seq: entity.seq };

      await this.emitWithRetry(event.batch, operation, trigger, context, tx);
      // The platform CPU leg of a tenant-funded call (§6.3) — a SECOND
      // `recordUsage`, because the two halves carry different cost bases and a
      // batch shares one. Emitted after the tokens so a failure on the smaller,
      // newer row can never cost the row that has always been billed.
      if (event.platformBatch) {
        await this.emitWithRetry(event.platformBatch, operation, trigger, context, tx);
      }
    }
  }

  /**
   * The device a SELF-HOSTED engine occupied, for the step's own provider.
   *
   * Resolved HERE rather than in the mapper so the mapper stays pure and
   * unit-testable without a settings cache. Never raises: an unresolvable
   * device is `cpu`, and losing a whole usage batch — tokens included — to
   * protect a device label would be the expensive direction to be wrong in.
   */
  private async resolveStepDevice(entity: AgentTrajectoryStepEntity): Promise<ComputeDevice | null> {
    if (!this.computeDeviceResolver) return null;
    const provider = readStepProvider(entity);
    if (!provider) return null;
    try {
      return await this.computeDeviceResolver.resolve(entity.tenantId, provider);
    } catch {
      return null;
    }
  }

  /**
   * Emit one batch, retrying a TRANSIENT failure a bounded number of times
   * (TASK-957 F-5, gateway half).
   *
   * Safe to retry because every key on this path is intent-derived — the
   * `(sessionId, runId, seq)` tuple for a step, `(activityId, attempt)` for a
   * sample — so a retry after a partial success converges on the same row
   * rather than billing twice.
   *
   * A failure is NEVER propagated: metering is a side effect of work already
   * done, and failing the trajectory POST would make the harness re-send a
   * batch whose steps already landed. What changes is that an exhausted budget
   * now increments a counter an alert can watch, instead of a warn line nobody
   * reads.
   */
  private async emitWithRetry(
    batch: UsageEventBatchInput,
    operation: UsageOperation,
    trigger: UsageTrigger | undefined,
    context: Record<string, unknown>,
    tx?: CorePrisma.TransactionClient,
  ): Promise<void> {
    if (!this.usageLedgerService) return;

    for (let attempt = 1; attempt <= USAGE_EMIT_ATTEMPTS; attempt += 1) {
      try {
        await this.usageLedgerService.recordUsage(batch, tx);
        return;
      } catch (error) {
        const lastAttempt = attempt === USAGE_EMIT_ATTEMPTS;
        this.logger.warn({
          message: lastAttempt ? 'Usage-ledger emission failed and was NOT billed' : 'Usage-ledger emission failed — retrying',
          operation,
          attempt,
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
        if (lastAttempt) {
          // `none` rather than an empty label: an absent trigger is a real
          // answer (the consultation lane stamps none), and an empty string
          // renders as a blank facet nobody can filter on.
          this.emissionFailedCounter?.inc({ operation, trigger: trigger ?? 'none' });
          return;
        }
        // Jittered so a shared outage does not resynchronise every in-flight
        // request onto the same retry instant.
        await delay(USAGE_EMIT_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * USAGE_EMIT_JITTER_MS);
      }
    }
  }
}

/** The provider id a step's stats named, for the device lookup. */
function readStepProvider(entity: AgentTrajectoryStepEntity): string | null {
  if (!entity.stats || typeof entity.stats !== 'object' || Array.isArray(entity.stats)) return null;
  const provider = (entity.stats as Record<string, unknown>).provider;
  return typeof provider === 'string' && provider.trim().length > 0 ? provider.trim() : null;
}

/**
 * One worker compute sample → its ledger batch, or `null` when it burned no
 * measurable CPU.
 *
 * Every dimension is a CONSTANT of this path rather than something read off the
 * sample: the durable worker runs on the platform's own hardware (`SELF_HOSTED`,
 * `device: 'cpu'` — it is a Python event loop, not a model) and its CPU belongs
 * to the `WORKFLOW` capability, which exists precisely so a run's orchestration
 * cost gets its own allowance and its own invoice line without touching any
 * inference capability.
 *
 * Throws on a blank identity field — see {@link UsageIdempotencyKey}.
 */
function buildComputeSampleUsage(sample: ComputeSampleInput): UsageEventBatchInput | null {
  if (typeof sample?.cpuMs !== 'number' || !Number.isFinite(sample.cpuMs) || sample.cpuMs <= 0) return null;
  if (typeof sample.tenantId !== 'string' || sample.tenantId.trim().length === 0) {
    throw new Error('AgentTrajectoryService: a compute sample must carry a tenantId');
  }

  const trigger = pickSampleTrigger(sample);
  const activityType = typeof sample.activityType === 'string' ? sample.activityType.trim() : '';

  return {
    common: {
      tenantId: sample.tenantId,
      idempotencyKey: UsageIdempotencyKey.harnessComputeSample(sample.sessionId, sample.runId, sample.activityId, sample.attempt),
      // The gateway clock. The worker flushes within seconds of the activity
      // finishing and the sample carries no timestamp of its own — stated here
      // rather than hidden, because `occurredAt` selects the price row.
      occurredAt: new Date(),
      capability: AiCapability.WORKFLOW,
      operation: 'workflow.step',
      provider: HARNESS_WORKER_PROVIDER,
      model: null,
      deployment: AiDeploymentKind.SELF_HOSTED,
      requestId: sample.runId,
      sessionId: sample.sessionId,
      attributesJson: {
        engine: HARNESS_WORKER_PROVIDER,
        device: 'cpu',
        ...(activityType ? { activityType } : {}),
        ...(trigger ? { trigger } : {}),
      },
    },
    // Three decimals, like every other occupancy row: a fast activity burns
    // well under a millisecond, and rounding those to zero would drop the
    // majority of this worker's samples.
    units: [{ unit: AiUsageUnit.CPU_SECOND, quantity: new Decimal(sample.cpuMs).div(1000).toFixed(3) }],
  };
}

/** The closed OD-E vocabulary — an unknown value is dropped, never forked in. */
function pickSampleTrigger(sample: ComputeSampleInput): UsageTrigger | undefined {
  const raw = sample?.trigger;
  return typeof raw === 'string' && (USAGE_TRIGGERS as readonly string[]).includes(raw) ? (raw as UsageTrigger) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Build an inclusive `createdAt` range filter, or `undefined` when both bounds are absent/invalid. */
function buildDateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
  const range: { gte?: Date; lte?: Date } = {};
  const fromMs = parseInstant(from);
  const toMs = parseInstant(to);
  if (fromMs !== undefined) range.gte = new Date(fromMs);
  if (toMs !== undefined) range.lte = new Date(toMs);
  return range.gte || range.lte ? range : undefined;
}

/**
 * Metrics window: explicit from/to when provided; otherwise default last 7 days
 * ending at now. Always returns both bounds so the scan is never open-ended.
 */
function resolveMetricsCreatedAtRange(from?: string, to?: string): { gte: Date; lte: Date } {
  const fromMs = parseInstant(from);
  const toMs = parseInstant(to);
  if (fromMs !== undefined && toMs !== undefined) {
    return { gte: new Date(fromMs), lte: new Date(toMs) };
  }
  const nowMs = Date.now();
  const lte = toMs !== undefined ? toMs : nowMs;
  const gte = fromMs !== undefined ? fromMs : lte - DEFAULT_METRICS_WINDOW_MS;
  return { gte: new Date(gte), lte: new Date(lte) };
}

function parseInstant(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Parsed AD-1 GenerationStats, incl. the token counts B4 surfaced. */
interface ParsedGenerationStats {
  ttftMs?: number;
  tokensPerSecond?: number;
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
}

/**
 * Per-model prices, keyed by the model id the engine reports in `stats.model`.
 *
 * Carried as DATA on `AiModel.metaData.pricing` rather than as schema — prices
 * change on a vendor's cadence, not a migration's, and no column is needed to
 * multiply two numbers.
 */
export type ModelPriceBook = Record<string, { inputPer1k: number; outputPer1k: number; currency?: string }>;

/** Token spend for one run, as the budget check consumes it. */
export interface RunTokenSpend {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The budget verdict threaded to the harness on activity results. */
export interface RunBudgetStatus extends RunTokenSpend {
  usedTokens: number;
  perRunBudget: number;
  exceeded: boolean;
}

/** Roll AD-1 GenerationStats (snake_case preferred; camelCase tolerated) into panel KPIs. */
function rollupGenerationStats(statsList: unknown[], pricing?: ModelPriceBook): GenerationMetricsAggregateResponse {
  const ttft: number[] = [];
  const toks: number[] = [];
  const stopReasons = new Map<string, number>();
  let sampleCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let sawTokens = false;
  let cost = 0;
  let sawCost = false;
  let currency: string | null = null;

  for (const raw of statsList) {
    const stats = parseGenerationStats(raw);
    if (!stats) continue;
    sampleCount += 1;
    if (typeof stats.ttftMs === 'number') ttft.push(stats.ttftMs);
    if (typeof stats.tokensPerSecond === 'number') toks.push(stats.tokensPerSecond);
    if (stats.stopReason) {
      stopReasons.set(stats.stopReason, (stopReasons.get(stats.stopReason) ?? 0) + 1);
    }
    if (typeof stats.promptTokens === 'number') {
      promptTokens += stats.promptTokens;
      sawTokens = true;
    }
    if (typeof stats.completionTokens === 'number') {
      completionTokens += stats.completionTokens;
      sawTokens = true;
    }
    // $-cost is best-effort and NEVER guessed: an unpriced model contributes
    // nothing rather than a fabricated number, so a partial price book yields a
    // partial (and honestly-labelled) cost instead of a wrong total.
    const price = stats.model ? pricing?.[stats.model] : undefined;
    if (price) {
      cost += ((stats.promptTokens ?? 0) / 1000) * price.inputPer1k + ((stats.completionTokens ?? 0) / 1000) * price.outputPer1k;
      currency ??= price.currency ?? null;
      sawCost = true;
    }
  }

  ttft.sort((a, b) => a - b);

  return {
    sampleCount,
    ttftMedianMs: percentile(ttft, 0.5),
    ttftP95Ms: percentile(ttft, 0.95),
    tokensPerSecondAvg: mean(toks),
    stopReasons: [...stopReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    // Null (not 0) when nothing reported tokens — "unknown" and "zero" are
    // different answers for a budget panel.
    promptTokensTotal: sawTokens ? promptTokens : null,
    completionTokensTotal: sawTokens ? completionTokens : null,
    totalTokens: sawTokens ? promptTokens + completionTokens : null,
    estimatedCost: sawCost ? cost : null,
    currency,
  };
}

function parseGenerationStats(raw: unknown): ParsedGenerationStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ttftMs = pickNumber(obj, 'ttft_ms', 'ttftMs');
  const tokensPerSecond = pickNumber(obj, 'tokens_per_second', 'tokensPerSecond');
  const stopReason = pickString(obj, 'stop_reason', 'stopReason');
  // Token counts were ALREADY being persisted here and thrown away:
  // the TEXT client's `stats`/`usage` carries them, the harness forwards `stats`
  // verbatim onto every LLM_CALL step, and this parser simply never looked. Read
  // both the flat and the nested `usage` shape (the TEXT wire uses both).
  const usage = (obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : {}) as Record<string, unknown>;
  const promptTokens =
    pickNumber(obj, 'prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens') ?? pickNumber(usage, 'prompt_tokens', 'promptTokens');
  const completionTokens =
    pickNumber(obj, 'completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens') ??
    pickNumber(usage, 'completion_tokens', 'completionTokens');
  const model = pickString(obj, 'model', 'modelName') ?? undefined;
  // A sample counts when at least one headline field is present. Tokens now
  // qualify: a stats block carrying only token counts used to parse to null, so
  // the step was skipped and contributed to NO metric at all.
  if (
    ttftMs === undefined &&
    tokensPerSecond === undefined &&
    stopReason === undefined &&
    promptTokens === undefined &&
    completionTokens === undefined
  ) {
    return null;
  }
  return { ttftMs, tokensPerSecond, stopReason, promptTokens, completionTokens, model };
}

function pickNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function percentile(sortedAsc: number[], fraction: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = fraction * (sortedAsc.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAsc[low];
  return sortedAsc[low] + (sortedAsc[high] - sortedAsc[low]) * (rank - low);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
