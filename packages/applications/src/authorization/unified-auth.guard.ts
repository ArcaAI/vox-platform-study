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
import { ModuleRef, Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../interfaces';
import { IApiKeyService } from '../services/apiKey/IApiKeyService';
import { IApiKeyRateLimiter, RateLimitResult } from '../services/apiKey/apikey-rate-limiter.service';
import { PERMISSION_MODE_KEY, PermissionMode, REQUIRED_PERMISSIONS_KEY, RequiredPermission, SKIP_AUTH_KEY } from './authorization.guard';
import { AppAbility, PolicyEngine } from './policy.engine';
import { serviceAccountPolicyRules } from '../services/serviceAccount/service-account-scopes.registry';
// Relative, not through the package barrel: this guard is INSIDE the package
// that now owns the primitive (TASK-993 lane J).
import { resolveAttributedClientIp } from '../common/client-ip';

/**
 * The gateway writes ONE failure line per failed request, from its terminal
 * exception filter (`apps/api/src/filters/failure-log.ts`). This guard
 * therefore does not log its rejections; it attaches the reason to the
 * exception it throws, under the same global-registry symbol the filter reads
 * (so neither package imports the other). Non-enumerable: never serialized.
 */
const FAILURE_LOG_CONTEXT = Symbol.for('hope.failureLogContext');

function withFailureLog<E>(err: E, ctx: Record<string, unknown>): E {
  if (err !== null && typeof err === 'object') {
    const previous = (err as Record<symbol, Record<string, unknown> | undefined>)[FAILURE_LOG_CONTEXT] ?? {};
    Object.defineProperty(err, FAILURE_LOG_CONTEXT, { value: { ...previous, ...ctx }, enumerable: false, configurable: true, writable: true });
  }
  return err;
}

/** The route TEMPLATE, never the URL (which carries the query string and raw ids). */
function routeOf(request: { route?: { path?: unknown } } | undefined): string {
  const path = request?.route?.path;
  return typeof path === 'string' && path.length > 0 ? path : '<unmatched>';
}

/** The CLS `credentialClass` key the logger reads. */
export type CredentialClass = 'jwt' | 'apiKey' | 'serviceAccount' | 'anonymous';

export const API_KEY_REQUIRED_SCOPES = 'apiKeyRequiredScopes';

/**
 * Metadata key set by `@ForbidApiKey()` ( bucket (c)).
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
 * The header a service-account access token is presented in.
 *
 * A DEDICATED header, not `Authorization: Bearer`. The token is opaque and
 * server-validated; sharing the JWT header would make "is this a JWT or a
 * machine token?" a parsing heuristic on the hot auth path, and a heuristic
 * that guesses wrong is an authentication bypass. A distinct header makes the
 * branch selection unambiguous and keeps the third class mechanically separate
 * from the other two, which is what the ruling requires.
 */
export const SERVICE_ACCOUNT_TOKEN_HEADER = 'x-service-account-token';

/**
 * Metadata key set by `@RequiredSvcScopes(...)` — the service-account
 * equivalent of `API_KEY_REQUIRED_SCOPES`, and DELIBERATELY a separate key.
 *
 * Deny-by-default: a route that declares no `svc:*` scope is not a
 * service-account surface at all and refuses every machine token, exactly as
 * `enforceApiKeyScopes` does for API keys. Boot-audit G turns that runtime
 * refusal into an authoring error.
 */
export const SERVICE_ACCOUNT_REQUIRED_SCOPES = 'serviceAccountRequiredScopes';

/**
 * Metadata key set by `@ForbidServiceAccount()` — an unconditional deny for any
 * service-account-authenticated caller.
 *
 * SEPARATE from `API_KEY_FORBIDDEN` on purpose. `@ForbidApiKey()` is about
 * TENANT API KEYS; a service account is a distinct credential class and a route
 * must be able to exclude machines independently of keys (`AuthController`,
 * `ConsentGrantController`, `AdminImpersonationController`, and the
 * service-account controller itself all want exactly that). Reusing one
 * decorator for both would re-create the "one mechanism, two purposes"
 * conflation the owner ruled against — and a route that wants to block both
 * simply declares both.
 */
export const SERVICE_ACCOUNT_FORBIDDEN = 'serviceAccountForbidden';

/**
 * Metadata key for `@ResolveSubjectInstance(...)`
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
  ctx: SubjectResolverContext,
) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;

/**
 * The dependency access a `SubjectInstanceResolver` is handed as its SECOND
 * argument (b).
 *
 * Task 14 gave the resolver only the raw request, which meant it could build
 * an instance from `params`/`body` but could never LOAD A ROW — and every
 * identity-shaped condition in `casl-blast-radius.md` (`userId`,
 * `doctorId`, `targetUserId`, `createdBy`, `isSystemRole`) needs the row. So
 * shadow mode could not be wired to a single real route and
 * `casl_shadow_divergence_total` could never move. This is the narrowest
 * change that unblocks it.
 *
 * `get` resolves NON-STRICTLY (`{ strict: false }`): `UnifiedAuthGuard` is an
 * `APP_GUARD` in the root module while the services a resolver wants live in
 * feature modules, so a module-scoped lookup would never find them.
 *
 * TRADEOFF, stated plainly. This hands route-declared code an escape hatch
 * into the container on the authentication hot path, and a careless resolver
 * can now issue an unbounded query on every gated request. Three things bound
 * it: the decorator is opt-in per route (an undecorated route resolves
 * nothing and loads no row), the whole path is fail-open (a throwing `get` is
 * swallowed — see `runCaslInstanceChecks`), and a resolver is expected to
 * reuse a read the handler makes anyway.
 *
 * The alternative the ticket named — resolve the instance in a PRECEDING
 * INTERCEPTOR and stash it on the request — was rejected as structurally
 * impossible, not merely worse: NestJS runs every guard BEFORE any
 * interceptor. That ordering is the same fact that disqualifies
 * `UserVoiceProfile` from enforcement (DEF-C3), so an interceptor could only
 * ever populate a request the guard has already finished with. Injecting the
 * concrete services into the guard directly was rejected too: the guard lives
 * in `packages/applications` and would have to depend on every feature module
 * that ever wants a resolver.
 */
export interface SubjectResolverContext {
  /** Resolve a provider by injection token from anywhere in the container. */
  get<T = unknown>(token: unknown): T;
}

/**
 * Opt IN a route to CASL shadow-mode instance comparison
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
 *   return c ? { tenantId: c.tenantId, doctorId: c.doctorId }: undefined;
 * })
 * getOne() { ... }
 * ```
 */
export const ResolveSubjectInstance = (resolver: SubjectInstanceResolver, options: SubjectInstanceResolverOptions = {}) =>
  SetMetadata(SUBJECT_INSTANCE_RESOLVER_KEY, {
    resolver,
    ...(options.subject !== undefined ? { subject: options.subject } : {}),
    enforceGrade: options.enforceGrade === true,
  } satisfies SubjectInstanceResolverDescriptor);

/**
 * what a route DECLARES about its resolver, beyond the function.
 *
 * `subject` closes the disclosed limitation that one route-level
 * resolver was applied to EVERY required permission: an instance shaped for
 * subject X was evaluated against subject Y's conditions, where a spurious
 * `false` becomes a wrongful 403. When declared, the instance is only ever
 * compared against permissions for that subject.
 *
 * `enforceGrade` is an ATTESTATION, consumed by
 * `assertCaslEnforcePairReachability` at boot, not by this guard: it states
 * that the resolver returns an instance for rows the caller does NOT own —
 * i.e. it does not delegate to an access-asserting accessor. A resolver that
 * throws on the deny case fails open, which is precisely how
 * `ApiKey` pairs ended up listed-but-unreachable. The guard
 * deliberately does NOT require the flag to enforce: a mis-declaration must
 * fail the BOOT loudly, never silently disable an enforced pair at runtime.
 */
export interface SubjectInstanceResolverOptions {
  subject?: string;
  enforceGrade?: boolean;
}

/** The metadata shape `@ResolveSubjectInstance` stores. */
export interface SubjectInstanceResolverDescriptor {
  resolver: SubjectInstanceResolver;
  subject?: string;
  enforceGrade: boolean;
}

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
 * Client-facing denial for a service-account caller on a route that is not a
 * service-account surface. Deliberately identical for both denial reasons
 * (`@ForbidServiceAccount()` and "route declares no `@RequiredSvcScopes`"), for
 * the same non-probing reason `API_KEY_ROUTE_DENIED_MESSAGE` documents.
 */
const SERVICE_ACCOUNT_ROUTE_DENIED_MESSAGE = 'This route does not accept service-account authentication';

/**
 * The minimal surface of `ServiceAccountService` this guard depends on.
 * Structural, so `@arcaai/applications`' authorization layer does not take a
 * hard dependency on the service module (mirroring how `IApiKeyService` is
 * injected by token).
 */
export interface IServiceAccountAuthenticator {
  authenticateByToken(token: string): Promise<ServiceAccountPrincipalLike | null>;
  hasScope(principal: ServiceAccountPrincipalLike, requiredScope: string): boolean;
}

export interface ServiceAccountPrincipalLike {
  id: string;
  clientId: string;
  tenantId: string;
  workingTenantId: string;
  scopes: string[];
  roles: string[];
  allowedTenantIds?: string[] | null;
}

export const SERVICE_ACCOUNT_AUTHENTICATOR = Symbol('SERVICE_ACCOUNT_AUTHENTICATOR');

/**
 * The CASL verdict for a set of `@Authorize()`-declared permissions.
 *
 * Extracted so the JWT path (`handleJwtPostAuth`) and the API-key path
 * (`enforceApiKeyAbilities`) compute the SAME verdict from the SAME metadata —
 * the two must never drift, or `@Authorize(...)` would mean something different
 * depending on how the caller authenticated, which is precisely the defect
 * closed.
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
 * ─── Authorization model on the API-key path ───────────────────
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
    // the THIRD credential class. `@Optional` so every existing test
    // double and any context that does not wire the service-account module
    // keeps constructing; without it the branch is simply never taken and a
    // presented machine token falls through to the ordinary 401.
    @Optional()
    @Inject(SERVICE_ACCOUNT_AUTHENTICATOR)
    private readonly serviceAccounts?: IServiceAccountAuthenticator,
    // b — the container handle a `@ResolveSubjectInstance`
    // resolver needs to load the row its `conditions` compare against.
    // `@Optional` so every existing test double keeps constructing; without
    // it `SubjectResolverContext.get` throws and the fail-open path in
    // `runCaslInstanceChecks` turns that into "no instance, no check".
    @Optional() private readonly moduleRef?: ModuleRef,
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
      this.publishIdentity('anonymous');
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const method = request?.method;
    const path = routeOf(request);
    const ipAddress = this.getClientIp(request);

    const rawApiKey = this.apiKeyService.extractApiKeyFromRequest(request);
    const serviceAccountToken = this.extractServiceAccountToken(request);

    // AMBIGUOUS CREDENTIALS ARE REJECTED, never silently resolved to one of
    // them ( test 28). Whichever branch we picked would be a
    // guess about caller intent, and a guess here decides an authorization
    // outcome: a caller could present a broad API key alongside a narrow
    // machine token (or vice versa) and receive whichever grant the guard
    // happened to prefer. Checked BEFORE either branch runs, so neither
    // credential is even validated.
    if (rawApiKey && serviceAccountToken) {
      throw withFailureLog(new UnauthorizedException('Present exactly one credential: an API key or a service-account token, not both'), {
        reason: 'multiple_credential_classes_presented',
        clientIp: ipAddress,
      });
    }

    // Ordered AFTER @Public() and BEFORE the API-key branch.
    if (serviceAccountToken) {
      try {
        return await this.handleServiceAccountAuth(context, request, serviceAccountToken, ipAddress, method, path);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw withFailureLog(new UnauthorizedException('Invalid service-account token'), {
          reason: 'service_account_auth_error',
          clientIp: ipAddress,
          error,
        });
      }
    }

    if (rawApiKey) {
      try {
        return await this.handleApiKeyAuth(context, request, rawApiKey, ipAddress, method, path);
      } catch (error) {
        if (error instanceof HttpException) throw error;
        throw withFailureLog(new UnauthorizedException('Invalid API key'), {
          reason: 'api_key_auth_error',
          clientIp: ipAddress,
          error,
        });
      }
    }

    // H-01 — there is deliberately NO query-parameter credential path here.
    // This block used to rewrite `?token=<value>` into an
    // `Authorization: Bearer <value>` header. Its comment said "SSE", but it
    // was gated on nothing — not `SSE_METADATA`, not `@StreamScope`, not the
    // path — so a long-lived session JWT appended to ANY of the gateway's
    // routes authenticated. Query strings land in CDN access logs, browser
    // history, `Referer` headers and session-replay recordings, so one leaked
    // log line handed over a session-lifetime credential for the whole API.
    // That is exactly what the single-use stream-ticket subsystem
    // (`apps/api/src/modules/auth/stream-ticket.service.ts`) exists to prevent.
    // The supported browser-`EventSource` path is `?ticket=<single-use ticket>`,
    // scope-checked in `apps/api/src/guards/jwtauth.guard.ts`; both SDK stream
    // clients already mint tickets and no consumer sends `?token=`.
    // Do not reintroduce a query-parameter credential path.

    // Why the JWT path failed, if it did — carried onto the 401 below.
    let jwtFailure: Record<string, unknown> | undefined;
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
        // The underlying failure rides the generic 401 below onto the single
        // failure line (it was once silently swallowed). An expected auth
        // failure (bad/expired token, already-consumed stream ticket) stays
        // `debug` — it is the most common line this gateway would otherwise
        // write; anything else keeps its Error and the default level.
        const jwtReason = error instanceof Error ? error.message : String(error);
        jwtFailure =
          error instanceof UnauthorizedException
            ? { level: 'debug', reason: 'jwt_rejected', jwtReason }
            : { reason: 'jwt_auth_error', jwtReason, error };
      }
    }

    throw withFailureLog(new UnauthorizedException('Authentication required. Provide a valid JWT (Authorization: Bearer) or API key (X-API-Key).'), {
      ...(jwtFailure ?? { reason: 'no_valid_credentials' }),
      clientIp: ipAddress,
    });
  }

  // ─── Service-Account Auth Path ──────────────────────────
  //
  // The THIRD credential class. It shares NO mechanism with the two below:
  // its own header, its own scope namespace (`svc:*`), its own exclusion
  // decorator, and — critically — its own CASL principal. The API-key path
  // evaluates abilities against the key's BOUND HUMAN; this path evaluates
  // them against the ACCOUNT ITSELF, so a machine's authority is
  // independently grantable and revocable.

  /**
   * Publish the authenticated identity on the CLS keys the logger reads:
   * `credentialClass` always, `userId` when a human is behind the credential
   * (a JWT user, or the user an API key is bound to — never a service account).
   * Best-effort: a context with no CLS (a WS upgrade) simply publishes nothing.
   */
  private publishIdentity(credentialClass: CredentialClass, userId?: string | null): void {
    try {
      const cls = this.cls as unknown as { set: (key: string, value: unknown) => void };
      cls.set('credentialClass', credentialClass);
      if (userId) cls.set('userId', userId);
    } catch {
      // No active CLS context.
    }
  }

  private extractServiceAccountToken(request: { headers?: Record<string, unknown> } | undefined): string | null {
    const raw = request?.headers?.[SERVICE_ACCOUNT_TOKEN_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async handleServiceAccountAuth(
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same request shape as handleApiKeyAuth.
    request: any,
    token: string,
    ipAddress: string,
    method: string,
    path: string,
  ): Promise<boolean> {
    if (!this.serviceAccounts) {
      // Nothing can validate the token, so nothing may be trusted. Fail closed.
      throw withFailureLog(new UnauthorizedException('Service-account authentication is not available'), {
        reason: 'service_account_auth_unavailable',
      });
    }

    // `@ForbidServiceAccount()` is checked BEFORE the token is even resolved:
    // a forbidden route has no scope and no principal that could rescue it.
    const forbidden = this.reflector.getAllAndOverride<boolean>(SERVICE_ACCOUNT_FORBIDDEN, [context.getHandler(), context.getClass()]);
    if (forbidden === true) {
      throw withFailureLog(new ForbiddenException(SERVICE_ACCOUNT_ROUTE_DENIED_MESSAGE), { reason: 'forbid_service_account' });
    }

    const principal = await this.serviceAccounts.authenticateByToken(token);
    if (!principal) {
      throw withFailureLog(new UnauthorizedException('Invalid or expired service-account token'), {
        reason: 'unknown_or_expired_token',
        clientIp: ipAddress,
      });
    }

    this.publishIdentity('serviceAccount');

    this.enforceServiceAccountScopes(context, principal);

    // The principal goes on its OWN CLS key. Never on `user`: every
    // `requestUser?.id` read in the codebase — including
    // `BaseService.broadcastSysEvent` — would otherwise record this machine's
    // actions against a person, which is 's defect made worse.
    this.cls.set('serviceAccount', principal);
    // The WORKING tenant, not the account's home tenant: a platform account
    // acts on the tenant it presented (validated against its allow-list at
    // exchange time), and a tenant-bound account's working tenant IS its own.
    if (principal.workingTenantId && !this.cls.get('tenantId')) {
      this.cls.set('tenantId', principal.workingTenantId);
    }
    request['serviceAccount'] = principal;

    await this.enforceServiceAccountAbilities(context, principal);

    this.logger.debug({
      message: 'Service account authenticated',
      serviceAccountId: principal.id,
      clientId: principal.clientId,
      tenantId: principal.workingTenantId,
      method,
      route: path,
    });

    return true;
  }

  /**
   * DENY BY DEFAULT, exactly as `enforceApiKeyScopes` does for API keys: a
   * route is reachable by a machine token only if it EXPLICITLY declares
   * `@RequiredSvcScopes(...)`. No declaration means "not a service-account
   * surface", and the request is refused rather than falling through to CASL.
   */
  private enforceServiceAccountScopes(context: ExecutionContext, principal: ServiceAccountPrincipalLike): void {
    const required = this.reflector.getAllAndOverride<string[]>(SERVICE_ACCOUNT_REQUIRED_SCOPES, [context.getHandler(), context.getClass()]);

    if (!required || required.length === 0) {
      throw withFailureLog(new ForbiddenException(SERVICE_ACCOUNT_ROUTE_DENIED_MESSAGE), {
        reason: 'no_svc_scopes_declared',
        serviceAccountId: principal.id,
      });
    }

    if (!required.some((scope) => this.serviceAccounts!.hasScope(principal, scope))) {
      throw withFailureLog(new ForbiddenException(`Service account does not have required scope(s): ${required.join(', ')}`), {
        reason: 'svc_scope_insufficient',
        serviceAccountId: principal.id,
        requiredScopes: required,
        heldScopes: principal.scopes,
      });
    }
  }

  /**
   * The SECOND half of the conjunction. Scopes bound the CREDENTIAL; abilities
   * bound the PRINCIPAL — and here the principal is the account, so its ability
   * is built from the `svc:*` scopes it was issued with rather than loaded for
   * a human. A held scope NEVER substitutes for a missing ability and vice
   * versa, in both directions.
   */
  private async enforceServiceAccountAbilities(context: ExecutionContext, principal: ServiceAccountPrincipalLike): Promise<void> {
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) {
      return;
    }

    const mode = this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [context.getHandler(), context.getClass()]) || 'AND';

    let ability: AppAbility;
    try {
      ability = this.policyEngine.buildAbilityFromRules(serviceAccountPolicyRules(principal.scopes));
    } catch (error) {
      // An infrastructure failure answered as 403: logged at `error`, with the Error.
      throw withFailureLog(new ForbiddenException('Authorization failed'), {
        level: 'error',
        reason: 'service_account_ability_build_failed',
        serviceAccountId: principal.id,
        error,
      });
    }

    const verdict = evaluatePermissions(ability, required, mode);
    if (!verdict.allowed) {
      throw withFailureLog(new ForbiddenException(verdict.message), {
        reason: 'service_account_lacks_permission',
        serviceAccountId: principal.id,
        mode,
        deniedPermissions: verdict.missing,
      });
    }
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
    this.publishIdentity('apiKey', apiKeyEntity.userId);

    this.enforceApiKeyNotForbidden(context);

    if (apiKeyEntity.rateLimit && apiKeyEntity.rateLimit > 0 && this.rateLimiter) {
      const result = await this.rateLimiter.checkRateLimit(apiKeyEntity.id, apiKeyEntity.tenantId, apiKeyEntity.rateLimit);
      if (!result.allowed) {
        throw withFailureLog(
          new HttpException(
            {
              statusCode: 429,
              message: 'Rate limit exceeded',
              remaining: result.remaining,
              resetAt: result.resetAt,
            },
            429,
          ),
          {
            limiter: 'apiKey',
            apiKeyId: apiKeyEntity.id,
            limit: result.limit,
            retryAfter: Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000)),
          },
        );
      }
    }

    this.enforceApiKeyScopes(context, apiKeyEntity);

    request['apiKey'] = apiKeyEntity;
    // TASK-1038 OD-35 — the KEY, on its own CLS key: a run started with it is bound to the key,
    // not to the human below (`RunPrincipalAccessService`). `user` stays `{ id, tenantId }`.
    this.cls.set('apiKey', { id: apiKeyEntity.id, scopes: Array.isArray(apiKeyEntity.scopes) ? [...(apiKeyEntity.scopes as string[])] : [] });
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

    await this.enforceApiKeyAbilities(context, request, apiKeyEntity);

    this.logger.debug({
      message: 'API key authenticated',
      keyId: apiKeyEntity.id,
      keyName: apiKeyEntity.keyName,
      tenantId: apiKeyEntity.tenantId,
      method,
      route: path,
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
      throw withFailureLog(new ForbiddenException(API_KEY_ROUTE_DENIED_MESSAGE), { reason: 'forbid_api_key' });
    }
  }

  /**
   * DENY BY DEFAULT.
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
      throw withFailureLog(new ForbiddenException(API_KEY_ROUTE_DENIED_MESSAGE), {
        reason: 'no_scopes_declared',
        apiKeyId: apiKeyEntity?.id,
        tenantId: apiKeyEntity?.tenantId,
      });
    }

    const hasRequiredScope = requiredScopes.some((scope) => this.apiKeyService.hasScope(apiKeyEntity, scope));

    if (!hasRequiredScope) {
      throw withFailureLog(new ForbiddenException(`API key does not have required scope(s): ${requiredScopes.join(', ')}`), {
        reason: 'api_key_scope_insufficient',
        apiKeyId: apiKeyEntity.id,
        tenantId: apiKeyEntity.tenantId,
        requiredScopes,
        keyScopes: apiKeyEntity.scopes,
      });
    }
  }

  /**
   * The SECOND half of the API-key authorization conjunction: the
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
  ): Promise<void> {
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if (!required || required.length === 0) {
      return;
    }

    if (!apiKeyEntity?.userId) {
      throw withFailureLog(
        new ForbiddenException('This API key is not linked to a user, so the permissions this route requires cannot be evaluated'),
        {
          reason: 'key_not_linked_to_user',
          apiKeyId: apiKeyEntity?.id,
        },
      );
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
      // An infrastructure failure answered as 403: logged at `error`, with the Error.
      throw withFailureLog(new ForbiddenException('Authorization failed'), {
        level: 'error',
        reason: 'ability_build_failed',
        apiKeyId: apiKeyEntity.id,
        error,
      });
    }

    const verdict = evaluatePermissions(ability, required, mode);
    if (!verdict.allowed) {
      throw withFailureLog(new ForbiddenException(verdict.message), {
        reason: 'api_key_principal_lacks_permission',
        apiKeyId: apiKeyEntity.id,
        mode,
        deniedPermissions: verdict.missing,
      });
    }
  }

  // ─── JWT Auth Path ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same ApiKeyEntity structural-consumption convention as enforceApiKeyScopes above.
  private async handleJwtPostAuth(context: ExecutionContext, request: any, method: string, path: string): Promise<boolean> {
    const user = request.user || this.cls.get('user');

    if (user) {
      this.publishIdentity('jwt', user.id);
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
      throw withFailureLog(new ForbiddenException('Authentication required'), { reason: 'no_user_on_request' });
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
      // An infrastructure failure answered as 403: logged at `error`, with the Error.
      throw withFailureLog(new ForbiddenException('Authorization failed'), {
        level: 'error',
        reason: 'ability_build_failed',
        error,
      });
    }

    request.ability = ability;
    this.cls.set('userAbility', ability);

    // Tasks 14+15 — CASL instance evaluation. For any
    // permission whose route opted in via `@ResolveSubjectInstance(...)`,
    // computes the instance-aware verdict its seeded `conditions` produce.
    // Pairs NOT in `CASL_ENFORCED_PAIRS` stay shadow (recorded, not applied);
    // pairs IN it come back here as denials to apply AFTER the type-only
    // verdict, so enforcement can only ever NARROW.
    const enforcedDenials = await this.runCaslInstanceChecks(context, request, ability, required, mode, method, path);

    const verdict = evaluatePermissions(ability, required, mode);

    if (verdict.allowed && enforcedDenials.length > 0) {
      const denied = enforcedDenials.map((d) => `${d.action}:${d.subject}`).join(', ');
      for (const d of enforcedDenials) {
        this.policyEngine.recordEnforceDenial(d.action, d.subject, { method, route: path });
      }
      // A PRIVILEGE denial (403) — the caller may act on this resource TYPE
      // but not on THIS row. Cross-tenant reads stay 404 via
      // `@TenantOwnedResource`; this is a different boundary.
      throw withFailureLog(new ForbiddenException(`Missing permissions: ${denied}`), {
        reason: 'casl_conditions_denied',
        route: path,
        deniedPermissions: denied,
      });
    }

    if (!verdict.allowed) {
      throw withFailureLog(new ForbiddenException(verdict.message), {
        reason: 'missing_permissions',
        route: path,
        mode,
        deniedPermissions: verdict.missing,
      });
    }

    return true;
  }

  /**
   * CASL shadow mode.
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
   * This method NEVER throws. For a SHADOW pair it exists purely to populate
   * `casl_shadow_divergence_total` / `casl.shadow.divergence`.
   *
   * ENFORCE. For a pair in `CASL_ENFORCED_PAIRS`
   * (`PolicyEngine.isEnforcedPair`) a `false` instance verdict is RETURNED to
   * the caller as a denial rather than merely recorded. The caller applies it
   * only after the type-only verdict already allowed, so enforcement can only
   * narrow — an instance verdict that would ALLOW never rescues a type-only
   * deny. All three fail-open paths above hold unchanged for enforced pairs
   * too: no resolver, no instance, or a throwing resolver yields NO denial.
   * A broken resolver is a diagnostics bug; it must never become an outage.
   */
  /**
   * The `SubjectResolverContext` handed to every resolver. Built once; throws
   * from `get` when no `ModuleRef` was wired, which `runCaslInstanceChecks`
   * swallows into the ordinary "no instance" path.
   */
  private readonly subjectResolverContext: SubjectResolverContext = {
    get: <T = unknown>(token: unknown): T => {
      if (!this.moduleRef) {
        throw new Error('SubjectInstanceResolver requested a provider, but UnifiedAuthGuard has no ModuleRef wired');
      }
      return this.moduleRef.get(token as never, { strict: false }) as T;
    },
  };

  private async runCaslInstanceChecks(
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same request shape as handleJwtPostAuth's own `request: any` param this method is called from.
    request: any,
    ability: AppAbility,
    required: RequiredPermission[],
    mode: PermissionMode,
    method: string,
    path: string,
  ): Promise<Array<{ action: string; subject: string }>> {
    const enforcedDenials: Array<{ action: string; subject: string }> = [];

    for (const permission of required) {
      try {
        const declared = this.reflector.getAllAndOverride<SubjectInstanceResolverDescriptor | SubjectInstanceResolver | undefined>(
          SUBJECT_INSTANCE_RESOLVER_KEY,
          [context.getHandler(), context.getClass()],
        );
        if (!declared) continue; // opt-in only — no resolver, no shadow check, no row loaded

        // A bare function is the earlier metadata shape; still accepted so
        // an un-migrated route keeps its (shadow) behaviour exactly.
        const descriptor: SubjectInstanceResolverDescriptor = typeof declared === 'function' ? { resolver: declared, enforceGrade: false } : declared;

        // a resolver that declares WHICH subject it resolves is
        // applied to that subject only. Without this, one route-level resolver
        // was compared against every required permission, so an instance
        // shaped for subject X was evaluated against subject Y's conditions
        // and a spurious `false` became a wrongful 403.
        if (descriptor.subject !== undefined && descriptor.subject !== permission.subject) continue;

        const instance = await descriptor.resolver(request, this.subjectResolverContext);
        if (!instance) continue; // resolver explicitly had nothing to compare against

        const verdict = this.policyEngine.evaluateShadowVerdict(ability, permission.action, permission.subject, instance);

        if (this.policyEngine.isEnforcedPair(permission.action, permission.subject)) {
          // never enforce on an OR-mode route. The denial is
          // applied AFTER the type-only verdict, so on `@CanAny` a denial from
          // one alternative would override an allow earned by another and
          // silently rewrite the route's declared OR into an AND. Shadow
          // recording continues below; `auditCaslEnforcePairReachability`
          // makes this combination unshippable in the first place.
          if (mode === 'OR') {
            this.logger.debug({
              message: 'casl.enforce.skipped_or_mode',
              action: permission.action,
              subject: permission.subject,
              method,
              route: path,
            });
            if (verdict.diverged) {
              this.policyEngine.recordShadowDivergence(permission.action, permission.subject, verdict, { method, route: path });
            }
            continue;
          }
          // ENFORCE: the instance verdict decides. Only a DENY is actionable
          // (an instance-allow cannot widen a type-only deny).
          if (!verdict.instanceVerdict) {
            // Recorded by the CALLER, and only once the type-only verdict has
            // already allowed — so the counter means "denied BECAUSE of
            // enforce", not "would also have been denied anyway".
            enforcedDenials.push({ action: permission.action, subject: permission.subject });
          }
          continue;
        }

        if (verdict.diverged) {
          this.policyEngine.recordShadowDivergence(permission.action, permission.subject, verdict, { method, route: path });
        }
      } catch (error) {
        // Shadow-mode failures are diagnostics-only and must never affect
        // the actual (type-only) authorization outcome computed after this.
        this.logger.debug({
          message: 'casl.shadow.resolver_error',
          action: permission.action,
          subject: permission.subject,
          method,
          route: path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return enforcedDenials;
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * The address this authentication attempt is attributed to.
   *
   * It reaches `ApiKeyService.authenticateByRawKey` / the service-account
   * validator and from there the AUDIT trail, so on a PHI platform it has to
   * name the caller. It read `X-Forwarded-For` until TASK-993 lane J, which is
   * wrong twice over on this ingress: the header's last hop is the cloudflared
   * pod (`Cloudflare edge → cloudflared → Traefik → pod`), so every audited
   * action named a piece of infrastructure — and the header is caller-supplied,
   * so a direct caller could choose the address recorded against its own
   * credential use.
   *
   * One shared rule now decides it, the same one the rate limiter's bucket key
   * uses (`common/client-ip.ts`): `CF-Connecting-IP` is believed only when the
   * SOCKET PEER is a declared ingress (`RATE_LIMIT_TRUSTED_PROXIES`), otherwise
   * the socket peer itself.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getClientIp(request: any): string {
    return resolveAttributedClientIp(request) ?? 'unknown';
  }
}
