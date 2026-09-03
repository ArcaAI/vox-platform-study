/**
 * the three kubelet probes must never be rate limited.
 *
 * OBSERVED (`hope-v2-dev`, 2026-08-25): `hope-api` Endpoints flipped to
 * `notReadyAddresses` at 09:02 and back to ready at 09:03, with NO container
 * restart — and while it was out of Endpoints, TEXT's effective-config pull
 * reported `last_refresh_ok:false, sources:{}` because `http://hope-api:8868`
 * was refused.
 *
 * MECHANISM: `TieredThrottlerGuard` is a GLOBAL guard and runs FIRST, ahead of
 * `UnifiedAuthGuard`. `@Public()` exempts a route from AUTH, not from the
 * throttler, so every kubelet probe was passing through the Redis-backed
 * default tier. Its bucket key is `tenant:${tenantId}` and an unauthenticated
 * request resolves `tenantId` to `null`, so all anonymous traffic — the probes
 * included — shares ONE `tenant:null` bucket. For THIS controller that bucket is
 * 30 requests / 60s, not the platform default tier's 100: the class carries
 * `@Throttle({ default: { limit: 30, ttl: 60000 } })`, which seeds the guard's
 * rank-5 value and wins absent a DB `RateLimitRule`.
 *
 * The kubelet alone spends 14 of those per minute — readiness every 5s (12) plus
 * liveness every 30s (2), verified against `deployment/k8s/base/api.yaml` in
 * `arca/hope-v2-deployment`, which the `dev` overlay does not patch. That is ~47%
 * of the budget at rest and ~87% while the startup probe also runs at 5s. Any
 * other anonymous burst exhausts the window, the
 * probe gets a 429, and a non-2xx IS a probe failure to the kubelet: two of
 * them (`failureThreshold: 2`, `periodSeconds: 5`) pull the pod out of
 * Endpoints ~10s later, and it returns when the 60s window rolls. A ~1 minute
 * outage with no restart — exactly what was observed.
 *
 * So the liveness of the pod depended on the rate-limit budget of every
 * anonymous caller. A probe answering a question about THIS process must not
 * be answerable by shared, remotely-exhaustible state.
 */
import { describe, expect, it } from 'vitest';
import { ApiHealthController } from '../health.controller';

/**
 * `@nestjs/throttler` stores the skip flag PER TIER, under
 * `'THROTTLER:SKIP' + tierName` (`throttler.decorator.js#SkipThrottle`), on the
 * method itself (`descriptor.value`). Spelled out here rather than imported
 * from `@nestjs/throttler/dist/...`, which is a private deep path.
 */
const THROTTLER_SKIP = 'THROTTLER:SKIP';

/**
 * The three routes the kubelet calls, per the `hope-api` Deployment's
 * `livenessProbe` / `readinessProbe` / `startupProbe`.
 */
const KUBELET_PROBES = ['liveness', 'readiness', 'startup'] as const;

describe('kubelet probes are exempt from rate limiting', () => {
  for (const handler of KUBELET_PROBES) {
    it(`${handler}() skips the default throttler tier`, () => {
      const method = ApiHealthController.prototype[handler];
      expect(method, `ApiHealthController.${handler} does not exist`).toBeTypeOf('function');

      // `default` is the tier that was gating these routes: the class declares
      // `@Throttle({ default: { limit: 30, ttl: 60000 } })`, and the guard lets
      // every OTHER tier through unless the route opts in. `@SkipThrottle()`
      // with no argument skips exactly this tier, which is the whole exposure.
      expect(
        Reflect.getMetadata(`${THROTTLER_SKIP}default`, method),
        'A rate-limited probe lets any anonymous caller exhaust the shared `tenant:null` bucket and ' +
          '429 the kubelet, which reads a non-2xx as a probe failure and removes the pod from Endpoints.',
      ).toBe(true);
    });
  }
});
