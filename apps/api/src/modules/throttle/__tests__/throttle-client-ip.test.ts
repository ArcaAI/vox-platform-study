/**
 * TASK-993 lane A — the three correctness defects in the rate-limit surface.
 *
 *   D-1  every client behind the ingress shared ONE bucket per route, because
 *        `@nestjs/throttler` keys on `req.ip` and `req.ip` is the socket peer
 *        (Express `trust proxy` is deliberately OFF). In the cluster that peer
 *        is the Traefik pod for 100% of traffic.
 *   D-3  the `RateLimit` advisory header reported the QUOTA as the remaining
 *        count and the WINDOW as the reset, both static.
 *   D-4  a non-default tier answers `Retry-After-<tier>` and no plain
 *        `Retry-After`, which every SDK reader misses.
 *
 * Everything runs in-process against the in-memory throttler storage (the
 * module skips Redis whenever VITEST / NODE_ENV=test is set). supertest
 * connects over loopback, so the SOCKET PEER is always 127.0.0.1 — which is
 * exactly what makes the trusted/untrusted split testable: the same peer is
 * declared trusted in one app and not in the other.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Throttle } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IRateLimitSettingsService, RATE_LIMIT_PRINCIPAL_DEFAULTS } from '@arcaai/applications';
import { ThrottleConfigModule } from '../throttle.module';
import { TieredThrottlerGuard } from '../tiered-throttler.guard';
import { RateLimitHeadersInterceptor } from '../rate-limit-headers.interceptor';

/** See the note in `throttle-guard.test.ts`: one listener per app, not one per request. */
async function listenOnce(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}

/**
 * A platform-lane settings stub — no tenant, no plan, no rules. Every
 * resolution below therefore lands on rank 5 and stays IP-keyed, which is the
 * lane D-1 is about.
 */
const platformSettings: IRateLimitSettingsService = {
  isEnabled: () => true,
  getTier: () => ({ limit: 1000, ttl: 60000 }),
  getRouteOverride: () => undefined,
  isEnabledForTenant: () => true,
  getTierForTenant: () => ({ limit: 1000, ttl: 60000, limitSource: 'system', ttlSource: 'system' }),
  getPrincipalPolicy: () => ({ enabled: true, ...RATE_LIMIT_PRINCIPAL_DEFAULTS }),
};

@Controller('cip')
class ClientIpController {
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Get('trusted')
  trusted() {
    return { ok: true };
  }

  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Get('spoof')
  spoof() {
    return { ok: true };
  }

  @Throttle({ default: { limit: 2, ttl: 60000 } })
  @Get('malformed')
  malformed() {
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Get('headers')
  headers() {
    return { ok: true };
  }

  @Throttle({ heavy: { limit: 1, ttl: 60000 } })
  @Get('heavy')
  heavy() {
    return { ok: true };
  }
}

async function buildApp(trustedProxies: string): Promise<INestApplication> {
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.RATE_LIMIT_TRUSTED_PROXIES = trustedProxies;

  const moduleRef = await Test.createTestingModule({
    imports: [ThrottleConfigModule],
    controllers: [ClientIpController],
    providers: [
      { provide: APP_GUARD, useClass: TieredThrottlerGuard },
      { provide: IRateLimitSettingsService, useValue: platformSettings },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalInterceptors(new RateLimitHeadersInterceptor());
  await listenOnce(app);
  return app;
}

/** Capture/restore the two process-wide knobs these suites set. */
function envSnapshot(): () => void {
  const enabled = process.env.RATE_LIMIT_ENABLED;
  const trusted = process.env.RATE_LIMIT_TRUSTED_PROXIES;
  return () => {
    if (enabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = enabled;
    if (trusted === undefined) delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
    else process.env.RATE_LIMIT_TRUSTED_PROXIES = trusted;
  };
}

describe('D-1 — the client IP comes from CF-Connecting-IP behind a TRUSTED ingress', () => {
  let app: INestApplication;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = envSnapshot();
    // The loopback peer supertest connects from IS the declared ingress here.
    app = await buildApp('127.0.0.1/32, ::1/128');
  });

  afterAll(async () => {
    if (app) await app.close();
    restoreEnv();
  });

  it('gives two distinct forwarded clients two INDEPENDENT counters', async () => {
    const hit = (clientIp: string) => request(app.getHttpServer()).get('/cip/trusted').set('CF-Connecting-IP', clientIp);

    // Client A spends its whole budget and is blocked.
    expect((await hit('203.0.113.1')).status).toBe(200);
    expect((await hit('203.0.113.1')).status).toBe(200);
    expect((await hit('203.0.113.1')).status).toBe(429);

    // Client B must be untouched by that. Before the fix this was the 4th
    // request into ONE shared bucket and came back 429 immediately.
    expect((await hit('198.51.100.7')).status).toBe(200);
    expect((await hit('198.51.100.7')).status).toBe(200);
    expect((await hit('198.51.100.7')).status).toBe(429);
  });

  it('ignores a MALFORMED CF-Connecting-IP rather than keying a bucket on it', async () => {
    // Unbounded tracker cardinality is a memory DoS on the in-memory store, so
    // anything that is not a parseable address falls back to the socket peer —
    // which means these three share one bucket.
    const hit = (clientIp: string) => request(app.getHttpServer()).get('/cip/malformed').set('CF-Connecting-IP', clientIp);

    expect((await hit('not-an-ip')).status).toBe(200);
    expect((await hit('999.1.1.1')).status).toBe(200);
    expect((await hit('<script>')).status).toBe(429);
  });
});

describe('D-1 — a DIRECT caller cannot spoof CF-Connecting-IP into its own bucket', () => {
  let app: INestApplication;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = envSnapshot();
    // The loopback peer is NOT in this list, so nothing it claims is believed.
    app = await buildApp('10.42.0.0/16');
  });

  afterAll(async () => {
    if (app) await app.close();
    restoreEnv();
  });

  it('keeps every claimed client IP on the socket peer bucket', async () => {
    const hit = (clientIp: string) => request(app.getHttpServer()).get('/cip/spoof').set('CF-Connecting-IP', clientIp);

    expect((await hit('203.0.113.10')).status).toBe(200);
    expect((await hit('203.0.113.11')).status).toBe(200);
    // A third distinct claim must NOT mint a third bucket.
    expect((await hit('203.0.113.12')).status).toBe(429);
  });
});

describe('D-3 / D-4 — advisory headers tell the truth', () => {
  let app: INestApplication;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = envSnapshot();
    app = await buildApp('');
  });

  afterAll(async () => {
    if (app) await app.close();
    restoreEnv();
  });

  it('D-3: `RateLimit` r= is the REMAINING count and agrees with X-RateLimit-Remaining', async () => {
    const first = await request(app.getHttpServer()).get('/cip/headers');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('4');
    expect(first.headers['ratelimit']).toBe('"default";r=4;t=60');

    const second = await request(app.getHttpServer()).get('/cip/headers');
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('3');
    expect(second.headers['ratelimit']).toBe('"default";r=3;t=60');

    // The quota itself is still advertised, statically, where it belongs.
    expect(second.headers['ratelimit-policy']).toBe('"default";q=5;w=60');
  });

  it('D-4: a heavy-tier 429 carries a plain Retry-After as well as the suffixed one', async () => {
    const ok = await request(app.getHttpServer()).get('/cip/heavy');
    expect(ok.status).toBe(200);

    const blocked = await request(app.getHttpServer()).get('/cip/heavy');
    expect(blocked.status).toBe(429);
    // The library only ever writes the suffixed form for a non-default tier.
    expect(blocked.headers['retry-after-heavy']).toBeDefined();
    // What every SDK actually reads — `@arcaai/vox-node` included.
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
  });
});
