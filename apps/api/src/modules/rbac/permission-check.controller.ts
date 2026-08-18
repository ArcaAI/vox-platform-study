import { Controller, Post, Body, Logger, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PolicyEngine } from '@arcaai/applications';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '@arcaai/applications';
import { Authorize, RequiredScopes } from '../../decorators';
import { CheckPermissionDto, CheckPermissionsBulkDto, CheckPermissionResponse, CheckPermissionsBulkResponse, MyPermissionsResponse } from './dto';

/**
 * The caller's OWN effective permission set.
 *
 * TASK-760 — `rbac/check` was a verb wearing a resource's clothes: an RPC
 * prefix under an internal subsystem name. It is now two resource
 * collections. This one is the self collection; the by-id collection
 * (`users/:id/permission-checks`) is `UserPermissionCheckController` below.
 *
 * ORDER IS LOAD-BEARING: this LITERAL-segment controller MUST be registered
 * before `UserPermissionCheckController`, whose `:id` parameter would
 * otherwise swallow the literal `me`. Pinned by
 * `apps/api/src/modules/user/controllers/__tests__/users-me-route-precedence.test.ts`.
 */
@ApiTags('RBAC - Permission Check')
@ApiBearerAuth()
@Controller('users/me/permission-checks')
// API-KEY-NOTE: policy A1. Permission introspection for the key's BOUND
// USER — reuses `user:profile:read` because that is exactly the subject being
// introspected. Checking ANOTHER user still requires `manage:User`, which
// `enforceApiKeyAbilities` evaluates against the bound user, not the key.
@RequiredScopes('user:profile:read')
export class PermissionCheckController {
  constructor(
    private readonly policyEngine: PolicyEngine,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  /**
   * Get current user's effective permissions
   */
  @Post()
  @Authorize()
  @ApiOperation({ summary: "Get current user's effective permissions" })
  @ApiResponse({ status: 200, description: "User's effective permissions", type: MyPermissionsResponse })
  async getMyPermissions(): Promise<MyPermissionsResponse> {
    const currentUser = this.cls.get('user');

    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    // Build ability
    const ability = await this.policyEngine.buildAbility({
      userId: currentUser.id,
      tenantId: currentUser.tenantId,
    });

    // Extract rules from ability
    const permissions = ability.rules.map((rule) => ({
      // Handle both string and string[] action types
      action: Array.isArray(rule.action) ? rule.action.join(',') : rule.action,
      subject: rule.subject as string,
      conditions: rule.conditions,
    }));

    return {
      userId: currentUser.id,
      tenantId: currentUser.tenantId,
      permissions,
    };
  }
}

/**
 * Permission checks against a NAMED user.
 *
 * TASK-760 — the by-id half of the retired `rbac/check` RPC. The privilege
 * rule is UNCHANGED: checking anyone other than yourself still requires
 * `manage:User`, evaluated against the caller (and, under an API key, against
 * the key's bound user). Behaviour is byte-identical to the retired routes —
 * the body's optional `userId` still wins when present, which is what lets the
 * 308 shim redirect an old `POST /rbac/check` (whose target user lived in the
 * body, not the path) to `users/<caller>/permission-checks` without changing
 * which user gets checked.
 */
@ApiTags('RBAC - Permission Check')
@ApiBearerAuth()
@Controller('users/:id/permission-checks')
// API-KEY-NOTE: policy A1. Permission introspection for the key's BOUND
// USER — reuses `user:profile:read` because that is exactly the subject being
// introspected. Checking ANOTHER user still requires `manage:User`, which
// `enforceApiKeyAbilities` evaluates against the bound user, not the key.
@RequiredScopes('user:profile:read')
export class UserPermissionCheckController {
  private readonly logger = new Logger(UserPermissionCheckController.name);

  constructor(
    private readonly policyEngine: PolicyEngine,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  /**
   * Check a single permission
   */
  @Post()
  @Authorize()
  @ApiParam({ name: 'id', description: 'Target user id, or `me` for the caller.', type: String })
  @ApiOperation({ summary: 'Check if a user has a specific permission' })
  @ApiResponse({ status: 200, description: 'Permission check result', type: CheckPermissionResponse })
  async checkPermission(@Param('id') id: string, @Body() dto: CheckPermissionDto): Promise<CheckPermissionResponse> {
    const currentUser = this.cls.get('user');

    // Determine which user to check
    // Only admins can check permissions for other users
    let targetUserId = id === 'me' ? currentUser?.id : id;
    const targetTenantId = dto.tenantId || currentUser?.tenantId;

    if (dto.userId && dto.userId !== currentUser?.id) {
      // Check if current user can check others' permissions
      const adminAbility = await this.policyEngine.buildAbility({
        userId: currentUser?.id || '',
        tenantId: currentUser?.tenantId,
      });

      if (!adminAbility.can('manage', 'User')) {
        throw new Error('You can only check your own permissions');
      }

      targetUserId = dto.userId;
    }

    // Build ability for target user
    const ability = await this.policyEngine.buildAbility({
      userId: targetUserId || '',
      tenantId: targetTenantId,
    });

    // Check permission
    let allowed: boolean;
    if (dto.resource) {
      allowed = this.policyEngine.can(ability, dto.action, dto.subject, dto.resource);
    } else {
      allowed = ability.can(dto.action, dto.subject);
    }

    this.logger.debug({
      message: 'Permission check',
      userId: targetUserId,
      action: dto.action,
      subject: dto.subject,
      hasResource: !!dto.resource,
      allowed,
    });

    return {
      allowed,
      action: dto.action,
      subject: dto.subject,
      userId: targetUserId,
      tenantId: targetTenantId,
    };
  }

  /**
   * Check multiple permissions at once
   */
  @Post('bulk')
  @Authorize()
  @ApiParam({ name: 'id', description: 'Target user id, or `me` for the caller.', type: String })
  @ApiOperation({ summary: 'Check multiple permissions at once' })
  @ApiResponse({ status: 200, description: 'Bulk permission check results', type: CheckPermissionsBulkResponse })
  async checkPermissionsBulk(@Param('id') id: string, @Body() dto: CheckPermissionsBulkDto): Promise<CheckPermissionsBulkResponse> {
    const currentUser = this.cls.get('user');

    // Determine which user to check
    let targetUserId = id === 'me' ? currentUser?.id : id;
    const targetTenantId = dto.tenantId || currentUser?.tenantId;

    if (dto.userId && dto.userId !== currentUser?.id) {
      // Check if current user can check others' permissions
      const adminAbility = await this.policyEngine.buildAbility({
        userId: currentUser?.id || '',
        tenantId: currentUser?.tenantId,
      });

      if (!adminAbility.can('manage', 'User')) {
        throw new Error('You can only check your own permissions');
      }

      targetUserId = dto.userId;
    }

    // Build ability for target user
    const ability = await this.policyEngine.buildAbility({
      userId: targetUserId || '',
      tenantId: targetTenantId,
    });

    // Check all permissions
    const results = dto.permissions.map((permission) => {
      let allowed: boolean;
      if (permission.resource) {
        allowed = this.policyEngine.can(ability, permission.action, permission.subject, permission.resource);
      } else {
        allowed = ability.can(permission.action, permission.subject);
      }

      return {
        action: permission.action,
        subject: permission.subject,
        allowed,
      };
    });

    const allAllowed = results.every((r) => r.allowed);
    const anyAllowed = results.some((r) => r.allowed);

    this.logger.debug({
      message: 'Bulk permission check',
      userId: targetUserId,
      totalChecks: results.length,
      allowedCount: results.filter((r) => r.allowed).length,
      deniedCount: results.filter((r) => !r.allowed).length,
    });

    return {
      userId: targetUserId || '',
      tenantId: targetTenantId,
      results,
      allAllowed,
      anyAllowed,
    };
  }
}
