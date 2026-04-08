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
 * Injectable token for the JWT auth guard.
 * The API layer provides an implementation (e.g., JwtAuthGuard extending Passport's AuthGuard('jwt')).
 */
export const JWT_AUTH_GUARD = Symbol('JWT_AUTH_GUARD');

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
          return this.handleJwtPostAuth(context, request, method, path);
        }
      } catch {
        // JWT failed — fall through to 401
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
