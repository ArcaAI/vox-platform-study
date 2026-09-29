/**
 * A6 (tiered limiter half) — a 429 from `TieredThrottlerGuard` used to be
 * silent: the guard throws before any interceptor runs, and the envelope filter
 * logged nothing. It now produces exactly one `warn` failure line carrying the
 * route template, the limiter and tier that refused, and `retryAfter`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for framework types */
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { IRateLimitSettingsService, SecretsService } from '@arcaai/applications';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GLOBAL_EXCEPTION_FILTERS } from '../../../filters/global-filters';
import { CLS_MODULE_OPTIONS } from '../../../request-id';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';
import { WindowOnlyThrottlerStorage } from '../window-only-storage';

@Controller('tl')
class LimitedController {
  @Get('plain')
  plain() {
    return { ok: true };
  }
}

const settings: IRateLimitSettingsService = {
  isEnabled: () => true,
  getTier: () => ({ limit: 1, ttl: 60_000 }),
  getRouteOverride: () => undefined,
  isEnabledForTenant: () => true,
  getTierForTenant: () => ({ limit: 1, ttl: 60_000, limitSource: 'tenant', ttlSource: 'tenant' }),
  getPrincipalPolicy: () => ({ enabled: false, limit: 1, ttl: 60_000 }),
  isLockoutEnabled: () => false,
} as any;

const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn(), fatal: vi.fn() };

describe('TieredThrottlerGuard — a 429 writes one warn line', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ClsModule.forRoot(CLS_MODULE_OPTIONS), ThrottleConfigModule],
      controllers: [LimitedController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        ...GLOBAL_EXCEPTION_FILTERS.map((useClass) => ({ provide: APP_FILTER, useClass })),
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: SecretsService, useValue: { getSecretSync: () => undefined } },
      ],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(new WindowOnlyThrottlerStorage(new ThrottlerStorageService()))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useLogger(logger);
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = prevEnabled;
  });

  it('logs route template, limiter, tier and retryAfter at warn; header and body share the id', async () => {
    await request(app.getHttpServer()).get('/tl/plain?probe=1').expect(200);
    for (const fn of Object.values(logger)) fn.mockClear();

    const res = await request(app.getHttpServer()).get('/tl/plain?probe=2').expect(429);
    expect(res.body.correlationId).toBe(res.headers['x-request-id']);

    const lines = logger.warn.mock.calls.map((c) => c[0]).filter((f: any) => f?.message === 'Request failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 429, route: '/tl/plain', limiter: 'tiered', tier: 'default', code: 'HTTP.TOO_MANY_REQUESTS' });
    expect(typeof lines[0].retryAfter).toBe('number');
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('probe=2');
  });
});
