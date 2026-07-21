/**
 * PlatformMetricsService.getPlatformMetrics.
 *
 * Per the APPROVED Prometheus-source decision (#1), the rate/error/p95 maths are
 * performed by PromQL (rate()/histogram_quantile()/clamp_min) — the service
 * COMPOSES the canonical queries from METRIC-CONTRACT.md and MAPS the results:
 *   - requests/min   = rate * 60
 *   - error rate %   = ratio * 100 (PromQL clamp_min avoids divide-by-zero)
 *   - p95 ms         = seconds * 1000
 *   - openSockets    = injected Redis socket-registry aggregate (#17)
 *   - models         = static inventory ⨝ Prometheus vectors; missing → null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformMetricsService } from '../platform-metrics.service';

function makePrometheus() {
  return {
    isConfigured: () => true,
    instant: vi.fn(async (q: string) => {
      if (q.startsWith('sum(rate(http_requests_total{status')) return 0.05; // error ratio
      if (q.startsWith('sum(rate(http_requests_total[5m]))')) return 2; // request rate (→120/min)
      if (q.startsWith('histogram_quantile(0.95, sum by (le) (rate(http_request_duration')) return 0.25; // overall p95 (→250ms)
      if (q.startsWith('sum(rate(active_connections_count')) return 0.5; // socket rate (→30/min)
      return null;
    }),
    instantVector: vi.fn(async (q: string) => {
      if (q.includes('model_running_instances')) {
        return [{ metric: { service: 'stt', model: 'whisper-large-v3-turbo' }, value: 2 }];
      }
      if (q.includes('model_inference_latency_seconds_sum')) {
        return [{ metric: { service: 'stt', model: 'whisper-large-v3-turbo' }, value: 0.1 }];
      }
      if (q.includes('by (le, service)')) {
        return [{ metric: { service: 'api-gateway' }, value: 0.2 }]; // per-service p95 → 200ms
      }
      if (q.includes('sum by (service) (rate(http_requests_total{status')) {
        return [{ metric: { service: 'api-gateway' }, value: 0.01 }]; // per-service error → 1%
      }
      if (q.includes('sum by (service) (rate(http_requests_total[5m]))')) {
        return [{ metric: { service: 'api-gateway' }, value: 3 }]; // per-service rate → 180/min
      }
      return [];
    }),
    range: vi.fn(async () => []),
  };
}

function makeCache() {
  return { get: vi.fn(async () => null), setex: vi.fn(async () => undefined) };
}

describe('PlatformMetricsService.getPlatformMetrics (#1)', () => {
  let prometheus: ReturnType<typeof makePrometheus>;
  let sockets: { getAggregateCount: ReturnType<typeof vi.fn>; publishLocalCount: ReturnType<typeof vi.fn> };
  let cache: ReturnType<typeof makeCache>;
  let service: PlatformMetricsService;

  beforeEach(() => {
    prometheus = makePrometheus();
    sockets = { getAggregateCount: vi.fn(async () => 7), publishLocalCount: vi.fn() };
    cache = makeCache();
    // Repository args (never exercised by these Prometheus-focused
    // specs; getConsumptionRollup has its own suite with real repo stubs).
    service = new PlatformMetricsService(prometheus as any, sockets as any, cache as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  });

  it('maps the Prometheus rate to requests/min', async () => {
    const res = await service.getPlatformMetrics();
    expect(res.requestsPerMinute).toBe(120);
  });

  it('maps the error ratio to a percentage (no divide-by-zero — PromQL clamp_min)', async () => {
    const res = await service.getPlatformMetrics();
    expect(res.errorRatePct).toBe(5);
  });

  it('converts the p95 seconds quantile to ms', async () => {
    const res = await service.getPlatformMetrics();
    expect(res.p95LatencyMs).toBe(250);
  });

  it('reflects the injected socket-registry aggregate as openSockets (#17)', async () => {
    const res = await service.getPlatformMetrics();
    expect(res.openSockets).toBe(7);
    expect(res.socketsPerMinute).toBe(30);
  });

  it('merges the static model inventory with the scrape; missing service → null (not 0)', async () => {
    const res = await service.getPlatformMetrics();
    expect(res.models.perModel).toHaveLength(6);

    const whisper = res.models.perModel.find((m) => m.id === 'whisper-large-v3-turbo');
    expect(whisper?.running).toBe(2);
    expect(whisper?.avgLatencyMs).toBe(100);

    const silero = res.models.perModel.find((m) => m.id === 'silero-vad-v5');
    expect(silero?.running).toBeNull();
    expect(silero?.avgLatencyMs).toBeNull();

    expect(res.models.running).toBe(1);
  });

  it('builds per-service rows keyed by the `service` label', async () => {
    const res = await service.getPlatformMetrics();
    const gateway = res.services.find((s) => s.key === 'api-gateway');
    expect(gateway?.p95LatencyMs).toBe(200);
    expect(gateway?.requestsPerMinute).toBe(180);
    expect(gateway?.errorRatePct).toBe(1);
  });

  it('serves a cached payload on a hit without recomputation', async () => {
    const cached = { requestsPerMinute: 999 };
    cache.get.mockResolvedValueOnce(JSON.stringify(cached));
    const res = await service.getPlatformMetrics();
    expect(res.requestsPerMinute).toBe(999);
    expect(prometheus.instant).not.toHaveBeenCalled();
  });
});
