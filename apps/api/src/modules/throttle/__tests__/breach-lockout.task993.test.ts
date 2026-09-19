/**
 * TASK-993 lane J, item 1 (defect D-2) — the guard's side of the breach
 * posture.
 *
 * `window-only-storage.task993.test.ts` proves what `blockDuration: 0` DOES
 * (identically on both backends, Redis included). This file proves the guard
 * actually asks for it — on every lane, including the opt-in tiers and the
 * per-principal bucket — and that `rate-limit.lockout.enabled` is the one
 * switch that puts the old 60-second lockout back.
 *
 * The wiring matters as much as the semantics: a lockout the tenant aggregate
 * applies but the per-principal bucket does not would be two different
 * platforms depending on which lane refused you first.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import * as jwtLib from 'jsonwebtoken';
import { IRateLimitSettingsService, SecretsService, type RateLimitPrincipalPolicy } from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';
import { WindowOnlyThrottlerStorage } from '../window-only-storage';
import { ThrottlerStorageService } from '@nestjs/throttler';

const TEST_JWT_SECRET = 'breach-lockout-test-secret';
const makeJwt = (tenantId: string, id: string): string => jwtLib.sign({ tenantId, id }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
const secretsStub = { getSecretSync: (k: string) => (k === 'JWT_SECRET_KEY' ? TEST_JWT_SECRET : undefined) } as unknown as SecretsService;

/** Every `blockDuration` the guard asked the storage for, in order. */
const asked: Array<{ limit: number; ttl: number; blockDuration: number }> = [];

class RecordingStorage extends WindowOnlyThrottlerStorage {
  override async increment(key: string, ttl: number, limit: number, blockDuration: number, name: string) {
    asked.push({ limit, ttl, blockDuration });
    return super.increment(key, ttl, limit, blockDuration, name);
  }
}

@Controller('bl')
class BreachController {
  @Get('plain')
  plain() {
    return { ok: true };
  }

  @Get('heavy')
  @Throttle({ heavy: { limit: 2, ttl: 30_000 } })
  heavy() {
    return { ok: true };
  }
}

const stub = {
  lockout: false,
  principal: { enabled: true, limit: 2, ttl: 45_000 } as RateLimitPrincipalPolicy,
};

const settings: IRateLimitSettingsService = {
  isEnabled: () => true,
  getTier: () => ({ limit: 50, ttl: 60_000 }),
  getRouteOverride: () => undefined,
  isEnabledForTenant: () => true,
  getTierForTenant: () => ({ limit: 50, ttl: 60_000, limitSource: 'tenant', ttlSource: 'tenant' }),
  getPrincipalPolicy: () => stub.principal,
  isLockoutEnabled: () => stub.lockout,
};

describe('TieredThrottlerGuard — what one request over the line costs (D-2)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [BreachController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: SecretsService, useValue: secretsStub },
      ],
    })
      .overrideProvider(ThrottlerStorage)
      .useValue(new RecordingStorage(new ThrottlerStorageService()))
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = prevEnabled;
  });

  beforeEach(() => {
    asked.length = 0;
    stub.lockout = false;
  });

  const asUser = (tenant: string, user: string, path = '/bl/plain') =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${makeJwt(tenant, user)}`);

  it('asks for NO lockout on every lane by default — the per-principal bucket included', async () => {
    await asUser('t-default', 'u-1').expect(200);

    // Two lanes ran for a tenant-resolved request: the per-principal bucket
    // (45s window) and the tenant aggregate (60s).
    expect(asked.map((a) => a.ttl)).toEqual([45_000, 60_000]);
    expect(asked.every((a) => a.blockDuration === 0)).toBe(true);
  });

  it('asks for NO lockout on the opt-in tiers too — `strict` is where a breach hurt most', async () => {
    // `auth/login` rides `strict`; a fat-fingered password used to cost a
    // clinician the next 60 seconds of the whole gateway lane.
    await request(app.getHttpServer()).get('/bl/heavy').expect(200);

    // Two lanes: the always-on `default` tier and the opted-in `heavy` one.
    expect(asked).toContainEqual({ limit: 2, ttl: 30_000, blockDuration: 0 });
    expect(asked.every((a) => a.blockDuration === 0)).toBe(true);
  });

  it('restores the full-window lockout — and nothing else — when an operator turns it on', async () => {
    stub.lockout = true;
    await asUser('t-lockout', 'u-2').expect(200);

    // `blockDuration === ttl` per lane: the ONLY value the Redis and in-memory
    // backends agree on, and byte-for-byte what shipped before this fix.
    expect(asked).toEqual([
      { limit: 2, ttl: 45_000, blockDuration: 45_000 },
      { limit: 50, ttl: 60_000, blockDuration: 60_000 },
    ]);
  });

  it('a refused caller is served again as soon as its window rolls', async () => {
    // The end-to-end shape of the defect: 2 allowed, the 3rd refused, and —
    // the part that was broken — served again at the window boundary rather
    // than 60 s after the breach.
    stub.principal = { enabled: true, limit: 2, ttl: 400 };
    const TENANT = 't-recovery';

    expect((await asUser(TENANT, 'u-3')).status).toBe(200);
    expect((await asUser(TENANT, 'u-3')).status).toBe(200);
    const refused = await asUser(TENANT, 'u-3');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 600));
    expect((await asUser(TENANT, 'u-3')).status).toBe(200);

    stub.principal = { enabled: true, limit: 2, ttl: 45_000 };
  });
});
