import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerStorageService, type ThrottlerModuleOptions, type ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RateLimitConfigService } from './rate-limit-config.service';
import { TieredThrottlerGuard } from './tiered-throttler.guard';
import { WindowOnlyThrottlerStorage } from './window-only-storage';

/**
 * Configures global rate limiting for the API gateway.
 *
 * Storage (both wrapped in `WindowOnlyThrottlerStorage`, which removes the
 * library's fixed 60s post-breach lockout — TASK-993 D-2):
 *   - Redis-backed (`@nest-lab/throttler-storage-redis`) when a Redis URL is
 *     resolvable AND the process is not running under tests — distributes the
 *     counters across API replicas.
 *   - In-memory fallback otherwise (no `storage` passed) — keeps unit /
 *     integration tests hermetic with no external Redis dependency.
 *
 * Named throttlers (see RateLimitConfigService.getThrottlers):
 *   - default  : 100 req / 60s (general API usage)
 *   - strict   : 10 req / 60s  (auth endpoints, brute-force protection)
 *   - heavy    : 20 req / 60s  (summary generation, AI processing)
 *   - relaxed  : 300 req / 60s (health probes, monitoring)
 *
 * The non-default tiers are OPT-IN: TieredThrottlerGuard only enforces
 * strict/heavy/relaxed on routes that explicitly select them via
 * @Throttle({ strict|heavy|relaxed: {...} }). The default tier always applies
 * (with per-route @Throttle({ default: {...} }) overrides). @SkipThrottle()
 * disables the relevant tier(s) for a route.
 *
 * Env overrides: RATE_LIMIT_ENABLED, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS,
 * REDIS_URL | (REDIS_HOST, REDIS_PORT, REDIS_PASS).
 */

function isTestEnv(): boolean {
  const vitest = process.env.VITEST;
  const nodeEnv = process.env.NODE_ENV;
  return Boolean(vitest) || nodeEnv === 'test';
}

function resolveRedisUrl(): string | undefined {
  const url = process.env.REDIS_URL;
  if (url) {
    return url;
  }

  const host = process.env.REDIS_HOST;
  if (!host) {
    return undefined;
  }

  const port = process.env.REDIS_PORT ?? '6379';
  const pass = process.env.REDIS_PASS;
  const auth = pass ? `:${pass}@` : '';
  return `redis://${auth}${host}:${port}`;
}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (): ThrottlerModuleOptions => {
        const cfg = new RateLimitConfigService();

        // Redis only outside tests and only when a URL is resolvable;
        // otherwise the library's own in-memory storage. It is constructed
        // here rather than left to the library's default provider because
        // BOTH are wrapped below and the wrapper needs the instance.
        const redisUrl = isTestEnv() ? undefined : resolveRedisUrl();
        const backend: ThrottlerStorage = redisUrl ? new ThrottlerStorageRedisService(redisUrl) : new ThrottlerStorageService();

        return {
          throttlers: cfg.getThrottlers(),
          skipIf: () => !cfg.isEnabled(),
          // TASK-993 D-2. The wrapper is what makes `blockDuration: 0` mean
          // "no lockout beyond this window" on EITHER backend; without it the
          // same zero is "no limit at all" in memory and a 500 on Redis. See
          // `window-only-storage.ts` for the measurements.
          storage: new WindowOnlyThrottlerStorage(backend),
        };
      },
    }),
  ],
  providers: [RateLimitConfigService, TieredThrottlerGuard],
  exports: [ThrottlerModule, RateLimitConfigService, TieredThrottlerGuard],
})
export class ThrottleConfigModule {}
