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
import {
  IEntitlementsService,
  IRateLimitSettingsService,
  RateLimitSettingsService,
  TenantSettingsService,
  type TenantRateLimitPolicy,
} from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';

/** Craft an unsigned JWT carrying `tenantId` (the guard decodes, never verifies). */
function makeJwt(tenantId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tenantId })).toString('base64url');
  return `${header}.${payload}.sig`;
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
    await app.init();
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
    // TASK-558 lane I — this suite has NO tenant lane wired, so the tenant
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
    await app.init();
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

  // decorator baseline 5 must beat the plan tier (precedence: decorator > plan).
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('decorated')
  decorated() {
    return { ok: 'decorated' };
  }
}

describe('TieredThrottlerGuard (per-tenant plan rate-limits)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  // Per-tenant policy stub, keyed by the tenantId decoded from the JWT.
  const policies: Record<string, TenantRateLimitPolicy | null> = {
    'tenant-strict': { tier: 'strict', perMinute: null },
    'tenant-override': { tier: 'strict', perMinute: 4 },
    'tenant-off': null, // kill-switch OFF / ungated → global tiers unchanged
  };

  const tierOf = (name: string) => (name === 'strict' ? { limit: 2, ttl: 60000 } : { limit: 1000, ttl: 60000 });

  const settings: IRateLimitSettingsService = {
    isEnabled: () => true,
    // default tier is generous; strict tier is tight (2/min).
    getTier: (name) => tierOf(name),
    getRouteOverride: () => undefined,
    // TASK-558 lane I — no tenant lane wired here either, so these report
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
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
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

  it('(e) precedence: a @Throttle decorator beats the plan tier — /q7/decorated allows 5 (not 2) then 429s on the 6th', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await hit('/q7/decorated', 'tenant-strict')).status).toBe(200);
    }
    expect((await hit('/q7/decorated', 'tenant-strict')).status).toBe(429);
  });
});

/**
 * TASK-558 lane I — THE HEADLINE PROOF, at the HTTP layer.
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

describe('TieredThrottlerGuard (per-tenant DB rate limits — TASK-558 lane I)', () => {
  let app: INestApplication;
  const prevEnabled = process.env.RATE_LIMIT_ENABLED;

  const TENANT_TIGHT = 'tenant-tight';
  const TENANT_NORMAL = 'tenant-normal';

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
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prevEnabled === undefined) {
      delete process.env.RATE_LIMIT_ENABLED;
    } else {
      process.env.RATE_LIMIT_ENABLED = prevEnabled;
    }
  });

  // NOTE ON ROUTE-PER-TENANT. The throttler's TRACKER is IP-based by design
  // (`tiered-throttler.guard.ts`: "only the effective limit/ttl is plan-aware"),
  // so two tenants calling the SAME route from the same client share one
  // counter and one block window. Each tenant therefore gets its own route
  // here; what is under test is the LIMIT each tenant's request resolves to,
  // which is exactly what lane I moved into the database.
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
    // it. The very next request through the SAME running app enforces it — no
    // restart, no redeploy.
    tenantRows[TENANT_NORMAL] = { 'rateLimit.maxRequests': 3 };
    expect((await hit('/lane-i/live', TENANT_NORMAL)).status).toBe(429);

    // …and that write did not touch any other tenant's resolved limit.
    expect(settings.getTierForTenant('default', TENANT_TIGHT).limit).toBe(2);
    expect(settings.getTierForTenant('default', 'tenant-third').limit).toBe(1000);
  });

  it('clamps a tenant that writes itself a limit ABOVE the platform value', async () => {
    // A tenant trying to raise its own ceiling to 5000 gets the platform 1000.
    tenantRows[TENANT_NORMAL] = { 'rateLimit.maxRequests': 5000 };
    for (let i = 0; i < 8; i++) {
      expect((await hit('/lane-i/clamped', TENANT_NORMAL)).status).toBe(200);
    }
    expect(settings.getTierForTenant('default', TENANT_NORMAL).limit).toBe(1000);
  });
});
