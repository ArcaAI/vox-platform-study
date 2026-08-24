/**
 * TieredThrottlerGuard in-process integration test.
 *
 * Proves the global throttler is actually wired into the guard chain and that
 * "Option 2" (named throttlers, non-default opt-in) behaves correctly:
 *
 *   - the `default` tier gates every route (honouring per-route overrides),
 *   - non-default tiers (strict/heavy/relaxed) ONLY gate routes that opt in via
 *     `@Throttle({ <tier>: {...} })`,
 *   - `@SkipThrottle()` disables throttling for the route.
 *
 * Runs fully in-memory: the module's storage selection skips Redis whenever
 * VITEST / NODE_ENV=test is set (see throttle.module.ts). The default IP-based
 * tracker keys every in-process supertest call on 127.0.0.1, so per-route
 * counters accumulate as expected.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as jwtLib from 'jsonwebtoken';
import {
  IApiKeyService,
  IEntitlementsService,
  IRateLimitSettingsService,
  IServiceAccountService,
  RateLimitSettingsService,
  SecretsService,
  TenantSettingsService,
  type TenantRateLimitPolicy,
} from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';

/**
 * The guard now VERIFIES the token before trusting its `tenantId` (TASK-785),
 * because that claim decides which tenant's COUNTER a request spends — not just
 * which tier it gets. So these fixtures sign for real.
 */
const TEST_JWT_SECRET = 'throttle-guard-test-secret';

/** A properly signed JWT carrying `tenantId` — the guard trusts this one. */
function makeJwt(tenantId: string): string {
  return jwtLib.sign({ tenantId }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

/**
 * An `alg: "none"` token naming a tenant, exactly as an attacker would forge it.
 * The guard must treat it as ANONYMOUS — if it did not, anyone could spend (or
 * borrow) any tenant's budget just by claiming to be them.
 */
function makeForgedJwt(tenantId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tenantId })).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** Supplies the verification key the guard reads via `getSecretSync`. */
const secretsStub = { getSecretSync: (key: string) => (key === 'JWT_SECRET_KEY' ? TEST_JWT_SECRET : undefined) } as unknown as SecretsService;

/**
 * Bind ONE ephemeral listener per app, up front.
 *
 * supertest binds a FRESH port for every request when the server is not already listening
 * (`Test.serverAddress` calls `app.listen(0)` whenever `app.address()` is null, and `Test.end`
 * closes the server it opened). This file makes ~50 requests, so that is ~50 listen/close cycles.
 * Under the full unit suite's parallelism a just-released ephemeral port can be re-bound by
 * another worker between our bind and our connect, and the request then lands on a foreign
 * server and comes back with a status these tests never assert against — observed once as a 400
 * on `/t/skip`, a route with no way to produce one, in a run that passed in isolation. Listening
 * once removes the churn; `app.close()` in `afterAll` still closes this listener.
 */
async function listenOnce(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}

@Controller('t')
class ThrottleTestController {
  @Get('open')
  open() {
    return { ok: 'open' };
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Get('tight')
  tight() {
    return { ok: 'tight' };
  }

  @Throttle({ strict: { limit: 2, ttl: 60000 } })
  @Get('strict-optin')
  strictOptin() {
    return { ok: 'strict-optin' };
  }

  /** TASK-773 — used only by the credential-class parity block at the end. */
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Get('parity')
  parity() {
    return { ok: 'parity' };
  }

  @SkipThrottle()
  @Get('skip')
  skip() {
    return { ok: 'skip' };
  }
}

describe('TieredThrottlerGuard (integration)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const hit = (path: string) => request(app.getHttpServer()).get(path);

  beforeAll(async () => {
    // Throttling defaults to ON; make it explicit so a stray env can't disable
    // the guard under test. `isEnabled()` reads this live via `skipIf`.
    process.env.RATE_LIMIT_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [ThrottleTestController],
      providers: [{ provide: APP_GUARD, useClass: TieredThrottlerGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = prevEnabled;
    }
  });

  it('(a) per-route default override: /t/tight allows 3 then 429s on the 4th', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await hit('/t/tight');
      expect(res.status).toBe(200);
    }
    const fourth = await hit('/t/tight');
    expect(fourth.status).toBe(429);
  });

  it('(b) opt-in strict tier: /t/strict-optin 429s on the 3rd call (strict limit = 2)', async () => {
    expect((await hit('/t/strict-optin')).status).toBe(200);
    expect((await hit('/t/strict-optin')).status).toBe(200);
    expect((await hit('/t/strict-optin')).status).toBe(429);
  });

  it('(c) non-default tiers do NOT gate opt-out routes: /t/open never 429s in 12 rapid calls', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await hit('/t/open');
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200);
    }
  });

  it('(d) @SkipThrottle disables throttling: /t/skip never 429s in 12 rapid calls', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await hit('/t/skip');
      expect(res.status).not.toBe(429);
      expect(res.status).toBe(200);
    }
  });
});

/**
 * DB-backed live overrides.
 *
 * Wires a STUB `IRateLimitSettingsService` so the guard resolves limits from
 * "the database" without any real DB/cache. Controllers are named to match the
 * `KNOWN_THROTTLED_ROUTES` registry (`AuthController.login` → `auth.login`,
 * `ApiHealthController` → `health`) so the guard's `resolveRouteId` maps onto
 * them. Each assertion targets a distinct route so the in-memory counters never
 * bleed across tests.
 */
@Controller('auth')
class AuthController {
  // Decorator baseline = 5; a per-endpoint DB override of 2 must win.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('login')
  login() {
    return { ok: 'login' };
  }
}

@Controller('hc')
class ApiHealthController {
  @Get('ping')
  ping() {
    return { ok: 'ping' };
  }
}

@Controller('live')
class LiveController {
  @Get('open')
  open() {
    return { ok: 'open' };
  }

  @Get('kill')
  kill() {
    return { ok: 'kill' };
  }
}

describe('TieredThrottlerGuard (DB-backed live overrides)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  // Mutable stub state, reconfigured per test.
  const stub = {
    enabled: true,
    tier: { limit: 1000, ttl: 60000 } as { limit: number; ttl: number },
    routeOverride: undefined as { limit?: number; ttl?: number; enabled?: boolean } | undefined,
  };

  const settings: IRateLimitSettingsService = {
    isEnabled: () => stub.enabled,
    getTier: () => stub.tier,
    getRouteOverride: () => stub.routeOverride,
    // This suite has NO tenant lane wired, so the tenant
    // accessors resolve to the platform answer and every assertion below keeps
    // its original meaning. `limitSource: 'system'` is what tells the guard the
    // value did not come from a tenant's own row, which is what keeps the
    // historical precedence chain (decorator > plan > tier) intact.
    isEnabledForTenant: () => stub.enabled,
    getTierForTenant: () => ({ ...stub.tier, limitSource: 'system', ttlSource: 'system' }),
  };

  const hit = (path: string) => request(app.getHttpServer()).get(path);

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [AuthController, ApiHealthController, LiveController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: IRateLimitSettingsService, useValue: settings },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = prevEnabled;
    }
  });

  it('(a) DB tier baseline changes the effective default-tier limit live: /live/open 429s on the 3rd call when tier.default.limit = 2', async () => {
    stub.enabled = true;
    stub.routeOverride = undefined;
    stub.tier = { limit: 2, ttl: 60000 };

    expect((await hit('/live/open')).status).toBe(200);
    expect((await hit('/live/open')).status).toBe(200);
    expect((await hit('/live/open')).status).toBe(429);
  });

  it('(b) per-endpoint DB override beats the @Throttle decorator: /auth/login (decorator 5) 429s on the 3rd call when override limit = 2', async () => {
    stub.enabled = true;
    stub.tier = { limit: 1000, ttl: 60000 };
    stub.routeOverride = { limit: 2 };

    expect((await hit('/auth/login')).status).toBe(200);
    expect((await hit('/auth/login')).status).toBe(200);
    expect((await hit('/auth/login')).status).toBe(429);
  });

  it('(c) global kill-switch: enabled=false never 429s /live/kill in 12 rapid calls', async () => {
    stub.enabled = false;
    stub.tier = { limit: 1, ttl: 60000 };
    stub.routeOverride = undefined;

    for (let i = 0; i < 12; i++) {
      expect((await hit('/live/kill')).status).toBe(200);
    }
  });

  it('(d) per-route disable: route override enabled=false never 429s /hc/ping in 12 rapid calls', async () => {
    stub.enabled = true;
    stub.tier = { limit: 1, ttl: 60000 };
    stub.routeOverride = { enabled: false };

    for (let i = 0; i < 12; i++) {
      expect((await hit('/hc/ping')).status).toBe(200);
    }
  });
});

/**
 * Per-tenant plan rate-limits on the pre-auth hot path.
 *
 * Wires a stub `IEntitlementsService.getTenantRateLimitPolicy` (the cached
 * plan-tier + per-tenant override resolver) alongside a stub
 * `IRateLimitSettingsService` (tier baselines). The guard extracts the tenant
 * from the JWT bearer BEFORE auth, then applies the plan tier to the always-on
 * `default` tier. Distinct routes per test keep the in-memory counters isolated.
 */
@Controller('q7')
class Q7Controller {
  @Get('plan')
  plan() {
    return { ok: 'plan' };
  }

  @Get('override')
  override() {
    return { ok: 'override' };
  }

  @Get('off')
  off() {
    return { ok: 'off' };
  }

  @Get('anon')
  anon() {
    return { ok: 'anon' };
  }

  // TASK-785 OD-2: the decorator is rank 5's SEED, so the plan tier (2) beats
  // this 5 — the reverse of the behaviour this route was added to prove.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('decorated')
  decorated() {
    return { ok: 'decorated' };
  }

  @Get('forged')
  forged() {
    return { ok: 'forged' };
  }
}

describe('TieredThrottlerGuard (per-tenant plan rate-limits)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  // Per-tenant policy stub, keyed by the tenantId decoded from the JWT.
  const policies: Record<string, TenantRateLimitPolicy | null> = {
    'tenant-strict': { tier: 'strict', perMinute: null, windowMs: null },
    // A tenant of its own for (e): a plan-resolved limit is now counted per
    // TENANT across every route (OD-3), so two cases sharing a tenant would
    // share one counter.
    'tenant-decorated': { tier: 'strict', perMinute: null, windowMs: null },
    'tenant-override': { tier: 'strict', perMinute: 4, windowMs: null },
    'tenant-off': null, // kill-switch OFF / ungated → global tiers unchanged
  };

  const tierOf = (name: string) => (name === 'strict' ? { limit: 2, ttl: 60000 } : { limit: 1000, ttl: 60000 });

  const settings: IRateLimitSettingsService = {
    isEnabled: () => true,
    // default tier is generous; strict tier is tight (2/min).
    getTier: (name) => tierOf(name),
    getRouteOverride: () => undefined,
    // No tenant lane wired here either, so these report
    // `system` and the PLAN tier keeps winning, exactly as this suite asserts.
    isEnabledForTenant: () => true,
    getTierForTenant: (name) => ({ ...tierOf(name), limitSource: 'system', ttlSource: 'system' }),
  };

  const entitlements = {
    getTenantRateLimitPolicy: async (tenantId: string): Promise<TenantRateLimitPolicy | null> => policies[tenantId] ?? null,
  } as unknown as IEntitlementsService;

  const hit = (path: string, tenantId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return tenantId ? req.set('Authorization', `Bearer ${makeJwt(tenantId)}`) : req;
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [Q7Controller],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: IEntitlementsService, useValue: entitlements },
        { provide: SecretsService, useValue: secretsStub },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = prevEnabled;
    }
  });

  it('(a) a tenant on a stricter plan gets its plan tier: /q7/plan 429s on the 3rd call (strict = 2)', async () => {
    expect((await hit('/q7/plan', 'tenant-strict')).status).toBe(200);
    expect((await hit('/q7/plan', 'tenant-strict')).status).toBe(200);
    expect((await hit('/q7/plan', 'tenant-strict')).status).toBe(429);
  });

  it('(b) per-tenant absolute override is respected: /q7/override allows 4 then 429s on the 5th', async () => {
    for (let i = 1; i <= 4; i++) {
      expect((await hit('/q7/override', 'tenant-override')).status).toBe(200);
    }
    expect((await hit('/q7/override', 'tenant-override')).status).toBe(429);
  });

  it('(c) disabled/ungated (policy null) = current behavior: /q7/off never 429s in 8 calls (default tier 1000)', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await hit('/q7/off', 'tenant-off')).status).toBe(200);
    }
  });

  it('(d) no JWT (unauthenticated) rides the global tiers: /q7/anon never 429s in 8 calls', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await hit('/q7/anon')).status).toBe(200);
    }
  });

  /*
   * REWRITTEN for TASK-785 OD-2. This case previously asserted the OPPOSITE —
   * that a route's `@Throttle` decorator beat the tenant's plan tier. That was
   * the shipped behaviour, and it is exactly what made the plan lane useless: an
   * ENTERPRISE tenant could not be granted more than a hardcoded decorator value
   * without a code change and a redeploy. The decorator is now rank 5's SEED,
   * so the plan (rank 3) wins.
   */
  it('(e) precedence: the plan tier beats a @Throttle decorator — /q7/decorated 429s on the 3rd call (plan strict = 2, decorator = 5)', async () => {
    expect((await hit('/q7/decorated', 'tenant-decorated')).status).toBe(200);
    expect((await hit('/q7/decorated', 'tenant-decorated')).status).toBe(200);
    expect((await hit('/q7/decorated', 'tenant-decorated')).status).toBe(429);
  });

  it('(f) a FORGED `alg:none` token is untrusted: it never reaches the tenant lane and rides the platform tier', async () => {
    // `tenant-strict` would cap at 2/min if the claim were believed. Forged, it
    // resolves no tenant at all, so the generous platform tier (1000) applies.
    const forged = () =>
      request(app.getHttpServer())
        .get('/q7/forged')
        .set('Authorization', `Bearer ${makeForgedJwt('tenant-strict')}`);
    for (let i = 0; i < 8; i++) {
      expect((await forged()).status).toBe(200);
    }
  });
});

/**
 * THE HEADLINE PROOF, at the HTTP layer.
 *
 * "Changing a rate limit for ONE tenant changes that tenant's behaviour and no
 * other, with no redeploy."
 *
 * `RATE_LIMIT_MAX_REQUESTS` was a `process.env` read evaluated once while the
 * throttler module was constructed. It is now the `global-kv` key
 * `rateLimit.maxRequests` at `maxScope: 'tenant'`, resolved on the request
 * path — so the number that decides a 429 comes from a settings ROW, per
 * tenant, and a write to that row is live on the next request.
 *
 * Wired with a REAL `RateLimitSettingsService` + `TenantSettingsService` over a
 * fake two-lane settings cache, so the resolution, the clamp and the guard's
 * precedence chain are all production code.
 */
@Controller('lane-i')
class LaneIController {
  @Get('limited')
  limited() {
    return { ok: 'limited' };
  }

  @Get('normal')
  normal() {
    return { ok: 'normal' };
  }

  @Get('live')
  live() {
    return { ok: 'live' };
  }

  @Get('clamped')
  clamped() {
    return { ok: 'clamped' };
  }
}

describe('TieredThrottlerGuard (per-tenant DB rate limits)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const TENANT_TIGHT = 'tenant-tight';
  const TENANT_NORMAL = 'tenant-normal';
  // TASK-785 OD-3: a tenant-wide limit is ONE bucket across every route, so a
  // case that exhausts a tenant's budget exhausts it for every later case using
  // that tenant. Each case below that spends a tenant-scoped budget therefore
  // gets a tenant of its own — the same reason each already had its own route
  // back when buckets were per-route.
  const TENANT_ISOLATION_A = 'tenant-isolation-a';
  const TENANT_ISOLATION_B = 'tenant-isolation-b';
  const TENANT_CLAMPED = 'tenant-clamped';

  // The platform row + per-tenant override rows, mutable so a test can perform
  // an admin "write" mid-flight and prove it takes effect with no restart.
  const platform: Record<string, unknown> = { 'rateLimit.maxRequests': 1000, 'rateLimit.windowMs': 60000 };
  const tenantRows: Record<string, Record<string, unknown>> = { [TENANT_TIGHT]: { 'rateLimit.maxRequests': 2 } };

  const appSettings = {
    getValueFromCache: (key: string) => (key in platform ? platform[key] : null),
    getTenantValueFromCache: (tenantId: string, key: string) => {
      const rows = tenantRows[tenantId];
      return rows && key in rows ? rows[key] : null;
    },
    getValueWithDefault: (key: string, fallback: unknown) => (key in platform ? platform[key] : fallback),
    hasSetting: (key: string) => key in platform,
  };

  const settings = new RateLimitSettingsService(appSettings as never, new TenantSettingsService(appSettings as never));

  const hit = (path: string, tenantId?: string) => {
    const req = request(app.getHttpServer()).get(path);
    return tenantId ? req.set('Authorization', `Bearer ${makeJwt(tenantId)}`) : req;
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [LaneIController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: SecretsService, useValue: secretsStub },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = prevEnabled;
    }
  });

  // NOTE ON ROUTE-PER-TENANT. Historically the tracker was IP-based for EVERY
  // request, so two tenants calling the same route from one client shared a
  // counter — which is why each tenant gets its own route here. TASK-785 OD-3
  // fixed that for tenant-resolved limits (they are now keyed on the tenant, so
  // that sharing is gone; see the dedicated isolation case below), but the
  // per-route split is kept because what these cases are really asserting is the
  // LIMIT each tenant's request resolves to, which is what lane I moved into
  // the database.
  it('enforces ONE tenant\u2019s own limit — the tight tenant 429s on its 3rd call', async () => {
    // The tight tenant's row says 2/min, against a platform row of 1000.
    expect((await hit('/lane-i/limited', TENANT_TIGHT)).status).toBe(200);
    expect((await hit('/lane-i/limited', TENANT_TIGHT)).status).toBe(200);
    expect((await hit('/lane-i/limited', TENANT_TIGHT)).status).toBe(429);
  });

  it('leaves every OTHER tenant on the platform value', async () => {
    // Same app, same platform row, no row of its own → 1000/min, so six calls
    // that would have 429'd under the tight tenant's limit all pass.
    for (let i = 0; i < 6; i++) {
      expect((await hit('/lane-i/normal', TENANT_NORMAL)).status).toBe(200);
    }
  });

  it('picks up an admin write with NO redeploy', async () => {
    // TENANT_NORMAL starts on the generous platform row.
    for (let i = 0; i < 3; i++) {
      expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(200);
    }

    // An admin writes a tenant-scope row; the settings cache refresh publishes
    // it. The very next request through the SAME running app resolves the new
    // limit — no restart, no redeploy.
    //
    // TASK-785 OD-3: the write also moves this tenant from the platform lane
    // (IP-keyed, per route) to the tenant lane (tenant-keyed), so the counter it
    // is measured against CHANGES with it and the window restarts. That is
    // inherent to per-tenant counting, and it is the safe direction — a scope
    // change grants a fresh window rather than retroactively 429-ing traffic
    // that was within its limit when it was served.
    tenantRows[TENANT_NORMAL] = { 'rateLimit.maxRequests': 3 };
    expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(200);
    expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(200);
    expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(200);
    expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(429);

    // …and that write did not touch any other tenant's resolved limit.
    expect(settings.getTierForTenant('default', TENANT_TIGHT).limit).toBe(2);
    expect(settings.getTierForTenant('default', 'tenant-third').limit).toBe(1000);
  });

  it('does NOT let two tenants on the same route share a counter (TASK-785 F-02)', async () => {
    // Both tenants hit ONE route from ONE client IP. Before OD-3 the shared
    // IP-keyed bucket meant the tight tenant's traffic could 429 the other's.
    tenantRows[TENANT_ISOLATION_A] = { 'rateLimit.maxRequests': 2 };
    tenantRows[TENANT_ISOLATION_B] = { 'rateLimit.maxRequests': 2 };

    expect((await hit('/lane-i/normal', TENANT_ISOLATION_A)).status).toBe(200);
    expect((await hit('/lane-i/normal', TENANT_ISOLATION_A)).status).toBe(200);
    expect((await hit('/lane-i/normal', TENANT_ISOLATION_A)).status).toBe(429);

    // B's budget is untouched by A having exhausted its own.
    expect((await hit('/lane-i/normal', TENANT_ISOLATION_B)).status).toBe(200);
    expect((await hit('/lane-i/normal', TENANT_ISOLATION_B)).status).toBe(200);
    expect((await hit('/lane-i/normal', TENANT_ISOLATION_B)).status).toBe(429);
  });

  it('clamps a tenant that writes itself a limit ABOVE the platform value', async () => {
    // A tenant trying to raise its own ceiling to 5000 gets the platform 1000.
    tenantRows[TENANT_CLAMPED] = { 'rateLimit.maxRequests': 5000 };
    for (let i = 0; i < 8; i++) {
      expect((await hit('/lane-i/clamped', TENANT_CLAMPED)).status).toBe(200);
    }
    expect(settings.getTierForTenant('default', TENANT_CLAMPED).limit).toBe(1000);
  });
});

/**
 * TASK-773 — the three credential classes are rate-limited IDENTICALLY.
 *
 * Owner decision, 2026-08-19: a service account gets the same rate-limit
 * treatment as every other caller — no tier of its own.
 *
 * STILL TRUE after TASK-785 O-4, but for a better reason. A machine credential
 * now resolves its tenant (service-account token → Redis blob, API key → Redis
 * hint) and is counted against THAT TENANT's bucket, exactly as a human's JWT
 * is. No credential class gets a tier of its own; they simply stopped being
 * anonymous. What this block still pins is the fallback: when NO tenant is
 * resolvable — no service-account/API-key service wired, a cold hint, an
 * unverifiable JWT — every class shares the IP-keyed bucket and none is
 * privileged over the others.
 *
 * Note the one asymmetry that is NOT a decision and cannot be fixed here:
 * `extractTenantIdPreAuth` resolves a tenant by DECODING A JWT, so per-tenant
 * plan limits apply to JWT callers only. An API key and a service-account token
 * are both OPAQUE — resolving either to a tenant means a DB/Redis lookup, which
 * is exactly what a pre-auth throttle guard must not do. So both fall to the
 * global tier, together, for the same structural reason.
 */
describe('TieredThrottlerGuard — credential-class parity (TASK-773)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [ThrottleTestController],
      providers: [{ provide: APP_GUARD, useClass: TieredThrottlerGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await listenOnce(app);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = prevEnabled;
  });

  it('all three credential classes draw on ONE shared bucket, not one each', async () => {
    // `/t/parity` allows 3. Spend them one per credential class: if each class
    // had its own bucket, all three would sit at 1/3 and a fourth call would
    // pass. It must not.
    expect((await request(app.getHttpServer()).get('/t/parity')).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/t/parity').set('X-API-Key', 'k_test')).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/t/parity').set('X-Service-Account-Token', 'sat_test')).status).toBe(200);

    // Fourth call — refused whichever credential it carries.
    expect((await request(app.getHttpServer()).get('/t/parity').set('X-Service-Account-Token', 'sat_test')).status).toBe(429);
    expect((await request(app.getHttpServer()).get('/t/parity')).status).toBe(429);
  });
});


/**
 * TASK-785 O-4 — the machine plane is no longer ungoverned.
 *
 * Before this, `resolveTrustedTenantId` looked only at a bearer JWT, so API-key
 * and service-account traffic — including every `@arcaai/vox-node` admin call —
 * resolved no tenant and could never reach the per-tenant or per-plan lanes.
 */
@Controller('machine')
class MachineController {
  @Get('svc')
  svc() {
    return { ok: 'svc' };
  }

  @Get('key')
  key() {
    return { ok: 'key' };
  }

  @Get('cold')
  cold() {
    return { ok: 'cold' };
  }
}

describe('TieredThrottlerGuard (machine credentials — TASK-785 O-4)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const SVC_TENANT = 'tenant-svc';
  const KEY_TENANT = 'tenant-key';

  const settings: IRateLimitSettingsService = {
    isEnabled: () => true,
    getTier: () => ({ limit: 1000, ttl: 60000 }),
    getRouteOverride: () => undefined,
    isEnabledForTenant: () => true,
    getTierForTenant: () => ({ limit: 1000, ttl: 60000, limitSource: 'system', ttlSource: 'system' }),
  };

  // Both machine credentials resolve a tenant WITHOUT a database read: the
  // service-account token from its Redis blob, the API key from a Redis hint the
  // previous successful authentication published.
  const serviceAccounts = {
    peekTenantForRateLimit: async (token: string) => (token === 'good-svc-token' ? SVC_TENANT : null),
  } as unknown as IServiceAccountService;

  const apiKeys = {
    peekTenantForRateLimit: async (raw: string) => (raw === 'good-api-key' ? KEY_TENANT : null),
  } as unknown as IApiKeyService;

  // Both machine tenants are on a 2/min plan; everyone else rides the platform 1000.
  const entitlements = {
    getTenantRateLimitPolicy: async (tenantId: string): Promise<TenantRateLimitPolicy | null> =>
      tenantId === SVC_TENANT || tenantId === KEY_TENANT ? { tier: 'strict', perMinute: 2, windowMs: null } : null,
  } as unknown as IEntitlementsService;

  beforeAll(async () => {
    process.env.RATE_LIMIT_ENABLED = 'true';

    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleConfigModule],
      controllers: [MachineController],
      providers: [
        { provide: APP_GUARD, useClass: TieredThrottlerGuard },
        { provide: IRateLimitSettingsService, useValue: settings },
        { provide: IEntitlementsService, useValue: entitlements },
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

  it('a service-account token reaches its tenant’s plan lane (2/min, not the platform 1000)', async () => {
    const hit = () => request(app.getHttpServer()).get('/machine/svc').set('X-Service-Account-Token', 'good-svc-token');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it('an API key reaches its tenant’s plan lane', async () => {
    const hit = () => request(app.getHttpServer()).get('/machine/key').set('X-API-Key', 'good-api-key');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });

  it('an unknown credential (cold hint, revoked token) rides the platform lane rather than failing', async () => {
    // The hint is a cache, not an oracle. A miss must under-attribute — never
    // 429 a caller whose tenant simply is not known yet.
    const hit = () => request(app.getHttpServer()).get('/machine/cold').set('X-API-Key', 'unknown-key');
    for (let i = 0; i < 8; i++) {
      expect((await hit()).status).toBe(200);
    }
  });
});
