import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../interfaces';
import { IApiKeyService } from '../services/apiKey/IApiKeyService';
import { IApiKeyRateLimiter, RateLimitResult } from '../services/apiKey/apikey-rate-limiter.service';
import { PERMISSION_MODE_KEY, PermissionMode, REQUIRED_PERMISSIONS_KEY, RequiredPermission, SKIP_AUTH_KEY } from './authorization.guard';
import { AppAbility, PolicyEngine } from './policy.engine';

export const API_KEY_REQUIRED_SCOPES = 'apiKeyRequiredScopes';

/**
 * Metadata key set by `@ForbidApiKey()` (TASK-708 Task 3 bucket (c)).
 *
 * Unlike `API_KEY_REQUIRED_SCOPES` (deny unless a listed scope is held),
 * this is an unconditional deny for ANY API-key-authenticated caller,
 * regardless of scopes — including a key holding the bare `'*'` wildcard.
 * Reserving a "never-granted" scope string instead was considered and
 * rejected: `ApiKeyService.hasScope`'s wildcard/prefix matching means a key
 * holding `'admin:*'` (a legitimate, intentionally broad admin grant)
 * satisfies EVERY `admin:*`-prefixed scope, including a "reserved" one — so
 * a reserved-scope trick nested under an existing wildcard family is not
 * actually safe against that family's own wildcard. An unconditional guard
 * check has no such collision surface. A JWT-authenticated caller is
 * completely unaffected by this decorator.
 */
export const API_KEY_FORBIDDEN = 'apiKeyForbidden';

/**
 * Metadata key for `@ResolveSubjectInstance(...)` (TASK-712 Phase 5 Task 14
 * — CASL shadow mode).
 */
export const SUBJECT_INSTANCE_RESOLVER_KEY = 'subjectInstanceResolver';

/**
 * A route-supplied function that resolves the SUBJECT INSTANCE a
 * `@Authorize`/`@CanXxx` permission's `conditions` would need to evaluate
 * against — e.g. `{ tenantId, doctorId }` for a `Consultation` row already
 * on `request.params`/`request.body`, or `undefined` when there is nothing
 * cheap to compare (no instance ⇒ no shadow check for that request, not a
 * divergence).
 *
 * Receives the raw Express/Fastify request; returns a plain object (or a
 * Promise of one) carrying whatever fields the tenant's seeded `conditions`
 * reference. Deliberately request-scoped and synchronous-or-cheap: this
 * runs on every gated request for an opted-in route, so it must never do
 * unbounded work (a full entity fetch belongs in a route that specifically
 * wants shadow coverage badly enough to pay for it — most routes should not
 * opt in without a measured reason).
 */
export type SubjectInstanceResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express/Fastify request shape varies by adapter; matches this file's existing request-param convention (e.g. handleApiKeyAuth below).
  request: any,
) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;

/**
 * Opt IN a route to CASL shadow-mode instance comparison (TASK-712 Phase 5
 * Task 14). Explicit and per-route by design — `UnifiedAuthGuard` never
 * resolves a subject instance (never loads a row) for a route that did not
 * ask for one. Divergences are logged (`CASL_SHADOW_DIVERGENCE_EVENT`) and
 * counted (`CASL_SHADOW_DIVERGENCE_METRIC`), both in `policy.engine.ts`; the
 * type-only verdict — the one actually enforced — is completely unaffected.
 *
 * @example
 * ```typescript
 * @Get(':id')
 * @Authorize(['read', 'Consultation'])
 * @ResolveSubjectInstance(async (request) => {
 *   const c = await consultationService.getById(request.params.id);
 *   return c ? { tenantId: c.tenantId, doctorId: c.doctorId } : undefined;
 * })
 * getOne() { ... }
 * ```
 */
export const ResolveSubjectInstance = (resolver: SubjectInstanceResolver) => SetMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, resolver);

/**
 * Injectable token for the JWT auth guard.
 * The API layer provides an implementation (e.g., JwtAuthGuard extending Passport's AuthGuard('jwt')).
 */
export const JWT_AUTH_GUARD = Symbol('JWT_AUTH_GUARD');

/**
 * Request-scoped marker holding the result of a SUCCESSFUL `canActivate` pass
 * for THIS request.
 *
 * `UnifiedAuthGuard` is the single global `APP_GUARD` enforcement
 * point, but Nest may still invoke a guard more than once per request (e.g. a
 * route-level `@UseGuards(UnifiedAuthGuard)` layered on the global pass). This
 * memo lets a repeat pass short-circuit instead of re-running the CASL
 * `buildAbility` + Redis round-trips. Only the SUCCESS path is memoised: a
 * thrown 401/403 stops the pipeline before any second pass, so `true` is the
 * only value that ever needs caching. Scoped to the request object, so a
 * subsequent (different) request is always authenticated from scratch.
 */
const UNIFIED_AUTH_RESULT = Symbol('unifiedAuthResult');

/**
 * Client-facing denial message for an API-key caller on a route that is not an
 * API-key surface.
 *
 * DELIBERATELY IDENTICAL for both denial reasons — `@ForbidApiKey()` ("declared
 * never") and the deny-by-default rule ("route declares no `@RequiredScopes`").
 * A caller must not be able to probe which routes merely lack a declaration
 * versus which were deliberately closed; the two are distinguished only in the
 * server-side log (`reason: 'forbid_api_key'` vs `'no_scopes_declared'`).
 */
const API_KEY_ROUTE_DENIED_MESSAGE = 'This route does not accept API-key authentication';

/**
 * The CASL verdict for a set of `@Authorize()`-declared permissions.
 *
 * Extracted so the JWT path (`handleJwtPostAuth`) and the API-key path
 * (`enforceApiKeyAbilities`) compute the SAME verdict from the SAME metadata —
 * the two must never drift, or `@Authorize(...)` would mean something different
 * depending on how the caller authenticated, which is precisely the defect
 * TASK-742 closed.
 */
function evaluatePermissions(
  ability: AppAbility,
  required: RequiredPermission[],
  mode: PermissionMode,
): { allowed: boolean; missing: string[]; message: string } {
  const results = required.map((permission) => ({
    permission,
    allowed: ability.can(permission.action, permission.subject),
  }));

  const allowed = mode === 'AND' ? results.every((r) => r.allowed) : results.some((r) => r.allowed);
  if (allowed) {
    return { allowed: true, missing: [], message: '' };
  }

  const denied = results.filter((r) => !r.allowed);
  const missing =
    mode === 'AND' ? denied.map((d) => `${d.permission.action}:${d.permission.subject}`) : required.map((p) => `${p.action}:${p.subject}`);
  const message = mode === 'AND' ? `Missing permissions: ${missing.join(', ')}` : `Requires at least one of: ${missing.join(', ')}`;

  return { allowed: false, missing, message };
}

/**
 * UnifiedAuthGuard — single guard replacing JwtAuthGuard + ApiKeyGuard + EitherAuthGuard + AuthorizationGuard.
 *
 * Processing order:
 * 1. Skip if @Public() metadata is set
 * 2. Try API key (headers: apikey, api-key, x-api-key):
 *    - Validate key: status, expiration, IP allowlist
 *    - Reject if the route is `@ForbidApiKey()`
 *    - Check rate limit
 *    - Require an explicit `@RequiredScopes(...)` declaration and a matching
 *      scope on the key (DENY BY DEFAULT — see `enforceApiKeyScopes`)
 *    - Set CLS context
 *    - Enforce the route's CASL permissions against the key's BOUND PRINCIPAL
 *      (see `enforceApiKeyAbilities`)
 * 3. Try JWT (Authorization: Bearer):
 *    - Validate via Passport strategy
 *    - Check CASL permissions
 * 4. Both failed → 401
 *
 * ─── Authorization model on the API-key path (TASK-742) ───────────────────
 *
 * An API-key request is authorized by **scopes AND abilities**, in that order,
 * both mandatory:
 *
 * - **Scopes** bound the CREDENTIAL: what the key was minted to do. Declared
 *   per route by `@RequiredScopes(...)`; a route with no declaration is not an
 *   API-key surface at all and is refused outright.
 * - **Abilities** bound the PRINCIPAL: what the user the key is linked to may
 *   do, evaluated with exactly the same `REQUIRED_PERMISSIONS_KEY` metadata and
 *   AND/OR mode the JWT path uses. A credential must never be able to do more
 *   than the human it belongs to.
 *
 * They compose as a conjunction, never as a fallback: a missing scope
 * declaration is NEVER rescued by CASL, and a held scope NEVER substitutes for
 * a missing ability. (Falling back to CASL when scopes are absent was
 * considered and rejected — it would silently grant an API key the full ability
 * set of whatever user it is attached to on every currently-undeclared route,
 * the exact opposite of "a key scoped to X cannot invoke anything else".)
 *
 * The ability computed for an API-key caller is used as a GATE ONLY: it is
 * deliberately NOT written to `request.ability` or CLS `userAbility`. Several
 * services read CLS `userAbility` and treat its absence as "not privileged"
 * (`ApiKeyService.callerCanManageAllKeys`, `PromptManagementService`), so
 * publishing it would WIDEN those paths for API-key callers as a side effect of
 * a narrowing change. Gate now, publish never — any future decision to expose
 * the ability to API-key callers must be made on its own merits.
 *
 * The JWT path is untouched by all of the above.
 */
@Injectable()
export class UnifiedAuthGuard implements CanActivate {
  private readonly logger = new Logger(UnifiedAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(IApiKeyService) private readonly apiKeyService: IApiKeyService,
    private readonly policyEngine: PolicyEngine,
    private readonly cls: ClsService<IActiveUserContext>,
    @Optional()
    @Inject(IApiKeyRateLimiter)
    private readonly rateLimiter?: { checkRateLimit: (apiKeyId: string, tenantId: string, limit: number) => Promise<RateLimitResult> },
    @Optional() @Inject(JWT_AUTH_GUARD) private readonly jwtAuthGuard?: CanActivate,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Idempotency: a repeat pass on the SAME request skips the
    // redundant CASL + Redis work. Only `true` is ever memoised; an auth
    // failure throws (401/403) and stops the pipeline before any second pass,
    // so the memo is only set after `authenticate` resolves successfully.
    const request = context.switchToHttp().getRequest();
    if (request?.[UNIFIED_AUTH_RESULT] === true) {
      return true;
    }

    const result = await this.authenticate(context);
    if (request) {
      request[UNIFIED_AUTH_RESULT] = result;
    }
    return result;
  }

  private async authenticate(context: ExecutionContext): Promise<boolean> {
    const skipAuth = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [context.getHandler(), context.getClass()]);
    const isPublic = skipAuth || this.reflector.getAllAndOverride<boolean>('isPublic', [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const method = request?.method;
    const path = request?.url;
    const ipAddress = this.getClientIp(request);

    const rawApiKey = this.apiKeyService.extractApiKeyFromRequest(request);
    if (rawApiKey) {
      try {
        return await this.handleApiKeyAuth(context, request, rawApiKey, ipAddress, method, path);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn({
          message: 'API key authentication error',
          reason: error instanceof Error ? error.message : String(error),
          method,
          path,
          ip: ipAddress,
        });
        throw new UnauthorizedException('Invalid API key');
      }
    }

    // SSE set token in query param
    if (!request.headers?.authorization && request.query?.token) {
      request.headers = request.headers || {};
      request.headers.authorization = `Bearer ${request.query.token}`;
    }

    if (this.jwtAuthGuard) {
      try {
        const jwtResult = await this.jwtAuthGuard.canActivate(context);
        if (jwtResult === true || jwtResult) {
          // Returned UN-AWAITED on purpose: a permission-denied
          // ForbiddenException (403) from post-auth must escape this `try` so
          // it is NOT downgraded to the generic 401 below. Only the awaited
          // `jwtAuthGuard.canActivate` rejection (an authentication failure) is
          // caught here.
          return this.handleJwtPostAuth(context, request, method, path);
        }
      } catch (error) {
        // Log the underlying failure (was silently swallowed). The
        // client still receives the generic 401 thrown below; this is purely
        // server-side diagnostics. Expected auth failures (bad/expired token,
        // already-consumed stream ticket) are debug noise; anything else is a
        // real signal worth a warn.
        const reason = error instanceof Error ? error.message : String(error);
        if (error instanceof UnauthorizedException) {
          this.logger.debug({ message: 'JWT/ticket auth failed; falling through to 401', reason, method, path });
        } else {
          this.logger.warn({ message: 'Unexpected error during JWT auth', reason, method, path });
        }
      }
    }

    this.logger.warn({
      message: 'Authentication failed',
      reason: 'no_valid_credentials',
      method,
      path,
      ip: ipAddress,
    });
    throw new UnauthorizedException('Authentication required. Provide a valid JWT (Authorization: Bearer) or API key (X-API-Key).');
  }

  // ─── API Key Auth Path ─────────────────────────────────────────────

  private async handleApiKeyAuth(
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: any,
    rawApiKey: string,
    ipAddress: string,
    method: string,
    path: string,
  ): Promise<boolean> {
    const apiKeyEntity = await this.apiKeyService.authenticateByRawKey(rawApiKey, ipAddress);

    this.enforceApiKeyNotForbidden(context);

    if (apiKeyEntity.rateLimit && apiKeyEntity.rateLimit > 0 && this.rateLimiter) {
      const result = await this.rateLimiter.checkRateLimit(apiKeyEntity.id, apiKeyEntity.tenantId, apiKeyEntity.rateLimit);
      if (!result.allowed) {
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Rate limit exceeded',
            remaining: result.remaining,
            resetAt: result.resetAt,
          },
          429,
        );
      }
    }

    this.enforceApiKeyScopes(context, apiKeyEntity);

    request['apiKey'] = apiKeyEntity;
    if (apiKeyEntity.userId) {
      this.cls.set('user', {
        id: apiKeyEntity.userId,
        tenantId: apiKeyEntity.tenantId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    if (apiKeyEntity.tenantId && !this.cls.get('tenantId')) {
      this.cls.set('tenantId', apiKeyEntity.tenantId);
    }

    await this.enforceApiKeyAbilities(context, request, apiKeyEntity, method, path);

    this.logger.debug({
      message: 'API key authenticated',
      keyId: apiKeyEntity.id,
      keyName: apiKeyEntity.keyName,
      tenantId: apiKeyEntity.tenantId,
      method,
      path,
    });

    return true;
  }

  /**
   * `@ForbidApiKey()` — an unconditional deny for API-key callers, checked
   * BEFORE scopes (a forbidden route has no scope that could rescue it).
   * See `API_KEY_FORBIDDEN`'s doc comment for why this is a dedicated check
   * rather than a reserved scope string.
   */
  private enforceApiKeyNotForbidden(context: ExecutionContext): void {
    const forbidden = this.reflector.getAllAndOverride<boolean>(API_KEY_FORBIDDEN, [context.getHandler(), context.getClass()]);
    if (forbidden === true) {
      this.logger.warn({ message: 'API key denied', reason: 'forbid_api_key' });
      throw new ForbiddenException(API_KEY_ROUTE_DENIED_MESSAGE);
    }
  }

  /**
   * DENY BY DEFAULT (TASK-742).
   *
   * A route is reachable by an API key only if it EXPLICITLY declares what an
   * API key may do there — i.e. carries `@RequiredScopes(...)` at the method or
   * class level. No declaration means "not an API-key surface", and the request
   * is refused.
   *
   * This inverts the previous behaviour, which returned early and PERMITTED
   * whenever no scopes were declared. Because CASL was (and, for undeclared
   * routes, still is) never reached on this path, that early return meant any
   * valid key bearing any trivial scope reached every undeclared route with no
   * authorization decision made at all.
   *
   * The boot-time audit `auditEveryApiKeyReachableRouteDeclaresScopes`
   * (`apps/api/src/bootstrap/api-key-surface-audit.ts`) enforces the same
   * invariant statically, so a route that would be denied here fails the boot
   * instead of surprising a caller at runtime.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enforceApiKeyScopes(context: ExecutionContext, apiKeyEntity: any): void {
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [context.getHandler(), context.getClass()]);

    if (!requiredScopes || requiredScopes.length === 0) {
      this.logger.warn({
        message: 'API key denied',
        reason: 'no_scopes_declared',
        keyId: apiKeyEntity?.id,
        tenantId: apiKeyEntity?.tenantId,
      });
      throw new ForbiddenException(API_KEY_ROUTE_DENIED_MESSAGE);
    }

    const hasRequiredScope = requiredScopes.some((scope) => this.apiKeyService.hasScope(apiKeyEntity, scope));

    if (!hasRequiredScope) {
      this.logger.warn({
        message: 'API key scope insufficient',
        keyId: apiKeyEntity.id,
        requiredScopes,
        keyScopes: apiKeyEntity.scopes,
      });
      throw new ForbiddenException(`API key does not have required scope(s): ${requiredScopes.join(', ')}`);
    }
  }

  /**
   * The SECOND half of the API-key authorization conjunction (TASK-742): the
   * route's own `@Authorize()`/`@CanXxx()` permissions, evaluated against the
   * ability of the user the key is BOUND to.
   *
   * Runs only after `enforceApiKeyScopes` has already established that this is
   * a declared API-key surface and that the key holds a matching scope, so it
   * can never widen anything — it only ever removes reach a scope would
   * otherwise have granted.
   *
   * Semantics deliberately mirror `handleJwtPostAuth` exactly (same metadata
   * key, same AND/OR mode, same message shape), so `@Authorize(...)` means the
   * same thing on both paths instead of being inert on this one. Two
   * API-key-specific rules:
   *
   * - A route declaring NO permissions is not gated here (the scope was the
   *   whole decision), matching the JWT path's own `required.length === 0`
   *   early return.
   * - A key with no linked `userId` has no principal, so a principal-scoped
   *   permission cannot be satisfied and the request is refused. Fail closed:
   *   the alternative — skipping the check for unlinked keys — would make an
   *   unbound credential strictly MORE powerful than a bound one.
   *
   * The ability is used as a gate and then discarded; see this class's doc
   * comment for why it is never published to `request.ability` / CLS.
   */
  private async enforceApiKeyAbilities(
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same request shape as handleApiKeyAuth's own `request: any` param.
    request: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ApiKeyEntity is consumed structurally here; matches this file's existing apiKeyEntity: any convention.
    apiKeyEntity: any,
    method: string,
    path: string,
  ): Promise<void> {
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required || required.length === 0) {
      return;
    }

    if (!apiKeyEntity?.userId) {
      this.logger.warn({
        message: 'API key denied',
        reason: 'key_not_linked_to_user',
        keyId: apiKeyEntity?.id,
        method,
        path,
      });
      throw new ForbiddenException('This API key is not linked to a user, so the permissions this route requires cannot be evaluated');
    }

    const mode = this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [context.getHandler(), context.getClass()]) || 'AND';

    let ability: AppAbility;
    try {
      ability = await this.policyEngine.buildAbility({
        userId: apiKeyEntity.userId,
        tenantId: apiKeyEntity.tenantId || undefined,
        params: request?.params,
      });
    } catch (error) {
      this.logger.error({
        message: 'Ability build failed',
        keyId: apiKeyEntity.id,
        userId: apiKeyEntity.userId,
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException('Authorization failed');
    }

    const verdict = evaluatePermissions(ability, required, mode);
    if (!verdict.allowed) {
      this.logger.warn({
        message: 'Access denied',
        reason: 'api_key_principal_lacks_permission',
        keyId: apiKeyEntity.id,
        userId: apiKeyEntity.userId,
        method,
        path,
        mode,
        deniedPermissions: verdict.missing,
      });
      throw new ForbiddenException(verdict.message);
    }
  }

  // ─── JWT Auth Path ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same ApiKeyEntity structural-consumption convention as enforceApiKeyScopes above.
  private async handleJwtPostAuth(context: ExecutionContext, request: any, method: string, path: string): Promise<boolean> {
    const user = request.user || this.cls.get('user');

    if (user) {
      if (!this.cls.get('user')) {
        this.cls.set('user', user);
      }
      if (user.tenantId && !this.cls.get('tenantId')) {
        this.cls.set('tenantId', user.tenantId);
      }
    }

    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required || required.length === 0) {
      return true;
    }

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const mode = this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [context.getHandler(), context.getClass()]) || 'AND';

    let ability: AppAbility;
    try {
      ability = await this.policyEngine.buildAbility({
        userId: user.id,
        tenantId: user.tenantId || undefined,
        params: request.params,
      });
    } catch (error) {
      this.logger.error({
        message: 'Ability build failed',
        userId: user.id,
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException('Authorization failed');
    }

    request.ability = ability;
    this.cls.set('userAbility', ability);

    // TASK-712 Phase 5 Task 14 — CASL shadow mode. Diagnostic-only: computes
    // what an instance-aware verdict WOULD be for any permission whose route
    // opted in via `@ResolveSubjectInstance(...)`, and records divergence
    // from the type-only verdict computed below. Never throws, never touches
    // `allowed` — see `runCaslShadowChecks`'s own guarantees.
    await this.runCaslShadowChecks(context, request, ability, required, method, path);

    const verdict = evaluatePermissions(ability, required, mode);

    if (!verdict.allowed) {
      this.logger.warn({
        message: 'Access denied',
        userId: user.id,
        method,
        path,
        mode,
        deniedPermissions: verdict.missing,
      });
      throw new ForbiddenException(verdict.message);
    }

    return true;
  }

  /**
   * TASK-712 Phase 5 Task 14 — CASL shadow mode.
   *
   * For each required permission whose route carries a
   * `@ResolveSubjectInstance(...)` resolver, resolves an instance and asks
   * `PolicyEngine.evaluateShadowVerdict` whether the instance-aware verdict
   * `conditions` would produce agrees with the type-only verdict actually
   * enforced by the caller. Every step is opt-in and fail-open toward "do
   * nothing":
   *
   * - No resolver on the route → skipped (no row loaded, no divergence).
   * - Resolver returns `undefined` → skipped (nothing to compare).
   * - Resolver throws → swallowed and logged at DEBUG; shadow mode must
   *   never be the reason a real request fails.
   *
   * This method NEVER throws and NEVER influences `allowed` — it exists
   * purely to populate `casl_shadow_divergence_total` /
   * `casl.shadow.divergence` for `casl-blast-radius.md`'s measure phase.
   */
  private async runCaslShadowChecks(
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same request shape as handleJwtPostAuth's own `request: any` param this method is called from.
    request: any,
    ability: AppAbility,
    required: RequiredPermission[],
    method: string,
    path: string,
  ): Promise<void> {
    for (const permission of required) {
      try {
        const resolver = this.reflector.getAllAndOverride<SubjectInstanceResolver | undefined>(SUBJECT_INSTANCE_RESOLVER_KEY, [
          context.getHandler(),
          context.getClass(),
        ]);
        if (!resolver) continue; // opt-in only — no resolver, no shadow check, no row loaded

        const instance = await resolver(request);
        if (!instance) continue; // resolver explicitly had nothing to compare against

        const verdict = this.policyEngine.evaluateShadowVerdict(ability, permission.action, permission.subject, instance);
        if (verdict.diverged) {
          this.policyEngine.recordShadowDivergence(permission.action, permission.subject, verdict, { method, path });
        }
      } catch (error) {
        // Shadow-mode failures are diagnostics-only and must never affect
        // the actual (type-only) authorization outcome computed after this.
        this.logger.debug({
          message: 'casl.shadow.resolver_error',
          action: permission.action,
          subject: permission.subject,
          method,
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getClientIp(request: any): string {
    const forwarded = request?.headers?.['x-forwarded-for'];
    if (forwarded) {
      const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
      return ips[0].trim();
    }
    return request?.ip || request?.socket?.remoteAddress || 'unknown';
  }
}
