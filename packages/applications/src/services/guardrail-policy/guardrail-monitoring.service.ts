import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { GuardrailEvaluationRepository, ResourceType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { GUARDRAIL_JUDGE_TASK_KEYS, GUARDRAIL_MEDICAL_JUDGE_TASK_KEY } from '@arcaai/types';
import { BaseService } from '../../common/base.service';
import type { IActiveUserContext } from '../../interfaces';
import { AI_TASK_KEYS } from '../ai-routing-policy/constants';
import { IAiRoutingPolicyService } from '../ai-routing-policy/IAiRoutingPolicyService';
import { IModelResidencyService } from '../model-residency/IModelResidencyService';
import type { ModelResidencyStateSnapshot } from '../model-residency/model-residency.service';
import { GUARDRAIL_PROMQL, type GuardrailPromqlKey } from '../platform-metrics/guardrail-promql';
import { IPrometheusQueryService, type PrometheusSample } from '../platform-metrics/prometheus-query.service';
import {
  GUARDRAIL_METRICS_BUCKETS,
  GuardrailActivityResponse,
  GuardrailEvaluationListQuery,
  GuardrailEvaluationListResponse,
  GuardrailHealthResponse,
  GuardrailMetricSample,
  GuardrailMetricsWindowQuery,
  GuardrailPerformanceResponse,
  type GuardrailMetricsBucket,
} from './dto';
import { assertGuardrailPlatformAdmin } from './guardrail-platform-gate';

export const IGuardrailMonitoringService = Symbol('IGuardrailMonitoringService');

export interface IGuardrailMonitoringService {
  activity(query: GuardrailMetricsWindowQuery): Promise<GuardrailActivityResponse>;
  performance(): Promise<GuardrailPerformanceResponse>;
  health(): Promise<GuardrailHealthResponse>;
  evaluations(query: GuardrailEvaluationListQuery): Promise<GuardrailEvaluationListResponse>;
}

const BUCKET_SECONDS: Readonly<Record<GuardrailMetricsBucket, number>> = Object.freeze({ '5m': 300, '1h': 3600, '1d': 86_400 });
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// API bounds of a monitoring read (not policy knobs): the window, the series length, the page sizes.
const DEFAULT_WINDOW_MS = DAY_MS;
const MAX_WINDOW_MS = 31 * DAY_MS;
const MAX_SERIES_BUCKETS = 2_000;
const TOP_CATEGORIES = 20;
const TOP_TENANTS = 50;
const DEFAULT_PAGE = 50;
/** The undetermined-rate window of the health view. */
const UNDETERMINED_WINDOW_MS = HOUR_MS;

const LANE_BY_TASK_KEY: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(GUARDRAIL_JUDGE_TASK_KEYS).map(([lane, taskKey]) => [taskKey, lane])),
  [GUARDRAIL_MEDICAL_JUDGE_TASK_KEY]: 'medical_validation',
});

const VECTOR_KEYS: readonly GuardrailPromqlKey[] = [
  'windowLatencyP50',
  'windowLatencyP95',
  'modelLatencyP50',
  'modelLatencyP95',
  'peerCallsPerSecond',
  'queueDepth',
  'admissionRejectionsPerSecond',
  'circuitBreakers',
  'peerFailuresPerSecond',
  'windowCacheHitRatio',
  'outbox',
];

/**
 * TASK-1050 W2h (README §11.3 E) — the platform guardrail monitoring reads. Cross-tenant by design: the gate
 * (platform admin, tenant-less) runs first, and the DB aggregates are raw SQL on `GuardrailEvaluationRepository`
 * that never select content. Performance is FIXED PromQL (`GUARDRAIL_PROMQL`) through `PrometheusQueryService`,
 * which degrades to "no data" — so this view never 5xxes because the observability stack is down.
 */
@Injectable()
export class GuardrailMonitoringService extends BaseService implements IGuardrailMonitoringService {
  private readonly logger = new Logger(GuardrailMonitoringService.name);
  /** Clock seam for tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly evaluationRows: GuardrailEvaluationRepository,
    @Inject(IAiRoutingPolicyService) private readonly routing: IAiRoutingPolicyService,
    @Inject(IPrometheusQueryService) private readonly prometheus: IPrometheusQueryService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IModelResidencyService) private readonly residency?: IModelResidencyService,
  ) {
    super(eventEmitter, clsService, ResourceType.GuardrailEvaluation);
  }

  async activity(query: GuardrailMetricsWindowQuery): Promise<GuardrailActivityResponse> {
    assertGuardrailPlatformAdmin(this.requestUser, this.tenantId, 'read guardrail activity');
    const bucket: GuardrailMetricsBucket = query.bucket ?? '1h';
    const window = this.window(query);
    const bucketSeconds = BUCKET_SECONDS[bucket];
    if ((window.to.getTime() - window.from.getTime()) / (bucketSeconds * 1000) > MAX_SERIES_BUCKETS) {
      throw new BadRequestException({ code: 'GUARDRAIL_METRICS_TOO_MANY_BUCKETS', message: `At most ${MAX_SERIES_BUCKETS} buckets per series; widen the bucket.` });
    }
    const [series, checks, topCategories, perTenant, perModel, overrides] = await Promise.all([
      this.evaluationRows.aggregateDecisionSeries({ ...window, bucketSeconds }),
      this.evaluationRows.aggregateChecks(window),
      this.evaluationRows.topCategories(window, TOP_CATEGORIES),
      this.evaluationRows.aggregateByTenant(window, TOP_TENANTS),
      this.evaluationRows.aggregateByModel(window),
      this.evaluationRows.countOverrides(window),
    ]);
    const sum = (decision: string) => series.filter((row) => row.decision === decision).reduce((total, row) => total + row.count, 0);
    const evaluations = series.reduce((total, row) => total + row.count, 0);
    const warn = sum('warn');
    const block = sum('block');
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      bucket,
      tenantId: window.tenantId ?? null,
      totals: { evaluations, allow: sum('allow'), warn, block, unverified: sum('unverified'), flagRate: evaluations === 0 ? 0 : (warn + block) / evaluations, overrides },
      series: series.map((row) => ({ ...row, bucketStart: row.bucketStart.toISOString() })),
      checks,
      topCategories,
      perTenant,
      perModel,
    };
  }

  async performance(): Promise<GuardrailPerformanceResponse> {
    assertGuardrailPlatformAdmin(this.requestUser, this.tenantId, 'read guardrail performance');
    const [judgeCallsPerSecond, evaluationsMissing, ...vectors] = await Promise.all([
      this.prometheus.instant(GUARDRAIL_PROMQL.judgeCallsPerSecond),
      this.prometheus.instant(GUARDRAIL_PROMQL.evaluationsMissing),
      ...VECTOR_KEYS.map((key) => this.prometheus.instantVector(GUARDRAIL_PROMQL[key])),
    ]);
    const samples = Object.fromEntries(VECTOR_KEYS.map((key, index) => [key, toSamples(vectors[index] as PrometheusSample[])])) as Record<
      GuardrailPromqlKey,
      GuardrailMetricSample[]
    >;
    const available = judgeCallsPerSecond !== null || evaluationsMissing !== null || VECTOR_KEYS.some((key) => samples[key].length > 0);
    return {
      at: this.now().toISOString(),
      available,
      windowLatencyP50: samples.windowLatencyP50,
      windowLatencyP95: samples.windowLatencyP95,
      modelLatencyP50: samples.modelLatencyP50,
      modelLatencyP95: samples.modelLatencyP95,
      judgeCallsPerSecond,
      peerCallsPerSecond: samples.peerCallsPerSecond,
      queueDepth: samples.queueDepth,
      admissionRejectionsPerSecond: samples.admissionRejectionsPerSecond,
      circuitBreakers: samples.circuitBreakers,
      peerFailuresPerSecond: samples.peerFailuresPerSecond,
      windowCacheHitRatio: samples.windowCacheHitRatio,
      evaluationsMissing,
      outbox: samples.outbox,
    };
  }

  async health(): Promise<GuardrailHealthResponse> {
    assertGuardrailPlatformAdmin(this.requestUser, this.tenantId, 'read guardrail health');
    const now = this.now();
    const taskKeys = AI_TASK_KEYS.filter((key) => key.startsWith('guardrail.'));
    const [states, undeterminedRate, lastAt, selections] = await Promise.all([
      this.readResidency(),
      this.evaluationRows.undeterminedShare(new Date(now.getTime() - UNDETERMINED_WINDOW_MS)),
      this.evaluationRows.latestEvaluationAt(),
      Promise.all(taskKeys.map((taskKey) => this.routing.resolveDefault(SYSTEM_TENANT_ID, taskKey, { systemOnly: true }).catch(() => null))),
    ]);
    return {
      at: now.toISOString(),
      models: taskKeys.map((taskKey, index) => {
        const model = selections[index]?.model ?? null;
        return {
          taskKey,
          lane: LANE_BY_TASK_KEY[taskKey] ?? null,
          modelId: model?.id ?? null,
          slug: model?.slug ?? null,
          residency: model ? residencyOf(states, model.id) : 'unselected',
        };
      }),
      undeterminedRate,
      lastEvaluationAt: lastAt ? lastAt.toISOString() : null,
      secondsSinceLastEvaluation: lastAt ? Math.max(0, Math.round((now.getTime() - lastAt.getTime()) / 1000)) : null,
    };
  }

  async evaluations(query: GuardrailEvaluationListQuery): Promise<GuardrailEvaluationListResponse> {
    assertGuardrailPlatformAdmin(this.requestUser, this.tenantId, 'read guardrail evaluations');
    const window = this.window(query);
    const page = await this.evaluationRows.listForDrilldown({
      ...window,
      limit: query.limit ?? DEFAULT_PAGE,
      ...(query.decision ? { decision: query.decision } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.checkId ? { checkId: query.checkId } : {}),
      ...(query.consultationId ? { consultationId: query.consultationId } : {}),
      ...(query.cursor ? { after: decodeCursor(query.cursor) } : {}),
    });
    return {
      items: page.items.map((item) => ({ ...item, at: item.at.toISOString() })),
      hasMore: page.hasMore,
      nextCursor: page.hasMore && page.last ? encodeCursor(page.last) : null,
    };
  }

  private window(query: GuardrailMetricsWindowQuery): { from: Date; to: Date; tenantId?: string } {
    const to = query.to ? new Date(query.to) : this.now();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_WINDOW_MS);
    if (!(from.getTime() < to.getTime())) throw new BadRequestException({ code: 'GUARDRAIL_METRICS_WINDOW_INVALID', message: '`from` must be before `to`.' });
    if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
      throw new BadRequestException({ code: 'GUARDRAIL_METRICS_WINDOW_INVALID', message: 'A monitoring window is at most 31 days.' });
    }
    return { from, to, ...(query.tenantId ? { tenantId: query.tenantId } : {}) };
  }

  private async readResidency(): Promise<ModelResidencyStateSnapshot | null> {
    const reader = this.residency as (IModelResidencyService & { getLifecycleStates?: () => Promise<ModelResidencyStateSnapshot> }) | undefined;
    if (!reader?.getLifecycleStates) return null;
    try {
      return await reader.getLifecycleStates();
    } catch (error) {
      this.logger.warn({ message: 'guardrail.monitoring.residency_unavailable', error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }
}

/** Every allowed bucket name (re-exported for the controller's docs). */
export const GUARDRAIL_MONITORING_BUCKETS = GUARDRAIL_METRICS_BUCKETS;

function toSamples(samples: readonly PrometheusSample[] | undefined): GuardrailMetricSample[] {
  return (samples ?? []).map((sample) => ({ labels: { ...sample.metric }, value: sample.value }));
}

function residencyOf(states: ModelResidencyStateSnapshot | null, modelId: string): string {
  if (!states) return 'unknown';
  const found = states.services.flatMap((service) => service.models).filter((entry) => entry.aiModelId === modelId);
  if (found.some((entry) => entry.state === 'loaded')) return 'loaded';
  return found[0]?.state ?? 'not_loaded';
}

function encodeCursor(position: { at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ at: position.at.toISOString(), id: position.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : null;
    if (!at || Number.isNaN(at.getTime()) || typeof parsed.id !== 'string' || parsed.id.length === 0) throw new Error('shape');
    return { at, id: parsed.id };
  } catch {
    throw new BadRequestException({ code: 'GUARDRAIL_METRICS_CURSOR_INVALID', message: 'The cursor is not one this endpoint issued.' });
  }
}
