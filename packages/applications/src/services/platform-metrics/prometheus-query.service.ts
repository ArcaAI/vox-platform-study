import { Injectable, Logger } from '@nestjs/common';

/**
 * One instant-query sample: the metric's label set plus its numeric value.
 */
export interface PrometheusSample {
  metric: Record<string, string>;
  value: number;
}

/**
 * One range-query series: the metric's label set plus `[unixSeconds, value]` points.
 */
export interface PrometheusRangeSeries {
  metric: Record<string, string>;
  values: Array<{ t: number; value: number }>;
}

/**
 * TASK-386 (decision #1) — thin client over the Prometheus HTTP API
 * (`/api/v1/query`, `/api/v1/query_range`). The platform-metrics service codes
 * against this INTERFACE so unit tests can mock it; the canonical PromQL lives
 * in the service (lifted verbatim from METRIC-CONTRACT.md).
 *
 * Every method degrades gracefully (returns `null`/`[]`) when Prometheus is
 * unreachable or returns an error, so the read endpoints never fail just
 * because the observability stack is down (e.g. the TEST stack without
 * Prometheus).
 */
export interface IPrometheusQueryService {
  /** True when a Prometheus base URL is configured (always true given the localhost default). */
  isConfigured(): boolean;
  /** Instant query → the first sample's scalar value, or `null` when empty/unavailable. */
  instant(query: string): Promise<number | null>;
  /** Instant query → every returned sample (vector). Empty array when unavailable. */
  instantVector(query: string): Promise<PrometheusSample[]>;
  /** Range query → one series per label set. Empty array when unavailable. */
  range(query: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusRangeSeries[]>;
}

export const IPrometheusQueryService = Symbol('IPrometheusQueryService');

const DEFAULT_PROMETHEUS_URL = 'http://localhost:9090';
const QUERY_TIMEOUT_MS = 2500;

@Injectable()
export class PrometheusQueryService implements IPrometheusQueryService {
  private readonly logger = new Logger(PrometheusQueryService.name);
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.PROMETHEUS_URL || DEFAULT_PROMETHEUS_URL).replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  async instant(query: string): Promise<number | null> {
    const samples = await this.instantVector(query);
    return samples.length > 0 ? samples[0].value : null;
  }

  async instantVector(query: string): Promise<PrometheusSample[]> {
    const json = await this.fetchJson(`/api/v1/query?query=${encodeURIComponent(query)}`);
    const result = json?.data?.result;
    if (!Array.isArray(result)) return [];

    const samples: PrometheusSample[] = [];
    for (const row of result) {
      const value = Number(row?.value?.[1]);
      if (Number.isFinite(value)) {
        samples.push({ metric: row?.metric ?? {}, value });
      }
    }
    return samples;
  }

  async range(query: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusRangeSeries[]> {
    const params = `query=${encodeURIComponent(query)}&start=${startSec}&end=${endSec}&step=${stepSec}`;
    const json = await this.fetchJson(`/api/v1/query_range?${params}`);
    const result = json?.data?.result;
    if (!Array.isArray(result)) return [];

    return result.map((row) => ({
      metric: row?.metric ?? {},
      values: (Array.isArray(row?.values) ? row.values : [])
        .map((pair: [number, string]) => ({ t: Number(pair[0]), value: Number(pair[1]) }))
        .filter((p: { t: number; value: number }) => Number.isFinite(p.value)),
    }));
  }

  /**
   * Issue a GET against the Prometheus HTTP API with a short abort timeout.
   * Returns the parsed JSON on a `status:"success"` response, else `null`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchJson(path: string): Promise<any | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) {
        this.logger.debug({ message: 'Prometheus query non-200', status: res.status, path });
        return null;
      }
      const json = await res.json();
      if (json?.status !== 'success') {
        this.logger.debug({ message: 'Prometheus query not successful', status: json?.status, path });
        return null;
      }
      return json;
    } catch (error) {
      // Connection refused / DNS / timeout → degrade silently to "no data".
      this.logger.debug({
        message: 'Prometheus query failed (degrading to empty)',
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
