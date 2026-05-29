import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';

// `@nestjs/throttler` does NOT re-export its constants barrel, so the
// `THROTTLER_LIMIT` key (used by `@Throttle({ <name>: {...} })` to write
// per-route metadata) is not importable from the package root. Mirror the
// literal the library uses internally — the throttle decorator tests assert
// against this exact string (`'THROTTLER:LIMIT' + name`).
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

/**
 * TASK-315 — Option 2 (named throttlers, non-default opt-in).
 *
 * Under throttler v6 a global guard enforces EVERY configured named throttler
 * on EVERY route unless that tier is skipped. With four registered tiers
 * (default/strict/heavy/relaxed) that would gate all traffic at the strictest
 * tier (strict = 10/60s). To prevent that, the `default` tier always applies
 * (honouring per-route `@Throttle({ default: {...} })` overrides) while the
 * non-default tiers only apply to routes that explicitly opted in via
 * `@Throttle({ strict|heavy|relaxed: {...} })`.
 *
 * `@SkipThrottle()` keeps working: the base `canActivate` short-circuits skipped
 * tiers before `handleRequest` is reached, so skipped/default tiers still flow
 * through `super.handleRequest`.
 *
 * No constructor — DI is inherited from `ThrottlerGuard` (same pattern as the
 * official WebSocket throttler example).
 */
@Injectable()
export class TieredThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = requestProps.throttler.name ?? 'default';

    if (name !== 'default') {
      const context: ExecutionContext = requestProps.context;
      const optedIn = this.reflector.getAllAndOverride(THROTTLER_LIMIT + name, [context.getHandler(), context.getClass()]);

      // Route did not opt into this non-default tier — skip it entirely.
      if (optedIn === undefined) {
        return true;
      }
    }

    return super.handleRequest(requestProps);
  }
}
