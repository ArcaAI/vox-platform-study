import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentStepType,
  AgentTrajectoryStepEntity,
  AgentTrajectoryStepFactory,
  AgentTrajectoryStepRepository,
  CorePrisma,
  CoreUnitOfWorkService,
  ResourceType,
} from '@arcaai/domains';
import { BaseService, assertEqualTenants } from '../../common';
import { clampCursorLimit, decodeCursor, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis';
import { IUsageLedgerService } from '../usageLedger';
import { AgentTrajectoryDtoMapper } from './agent-trajectory.dto.mapper';
import {
  AgentTrajectorySessionResponse,
  AgentTrajectorySessionsListResponse,
  AgentTrajectoryStepsPageResponse,
  CreateAgentTrajectoryStepInput,
  GenerationMetricsAggregateResponse,
} from './dto';
import { buildHarnessUsageEvent } from './harness-usage.mapper';
import {
  AggregateGenerationStatsFilters,
  IAgentTrajectoryService,
  ListTrajectorySessionsFilters,
  ListTrajectorySessionsOptions,
  ListTrajectoryStepsOptions,
} from './IAgentTrajectoryService';

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
  ) {
    // Telemetry exemption — never broadcasts, so the ResourceType is inert.
    super(eventEmitter, clsService, ResourceType.SummaryMeta);
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
      const event = buildHarnessUsageEvent(entity);
      if (!event) continue;
      try {
        await this.usageLedgerService.recordUsage(event, tx);
      } catch (error) {
        this.logger.warn({
          message: 'Failed to emit harness usage-ledger event',
          tenantId: entity.tenantId,
          sessionId: entity.sessionId,
          runId: entity.runId,
          seq: entity.seq,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
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
