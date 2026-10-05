/**
 * The sunset gate: every request to an `@ApiDeprecated` route increments
 * `<prefix>deprecated_requests_total{route, removeIn}`, where `route` is the route TEMPLATE.
 */
import 'reflect-metadata';
import { lastValueFrom, of } from 'rxjs';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { ApiDeprecated } from '../api-deprecated.decorator';
import { gatewayMetricPrefix } from '../../observability/metric-naming';

const NAME = () => `${gatewayMetricPrefix()}deprecated_requests_total`;

function interceptorsOf(removeIn: string) {
  class Probe {
    handler(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Probe.prototype, 'handler')!;
  ApiDeprecated({ ticket: 'TASK-1045', removeIn })(Probe.prototype, 'handler', descriptor);
  return (Reflect.getMetadata(INTERCEPTORS_METADATA, descriptor.value as object) ?? []) as Array<new () => { intercept: Function }>;
}

function contextFor(route: { path: string } | undefined, baseUrl = '', url = '/raw/123') {
  return { switchToHttp: () => ({ getRequest: () => ({ route, baseUrl, url }) }) };
}

async function valueOf(): Promise<Array<{ labels: Record<string, string>; value: number }>> {
  const metric = register.getSingleMetric(NAME());
  return metric ? ((await metric.get()).values as never) : [];
}

describe('@ApiDeprecated request counter', () => {
  beforeEach(() => register.resetMetrics());
  afterEach(() => register.resetMetrics());

  it('counts a request by route template and removeIn, never by the raw URL', async () => {
    const [Interceptor] = interceptorsOf('R5');
    expect(Interceptor).toBeDefined();
    const interceptor = new Interceptor();
    const handler = { handle: () => of('ok') };
    await lastValueFrom(interceptor.intercept(contextFor({ path: '/consultations/:id/prime' }, '/api/v1', '/api/v1/consultations/abc-123/prime'), handler));
    await lastValueFrom(interceptor.intercept(contextFor({ path: '/consultations/:id/prime' }, '/api/v1', '/api/v1/consultations/def-456/prime'), handler));
    const samples = await valueOf();
    expect(samples).toHaveLength(1);
    expect(samples[0].labels).toEqual({ route: '/api/v1/consultations/:id/prime', removeIn: 'R5' });
    expect(samples[0].value).toBe(2);
  });

  it('keeps separate series per removeIn and does not break when a route is unknown', async () => {
    const [A] = interceptorsOf('R5');
    const [B] = interceptorsOf('R6');
    const handler = { handle: () => of('ok') };
    await lastValueFrom(new A().intercept(contextFor(undefined), handler));
    await lastValueFrom(new B().intercept(contextFor(undefined), handler));
    const labels = (await valueOf()).map((s) => s.labels);
    expect(labels).toEqual(expect.arrayContaining([{ route: '<unmatched>', removeIn: 'R5' }, { route: '<unmatched>', removeIn: 'R6' }]));
  });
});
