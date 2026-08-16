import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
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
 * UnifiedAuthGuard — single guard replacing JwtAuthGuard + ApiKeyGuard + EitherAuthGuard + AuthorizationGuard.
 *
 * Processing order:
 * 1. Skip if @Public() metadata is set
 * 2. Try API key (headers: apikey, api-key, x-api-key):
 *    - Validate key: status, expiration, IP allowlist
 *    - Check rate limit
 *    - Check required scopes
 *    - Set CLS context
 * 3. Try JWT (Authorization: Bearer):
 *    - Validate via Passport strategy
 *    - Check CASL permissions
 * 4. Both failed → 401
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
      throw new ForbiddenException('This route does not accept API-key authentication');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private enforceApiKeyScopes(context: ExecutionContext, apiKeyEntity: any): void {
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(API_KEY_REQUIRED_SCOPES, [context.getHandler(), context.getClass()]);

    if (!requiredScopes || requiredScopes.length === 0) {
      return;
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

  // ─── JWT Auth Path ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    const results = required.map((permission) => ({
      permission,
      allowed: ability.can(permission.action, permission.subject),
    }));

    const allowed = mode === 'AND' ? results.every((r) => r.allowed) : results.some((r) => r.allowed);

    if (!allowed) {
      const denied = results.filter((r) => !r.allowed);
      const missing =
        mode === 'AND' ? denied.map((d) => `${d.permission.action}:${d.permission.subject}`) : required.map((p) => `${p.action}:${p.subject}`);
      const message = mode === 'AND' ? `Missing permissions: ${missing.join(', ')}` : `Requires at least one of: ${missing.join(', ')}`;

      this.logger.warn({
        message: 'Access denied',
        userId: user.id,
        method,
        path,
        mode,
        deniedPermissions: missing,
      });
      throw new ForbiddenException(message);
    }

    return true;
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
