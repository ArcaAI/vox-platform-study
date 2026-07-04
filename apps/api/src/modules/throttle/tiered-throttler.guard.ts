import { Inject, Injectable, Optional, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { IEntitlementsService, IRateLimitSettingsService, resolvePlanRateLimit, resolveRouteId, type RateLimitTierName } from '@arcaai/applications';

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
 *                  > per-tenant plan tier (TASK-392 Q7)
 *                  > tier DB baseline
 *                  > static tier default
 *
 * TASK-392 (Q7) — per-request plan rate-limits. The guard runs BEFORE auth, so
 * it derives the tenant identity early from the request (the JWT bearer /
 * SSE token payload — matching how the app identifies tenants) and asks
 * `IEntitlementsService.getTenantRateLimitPolicy` for that tenant's plan tier +
 * per-tenant absolute override. `resolvePlanRateLimit` then composes the
 * effective `{ limit, ttl }` from the DB tier baseline. This applies ONLY to the
 * always-on `default` tier and ONLY when the entitlements kill-switch is ON and
 * a tenant is resolvable — otherwise the global tiers are used unchanged. The
 * IP-based tracker is intentionally left untouched (so brute-force tiers keep
 * their per-IP semantics); only the effective limit/ttl is plan-aware.
 *
 * Both service dependencies are `@Optional()` so the standalone TASK-315
 * integration test (which wires only `ThrottleConfigModule`, no settings /
 * entitlements service) keeps its exact static behavior.
 */
@Injectable()
export class TieredThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(IRateLimitSettingsService)
  private readonly rateLimitSettings?: IRateLimitSettingsService;

  @Optional()
  @Inject(IEntitlementsService)
  private readonly entitlements?: IEntitlementsService;

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = (requestProps.throttler.name ?? 'default') as RateLimitTierName;
    const context: ExecutionContext = requestProps.context;

    // The per-route `@Throttle` value for this tier (undefined = the route did
    // not decorate this tier). Doubles as the TASK-315 opt-in signal.
    const decoratorLimit = this.reflector.getAllAndOverride<number>(THROTTLER_LIMIT + name, [context.getHandler(), context.getClass()]);

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
    const routeId = name === 'default' ? resolveRouteId(context.getClass().name, context.getHandler().name) : undefined;
    const override = routeId ? settings.getRouteOverride(routeId) : undefined;

    if (override?.enabled === false) {
      return true;
    }

    // (3) Resolve effective limit/ttl by precedence.
    const tier = settings.getTier(name);
    const decoratorTtl = this.reflector.getAllAndOverride<number>(THROTTLER_TTL + name, [context.getHandler(), context.getClass()]);

    // (3a) TASK-392 (Q7) — per-tenant plan tier, applied only to the always-on
    // `default` tier. Sits between the `@Throttle` decorator and the tier
    // baseline in the precedence chain.
    const plan = name === 'default' ? await this.resolvePlanRateLimit(context, settings) : undefined;

    const limit = override?.limit ?? decoratorLimit ?? plan?.limit ?? tier.limit;
    const ttl = override?.ttl ?? decoratorTtl ?? plan?.ttl ?? tier.ttl;

    return super.handleRequest({ ...requestProps, limit, ttl });
  }

  /**
   * TASK-392 (Q7) — resolve the caller-tenant's effective `{ limit, ttl }` from
   * its plan rate-limit tier + per-tenant override, or `undefined` to leave the
   * global tiers unchanged (kill-switch OFF, no tenant resolvable, or an ungated
   * null-plan/system tenant). Never throws — a Redis/DB blip or a bad token
   * falls back to the global tiers.
   */
  private async resolvePlanRateLimit(
    context: ExecutionContext,
    settings: IRateLimitSettingsService,
  ): Promise<{ limit: number; ttl: number } | undefined> {
    if (!this.entitlements) return undefined;

    const tenantId = this.extractTenantIdPreAuth(context);
    if (!tenantId) return undefined;

    try {
      const policy = await this.entitlements.getTenantRateLimitPolicy(tenantId);
      if (!policy) return undefined;

      const baseline = settings.getTier(policy.tier as RateLimitTierName);
      const effective = resolvePlanRateLimit(policy.tier, policy.perMinute, baseline);
      return { limit: effective.limit, ttl: effective.ttl };
    } catch {
      // Best-effort: any failure resolving the plan tier leaves the global tiers
      // in force. The throttler must never fail-closed on an entitlements blip.
      return undefined;
    }
  }

  /**
   * TASK-392 (Q7) — best-effort pre-auth tenant extraction. The throttler runs
   * before `UnifiedAuthGuard`, so there is no CLS tenant yet; we read the tenant
   * from the JWT bearer (or the SSE `?token=` fallback the auth guard also
   * honours), DECODING the payload without verifying the signature. This is a
   * rate-limit tiering hint only — never an authorization decision (the real
   * auth guard still fully validates the token immediately after), so an
   * unverified decode is acceptable and cheap. Returns `null` for API-key /
   * unauthenticated traffic, which then rides the global tiers (API keys also
   * carry their own per-key limiter in `UnifiedAuthGuard`).
   */
  private extractTenantIdPreAuth(context: ExecutionContext): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = context.switchToHttp().getRequest<any>();
    if (!request) return null;

    const authHeader: string | undefined = request.headers?.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    // SSE clients pass the JWT as `?token=` instead of a header (mirrors
    // UnifiedAuthGuard's SSE handling).
    const token = bearer ?? (typeof request.query?.token === 'string' ? request.query.token : undefined);
    if (!token) return null;

    return decodeJwtTenantId(token);
  }
}

/**
 * Decode the `tenantId` claim from a JWT WITHOUT verifying its signature. Used
 * only for pre-auth rate-limit tiering (TASK-392 Q7) — returns `null` on any
 * malformed input rather than throwing.
 */
function decodeJwtTenantId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { tenantId?: unknown };
    return typeof payload.tenantId === 'string' && payload.tenantId.length > 0 ? payload.tenantId : null;
  } catch {
    return null;
  }
}
