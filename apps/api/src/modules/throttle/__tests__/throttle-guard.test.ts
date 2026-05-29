/**
 * TASK-315 — TieredThrottlerGuard in-process integration test.
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
import { IRateLimitSettingsService } from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';

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
 * TASK-316 — DB-backed live overrides.
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
