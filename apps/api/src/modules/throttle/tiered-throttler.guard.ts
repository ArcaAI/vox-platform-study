import { Inject, Injectable, Optional, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { IRateLimitSettingsService, resolveRouteId, type RateLimitTierName } from '@arcaai/applications';

// `@nestjs/throttler` does NOT re-export its constants barrel, so the
// `THROTTLER_LIMIT` / `THROTTLER_TTL` keys (written by `@Throttle({ <name>:
// {...} })`) are not importable from the package root. Mirror the literals the
// library uses internally — the throttle decorator tests assert against these
// exact strings (`'THROTTLER:LIMIT' + name` / `'THROTTLER:TTL' + name`).
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

/**
 * TASK-315 — Option 2 (named throttlers, non-default opt-in).
 * TASK-316 — DB-backed, admin-controlled limits resolved live per request.
 *
 * Under throttler v6 a global guard enforces EVERY configured named throttler
 * on EVERY route unless that tier is skipped. With four registered tiers
 * (default/strict/heavy/relaxed) that would gate all traffic at the strictest
 * tier. To prevent that, the `default` tier always applies (honouring per-route
 * `@Throttle({ default: {...} })` overrides) while the non-default tiers only
 * apply to routes that explicitly opted in via `@Throttle({ strict|heavy|relaxed:
 * {...} })`.
 *
 * When `IRateLimitSettingsService` is available (the running gateway imports
 * `RateLimitServiceModule`), the effective limit/ttl is resolved live from the
 * DB-backed `GlobalSetting` cache with this precedence:
 *
 *   1. `rate-limit.enabled === false`            → skip (global kill-switch)
 *   2. `rate-limit.route.<id>.enabled === false` → skip that route
 *   3. limit/ttl = per-endpoint DB override
 *                  > `@Throttle` decorator value
 *                  > tier DB baseline
 *                  > static tier default
 *
 * The dependency is `@Optional()` so the standalone TASK-315 integration test
 * (which wires only `ThrottleConfigModule`, no settings service) keeps its
 * exact static behavior.
 */
@Injectable()
export class TieredThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(IRateLimitSettingsService)
  private readonly rateLimitSettings?: IRateLimitSettingsService;

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = (requestProps.throttler.name ?? 'default') as RateLimitTierName;
    const context: ExecutionContext = requestProps.context;

    // The per-route `@Throttle` value for this tier (undefined = the route did
    // not decorate this tier). Doubles as the TASK-315 opt-in signal.
    const decoratorLimit = this.reflector.getAllAndOverride<number>(THROTTLER_LIMIT + name, [
      context.getHandler(),
      context.getClass(),
    ]);

    // TASK-315 — non-default tiers only gate routes that opted in.
    if (name !== 'default' && decoratorLimit === undefined) {
      return true;
    }

    const settings = this.rateLimitSettings;

    // No DB settings wired → preserve the exact static (TASK-315) behavior.
    if (!settings) {
      return super.handleRequest(requestProps);
    }

    // (1) Global kill-switch.
    if (!settings.isEnabled()) {
      return true;
    }

    // (2) Per-endpoint override — only the always-on `default` tier is tunable
    // per endpoint; non-default tiers ride their decorator + tier baseline.
    const routeId =
      name === 'default' ? resolveRouteId(context.getClass().name, context.getHandler().name) : undefined;
    const override = routeId ? settings.getRouteOverride(routeId) : undefined;

    if (override?.enabled === false) {
      return true;
    }

    // (3) Resolve effective limit/ttl by precedence.
    const tier = settings.getTier(name);
    const decoratorTtl = this.reflector.getAllAndOverride<number>(THROTTLER_TTL + name, [
      context.getHandler(),
      context.getClass(),
    ]);

    const limit = override?.limit ?? decoratorLimit ?? tier.limit;
    const ttl = override?.ttl ?? decoratorTtl ?? tier.ttl;

    return super.handleRequest({ ...requestProps, limit, ttl });
  }
}
