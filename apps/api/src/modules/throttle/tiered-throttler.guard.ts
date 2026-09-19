import { Inject, Injectable, Optional, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail, type ThrottlerRequest } from '@nestjs/throttler';
import * as jwt from 'jsonwebtoken';
import { resolveClientIp, trustedProxiesFromEnv } from './client-ip';
import {
  IApiKeyService,
  IEntitlementsService,
  IRateLimitSettingsService,
  RateLimitRuleCache,
  IServiceAccountService,
  SecretsService,
  buildRouteKey,
  resolveRouteId,
  resolvePlanRateLimit,
  resolveRateLimit,
  type RateLimitLevel,
  type RateLimitTierName,
} from '@arcaai/applications';

// `@nestjs/throttler` does NOT re-export its constants barrel, so the
// `THROTTLER_LIMIT` / `THROTTLER_TTL` keys (written by `@Throttle({ <name>:
// {...} })`) are not importable from the package root. Mirror the literals the
// library uses internally — the throttle decorator tests assert against these
// exact strings (`'THROTTLER:LIMIT' + name` / `'THROTTLER:TTL' + name`).
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

/** Levels whose value came from the tenant's own identity — bucket per tenant. */
const TENANT_SCOPED_LEVELS: ReadonlySet<RateLimitLevel> = new Set<RateLimitLevel>(['tenant-route', 'tenant', 'plan']);

/** Stashed on the request so `RateLimitHeadersInterceptor` can advertise the applied policy. */
export const RATE_LIMIT_RESOLUTION_KEY = '__rateLimitResolution';

export interface RequestRateLimitResolution {
  limitValue: number;
  windowMs: number;
  level: RateLimitLevel;
  /**
   * Requests left in the CURRENT window, as the storage backend counted them.
   * Absent when the counters could not be observed (see
   * `recordObservedCounters`), which the interceptor reads as "say nothing"
   * rather than "say the quota".
   */
  remaining?: number;
  /** Seconds until the current window resets. Same absence rule as `remaining`. */
  resetSeconds?: number;
}

/** A response header the library wrote back as a number, or `null`. */
function readCounterHeader(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Named throttlers with DB-backed, admin-controlled limits resolved live per
 * request.
 *
 * Under throttler v6 a global guard enforces EVERY configured named throttler on
 * EVERY route unless that tier is skipped. With four registered tiers that would
 * gate all traffic at the strictest one, so the `default` tier always applies
 * while `strict`/`heavy`/`relaxed` only gate routes that opted in via
 * `@Throttle({ <tier>: {...} })`.
 *
 * ## Precedence — delegated to `resolveRateLimit`
 *
 *   1. tenant × route rule 2. tenant rule 3. plan
 *   4. platform route rule 5. platform base (the `@Throttle` decorator value,
 *                                                else the named tier baseline)
 *
 * The decorator is rank 5's seed, NOT an override. It used to outrank both
 * the tenant and the plan, which meant an ENTERPRISE tenant could not be granted
 * more than `auth/login`'s hardcoded 5/min without a redeploy — defeating the
 * point of a runtime-tunable surface.
 *
 * ## Bucket keying
 *
 * A limit that resolved from ranks 1–3 is counted PER TENANT; one that resolved
 * from ranks 4–5 keeps the historical per-IP counting. Before this, every limit
 * was per-IP, so "500/min for tenant A" actually meant "500/min per source IP",
 * and two tenants behind one NAT shared a bucket.
 *
 * ## Why the tenant id is VERIFIED here
 *
 * The guard runs before `UnifiedAuthGuard`, so there is no CLS tenant yet and the
 * tenant must come from the credential itself. Deriving it unverified is fine for
 * choosing a tier, but NOT for choosing a counter key: an attacker could then
 * name a generous tenant and spend that tenant's budget (or borrow it). So every
 * lane proves the credential first, and an unprovable one is UNTRUSTED — it
 * resolves on ranks 4–5 and is IP-keyed, exactly as anonymous traffic is.
 *
 * Three credential classes, three lanes, none of which touches the database
 *  — before it, only the JWT lane existed, so the ENTIRE machine
 * plane, including every `@arcaai/vox-node` admin call, was ungoverned by tenant
 * and plan limits):
 *
 *   - **JWT** — signature verified against the warm `JWT_SECRET_KEY`.
 *   - **Service-account token** — one Redis GET of the token blob minted at
 *     exchange; yields the bound `workingTenantId`.
 *   - **API key** — a Redis hint published by `ApiKeyService` on the previous
 *     successful authentication. The first request in each TTL window rides the
 *     platform lane rather than paying a DB read here.
 *
 * All three deliberately skip revocation and ability checks: `UnifiedAuthGuard`
 * runs immediately after and is authoritative, so a credential that has just
 * lost its authority can only spend the budget it already owned.
 *
 * Both service dependencies stay `@Optional()` so the standalone integration test
 * (which wires only `ThrottleConfigModule`) keeps its exact static behaviour.
 */
@Injectable()
export class TieredThrottlerGuard extends ThrottlerGuard {
  @Optional()
  @Inject(IRateLimitSettingsService)
  private readonly rateLimitSettings?: IRateLimitSettingsService;

  @Optional()
  @Inject(IEntitlementsService)
  private readonly entitlements?: IEntitlementsService;

  @Optional()
  @Inject(RateLimitRuleCache)
  private readonly ruleCache?: RateLimitRuleCache;

  @Optional()
  @Inject(SecretsService)
  private readonly secrets?: SecretsService;

  // Injected by INTERFACE token, not class: `ApiKeyServiceModule` exports only
  // `IApiKeyService`, so a class-token injection would silently resolve to
  // `undefined` under `@Optional()` and the whole API-key lane would be a
  // no-op that still compiled and still passed every test.
  @Optional()
  @Inject(IServiceAccountService)
  private readonly serviceAccounts?: IServiceAccountService;

  @Optional()
  @Inject(IApiKeyService)
  private readonly apiKeys?: IApiKeyService;

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const name = (requestProps.throttler.name ?? 'default') as RateLimitTierName;
    const context: ExecutionContext = requestProps.context;

    // The per-route `@Throttle` value for this tier (undefined = the route did
    // not decorate this tier). Doubles as the opt-in signal.
    const decoratorLimit = this.reflector.getAllAndOverride<number>(THROTTLER_LIMIT + name, [context.getHandler(), context.getClass()]);
    const decoratorTtl = this.reflector.getAllAndOverride<number>(THROTTLER_TTL + name, [context.getHandler(), context.getClass()]);

    // Non-default tiers only gate routes that opted in.
    if (name !== 'default' && decoratorLimit === undefined) {
      return true;
    }

    const settings = this.rateLimitSettings;

    // No DB settings wired → preserve the exact static behaviour.
    if (!settings) {
      return super.handleRequest(requestProps);
    }

    const tenantId = await this.resolveTrustedTenantId(context);

    // (1) Kill-switch: the platform master switch, then the tenant's own view of
    // it. A tenant may only make this STRICTER (`tenant-clamp.ts`).
    if (!settings.isEnabledForTenant(tenantId)) {
      return true;
    }

    const tierBaseline = settings.getTierForTenant(name, tenantId, {});

    // The opt-in tiers have no per-tenant, per-plan or per-route lane — they
    // exist to bound brute force platform-wide. Resolve them exactly as before.
    if (name !== 'default') {
      return super.handleRequest({
        ...requestProps,
        limit: decoratorLimit ?? tierBaseline.limit,
        ttl: decoratorTtl ?? tierBaseline.ttl,
      });
    }

    // The LEGACY per-endpoint lane: `rate-limit.route.<slug>.*` GlobalSetting
    // rows over the five hand-registered `KNOWN_THROTTLED_ROUTES`. Superseded by
    // `RateLimitRule` (which governs any of the 657 routes and any tenant) and
    // kept only so the shipped admin screen and SDK keep telling the truth —
    // a lane still displayed as effective must still BE effective. It sits just
    // above the decorator, which is where it always sat; a real rank-4 rule
    // outranks it.
    const legacyRouteId = resolveRouteId(context.getClass().name, context.getHandler().name);
    const legacy = legacyRouteId ? settings.getRouteOverride(legacyRouteId) : undefined;
    if (legacy?.enabled === false) {
      return true;
    }

    // Rank 5 — the decorator seeds it ; the named tier baseline is the
    // floor when the route declares nothing.
    const base = {
      limitValue: legacy?.limit ?? decoratorLimit ?? tierBaseline.limit,
      windowMs: legacy?.ttl ?? decoratorTtl ?? tierBaseline.ttl,
    };

    const routeKey = this.resolveRouteKey(context);
    const plan = await this.resolvePlanValue(tenantId, settings);

    // Re-resolve the tier now that the plan is known: its limit is the
    // entitlement CEILING the tenant clamp applies to the tenant's own row (a
    // tenant may throttle itself harder than its plan, never softer).
    const tier = settings.getTierForTenant(name, tenantId, plan ? { entitlement: plan.limitValue } : {});

    // Rank 2's self-service lane — counted ONLY when the value genuinely came
    // from the tenant's OWN row. A value that merely fell through to the
    // platform row or the code baseline is rank 5, not rank 2.
    const tenantOwnsLimit = tier.limitSource === 'tenant';
    const tenantOwnsTtl = tier.ttlSource === 'tenant';
    const tenantSetting = tenantOwnsLimit || tenantOwnsTtl ? { limitValue: tier.limit, windowMs: tier.ttl } : null;

    const resolution = resolveRateLimit({
      tenantId,
      // No route pattern (a non-Express adapter, or a 404 that never matched a
      // route) means we cannot key a bucket without unbounded cardinality, so
      // route-scoped rules simply do not apply.
      routeKey: routeKey ?? '',
      tenantRules: this.ruleCache?.getRulesFor(tenantId) ?? [],
      platformRules: this.ruleCache?.getPlatformRules() ?? [],
      tenantSetting,
      plan,
      base,
    });

    // A matching rule with `active: false` EXEMPTS the scope.
    if (!resolution.effective) {
      return true;
    }

    // Stash for the headers interceptor (AC-9).
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    if (request) {
      request[RATE_LIMIT_RESOLUTION_KEY] = {
        limitValue: resolution.effective.limitValue,
        windowMs: resolution.effective.windowMs,
        level: resolution.level,
      } satisfies RequestRateLimitResolution;
    }

    const tenantScoped = tenantId !== null && TENANT_SCOPED_LEVELS.has(resolution.level);

    if (!tenantScoped) {
      // Platform-resolved limits keep the library's own key — which already
      // includes the handler identity, so each route keeps its own per-IP
      // bucket exactly as before. Substituting our own key here would collapse
      // every route into one shared counter.
      const allowed = await super.handleRequest({ ...requestProps, limit: resolution.effective.limitValue, ttl: resolution.effective.windowMs });
      this.recordObservedCounters(context, request);
      return allowed;
    }

    // OD-3: a limit that resolved from the tenant's own identity is counted PER
    // TENANT. A tenant × route rule keeps a bucket per route; a tenant-wide or
    // plan limit is deliberately ONE bucket across all of that tenant's traffic
    // — that is what "500 requests per minute for tenant A" means.
    const bucketScope = resolution.level === 'tenant-route' ? `t:${tenantId}:r:${routeKey ?? '-'}` : `t:${tenantId}`;

    const allowed = await super.handleRequest({
      ...requestProps,
      limit: resolution.effective.limitValue,
      ttl: resolution.effective.windowMs,
      getTracker: async () => `tenant:${tenantId}`,
      generateKey: (_ctx, tracker, throttlerName) => `${throttlerName}:${bucketScope}:${tracker}`,
    });
    this.recordObservedCounters(context, request);
    return allowed;
  }

  /**
   * The bucket key's IP component.
   *
   * The base class returns `req.ip`, which with `trust proxy` off is the socket
   * peer — behind this platform's ingress that is ONE address for the entire
   * internet (TASK-993 D-1). `resolveClientIp` promotes `CF-Connecting-IP` to
   * the tracker, but ONLY when the socket peer is a declared ingress; see
   * `client-ip.ts` for why that header and not `X-Forwarded-For`, and why the
   * trust is expressed here rather than as Express `trust proxy`.
   *
   * With no declared ingress (`RATE_LIMIT_TRUSTED_PROXIES` unset — the default,
   * and what every test and local dev run sees) this is `super.getTracker`
   * verbatim.
   *
   * Tenant-scoped buckets are unaffected: they pass their own `getTracker` in
   * `requestProps` and never reach this method.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const resolved = resolveClientIp(req, trustedProxiesFromEnv());
    return resolved ?? super.getTracker(req);
  }

  /**
   * Guarantee a plain `Retry-After` on every 429 (TASK-993 D-4).
   *
   * The library stamps `Retry-After-<tier>` for a non-default throttler and
   * never an unsuffixed one, so a `heavy`-tier 429 (agent invoke, workflow
   * runs, agent bench) answered only `Retry-After-heavy`. Every SDK reads
   * `retry-after` — `@arcaai/vox-node` included
   * (`packages/vox-node/src/core/errors.ts`) — so the backoff hint was lost
   * exactly where the waits are longest.
   *
   * The suffixed header is already written by the time this runs and is left
   * alone: something may depend on it, and removing it is not this fix.
   */
  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const response = context.switchToHttp().getResponse<
      | {
          header?: (name: string, value: string) => void;
          getHeader?: (name: string) => unknown;
        }
      | undefined
    >();

    // `timeToBlockExpire` is SECONDS in both storage backends (the in-memory
    // service and the Redis Lua both divide by 1000 before returning).
    const seconds = Number(detail.timeToBlockExpire);
    if (response?.header && response.getHeader?.('Retry-After') === undefined && Number.isFinite(seconds)) {
      try {
        response.header('Retry-After', String(Math.max(1, Math.ceil(seconds))));
      } catch {
        // A stream/upgrade response may refuse a late header write. The 429
        // itself still has to be thrown.
      }
    }

    return super.throwThrottlingException(context, detail);
  }

  /**
   * Carry the REAL counters from the throttler to `RateLimitHeadersInterceptor`
   * (TASK-993 D-3).
   *
   * The interceptor used to render `r=<quota>;t=<window>` — both static — so
   * `RateLimit: "default";r=30;t=60` sat next to `X-RateLimit-Remaining: 29`
   * and an integrator reading the modern header saw full headroom forever.
   *
   * `handleRequest` computes `totalHits`/`timeToExpire` in a local scope and
   * returns only a boolean, so they are read back off the headers the base
   * class has just written. That is deliberate rather than merely convenient:
   * sourcing both fields from the SAME numbers makes the two headers unable to
   * disagree again, which is the entire defect.
   */
  private recordObservedCounters(context: ExecutionContext, request: Record<string, unknown> | undefined): void {
    const stashed = request?.[RATE_LIMIT_RESOLUTION_KEY] as RequestRateLimitResolution | undefined;
    if (!stashed) return;

    const response = context.switchToHttp().getResponse<{ getHeader?: (name: string) => unknown } | undefined>();
    if (!response?.getHeader) return;

    // Only the `default` tier stashes a resolution, and its header suffix is
    // empty — hence the bare prefix.
    const remaining = readCounterHeader(response.getHeader(`${this.headerPrefix}-Remaining`));
    const resetSeconds = readCounterHeader(response.getHeader(`${this.headerPrefix}-Reset`));
    if (remaining !== null) stashed.remaining = remaining;
    if (resetSeconds !== null) stashed.resetSeconds = resetSeconds;
  }

  /**
   * `METHOD:/route/pattern` from the router's REGISTERED pattern
   * (`/api/v1/tenants/:id`), never the resolved URL — a resolved URL would make
   * both the rule set and the bucket keys unbounded in cardinality. Returns
   * `null` when no pattern is available, which degrades to rank 5.
   */
  private resolveRouteKey(context: ExecutionContext): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = context.switchToHttp().getRequest<any>();
    const method: string | undefined = request?.method;
    const pattern: string | undefined = request?.route?.path;
    if (!method || !pattern) return null;

    // Express strips the mount prefix from `route.path`; `baseUrl` carries it.
    const baseUrl: string = typeof request.baseUrl === 'string' ? request.baseUrl : '';
    const full = pattern.startsWith(baseUrl) ? pattern : `${baseUrl}${pattern}`;
    return buildRouteKey(method, full);
  }

  /**
   * Rank 3, or `null` when the tenant has no plan opinion. Never throws — an
   * entitlements blip means "rank 3 has no opinion", never a 429 or a 500.
   */
  private async resolvePlanValue(
    tenantId: string | null,
    settings: IRateLimitSettingsService,
  ): Promise<{ limitValue: number; windowMs: number } | null> {
    if (!this.entitlements || !tenantId) return null;

    try {
      const policy = await this.entitlements.getTenantRateLimitPolicy(tenantId);
      if (!policy) return null;

      const baseline = settings.getTier(policy.tier as RateLimitTierName);
      const effective = resolvePlanRateLimit(policy.tier, policy.perMinute, baseline, policy.windowMs);
      return { limitValue: effective.limit, windowMs: effective.ttl };
    } catch {
      return null;
    }
  }

  /**
   * The caller's tenant, proven from whichever credential is present. Returns
   * `null` for anonymous and unprovable traffic, which then rides the platform
   * lanes and is IP-keyed.
   *
   * Verification is deliberately minimal: signature + expiry against the
   * already-warm secret. No DB read, no revocation check, no CLS — those belong
   * to `UnifiedAuthGuard`, which runs immediately after and is authoritative.
   * A revoked-but-unexpired token can therefore still be counted against its own
   * tenant's bucket for the few seconds before the real guard rejects it, which
   * is harmless: it only ever spends the budget it already owned.
   */
  private async resolveTrustedTenantId(context: ExecutionContext): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const request = context.switchToHttp().getRequest<any>();
    if (!request) return null;

    // Machine credentials first: they are unambiguous (a single header each),
    // and `UnifiedAuthGuard` rejects a request presenting both, so there is no
    // precedence question to get wrong here.
    const serviceAccountToken: string | undefined = request.headers?.['x-service-account-token'];
    if (serviceAccountToken && this.serviceAccounts) {
      return this.serviceAccounts.peekTenantForRateLimit(serviceAccountToken);
    }

    const apiKey: string | undefined = request.headers?.['x-api-key'];
    if (apiKey && this.apiKeys) {
      return this.apiKeys.peekTenantForRateLimit(apiKey);
    }

    const authHeader: string | undefined = request.headers?.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    // SSE clients pass the JWT as `?token=` instead of a header (mirrors
    // UnifiedAuthGuard's SSE handling).
    const token = bearer ?? (typeof request.query?.token === 'string' ? request.query.token : undefined);
    if (!token) return null;

    const secret = this.secrets?.getSecretSync('JWT_SECRET_KEY');
    if (!secret) return null;

    try {
      // ALGORITHMS PINNED. `jsonwebtoken@9` already infers HS* from a string
      // secret, so `alg: none` and an RS256 header are rejected without this —
      // but that is a library default protecting a security boundary, and the
      // boundary should say so itself. Tokens are minted by `createJwt`, which
      // signs with the library's string-secret default: HS256.
      //
      // Measured cost: ~95us/verify, ~0.1ms per request. A lean
      // hand-rolled HMAC path benchmarks ~9x faster, and is deliberately NOT
      // used: re-implementing JWT verification to save 85us on a request that
      // also does Redis I/O trades a real security surface for an unmeasurable
      // latency win. Revisit only if profiling shows this on the hot path.
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as { tenantId?: unknown };
      return typeof payload.tenantId === 'string' && payload.tenantId.length > 0 ? payload.tenantId : null;
    } catch {
      // Forged, expired, or signed with another key — untrusted, so it must not
      // reach any tenant-scoped lane or bucket.
      return null;
    }
  }
}
