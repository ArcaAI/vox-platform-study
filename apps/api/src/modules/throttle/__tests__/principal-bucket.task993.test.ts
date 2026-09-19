/**
 * TASK-993 lane F — two-level bucketing (owner decision OD-2).
 *
 * ─── The defect this file pins ──────────────────────────────────────────────
 *
 * F-1: a plan-resolved limit was counted in ONE bucket for the whole tenant,
 * across every route and every caller (`tiered-throttler.guard.ts` keyed
 * `t:<tenantId>` with no route and no principal component). Lane G confirmed it
 * against the running gateway: ArcaAI (ENTERPRISE) resolved to 300/window, one
 * bucket, tenant-keyed. So ONE looping integration, ONE stuck poller or ONE
 * browser tab in a reconnect storm consumed the tenant's entire minute and
 * every other doctor on that tenant was refused for traffic they did not send.
 *
 * ─── The contract these tests fix ───────────────────────────────────────────
 *
 *   1. Two buckets apply — a per-principal one UNDER the tenant aggregate —
 *      and a request is refused when EITHER is exhausted.
 *   2. The per-principal bucket is charged FIRST, so a runaway's surplus never
 *      reaches the shared budget. That ordering is the whole fairness
 *      property; check the aggregate first and the runaway still burns the
 *      tenant's minute on every request it is about to be refused for.
 *   3. A principal is whatever the credential PROVED — never an unverified
 *      claim. An unprovable credential gets no second bucket and rides the
 *      platform IP lane exactly as before.
 *   4. The headers advertise the BINDING lane. Advertising the more generous
 *      one is D-3 in a new place: a client self-pacing off a number it can
 *      never reach is a client that gets 429'd while its headers say it has
 *      headroom.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as jwtLib from 'jsonwebtoken';
import {
  IApiKeyService,
  IRateLimitSettingsService,
  IServiceAccountService,
  SecretsService,
  type RateLimitPrincipalPolicy,
} from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';
import { RateLimitHeadersInterceptor } from '../rate-limit-headers.interceptor';

const TEST_JWT_SECRET = 'principal-bucket-test-secret';

/**
 * A real session token. `createJwt` signs a `UserSession`, whose user id is
 * `id` — NOT `sub` — which is why the principal lane reads `id`.
 */
const makeJwt = (tenantId: string, id?: string): string =>
  jwtLib.sign({ tenantId, ...(id ? { id } : {}) }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

/** `alg: none`, exactly as an attacker would forge it. */
function makeForgedJwt(tenantId: string, id: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tenantId, id })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const secretsStub = { getSecretSync: (key: string) => (key === 'JWT_SECRET_KEY' ? TEST_JWT_SECRET : undefined) } as unknown as SecretsService;

/** See `throttle-guard.test.ts`: one listener per app, not one per request. */
async function listenOnce(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}

@Controller('pb')
class PrincipalController {
  @Get('a')
  a() {
    return { ok: 'a' };
  }

  @Get('b')
  b() {
    return { ok: 'b' };
  }
}

/**
 * Mutable stub state. `tenantLimit` is reported with `limitSource: 'tenant'`
 * so the resolution lands on rank 2 and is TENANT-SCOPED — the lane the
 * per-principal bucket sits under.
 */
const stub = {
  tenantLimit: 1000,
  principal: { enabled: true, limit: 150, ttl: 60_000 } as RateLimitPrincipalPolicy,
};

const settings: IRateLimitSettingsService = {
  isEnabled: () => true,
  getTier: () => ({ limit: stub.tenantLimit, ttl: 60_000 }),
  getRouteOverride: () => undefined,
  isEnabledForTenant: () => true,
  getTierForTenant: () => ({ limit: stub.tenantLimit, ttl: 60_000, limitSource: 'tenant', ttlSource: 'tenant' }),
  getPrincipalPolicy: () => stub.principal,
  // TASK-993 lane J added this accessor to the interface; the default (OFF)
  // is what every test here assumed before it existed.
  isLockoutEnabled: () => false,
};

/** Both machine lanes resolve a tenant WITHOUT a database read. */
const MACHINE_TENANT = 'tenant-machine';
const serviceAccounts = {
  peekTenantForRateLimit: async (token: string) => (token.startsWith('good-svc-') ? MACHINE_TENANT : null),
} as unknown as IServiceAccountService;
const apiKeys = {
  peekTenantForRateLimit: async (raw: string) => (raw.startsWith('good-key-') ? MACHINE_TENANT : null),
} as unknown as IApiKeyService;

describe('TieredThrottlerGuard — per-principal bucket under the tenant ceiling', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const asUser = (tenantId: string, userId: string, path = '/pb/a') =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${makeJwt(tenantId, userId)}`);

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [PrincipalController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: RateLimitHeadersInterceptor },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: SecretsService, useValue: secretsStub },
        { provide: IServiceAccountService, useValue: serviceAccounts },
        { provide: IApiKeyService, useValue: apiKeys },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = prevEnabled;
  });

  it('a runaway principal can no longer exhaust its tenant’s whole budget', async () => {
    // Tenant aggregate 12/min; each caller 3/min.
    stub.tenantLimit = 12;
    stub.principal = { enabled: true, limit: 3, ttl: 60_000 };
    const TENANT = 'tenant-runaway';

    // The runaway makes 10 attempts. Three succeed; the rest are refused by
    // its OWN bucket and therefore never touch the tenant's.
    let runawayOk = 0;
    for (let i = 0; i < 10; i++) {
      if ((await asUser(TENANT, 'u-runaway')).status === 200) runawayOk++;
    }
    expect(runawayOk).toBe(3);

    // THE COUNTERFACTUAL. Before OD-2 all ten attempts were charged to the one
    // tenant bucket, leaving 2 of 12 for everyone else. Now the tenant has
    // spent only 3, so three other doctors get their full allowance each.
    let othersOk = 0;
    for (const user of ['u-second', 'u-third', 'u-fourth']) {
      for (let i = 0; i < 3; i++) {
        if ((await asUser(TENANT, user)).status === 200) othersOk++;
      }
    }
    expect(othersOk).toBe(9);

    // ...and the aggregate is still a real ceiling: 3 + 9 = 12 is the whole
    // tenant budget, so a fresh principal's first request is refused by the
    // TENANT lane, not by its own.
    expect((await asUser(TENANT, 'u-fifth')).status).toBe(429);
  });

  it('two principals in one tenant hold independent buckets', async () => {
    stub.tenantLimit = 100;
    stub.principal = { enabled: true, limit: 2, ttl: 60_000 };
    const TENANT = 'tenant-independent';

    expect((await asUser(TENANT, 'u-x')).status).toBe(200);
    expect((await asUser(TENANT, 'u-x')).status).toBe(200);
    expect((await asUser(TENANT, 'u-x')).status).toBe(429);

    // A different caller is untouched by the first one's exhaustion.
    expect((await asUser(TENANT, 'u-y')).status).toBe(200);
    expect((await asUser(TENANT, 'u-y')).status).toBe(200);
    expect((await asUser(TENANT, 'u-y')).status).toBe(429);
  });

  it('one principal’s bucket spans every route, matching what the number measures', async () => {
    // 44.1 req/min is a whole-SESSION rate, not a per-endpoint one, so a
    // per-route principal bucket would be N times the intended budget.
    stub.tenantLimit = 100;
    stub.principal = { enabled: true, limit: 2, ttl: 60_000 };
    const TENANT = 'tenant-cross-route';

    expect((await asUser(TENANT, 'u-routes', '/pb/a')).status).toBe(200);
    expect((await asUser(TENANT, 'u-routes', '/pb/b')).status).toBe(200);
    expect((await asUser(TENANT, 'u-routes', '/pb/b')).status).toBe(429);
  });

  it('each machine credential is its own principal', async () => {
    stub.tenantLimit = 100;
    stub.principal = { enabled: true, limit: 2, ttl: 60_000 };
    const hitKey = (key: string) => request(app.getHttpServer()).get('/pb/a').set('X-API-Key', key);
    const hitSvc = (token: string) => request(app.getHttpServer()).get('/pb/a').set('X-Service-Account-Token', token);

    expect((await hitKey('good-key-1')).status).toBe(200);
    expect((await hitKey('good-key-1')).status).toBe(200);
    expect((await hitKey('good-key-1')).status).toBe(429);

    // A SECOND key on the SAME tenant is a different caller. If the two shared
    // a bucket this first call would already be the third and be refused.
    expect((await hitKey('good-key-2')).status).toBe(200);

    // And a service-account token is a third caller again.
    expect((await hitSvc('good-svc-1')).status).toBe(200);
    expect((await hitSvc('good-svc-1')).status).toBe(200);
    expect((await hitSvc('good-svc-1')).status).toBe(429);
  });

  it('an unprovable credential gets NO principal bucket — it rides the platform IP lane', async () => {
    // The forged token names a tenant AND a user. Neither may be believed:
    // trusting `id` off an unverified payload would let an attacker pick which
    // bucket to spend, or park on someone else's.
    stub.tenantLimit = 1000;
    stub.principal = { enabled: true, limit: 1, ttl: 60_000 };

    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .get('/pb/b')
        .set('Authorization', `Bearer ${makeForgedJwt('tenant-forged', 'u-forged')}`);
      expect(res.status).toBe(200);
    }
  });

  it('a verified token with no `id` claim keeps the tenant bucket and gains no second one', async () => {
    // The tenant is proven; the caller is not. Inventing a shared
    // "anonymous-in-tenant" principal would put unrelated callers in one
    // bucket and refuse them for each other's traffic.
    stub.tenantLimit = 20;
    stub.principal = { enabled: true, limit: 1, ttl: 60_000 };
    const TENANT = 'tenant-no-id';

    for (let i = 0; i < 5; i++) {
      const res = await request(app.getHttpServer())
        .get('/pb/a')
        .set('Authorization', `Bearer ${makeJwt(TENANT)}`);
      expect(res.status).toBe(200);
    }
  });

  it('the off-switch restores the single tenant-wide counter', async () => {
    stub.tenantLimit = 20;
    stub.principal = { enabled: false, limit: 1, ttl: 60_000 };
    const TENANT = 'tenant-lane-off';

    for (let i = 0; i < 5; i++) {
      expect((await asUser(TENANT, 'u-off')).status).toBe(200);
    }
  });

  it('skips the second bucket entirely when it could never bind', async () => {
    // Per-principal 100 against a tenant aggregate of 3, same window: the
    // principal lane can never refuse anything, so it is not opened at all.
    // The refusal must therefore land exactly on the aggregate's 4th request,
    // and the headers must keep naming the aggregate.
    stub.tenantLimit = 3;
    stub.principal = { enabled: true, limit: 100, ttl: 60_000 };
    const TENANT = 'tenant-cannot-bind';

    const first = await asUser(TENANT, 'u-cb');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect((await asUser(TENANT, 'u-cb')).status).toBe(200);
    expect((await asUser(TENANT, 'u-cb')).status).toBe(200);
    expect((await asUser(TENANT, 'u-cb')).status).toBe(429);
  });

  it('a per-principal refusal carries a plain `Retry-After`', async () => {
    // Lane A's D-4 fix has to survive the new lane: every SDK reads
    // `retry-after`, and a 429 without it degrades to blind jitter backoff.
    stub.tenantLimit = 100;
    stub.principal = { enabled: true, limit: 1, ttl: 60_000 };
    const TENANT = 'tenant-retry-after';

    expect((await asUser(TENANT, 'u-ra')).status).toBe(200);
    const refused = await asUser(TENANT, 'u-ra');
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('TieredThrottlerGuard — the headers advertise the BINDING lane', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const asUser = (tenantId: string, userId: string) =>
    request(app.getHttpServer())
      .get('/pb/a')
      .set('Authorization', `Bearer ${makeJwt(tenantId, userId)}`);

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [PrincipalController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: RateLimitHeadersInterceptor },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: SecretsService, useValue: secretsStub },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = prevEnabled;
  });

  it('reports the PER-PRINCIPAL lane while it is the tighter of the two', async () => {
    stub.tenantLimit = 50;
    stub.principal = { enabled: true, limit: 4, ttl: 60_000 };

    const res = await asUser('tenant-hdr-principal', 'u-h1');
    expect(res.status).toBe(200);
    // The legacy trio and the modern field must agree, and both must name the
    // 4 the caller will actually hit — not the tenant's 50.
    expect(res.headers['x-ratelimit-limit']).toBe('4');
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
    expect(res.headers['ratelimit-policy']).toBe('"default";q=4;w=60');
    expect(res.headers['ratelimit']).toMatch(/^"default";r=3;t=\d+$/);
  });

  it('flips to the AGGREGATE once the tenant is the one running out', async () => {
    // Both lanes live (4 < 6), but the tenant's shared budget is nearly gone
    // while this caller's own is not — so the honest advice is the tenant's.
    stub.tenantLimit = 6;
    stub.principal = { enabled: true, limit: 4, ttl: 60_000 };
    const TENANT = 'tenant-hdr-flip';

    // The FIRST caller's first request: its own bucket (3 left) is tighter
    // than the tenant's (5 left), so the principal lane is what is reported.
    // Asserting both ends of the transition in ONE scenario is what makes this
    // a test of the CHOICE rather than of a constant.
    const opening = await asUser(TENANT, 'u-first');
    expect(opening.headers['x-ratelimit-limit']).toBe('4');
    expect(opening.headers['x-ratelimit-remaining']).toBe('3');
    for (let i = 0; i < 2; i++) expect((await asUser(TENANT, 'u-first')).status).toBe(200);

    // Aggregate: 4 of 6 spent → 2 left. This caller's own bucket: 3 left.
    const res = await asUser(TENANT, 'u-second');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('6');
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
    expect(res.headers['ratelimit-policy']).toBe('"default";q=6;w=60');
    expect(res.headers['ratelimit']).toMatch(/^"default";r=2;t=\d+$/);
  });
});
