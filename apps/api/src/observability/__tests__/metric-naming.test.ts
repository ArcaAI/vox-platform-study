/**
 * Every gateway series is prefixed from `OTEL_SERVICE_NAME` — `hope_api_` in
 * the cluster, `api_gateway_` locally. Lane H registers its metrics directly
 * on prom-client's global register rather than through `IMetricsService` (it
 * runs in `main.ts`, before DI exists), so it has to derive the same prefix
 * independently.
 *
 * Two derivations of one name is how they drift, and a drift here is silent:
 * the HPA's prometheus-adapter rule matches `hope_api_prisma_pool_*`
 * exactly, so a prefix that diverged by one character would leave the
 * saturation trigger matching nothing while every other gateway panel kept
 * working. The last test pins the two derivations together by BEHAVIOUR —
 * it registers a metric through the real `SimplifiedMetricsService` and
 * compares the name it landed under.
 */
import { SimplifiedMetricsService } from '@arcaai/applications';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatewayMetricPrefix, gatewayServiceLabel } from '../metric-naming';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
  register.removeSingleMetric(`${gatewayMetricPrefix()}metric_naming_parity_probe_total`);
});

describe('gatewayMetricPrefix', () => {
  it('sanitizes the cluster service name into the prefix the adapter rule matches', () => {
    process.env.OTEL_SERVICE_NAME = 'hope-api';
    delete process.env.METRICS_PREFIX;
    expect(gatewayMetricPrefix()).toBe('hope_api_');
  });

  it('sanitizes the local service name the same way', () => {
    process.env.OTEL_SERVICE_NAME = 'api-gateway';
    delete process.env.METRICS_PREFIX;
    expect(gatewayMetricPrefix()).toBe('api_gateway_');
  });

  it('treats an EMPTY METRICS_PREFIX as absent — `.env.dev` ships it blank', () => {
    process.env.OTEL_SERVICE_NAME = 'api-gateway';
    process.env.METRICS_PREFIX = '';
    expect(gatewayMetricPrefix()).toBe('api_gateway_');
  });

  it('lets an explicit METRICS_PREFIX win', () => {
    process.env.OTEL_SERVICE_NAME = 'api-gateway';
    process.env.METRICS_PREFIX = 'custom_';
    expect(gatewayMetricPrefix()).toBe('custom_');
  });

  it('falls back to the same default service name when OTEL_SERVICE_NAME is unset', () => {
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.METRICS_PREFIX;
    expect(gatewayMetricPrefix()).toBe('hope_service_');
    expect(gatewayServiceLabel()).toBe('hope-service');
  });
});

describe('parity with SimplifiedMetricsService', () => {
  /**
   * The load-bearing test of this file. It does not compare the two
   * implementations — it registers a probe through the REAL DI metrics
   * service and asserts the name and label it actually landed under, so a
   * change to either derivation breaks it.
   */
  it('derives the SAME prefix and service label the DI metrics service uses', async () => {
    process.env.OTEL_SERVICE_NAME = 'hope-api';
    delete process.env.METRICS_PREFIX;

    const service = new SimplifiedMetricsService();
    service.createCounter({ name: 'metric_naming_parity_probe_total', help: 'parity probe', labelNames: [] });
    service.incrementCounter('metric_naming_parity_probe_total');

    expect(register.getSingleMetric(`${gatewayMetricPrefix()}metric_naming_parity_probe_total`)).toBeDefined();
    const scrape = await register.getSingleMetricAsString(`${gatewayMetricPrefix()}metric_naming_parity_probe_total`);
    expect(scrape).toContain(`service="${gatewayServiceLabel()}"`);
  });
});
