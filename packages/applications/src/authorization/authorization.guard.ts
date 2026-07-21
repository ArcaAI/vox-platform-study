import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import { PolicyEngine, AppAbility } from './policy.engine';
import { IActiveUserContext } from '../interfaces';

/**
 * Metadata key for required permissions
 */
export const REQUIRED_PERMISSIONS_KEY = 'required_permissions';

/**
 * Metadata key for skipping authorization
 */
export const SKIP_AUTH_KEY = 'skip_auth';

/**
 * Metadata key for permission mode (AND or OR)
 */
export const PERMISSION_MODE_KEY = 'permission_mode';

/**
 * Permission mode - determines how multiple permissions are evaluated
 * - AND: All permissions must be satisfied (default)
 * - OR: At least one permission must be satisfied
 */
export type PermissionMode = 'AND' | 'OR';

/**
 * Required permission structure
 */
export interface RequiredPermission {
  action: string;
  subject: string;
}

/**
 * Authorization result for a single permission check
 */
interface PermissionCheckResult {
  permission: RequiredPermission;
  allowed: boolean;
}

/**
 * AuthorizationGuard - Enforces policy-based access control
 *
 * This guard:
 * 1. Checks if route is public (skip auth)
 * 2. Extracts required permissions from decorator metadata
 * 3. Builds user's CASL ability via PolicyEngine
 * 4. Verifies user has required permissions based on mode (AND/OR)
 * 5. Stores ability in context for service layer use
 *
 * @example
 * ```typescript
 * @Controller('users')
 * export class UsersController {
 *   // Requires read permission on User (AND is default)
 *   @Get()
 *   @Authorize(['read', 'User'])
 *   findAll() { ... }
 *
 *   // Requires BOTH read:User AND read:Tenant
 *   @Get(':id/details')
 *   @Authorize(['read', 'User'], ['read', 'Tenant'])
 *   getDetails() { ... }
 *
 *   // Requires EITHER manage:User OR read:AuditLog
 *   @Get(':id/sensitive')
 *   @AuthorizeAny(['manage', 'User'], ['read', 'AuditLog'])
 *   getSensitive() { ... }
 * }
 * ```
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(AuthorizationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly policyEngine: PolicyEngine,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if auth is skipped (public routes)
    const skipAuth = this.reflector.getAllAndOverride<boolean>(SKIP_AUTH_KEY, [context.getHandler(), context.getClass()]);

    if (skipAuth) {
      return true;
    }

    // Get required permissions from decorator
    const required = this.reflector.getAllAndOverride<RequiredPermission[]>(REQUIRED_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    // Deny by default on admin/* routes when no explicit permissions are
    // declared — an empty required-permissions list must never auto-allow
    // any authenticated user.
    if (!required || required.length === 0) {
      const httpRequest = context.switchToHttp().getRequest();
      const path: string | undefined = httpRequest?.url;
      const isAdminRoute = typeof path === 'string' && /^\/(api\/v\d+\/)?admin\//.test(path);

      if (isAdminRoute) {
        this.logger.warn({
          message: 'Phase 0 Item 3: refused admin route with no @CanManage / @Authorize decorator',
          path,
        });
        throw new ForbiddenException('Admin routes require an explicit permission decorator.');
      }
      return true;
    }

    // Get permission mode (AND or OR)
    const mode = this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [context.getHandler(), context.getClass()]) || 'AND';

    // Get user from context
    const user = this.cls.get('user');
    const request = context.switchToHttp().getRequest();
    const method = request?.method;
    const path = request?.url;

    if (!user) {
      this.logger.warn({
        message: 'Authorization failed',
        reason: 'no_user_in_context',
        method,
        path,
      });
      throw new ForbiddenException('Authentication required');
    }

    // Build ability using PolicyEngine
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
        tenantId: user.tenantId,
        method,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ForbiddenException('Authorization failed');
    }

    // Store ability in request and CLS context for later use
    request.ability = ability;
    this.cls.set('userAbility', ability);

    // Check all permissions and collect results
    const results: PermissionCheckResult[] = required.map((permission) => ({
      permission,
      allowed: ability.can(permission.action, permission.subject),
    }));

    // Evaluate based on mode
    const allowed = mode === 'AND' ? results.every((r) => r.allowed) : results.some((r) => r.allowed);

    if (!allowed) {
      const denied = results.filter((r) => !r.allowed);
      const message = this.buildDeniedMessage(mode, required, denied);

      this.logger.warn({
        message: 'Access denied',
        userId: user.id,
        tenantId: user.tenantId,
        method,
        path,
        mode,
        requiredPermissions: required.map((p) => `${p.action}:${p.subject}`),
        deniedPermissions: denied.map((d) => `${d.permission.action}:${d.permission.subject}`),
      });
      throw new ForbiddenException(message);
    }

    this.logger.debug({
      message: 'Access granted',
      userId: user.id,
      tenantId: user.tenantId,
      method,
      path,
      mode,
      permissions: required.map((p) => `${p.action}:${p.subject}`),
    });

    return true;
  }

  /**
   * Build a user-friendly error message for denied access
   */
  private buildDeniedMessage(mode: PermissionMode, required: RequiredPermission[], denied: PermissionCheckResult[]): string {
    if (mode === 'AND') {
      // For AND mode, show which specific permissions are missing
      const missing = denied.map((d) => `${d.permission.action}:${d.permission.subject}`);
      return `Missing permissions: ${missing.join(', ')}`;
    } else {
      // For OR mode, show all required permissions (user needs at least one)
      const all = required.map((p) => `${p.action}:${p.subject}`);
      return `Requires at least one of: ${all.join(', ')}`;
    }
  }
}
