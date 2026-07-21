import {
  IActiveUserContext,
  IAppSettingsService,
  IAuthService,
  IUserDepartmentService,
  IUserRoleAssignmentService,
  SecretsService,
  createJwt,
} from '@arcaai/applications';
import { EventTypes, ResourceStatusType, ResourceType, SysEventType, UserRepository } from '@arcaai/domains';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';
import { AdminImpersonateRequest, ImpersonateResponse, ImpersonateUserResponse } from './dto';
import { ImpersonationEvents, ImpersonationDeniedReason, ImpersonationEventPayload } from './impersonation-events';

// The elevated tier is exactly GLOBAL_ADMIN (the legacy SUPER_ADMIN role has been retired).
const ELEVATED_TIER_ROLES = ['GLOBAL_ADMIN'];

/** Forced-audit action codes for the impersonation lifecycle rows. */
export const USER_IMPERSONATION_STARTED = 'USER_IMPERSONATION_STARTED';
export const USER_IMPERSONATION_ENDED = 'USER_IMPERSONATION_ENDED';

/** TTL bounds for the test-only `expiresInSeconds` override (10s … 30m). */
const MIN_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 1800;

/**
 * Global-admin-only impersonation start endpoint.
 *
 * `POST /admin/users/:id/impersonate` mints a time-boxed (default 30m),
 * NON-refreshable "act-as" token whose claims carry BOTH the subject identity
 * (the target's id/username/roles/permissions/tenant — so downstream auth
 * context resolves to the target) AND the true actor (`impersonatedBy`), which
 * `JwtStrategy` threads into CLS for the per-request audit interceptor and the
 * `BaseService.broadcastSysEvent` provenance metadata.
 *
 * Posture mirrors the secret reveal endpoint: the method-level
 * `@Authorize(['manage','all'])` limits the route to holders of the
 * `system-full-access` policy (GLOBAL_ADMIN); tenant admins keep the legacy
 * `/auth/impersonate` endpoint with its own-tenant restrictions. A DB-role
 * check inside the handler backs the CASL gate (defense-in-depth, and the
 * source of the audited denial reasons).
 *
 * The legacy endpoint is intentionally left in place — this controller shares
 * its mint shape (same claims, same `impersonate-` jti prefix) so the existing
 * JwtStrategy / interceptor / revocation plumbing applies unchanged.
 */
@ApiTags('admin-users')
@Controller('admin/users')
export class AdminImpersonationController {
  constructor(
    @Inject(IAuthService) private readonly authService: IAuthService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject(IUserRoleAssignmentService) private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    @Inject(IUserDepartmentService) private readonly userDepartmentService: IUserDepartmentService,
    private readonly userRepository: UserRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post(':id/impersonate')
  // Same envelope as the legacy /auth/impersonate route.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  // Only `system-full-access` (GLOBAL_ADMIN) holds manage:all.
  @Authorize(['manage', 'all'])
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Impersonate a user (global-admin only, time-boxed, audited)',
    description:
      'Mints a time-boxed (default 30 minutes), non-refreshable impersonation token that acts as the target ' +
      'user while preserving the true actor in the `impersonatedBy` claim. GLOBAL_ADMIN only (CASL `manage:all`). ' +
      'Safeguards: no self-impersonation, no global-admin targets, target must be ENABLED, and an already ' +
      'impersonated session can never start another (no nesting). Start and end are force-audited.',
  })
  @ApiParam({ name: 'id', description: 'Target user id', type: String })
  @ApiResponse({ status: 200, description: 'Impersonation token minted', type: ImpersonateResponse })
  @ApiResponse({ status: 400, description: 'Invalid target (self, global-admin, disabled, or missing tenant assignment)' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — global-admin only, or nested impersonation attempt' })
  @ApiResponse({ status: 404, description: 'Target user not found' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async impersonate(@Param('id') targetUserId: string, @Body() request: AdminImpersonateRequest, @Request() req: any): Promise<ImpersonateResponse> {
    const actor = this.clsService.get('user');
    if (!actor) {
      throw new UnauthorizedException('User not found in context');
    }

    // Never allow nesting: an impersonated session cannot start another.
    if (actor.impersonatedBy) {
      this.recordDenied(req, actor.id, targetUserId, ImpersonationDeniedReason.NestedImpersonation);
      throw new ForbiddenException('An impersonated session cannot start another impersonation');
    }

    // Defense-in-depth under the @Authorize(['manage','all']) CASL gate: the
    // DB roles are the fresh source of truth (a revoked role outlives its JWT).
    const actorRoles = await this.userRoleAssignmentService.findActiveRolesForUser(actor.id);
    const actorIsSuperAdmin = actorRoles.some((r) => ELEVATED_TIER_ROLES.includes(r.name));
    if (!actorIsSuperAdmin) {
      this.recordDenied(req, actor.id, targetUserId, ImpersonationDeniedReason.CallerNotSuperAdmin);
      throw new ForbiddenException('Impersonation requires a GLOBAL_ADMIN user');
    }

    if (targetUserId === actor.id) {
      this.recordDenied(req, actor.id, targetUserId, ImpersonationDeniedReason.SelfImpersonation);
      throw new BadRequestException('You cannot impersonate yourself');
    }

    // Lookup WITHOUT a status filter so a disabled target yields a distinct,
    // audited rejection instead of a generic not-found (unlike the legacy route).
    const targetUser = await this.userRepository.findFirst({
      filters: { id: targetUserId },
      relations: { UserProfile: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (!targetUser) {
      throw new NotFoundException('Target user not found');
    }

    if (targetUser.resourceStatus !== ResourceStatusType.ENABLED) {
      this.recordDenied(req, actor.id, targetUser.id, ImpersonationDeniedReason.TargetDisabled);
      throw new BadRequestException('Target user is not enabled');
    }

    // A service account is an API-only principal; impersonating one
    // would mint the interactive session it must never have.
    if (targetUser.isServiceAccount) {
      this.recordDenied(req, actor.id, targetUser.id, ImpersonationDeniedReason.TargetIsServiceAccount);
      throw new BadRequestException('Cannot impersonate a service account');
    }

    const targetRoles = await this.userRoleAssignmentService.findActiveRolesForUser(targetUser.id);
    const targetRoleNames = targetRoles.map((r) => r.name);
    if (targetRoleNames.some((r) => ELEVATED_TIER_ROLES.includes(r))) {
      this.recordDenied(req, actor.id, targetUser.id, ImpersonationDeniedReason.TargetIsSuperAdmin);
      throw new BadRequestException('Cannot impersonate a global administrator');
    }

    const targetPermissions = this.collectPermissions(targetRoles);

    // Tenant resolution mirrors the legacy route: caller may pin
    // one of the target's enabled assignments; default = oldest assignment.
    const targetTenantIds = await this.userRoleAssignmentService.findActiveTenantIdsForUser(targetUser.id);
    let resolvedTenantId: string;
    if (request.targetTenantId) {
      if (!targetTenantIds.includes(request.targetTenantId)) {
        throw new BadRequestException('Target user is not assigned to the requested tenant');
      }
      resolvedTenantId = request.targetTenantId;
    } else {
      resolvedTenantId = targetTenantIds[0] ?? '';
    }
    if (!resolvedTenantId) {
      throw new BadRequestException('Target user has no tenant assignment. Assign the user to a tenant before impersonating.');
    }

    const jwtSecretKey = this.secretsService.getSecretSync('JWT_SECRET_KEY') ?? (await this.secretsService.getSecretOptional('JWT_SECRET_KEY'));
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }

    // Default is 30m (the legacy route keeps its 15m default). An env
    // JWT_IMPERSONATION_EXPIRES_IN overrides both; `expiresInSeconds` (clamped,
    // test-only affordance) overrides per-request.
    const configuredTtl = this.appSettingsService.getValueWithDefault('JWT_IMPERSONATION_EXPIRES_IN', '30m') as string;
    const expiresIn =
      typeof request.expiresInSeconds === 'number'
        ? `${Math.min(Math.max(Math.trunc(request.expiresInSeconds), MIN_TTL_SECONDS), MAX_TTL_SECONDS)}s`
        : configuredTtl;

    // Same claim shape as the legacy /auth/impersonate mint (built as a
    // variable, exactly like the legacy route: `username`/`email` ride along
    // beyond the strict UserSession type and land in the signed claims).
    const tokenPayload = {
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId,
      impersonatedBy: actor.id,
      // Same `impersonate-` prefix + randomBytes hygiene as the legacy mint so
      // revocation/log filtering treats both endpoints' tokens identically.
      jti: `impersonate-${randomBytes(16).toString('hex')}`,
      jwtSecretKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: expiresIn as any,
    };
    const token = createJwt(tokenPayload);

    // The signed token's exp claim is the authoritative expiry.
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp: number };
    const expiresAt = new Date(exp * 1000).toISOString();
    const expiresInSeconds = Math.max(0, exp - Math.floor(Date.now() / 1000));
    const reason = request.reason?.trim() || undefined;

    await this.authService.trackAuthentication(actor.id, {
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      endpoint: `/admin/users/${targetUser.id}/impersonate`,
      method: 'POST',
    });

    // Explicit lifecycle START bracket enriched with impersonation
    // fields — persisted synchronously by
    // AuditLogService.handleUserAuthenticatedEvent.
    this.eventEmitter?.emit(EventTypes.UserAuthenticated, {
      userId: actor.id,
      impersonatedUserId: targetUser.id,
      phase: 'START',
      endpoint: `/admin/users/${targetUser.id}/impersonate`,
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
      reason,
      expiresAt,
      impersonationTenantId: resolvedTenantId,
    });

    // Dedicated semantic signal with the impersonation extras.
    this.eventEmitter?.emit(ImpersonationEvents.Started, {
      adminId: actor.id,
      targetUserId: targetUser.id,
      tenantId: resolvedTenantId,
      success: true,
      reason,
      expiresAt,
      endpoint: `/admin/users/${targetUser.id}/impersonate`,
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    } satisfies ImpersonationEventPayload);

    // Forced audit row for the sensitive action. Direct emit
    // (not broadcastSysEvent): a global-admin's CLS tenant is usually EMPTY
    // STRING (never null — their JWT carries `tenantId: ''`, see
    // `resolve-active-tenant.ts`) and the AuditLogProcessor fail-closes on a
    // falsy tenant, so the row is attributed to the RESOLVED impersonation
    // tenant (a persisted assignment, never caller-supplied free text).
    // `??` only falls back on null/undefined and let the real
    // empty-string CLS value through, producing a job the processor rejected;
    // `||` catches the actual falsy shape.
    this.eventEmitter?.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: actor.id,
      responsibleIp: req.ip || '127.0.0.1',
      resourceType: ResourceType.User,
      resourceId: targetUser.id,
      correlationId: this.clsService.get('correlationId') ?? undefined,
      tenantId: this.clsService.get('tenantId') || resolvedTenantId,
      forceAuditLog: true,
      data: {
        action: USER_IMPERSONATION_STARTED,
        impersonatorUserId: actor.id,
        targetUserId: targetUser.id,
        targetUsername: targetUser.username,
        tenantId: resolvedTenantId,
        expiresAt,
        reason: reason ?? null,
      },
    });

    // Carry the target's primary department for the SDK
    // preference cascade (same as the legacy mint).
    const targetPrimaryDepartment = await this.userDepartmentService.findActiveDepartmentForUserInTenant(targetUser.id, resolvedTenantId);

    const userResponse = new ImpersonateUserResponse({
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId,
      departmentId: targetPrimaryDepartment?.id,
    });

    return {
      user: userResponse,
      token,
      impersonatedBy: actor.id,
      expiresAt,
      expiresInSeconds,
    };
  }

  /** Audited denial signal (mirrors AuthController.recordImpersonationDenied). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recordDenied(req: any, adminId: string, targetUserId: string, reason: string): void {
    this.eventEmitter?.emit(ImpersonationEvents.Denied, {
      adminId,
      targetUserId,
      success: false,
      reason,
      endpoint: `/admin/users/${targetUserId}/impersonate`,
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    } satisfies ImpersonationEventPayload);
  }

  /** Union of role permissions (same shape AuthController.getUserPermissions consumes). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collectPermissions(roles: any[]): string[] {
    const permissions = new Set<string>();
    for (const role of roles) {
      if (Array.isArray(role.permissions)) {
        role.permissions.forEach((permission: string) => permissions.add(permission));
      }
    }
    return Array.from(permissions);
  }
}
