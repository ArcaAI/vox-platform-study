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
