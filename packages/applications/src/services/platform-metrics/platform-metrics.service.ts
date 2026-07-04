import { Inject, Injectable, Logger } from '@nestjs/common';
import { AudioRecordingRepository, ConsultationRepository, MediaRepository, SummaryMetaRepository, TenantBucketRepository } from '@arcaai/domains';
import { IPlatformMetricsService } from './IPlatformMetricsService';
import { IPrometheusQueryService, PrometheusSample } from './prometheus-query.service';
import { ISocketRegistryService } from './socket-registry.service';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';
import {
  PlatformMetricsResponse,
  PlatformServiceMetric,
  PlatformModelMetric,
  OpenSocketsResponse,
  ConsumptionRollupResponse,
  RequestVolumePoint,
} from './dto';

/**
 * Static model inventory (matches METRIC-CONTRACT.md §3 + FE PLATFORM_MODELS).
 * `service` uses the lowercase Prometheus `service` label so rows merge against
 * `model_running_instances{service,model}`.
 */
const MODEL_INVENTORY: ReadonlyArray<{ id: string; service: string }> = [
  { id: 'whisper-large-v3-turbo', service: 'stt' },
  { id: 'silero-vad-v5', service: 'stt' },
  { id: 'gemma-4-e4b', service: 'smr' },
  { id: 'granite-guardian-4.1-8b', service: 'guardrail' },
  { id: 'Medical-NER', service: 'nlp' },
  { id: 'symps-disease-bert', service: 'nlp' },
];

/** Canonical PromQL, lifted verbatim from METRIC-CONTRACT.md. */
const PROMQL = {
  requestRate: 'sum(rate(http_requests_total[5m]))',
  errorRatio: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1)',
  p95: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))',
  socketRate: 'sum(rate(active_connections_count[5m]))',
  perServiceP95: 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))',
  perServiceRate: 'sum by (service) (rate(http_requests_total[5m]))',
  perServiceErrorRatio:
    'sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum by (service) (rate(http_requests_total[5m])), 1)',
  modelRunning: 'sum by (service, model) (model_running_instances)',
  modelAvgLatency:
    'sum by (service, model) (rate(model_inference_latency_seconds_sum[5m])) / sum by (service, model) (rate(model_inference_latency_seconds_count[5m]))',
  seriesRequests: 'sum(rate(http_requests_total[1m]))',
  seriesSockets: 'sum(active_connections_count)',
} as const;

const CACHE_TTL_SECONDS = 12;

@Injectable()
export class PlatformMetricsService implements IPlatformMetricsService {
  private readonly logger = new Logger(PlatformMetricsService.name);

  constructor(
    @Inject(IPrometheusQueryService) private readonly prometheus: IPrometheusQueryService,
    @Inject(ISocketRegistryService) private readonly sockets: ISocketRegistryService,
    @Inject(IRedisCacheService) private readonly cache: IRedisCacheService,
    // TASK-414 — the consumption roll-up reads route through domain
    // repositories (TASK-311 AC-8) instead of the raw Prisma client.
    private readonly audioRecordingRepository: AudioRecordingRepository,
    private readonly summaryMetaRepository: SummaryMetaRepository,
    private readonly mediaRepository: MediaRepository,
    private readonly tenantBucketRepository: TenantBucketRepository,
    private readonly consultationRepository: ConsultationRepository,
  ) {}

  async getPlatformMetrics(): Promise<PlatformMetricsResponse> {
    return this.cached('platform:metrics', async () => {
      const [requestRate, errorRatio, p95, socketRate, openSockets, services, models, requestVolumeSeries] = await Promise.all([
        this.prometheus.instant(PROMQL.requestRate),
        this.prometheus.instant(PROMQL.errorRatio),
        this.prometheus.instant(PROMQL.p95),
        this.prometheus.instant(PROMQL.socketRate),
        this.sockets.getAggregateCount(),
        this.buildServiceMetrics(),
        this.buildModelMetrics(),
        this.buildRequestVolumeSeries(),
      ]);

      return {
        requestsPerMinute: round(toNumber(requestRate) * 60),
        errorRatePct: round2(toNumber(errorRatio) * 100),
        p95LatencyMs: round(toNumber(p95) * 1000),
        openSockets,
        socketsPerMinute: round(toNumber(socketRate) * 60),
        services,
        models,
        requestVolumeSeries,
        refreshedAt: new Date().toISOString(),
      };
    });
  }

  async getOpenSockets(): Promise<OpenSocketsResponse> {
    return this.cached('platform:sockets', async () => {
      const [open, socketRate] = await Promise.all([this.sockets.getAggregateCount(), this.prometheus.instant(PROMQL.socketRate)]);
      return {
        open,
        perMinute: round(toNumber(socketRate) * 60),
        total: open,
        refreshedAt: new Date().toISOString(),
      };
    });
  }

  async getConsumptionRollup(tenantId: string | null): Promise<ConsumptionRollupResponse> {
    return this.cached(`platform:consumption:${tenantId ?? 'all'}`, async () => {
      const tenantWhere = tenantId ? { tenantId } : {};
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const [durationSum, summaries24h, sizeSum, quotaSum, totalConsultations, consultationsToday] = await Promise.all([
        this.audioRecordingRepository.sumDurationForTenant(tenantId),
        this.summaryMetaRepository.countGeneratedSince(since24h, tenantId),
        this.mediaRepository.sumSizeForTenant(tenantId),
        this.tenantBucketRepository.sumConfiguredQuotaBytes(tenantId),
        this.consultationRepository.count({ filters: tenantWhere }),
        this.consultationRepository.count({ filters: { ...tenantWhere, createdAt: { gte: startOfToday } } }),
      ]);

      const durationMs = durationSum ?? 0;

      return {
        transcriptionMinutes: round2(durationMs / 60000),
        summaries24h,
        storageUsedBytes: sizeSum ?? 0,
        storageQuotaBytes: quotaSum === null || quotaSum === undefined ? null : Number(quotaSum),
        consultations: { total: totalConsultations, today: consultationsToday },
        refreshedAt: new Date().toISOString(),
      };
    });
  }

  /** Merge the per-service Prometheus vectors (p95 / rate / error) keyed by `service`. */
  private async buildServiceMetrics(): Promise<PlatformServiceMetric[]> {
    const [p95Rows, rateRows, errorRows] = await Promise.all([
      this.prometheus.instantVector(PROMQL.perServiceP95),
      this.prometheus.instantVector(PROMQL.perServiceRate),
      this.prometheus.instantVector(PROMQL.perServiceErrorRatio),
    ]);

    const keys = new Set<string>();
    const collect = (rows: PrometheusSample[]) => rows.forEach((r) => r.metric.service && keys.add(r.metric.service));
    collect(p95Rows);
    collect(rateRows);
    collect(errorRows);

    const byService = (rows: PrometheusSample[], key: string) => rows.find((r) => r.metric.service === key)?.value;

    return Array.from(keys)
      .sort()
      .map((key) => {
        const p95 = byService(p95Rows, key);
        const rate = byService(rateRows, key);
        const error = byService(errorRows, key);
        return {
          key,
          p95LatencyMs: p95 === undefined ? null : round(p95 * 1000),
          requestsPerMinute: rate === undefined ? null : round(rate * 60),
          errorRatePct: error === undefined ? null : round2(error * 100),
        };
      });
  }

  /** Merge the static model inventory with the Prometheus per-model vectors (#19). */
  private async buildModelMetrics(): Promise<PlatformMetricsResponse['models']> {
    const [runningRows, latencyRows] = await Promise.all([
      this.prometheus.instantVector(PROMQL.modelRunning),
      this.prometheus.instantVector(PROMQL.modelAvgLatency),
    ]);

    const find = (rows: PrometheusSample[], service: string, model: string) =>
      rows.find((r) => r.metric.service === service && r.metric.model === model)?.value;

    const perModel: PlatformModelMetric[] = MODEL_INVENTORY.map(({ id, service }) => {
      const running = find(runningRows, service, id);
      const latency = find(latencyRows, service, id);
      return {
        id,
        service,
        // Missing from the scrape → null (NOT 0): "not reporting" ≠ "idle".
        running: running === undefined ? null : Math.round(running),
        avgLatencyMs: latency === undefined ? null : round(latency * 1000),
      };
    });

    const running = perModel.filter((m) => (m.running ?? 0) > 0).length;
    return { running, perModel };
  }

  /** Best-effort 30-minute request/socket time-series via Prometheus range queries. */
  private async buildRequestVolumeSeries(): Promise<RequestVolumePoint[]> {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 30 * 60;
    const step = 60;

    const [requestSeries, socketSeries] = await Promise.all([
      this.prometheus.range(PROMQL.seriesRequests, start, end, step),
      this.prometheus.range(PROMQL.seriesSockets, start, end, step),
    ]);

    const requests = requestSeries[0]?.values ?? [];
    if (requests.length === 0) return [];

    const socketsByTs = new Map<number, number>();
    (socketSeries[0]?.values ?? []).forEach((p) => socketsByTs.set(p.t, p.value));

    return requests.map((p) => ({
      t: new Date(p.t * 1000).toISOString(),
      requests: round2(p.value),
      sockets: Math.round(socketsByTs.get(p.t) ?? 0),
    }));
  }

  /**
   * Redis-cached read wrapper (decision #7). Degrades to a live computation when
   * Redis is unavailable (cache.get → null, cache.setex → no-op).
   */
  private async cached<T>(key: string, producer: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get(key);
    if (hit) {
      try {
        return JSON.parse(hit) as T;
      } catch {
        // Corrupt cache entry → fall through and recompute.
      }
    }
    const value = await producer();
    await this.cache.setex(key, CACHE_TTL_SECONDS, JSON.stringify(value));
    return value;
  }
}

function toNumber(value: number | null | undefined): number {
  return value === null || value === undefined || !Number.isFinite(value) ? 0 : value;
}

function round(value: number): number {
  return Math.round(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
