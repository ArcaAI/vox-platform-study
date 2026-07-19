import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  AgentStepType,
  AgentTrajectoryStepEntity,
  AgentTrajectoryStepFactory,
  AgentTrajectoryStepRepository,
  ResourceType,
} from '@arcaai/domains';
import { BaseService, assertEqualTenants } from '../../common';
import { clampCursorLimit, decodeCursor, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { IRedisCacheService } from '../baseServices/redis';
import { AgentTrajectoryDtoMapper } from './agent-trajectory.dto.mapper';
import {
  AgentTrajectorySessionResponse,
  AgentTrajectorySessionsListResponse,
  AgentTrajectoryStepsPageResponse,
  CreateAgentTrajectoryStepInput,
  GenerationMetricsAggregateResponse,
} from './dto';
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

/** Default lookback when callers omit from/to (TASK-509 aggregate). */
const DEFAULT_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap — never scan unbounded tenant history for metrics. */
const MAX_GENERATION_METRICS_ROWS = 5000;

/**
 * AgentTrajectoryService (TASK-510 Phase 2B — ordered session trajectory).
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
    const { count } = await this.agentTrajectoryStepRepository.createMany(entities, true);

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
    // TASK-510 S2 — DB-level groupBy via listSessionSummaries (no full step scan).
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

  async listSteps(
    tenantId: string,
    sessionId: string,
    options: ListTrajectoryStepsOptions = {},
  ): Promise<AgentTrajectoryStepsPageResponse> {
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
        AND: [
          baseWhere,
          { OR: [{ seq: { gt: seqValue } }, { AND: [{ seq: seqValue }, { id: { gt: cursor.id } }] }] },
        ],
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

  async aggregateGenerationStats(
    tenantId: string,
    filters: AggregateGenerationStatsFilters = {},
  ): Promise<GenerationMetricsAggregateResponse> {
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

    return rollupGenerationStats(rows.map((row) => row.stats));
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

/** Roll AD-1 GenerationStats (snake_case preferred; camelCase tolerated) into panel KPIs. */
function rollupGenerationStats(statsList: unknown[]): GenerationMetricsAggregateResponse {
  const ttft: number[] = [];
  const toks: number[] = [];
  const stopReasons = new Map<string, number>();
  let sampleCount = 0;

  for (const raw of statsList) {
    const stats = parseGenerationStats(raw);
    if (!stats) continue;
    sampleCount += 1;
    if (typeof stats.ttftMs === 'number') ttft.push(stats.ttftMs);
    if (typeof stats.tokensPerSecond === 'number') toks.push(stats.tokensPerSecond);
    if (stats.stopReason) {
      stopReasons.set(stats.stopReason, (stopReasons.get(stats.stopReason) ?? 0) + 1);
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
  };
}

function parseGenerationStats(
  raw: unknown,
): { ttftMs?: number; tokensPerSecond?: number; stopReason?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ttftMs = pickNumber(obj, 'ttft_ms', 'ttftMs');
  const tokensPerSecond = pickNumber(obj, 'tokens_per_second', 'tokensPerSecond');
  const stopReason = pickString(obj, 'stop_reason', 'stopReason');
  // A sample counts when at least one headline field is present.
  if (ttftMs === undefined && tokensPerSecond === undefined && stopReason === undefined) {
    return null;
  }
  return { ttftMs, tokensPerSecond, stopReason };
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
