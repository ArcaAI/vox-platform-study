/**
 * TASK-993 lane H item 2 — the request metric that can SEE a refusal.
 *
 * `api_gateway_http_requests_total` is written by `MetricsInterceptor`, and
 * Nest runs guards BEFORE interceptors: a 429 from `TieredThrottlerGuard`, a
 * 401 from `UnifiedAuthGuard` or a 403 from `AuthorizationGuard` never reaches
 * `next.handle()`, so the interceptor is never invoked and the counter never
 * moves. Lane G measured the gap on a real run: the client issued 96 requests
 * and the gateway counted 43.
 *
 * That makes the existing metric go QUIET exactly when the platform starts
 * refusing traffic — the worst possible property for the signal an HPA or an
 * error-rate alert reads. An interceptor structurally cannot fix it; Express
 * middleware, which runs before the guards and observes the final status on
 * `res.on('close')`, can.
 *
 * The load-bearing test here is "counts a 429 a guard produced". Everything
 * else guards the cardinality of the label set it does it with.
 */
import { request as httpRequest } from 'node:http';

import { CanActivate, Controller, Get, HttpException, HttpStatus, type INestApplication, Injectable, Param } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { register } from 'prom-client';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatewayMetricPrefix } from '../metric-naming';
import { HTTP_RESPONSES_TOTAL, httpResponseMetricsMiddleware, resolveResponseRouteLabel, UNMATCHED_ROUTE_LABEL } from '../http-response-metrics';

const originalEnv = { ...process.env };

/** Reset per boot; resolved by the hanging probe route the instant it is entered. */
let handlerEntered = deferred();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Poll until `read()` reports `expected`, or fail after `timeoutMs`. */
async function eventually(read: () => Promise<number>, expected: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (latest !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await read();
  }
  return latest;
}

/** Refuses anything under `/refused`, exactly as the throttler guard refuses a breach. */
@Injectable()
class RefusingGuard implements CanActivate {
  canActivate(context: Parameters<CanActivate['canActivate']>[0]): boolean {
    const req = context.switchToHttp().getRequest<{ path: string }>();
    if (req.path.includes('/refused')) throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('tenants/:id')
  byId(@Param('id') id: string) {
    return { id };
  }

  @Get('refused')
  refused() {
    throw new Error('the guard must refuse before this handler is ever reached');
  }

  /**
   * Never answers — the client is expected to abandon it. `entered` fires the
   * moment the handler runs, so the abort test can wait for a fact instead of
   * sleeping for a guessed interval (which is flaky on a loaded machine).
   */
  @Get('hangs')
  hangs(): Promise<never> {
    handlerEntered.resolve();
    return new Promise<never>(() => undefined);
  }
}

async function bootProbeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: RefusingGuard }],
  }).compile();

  handlerEntered = deferred();
  const app = moduleRef.createNestApplication();
  app.use(httpResponseMetricsMiddleware());
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

/** The sample for one label combination, or 0 when the series has not been created. */
async function sampleFor(labels: { method: string; path: string; status: string }): Promise<number> {
  const metric = register.getSingleMetric(`${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`);
  if (!metric) return 0;
  const collected = await metric.get();
  const match = collected.values.find(
    (value) => value.labels.method === labels.method && value.labels.path === labels.path && value.labels.status === labels.status,
  );
  return match?.value ?? 0;
}

let app: INestApplication | undefined;

beforeEach(() => {
  process.env = { ...originalEnv, OTEL_SERVICE_NAME: 'hope-api', METRICS_PREFIX: '' };
  register.removeSingleMetric(`${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  register.removeSingleMetric(`${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`);
  process.env = originalEnv;
});

describe('resolveResponseRouteLabel', () => {
  it('prefers the templated pattern over the resolved URL — the cardinality rule', () => {
    expect(resolveResponseRouteLabel({ method: 'GET', url: '/api/v1/tenants/9f1c?x=1', baseUrl: '', route: { path: '/api/v1/tenants/:id' } })).toBe(
      '/api/v1/tenants/:id',
    );
  });

  it('re-attaches the mount prefix Express strips from route.path', () => {
    expect(resolveResponseRouteLabel({ method: 'GET', url: '/api/v1/tenants/9f1c', baseUrl: '/api/v1', route: { path: '/tenants/:id' } })).toBe(
      '/api/v1/tenants/:id',
    );
  });

  it('does NOT fall back to the raw URL when no route matched — that is unbounded cardinality', () => {
    expect(resolveResponseRouteLabel({ method: 'GET', url: '/api/v1/' + 'x'.repeat(40), baseUrl: '', route: undefined })).toBe(UNMATCHED_ROUTE_LABEL);
  });

  it('refuses a non-string route path (array/RegExp route definitions)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveResponseRouteLabel({ method: 'GET', url: '/x', baseUrl: '', route: { path: ['/a', '/b'] as any } })).toBe(UNMATCHED_ROUTE_LABEL);
  });
});

describe('httpResponseMetricsMiddleware', () => {
  it('counts a 429 a GUARD produced — the refusal the interceptor cannot see', async () => {
    app = await bootProbeApp();
    await request(app.getHttpServer()).get('/api/v1/probe/refused').expect(429);

    expect(await sampleFor({ method: 'GET', path: '/api/v1/probe/refused', status: '429' })).toBe(1);
  });

  it('counts a handled 200 as well, so the two families are directly comparable', async () => {
    app = await bootProbeApp();
    await request(app.getHttpServer()).get('/api/v1/probe/ok').expect(200);

    expect(await sampleFor({ method: 'GET', path: '/api/v1/probe/ok', status: '200' })).toBe(1);
  });

  it('labels a parameterised route by its PATTERN, so 100 ids are one series', async () => {
    app = await bootProbeApp();
    for (const id of ['a1', 'b2', 'c3']) {
      await request(app.getHttpServer()).get(`/api/v1/probe/tenants/${id}`).expect(200);
    }

    expect(await sampleFor({ method: 'GET', path: '/api/v1/probe/tenants/:id', status: '200' })).toBe(3);

    const metric = await register.getSingleMetric(`${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`)!.get();
    expect(metric.values.filter((v) => String(v.labels.path).includes('tenants'))).toHaveLength(1);
  });

  it('folds an unrouted 404 into one bounded label instead of one series per probe', async () => {
    app = await bootProbeApp();
    await request(app.getHttpServer()).get('/api/v1/no-such-route-aaa').expect(404);
    await request(app.getHttpServer()).get('/api/v1/no-such-route-bbb').expect(404);

    expect(await sampleFor({ method: 'GET', path: UNMATCHED_ROUTE_LABEL, status: '404' })).toBe(2);
  });

  it('stamps the same `service` label as the rest of the gateway family', async () => {
    app = await bootProbeApp();
    await request(app.getHttpServer()).get('/api/v1/probe/ok').expect(200);

    const scrape = await register.getSingleMetricAsString(`${gatewayMetricPrefix()}${HTTP_RESPONSES_TOTAL}`);
    expect(scrape).toContain('service="hope-api"');
  });

  it('counts each response exactly once', async () => {
    app = await bootProbeApp();
    await request(app.getHttpServer()).get('/api/v1/probe/ok').expect(200);
    await request(app.getHttpServer()).get('/api/v1/probe/ok').expect(200);

    expect(await sampleFor({ method: 'GET', path: '/api/v1/probe/ok', status: '200' })).toBe(2);
  });

  it('counts a client that gave up as 499, instead of dropping it or calling it a 200', async () => {
    // These are the requests a `finish`-only listener loses — and under
    // saturation they are the majority, which would leave the metric quietest
    // exactly when the platform is worst. `statusCode` on an unfinished
    // response is still the default 200, so reporting it verbatim would
    // record an abandoned request as a success.
    app = await bootProbeApp();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };

    const clientRequest = httpRequest({ host: '127.0.0.1', port: address.port, path: '/api/v1/probe/hangs', method: 'GET' });
    clientRequest.on('error', () => undefined);
    clientRequest.end();

    // Wait for the handler to be ENTERED (so Express has routed the request
    // and `req.route` is populated), then walk away.
    await handlerEntered.promise;
    clientRequest.destroy();

    const counted = await eventually(() => sampleFor({ method: 'GET', path: '/api/v1/probe/hangs', status: '499' }), 1);
    expect(counted).toBe(1);
  });
});
