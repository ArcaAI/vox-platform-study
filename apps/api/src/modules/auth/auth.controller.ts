import {
  IActiveUserContext,
  IAppSettingsService,
  IAuthService,
  IJwtRevocationService,
  IRefreshTokenService,
  IUserDepartmentService,
  IUserRoleAssignmentService,
  IUserService,
  SecretsService,
  createJwt,
  // TASK-400 — password rotation surfaced at login (warning-only).
  isPasswordExpired,
  resolvePasswordPolicy,
} from '@arcaai/applications';
import {
  ConsultationRepository,
  EventTypes,
  ResourceStatusType,
  ResourceType,
  RoleRepository,
  SysEventType,
  TenantRepository,
  UserRepository,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { Authorize, Public } from '../../decorators';
import {
  LoginRequest,
  LoginResponse,
  LoginUserResponse,
  LogoutResponse,
  MeResponse,
  ImpersonateRequest,
  ImpersonateResponse,
  ImpersonateUserResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  RevokeImpersonationResponse,
  IssueStreamTicketRequest,
  IssueStreamTicketResponse,
} from './dto';
import { ImpersonationEvents, ImpersonationDeniedReason, ImpersonationEventPayload } from './impersonation-events';
import { StreamTicketService } from './stream-ticket.service';

// TASK-417 — GLOBAL_ADMIN is the single elevated role (SUPER_ADMIN retired).
const GLOBAL_ADMIN_ROLE = 'GLOBAL_ADMIN';

// TASK-308 AC-5 — the previous class-wide `@Throttle({ default: { limit: 10,
// ttl: 60000 } })` lumped `/login`, `/refresh`, `/me`, `/logout`,
// `/stream-ticket`, `/impersonate`, and `/revoke-impersonation` into a single
// 10 req/min counter. The SDK polls `/me` + rotates `/refresh` more
// aggressively than that envelope allows, while `/login` needs a tighter
// bound to defend against credential stuffing. The decorator now lives on
// each handler that needs a non-default limit; `/me`, `/logout`,
// `/stream-ticket`, and `/revoke-impersonation` ride the app-wide default
// throttler instead.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(IUserService) private readonly userService: IUserService,
    @Inject(IAuthService) private readonly authService: IAuthService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject(IUserRoleAssignmentService) private readonly userRoleAssignmentService: IUserRoleAssignmentService,
    private readonly userRepository: UserRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly roleRepository: RoleRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly streamTicketService: StreamTicketService,
    @Inject(IJwtRevocationService) private readonly jwtRevocationService: IJwtRevocationService,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    @Inject(IRefreshTokenService) private readonly refreshTokenService: IRefreshTokenService,
    // TASK-305 Phase F — login enforces full membership (role + department);
    // this resolves the department half via a pre-auth baseClient lookup.
    @Inject(IUserDepartmentService) private readonly userDepartmentService: IUserDepartmentService,
    // TASK-331 M-3 — emits the explicit impersonation start/stop audit bracket.
    // EventEmitter2 is globally provided via EventEmitterModule (same source the
    // ImpersonationAuditInterceptor uses for the per-request rows).
    private readonly eventEmitter: EventEmitter2,
    // TASK-341 B4 — mint-time tenant-ownership check for live-summary stream
    // tickets (defense-in-depth alongside the SSE route's @TenantOwnedResource).
    private readonly consultationRepository: ConsultationRepository,
  ) {}

  /**
   * Resolve the JWT signing secret for the mint paths (login / impersonate
   * / refresh). Reads the boot-warmed sync cache first (the common case),
   * then falls back to an async provider fetch when that entry has aged out.
   *
   * `SecretsService.getSecretSync` is cache-only by design (no lazy re-fetch
   * on the sync hot path). The boot warmup seeds JWT_SECRET_KEY under the
   * default SECRETS_TTL_SEC (300s); once that window lapses the sync read
   * returns undefined and every sign-path 401s with "Authentication system
   * not configured" — even though JwtStrategy keeps verifying tokens fine
   * because it captured the secret once at construction. The async fallback
   * re-fetches from the provider (and refills the LRU), so the mint paths
   * survive TTL expiry without widening the secret's in-memory lifetime by
   * inflating the TTL. Returns undefined only when the provider genuinely
   * cannot supply the secret, preserving the fail-closed 401.
   */
  private async resolveJwtSecretKey(): Promise<string | undefined> {
    return this.secretsService.getSecretSync('JWT_SECRET_KEY') ?? (await this.secretsService.getSecretOptional('JWT_SECRET_KEY'));
  }

  @Post('login')
  // TASK-308 AC-5 — 5 req/min: tight bound vs credential stuffing.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'User login' })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: LoginResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - missing username or password',
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async login(@Body() request: LoginRequest, @Request() req: any): Promise<LoginResponse> {
    try {
      if (!request.username || !request.password) {
        throw new BadRequestException('Username and password are required');
      }

      const user = await this.userRepository.findFirst({
        filters: {
          username: request.username,
          resourceStatus: { equals: ResourceStatusType.ENABLED },
        },
        relations: { UserProfile: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      if (!user) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const isPasswordValid = await bcrypt.compare(request.password, user.password);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const userRoles = await this.getUserRoles(user.id);
      const roles = userRoles.map((role) => role.name);
      const isSuperAdmin = roles.includes(GLOBAL_ADMIN_ROLE);

      // Tenant validation: required for non-global-admin users
      let resolvedTenantId = '';
      let resolvedTenantKey = '';

      if (isSuperAdmin) {
        // Global admins can optionally scope to a tenant
        if (request.tenantKey) {
          const tenant = await this.resolveTenant(request.tenantKey);
          resolvedTenantId = tenant.id;
          resolvedTenantKey = tenant.key;
        }
      } else {
        if (!request.tenantKey) {
          throw new BadRequestException('Tenant key is required for non-admin users');
        }

        const tenant = await this.resolveTenant(request.tenantKey);
        resolvedTenantId = tenant.id;
        resolvedTenantKey = tenant.key;

        // TASK-307 W6.1 (audit C-10) — tenant validation now flows through
        // `UserRoleAssignmentService` instead of touching Prisma directly.
        const tenantRoleAssignment = await this.userRoleAssignmentService.findActiveAssignmentForUserInTenant(user.id, resolvedTenantId);

        if (!tenantRoleAssignment) {
          throw new UnauthorizedException('User does not have access to the specified tenant');
        }

        // TASK-305 Phase F — full tenant membership = an enabled role AND an
        // enabled department. Service accounts (which authenticate via API
        // keys, not this flow) are exempt from the department half. The 401
        // message is intentionally identical to the role miss above so the
        // response never reveals which half of the membership is incomplete.
        if (!user.isServiceAccount) {
          const tenantDepartment = await this.userDepartmentService.findActiveDepartmentForUserInTenant(user.id, resolvedTenantId);

          if (!tenantDepartment) {
            throw new UnauthorizedException('User does not have access to the specified tenant');
          }
        }
      }

      const permissions = await this.getUserPermissions(userRoles);

      // TASK-307 W2.3 (closes audit C-6) — JWT_SECRET_KEY now sourced
      // from SecretsService (cache-warmed at bootstrap, placeholder
      // refused by main.ts W2.2 assertion). Unifies the sign-path with
      // JwtStrategy.verify-path so the two cannot diverge.
      // JWT_EXPIRES_IN stays on AppSettings (it's a tunable, not a
      // secret — same rationale as oidc.strategy.ts:82-83).
      const jwtSecretKey = await this.resolveJwtSecretKey();
      if (!jwtSecretKey) {
        throw new UnauthorizedException('Authentication system not configured');
      }
      const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;

      // TASK-307 W1.6 / E-1: jti is randomBytes(16).hex — unpredictable, no
      // userId or timestamp leak. The legacy `auth-${user.id}-${Date.now()}`
      // shape was guessable and tied the jti's information density to the
      // user id, which is itself sometimes assumed-public elsewhere.
      const jti = randomBytes(16).toString('hex');

      // TASK-307 W1.2 / C-1 / C-12: persist the refresh token in Redis so it
      // can be validated server-side on refresh. Carry the resolvedTenantId
      // (active session) — NOT user.tenantId — so multi-tenant users keep
      // their selected tenant across refreshes.
      const issued = await this.refreshTokenService.issue({
        userId: user.id,
        tenantId: resolvedTenantId,
        jti,
      });

      const tokenPayload = {
        id: user.id,
        username: user.username,
        email: user.UserProfile?.email || '',
        roles,
        permissions,
        tenantId: resolvedTenantId,
        jti,
        // TASK-307 W1.4 / AC-2: ride the family id through the access-token
        // JWT so `logout` can revoke every refresh token in this session
        // family without a Redis lookup.
        refreshFamily: issued.family,
        jwtSecretKey,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expiresIn: jwtExpiresIn as any,
      };

      const token = createJwt(tokenPayload);

      const refreshToken = issued.rawToken;

      await this.authService.trackAuthentication(user.id, {
        ip: req.ip || '127.0.0.1',
        userAgent: req.headers['user-agent'] || 'Unknown',
        endpoint: '/auth/login',
        method: 'POST',
      });

      try {
        user.lastLoginAt = new Date();
        user.lastActiveAt = new Date();
        await this.userRepository.update(user.id, user);
      } catch {
        // Non-fatal: proceed with login even if timestamp update fails
      }

      const userResponse = new LoginUserResponse({
        id: user.id,
        username: user.username,
        email: user.UserProfile?.email || '',
        roles,
        permissions,
        tenantId: resolvedTenantId,
        tenantKey: resolvedTenantKey,
      });

      // TASK-400 — rotation check (warning only, never blocks). Disabled by
      // default (maxAgeDays=0); a NULL passwordChangedAt (legacy user) never
      // counts as expired, so enabling the knob cannot lock anyone out.
      const passwordExpired = isPasswordExpired(
        (user as { passwordChangedAt?: Date | null }).passwordChangedAt ?? null,
        resolvePasswordPolicy(this.appSettingsService).maxAgeDays,
      );

      return {
        user: userResponse,
        token,
        refreshToken,
        ...(passwordExpired ? { passwordExpired } : {}),
      };
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'User logout' })
  @ApiResponse({
    status: 200,
    description: 'Logout successful',
    type: LogoutResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing token',
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async logout(@Request() req: any): Promise<LogoutResponse> {
    const user = this.clsService.get('user');

    // TASK-307 W1.4 / C-11: revoke the access token's jti so any in-flight
    // request bearing this token is rejected at the very next hop. Mirrors
    // the `revokeImpersonation` pattern. Best-effort — a Redis outage must
    // NOT leave the client stuck (the tokens have already been discarded
    // client-side).
    if (user?.jti) {
      try {
        await this.jwtRevocationService.revoke(user.jti, user.exp);
      } catch {
        // Swallow — see comment above.
      }
    }

    // TASK-307 W1.4 / AC-2: revoke the ENTIRE refresh-token family so the
    // chain of rotated refresh tokens (login → refresh → refresh → …) is
    // dead. Without this, an attacker who exfiltrated any token earlier
    // in the chain could still rotate forward.
    if (user?.refreshFamily) {
      try {
        await this.refreshTokenService.revokeFamily(user.refreshFamily);
      } catch {
        // Swallow — independent of the jti revoke above.
      }
    }

    // Best-effort tracking of the logout event (TASK-224 behaviour).
    if (user) {
      try {
        await this.authService.trackAuthentication(user.id, {
          ip: req.ip || '127.0.0.1',
          userAgent: req.headers['user-agent'] || 'Unknown',
          endpoint: '/auth/logout',
          method: 'POST',
        });
      } catch {
        // Non-fatal — already revoked tokens, response stays success.
      }
    }

    return {
      success: true,
      message: 'Successfully logged out',
    };
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user information' })
  @ApiResponse({
    status: 200,
    description: 'Current user information retrieved successfully',
    type: MeResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - invalid or missing token',
  })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  async me(@Request() req: any): Promise<MeResponse> {
    try {
      const user = this.clsService.get('user');
      if (!user) {
        throw new UnauthorizedException('User not found in context');
      }

      const dbUser = await this.userRepository.findFirst({
        filters: {
          id: user.id,
          resourceStatus: { equals: ResourceStatusType.ENABLED },
        },
        relations: { UserProfile: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      if (!dbUser) {
        throw new UnauthorizedException('User not found');
      }

      const userRoles = await this.getUserRoles(dbUser.id);
      const roles = userRoles.map((role) => role.name);
      const permissions = await this.getUserPermissions(userRoles);

      return new MeResponse({
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.UserProfile?.email || '',
        // firstName: dbUser.UserProfile?.firstName || '',
        // lastName: dbUser.UserProfile?.lastName || '',
        // phone: dbUser.UserProfile?.phone || '',
        roles,
        permissions,
        // tenantId: dbUser.tenantId,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Failed to retrieve user information');
    }
  }

  /**
   * AC-11 (TASK-336): record a DENIED impersonation attempt as a dedicated
   * audit event. The legacy `UserAuthenticated` bracket is success-only, so
   * denials were previously invisible to the audit trail. Fire-and-forget — an
   * audit failure must never mask the authorization error being thrown.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recordImpersonationDenied(req: any, adminId: string, targetUserId: string, reason: string): void {
    this.eventEmitter?.emit(ImpersonationEvents.Denied, {
      adminId,
      targetUserId,
      success: false,
      reason,
      endpoint: '/auth/impersonate',
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    } satisfies ImpersonationEventPayload);
  }

  @Post('impersonate')
  // TASK-308 AC-5 — 10 req/min: same envelope as the retired class-wide
  // throttle, kept explicit. Impersonation is an admin-tier action and
  // does not need the more permissive SDK-poll bound.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  // AC-08 (TASK-336): the prior "Cannot impersonate admin users" wording was
  // inaccurate. A GLOBAL_ADMIN MAY impersonate a TENANT_ADMIN (and any
  // non-global-admin) cross-tenant; only GLOBAL_ADMIN TARGETS can never be
  // impersonated. A TENANT_ADMIN may impersonate only non-admin users within
  // its OWN tenant.
  @ApiOperation({
    summary: 'Impersonate another user (admin only)',
    description:
      'Mints a short-lived impersonation token. A GLOBAL_ADMIN may impersonate any ' +
      'non-global-admin user cross-tenant — including a TENANT_ADMIN. A TENANT_ADMIN may impersonate ' +
      'only non-admin users within its own tenant. GLOBAL_ADMIN targets ' +
      'can never be impersonated.',
  })
  @ApiResponse({
    status: 200,
    description: 'Impersonation token generated',
    type: ImpersonateResponse,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - caller is not an administrator' })
  @ApiResponse({ status: 403, description: 'Forbidden - tenant admin cannot impersonate outside its own tenant' })
  @ApiResponse({ status: 400, description: 'Invalid target (e.g. a global-admin target) or missing tenant assignment' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async impersonate(@Body() request: ImpersonateRequest, @Request() req: any): Promise<ImpersonateResponse> {
    const adminUser = this.clsService.get('user');
    if (!adminUser) {
      throw new UnauthorizedException('User not found in context');
    }

    // TASK-401 — nested impersonation is never allowed: an impersonated
    // session (impersonatedBy claim present) cannot start another. Backported
    // to this legacy route so no nesting path remains.
    if (adminUser.impersonatedBy) {
      this.recordImpersonationDenied(req, adminUser.id, request.targetUserId, ImpersonationDeniedReason.NestedImpersonation);
      throw new ForbiddenException('An impersonated session cannot start another impersonation');
    }

    // TASK-401 — self-impersonation guard (backported alongside the nested one).
    if (request.targetUserId === adminUser.id) {
      this.recordImpersonationDenied(req, adminUser.id, request.targetUserId, ImpersonationDeniedReason.SelfImpersonation);
      throw new BadRequestException('You cannot impersonate yourself');
    }

    const adminRoles = await this.getUserRoles(adminUser.id);
    const adminRoleNames = adminRoles.map((r) => r.name);
    // TASK-331 F-4 / TASK-417 — GLOBAL_ADMIN is the elevated cross-tenant
    // role (unrestricted); it carries the C-1 cross-tenant bypass below.
    const isSuperAdmin = adminRoleNames.includes(GLOBAL_ADMIN_ROLE);
    const isTenantAdmin = adminRoleNames.some((r) => ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r));
    if (!isSuperAdmin && !isTenantAdmin) {
      this.recordImpersonationDenied(req, adminUser.id, request.targetUserId, ImpersonationDeniedReason.CallerNotAdmin);
      throw new UnauthorizedException('Only administrators can impersonate users');
    }

    const targetUser = await this.userRepository.findFirst({
      filters: {
        id: request.targetUserId,
        resourceStatus: { equals: ResourceStatusType.ENABLED },
      },
      relations: { UserProfile: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (!targetUser) {
      throw new BadRequestException('Target user not found');
    }

    const targetRoles = await this.getUserRoles(targetUser.id);
    const targetRoleNames = targetRoles.map((r) => r.name);
    // TASK-331 F-4 / TASK-417 — a GLOBAL_ADMIN target can never be
    // impersonated.
    const targetIsSuperAdmin = targetRoleNames.includes(GLOBAL_ADMIN_ROLE);
    const targetIsTenantAdmin = targetRoleNames.some((r) => ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r));

    if (targetIsSuperAdmin) {
      this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.TargetIsSuperAdmin);
      throw new BadRequestException('Cannot impersonate a global administrator');
    }

    if (isTenantAdmin && !isSuperAdmin && targetIsTenantAdmin) {
      this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.TenantAdminTargetNotAllowed);
      throw new BadRequestException('Tenant administrators cannot impersonate other administrators');
    }

    const targetPermissions = await this.getUserPermissions(targetRoles);

    // TASK-295 H-3 + TASK-307 W6.1 (audit C-10): resolve the impersonation
    // tenant from the target user's ENABLED userRoleAssignments via the
    // application service (no direct Prisma access). Caller may pin a
    // specific tenant via `targetTenantId`; otherwise we pick the oldest
    // assignment for backward compatibility with the previous behavior.
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

    // TASK-295 C-1: tenant admins must not impersonate users outside their
    // own tenant. GLOBAL_ADMIN remains unrestricted (cross-tenant impersonation
    // is part of the business requirement for global admins).
    if (!isSuperAdmin) {
      const adminTenantId = adminUser.tenantId;
      if (!adminTenantId) {
        throw new BadRequestException('Tenant admin missing tenant context');
      }
      if (adminTenantId !== resolvedTenantId) {
        this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.CrossTenantDenied);
        throw new ForbiddenException('Tenant admin cannot impersonate users outside their own tenant');
      }
    }

    // TASK-307 W2.3 (closes audit C-6) — see login() for rationale.
    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }
    const jwtImpersonationExpiresIn = this.appSettingsService.getValueWithDefault('JWT_IMPERSONATION_EXPIRES_IN', '15m') as string;

    const tokenPayload = {
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId,
      impersonatedBy: adminUser.id,
      // TASK-331 F-8 — unpredictable jti (randomBytes(16).hex), same hygiene as
      // login/refresh. The stable `impersonate-` prefix is retained so audit /
      // log filtering on impersonation tokens still works; no admin/target id
      // or timestamp is leaked into the claim anymore.
      jti: `impersonate-${randomBytes(16).toString('hex')}`,
      jwtSecretKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: jwtImpersonationExpiresIn as any,
    };

    const token = createJwt(tokenPayload);

    await this.authService.trackAuthentication(adminUser.id, {
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      endpoint: '/auth/impersonate',
      method: 'POST',
    });

    // TASK-331 M-3 — explicit IMPERSONATION start bracket. The AuditAction enum
    // is frozen (no migration in scope), so START reuses IMPERSONATED_ACTION +
    // the IMPERSONATION eventType, discriminated by `phase` inside the row's
    // data JSON (persisted by AuditLogService.handleUserAuthenticatedEvent).
    // Fire-and-forget like the per-request interceptor — an audit failure must
    // never break the impersonation mint.
    this.eventEmitter?.emit(EventTypes.UserAuthenticated, {
      userId: adminUser.id,
      impersonatedUserId: targetUser.id,
      phase: 'START',
      endpoint: '/auth/impersonate',
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    });

    // AC-11 (TASK-336): dedicated, semantically named start event (in addition
    // to the legacy bracket above) so audit consumers get a precise signal.
    this.eventEmitter?.emit(ImpersonationEvents.Started, {
      adminId: adminUser.id,
      targetUserId: targetUser.id,
      tenantId: resolvedTenantId,
      success: true,
      endpoint: '/auth/impersonate',
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    } satisfies ImpersonationEventPayload);

    // TASK-331 F-9 — resolve the target's PRIMARY department for the
    // impersonation tenant so the SDK preference cascade keeps the impersonated
    // doctor's department tier (without it, effectiveDepartmentId resolves to
    // null during impersonation). Absent assignment ⇒ leave departmentId unset.
    const targetPrimaryDepartment = await this.userDepartmentService.findActiveDepartmentForUserInTenant(targetUser.id, resolvedTenantId);

    const userResponse = new ImpersonateUserResponse({
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId || undefined,
      departmentId: targetPrimaryDepartment?.id,
    });

    return {
      user: userResponse,
      token,
      impersonatedBy: adminUser.id,
    };
  }

  @Post('refresh')
  // TASK-308 AC-5 — 60 req/min: the SDK rotates refresh tokens aggressively
  // (single-use refresh per TASK-307 W1.3); the previous 10/min class-wide
  // limit tripped legitimate clients in production.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed', type: RefreshTokenResponse })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body() body: RefreshTokenRequest): Promise<RefreshTokenResponse> {
    if (!body.refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }

    // TASK-307 W1.3 / C-1 / C-12: server-side validation through
    // RefreshTokenService. The old `parts.split('_')` parser is RETIRED —
    // it took client-supplied input as the userId, which is the audit
    // finding itself. RefreshTokenService.consume:
    //   - looks the token up by sha256(token)
    //   - returns the ORIGINAL session's userId, tenantId, jti, and family
    //   - deletes the record (single-use) and flags reuse for family-revoke
    //   - throws UnauthorizedException on miss / reuse (let it bubble up)
    const consumed = await this.refreshTokenService.consume(body.refreshToken);

    const user = await this.userRepository.findFirst({
      filters: {
        id: consumed.userId,
        resourceStatus: { equals: ResourceStatusType.ENABLED },
      },
      relations: { UserProfile: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (!user) {
      throw new UnauthorizedException('User not found or disabled');
    }

    const userRoles = await this.getUserRoles(user.id);
    const roles = userRoles.map((role) => role.name);
    const permissions = await this.getUserPermissions(userRoles);

    // TASK-307 W2.3 (closes audit C-6) — see login() for rationale.
    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }
    const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;

    // TASK-307 W1.6 / E-1: fresh unpredictable jti per rotation.
    const newJti = randomBytes(16).toString('hex');

    // TASK-307 W1.3 / C-12: refresh stays scoped to the tenant that ORIGINALLY
    // issued the token — NOT a tenant the user has since been moved into.
    // The cross-tenant carry-through is the whole point.
    const issued = await this.refreshTokenService.issue({
      userId: consumed.userId,
      tenantId: consumed.tenantId,
      jti: newJti,
      // Keep the family stable across the rotation so logout-by-family
      // continues to nuke the full chain (RFC 6749 §10.4).
      family: consumed.family,
    });

    const tokenPayload = {
      id: user.id,
      username: user.username,
      email: user.UserProfile?.email || '',
      roles,
      permissions,
      tenantId: consumed.tenantId,
      jti: newJti,
      refreshFamily: issued.family,
      jwtSecretKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expiresIn: jwtExpiresIn as any,
    };

    const token = createJwt(tokenPayload);

    return { token, refreshToken: issued.rawToken };
  }

  @Post('stream-ticket')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Issue a single-use, 30-second ticket for authenticating SSE streams (TASK-263 W0-1)',
    description:
      'Returns a single-use ticket bound to the requested scope (e.g. `consultation_job:<jobId>`). The SDK passes the ticket as `?ticket=<ticket>` when opening the SSE endpoint, avoiding the HIPAA-sensitive pattern of putting the long-lived JWT in the URL query string.',
  })
  @ApiResponse({ status: 200, description: 'Ticket issued', type: IssueStreamTicketResponse })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async issueStreamTicket(@Body() body: IssueStreamTicketRequest): Promise<IssueStreamTicketResponse> {
    const user = this.clsService.get('user');
    if (!user?.id) {
      throw new UnauthorizedException('User context not available');
    }
    // TASK-341 B4 — the ACTIVE (CLS) tenant wins so a global admin's selected
    // `X-Tenant-Id` propagates into the ticket (`??` would have kept an empty-
    // string JWT tenant); fall back to the JWT tenant, then null.
    const tenantId = this.clsService.get('tenantId') || user.tenantId || null;

    // TASK-341 B4 / TASK-348 MIN-1 — defense-in-depth: any consultation-id-keyed
    // `consultation_*:<id>` ticket may only be minted for a consultation in the
    // caller's (active) tenant. The SSE routes are `@TenantOwnedResource`, but
    // the ticket bypasses that interceptor, so we re-check ownership here
    // before issuing.
    await this.assertConsultationScopeOwnership(body.scope, tenantId);

    const issued = await this.streamTicketService.issueTicket({
      userId: user.id,
      tenantId,
      scope: body.scope,
      // TASK-295 SEC-A5-6 / M-8: carry the impersonatedBy claim through the
      // ticket so the SSE/WS request restored from the ticket can fire the
      // ImpersonationAuditInterceptor and produce a HIPAA-compliant audit row.
      impersonatedBy: user.impersonatedBy ?? null,
    });
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt,
      scope: issued.scope,
    };
  }

  /**
   * Stream-ticket scopes under `consultation_*` whose suffix is NOT a
   * consultation id, exempted from the mint-time consultation-ownership check.
   * `consultation_job:<jobId>` is keyed by jobId — its ownership is enforced by
   * the job routes' `@TenantOwnedResource('ConsultationJob', 'jobId')` guard.
   * Every OTHER `consultation_*` namespace (current or future) is
   * ownership-checked fail-closed below.
   */
  private static readonly NON_CONSULTATION_ID_SCOPES: ReadonlySet<string> = new Set(['consultation_job']);

  /**
   * TASK-341 B4 / TASK-348 MIN-1 — for any consultation-id-keyed
   * `consultation_*:<id>` ticket scope (live-summary, harness-progress, and any
   * future sibling), verify the consultation belongs to the caller's active
   * tenant before minting. A missing OR cross-tenant consultation both yield
   * 404 (no existence leak), matching the SSE routes' `@TenantOwnedResource`
   * semantics. Non-consultation scopes pass through untouched. The explicit
   * tenant match is belt-and-suspenders for global admins whose `findById` may
   * not be auto-scoped by the Prisma tenant extension.
   */
  private async assertConsultationScopeOwnership(scope: string, activeTenantId: string | null): Promise<void> {
    const match = /^(consultation_[a-z0-9_]+):(.*)$/.exec(scope ?? '');
    if (!match) {
      return;
    }
    const [, namespace, consultationId] = match;
    if (AuthController.NON_CONSULTATION_ID_SCOPES.has(namespace)) {
      return;
    }
    let consultationTenantId: string | null | undefined;
    if (consultationId) {
      try {
        const consultation = await this.consultationRepository.findById(consultationId);
        consultationTenantId = consultation?.tenantId;
      } catch {
        consultationTenantId = undefined;
      }
    }
    if (consultationTenantId === undefined || consultationTenantId === null || (activeTenantId !== null && consultationTenantId !== activeTenantId)) {
      throw new NotFoundException('Consultation not found');
    }
  }

  @Post('revoke-impersonation')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current impersonation token' })
  @ApiResponse({ status: 200, description: 'Impersonation token revoked', type: RevokeImpersonationResponse })
  @ApiResponse({ status: 400, description: 'Caller is not currently impersonating' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async revokeImpersonation(@Request() req: any): Promise<RevokeImpersonationResponse> {
    const user = this.clsService.get('user');
    if (!user) {
      throw new UnauthorizedException('User not found in context');
    }

    // TASK-295 L-3: only an actively-impersonated token may be revoked.
    if (!user.impersonatedBy) {
      throw new BadRequestException('Not currently impersonating');
    }

    // TASK-295 C-4: actually revoke the JWT by adding its jti to the
    // Redis-backed revocation set. JwtStrategy.validate consults this set
    // on every subsequent request so the revoked token fails at the very
    // next request.
    if (user.jti) {
      await this.jwtRevocationService.revoke(user.jti, user.exp);
    }

    await this.authService.trackAuthentication(user.id, {
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      endpoint: '/auth/revoke-impersonation',
      method: 'POST',
    });

    // TASK-331 M-3 — explicit IMPERSONATION stop bracket (mirrors the START in
    // impersonate()). `user.impersonatedBy` is guaranteed by the L-3 guard
    // above. Fire-and-forget audit side-channel.
    this.eventEmitter?.emit(EventTypes.UserAuthenticated, {
      userId: user.impersonatedBy,
      impersonatedUserId: user.id,
      phase: 'STOP',
      endpoint: '/auth/revoke-impersonation',
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    });

    // AC-11 (TASK-336): dedicated, semantically named end event (in addition to
    // the legacy bracket above) so audit consumers get a precise signal.
    this.eventEmitter?.emit(ImpersonationEvents.Ended, {
      adminId: user.impersonatedBy,
      targetUserId: user.id,
      success: true,
      endpoint: '/auth/revoke-impersonation',
      method: 'POST',
      ip: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'] || 'Unknown',
      timestamp: new Date(),
    } satisfies ImpersonationEventPayload);

    // TASK-401 — forced audit row for the lifecycle END, symmetric with the
    // USER_IMPERSONATION_STARTED row minted by AdminImpersonationController
    // (TASK-396 forceAuditLog pattern). The impersonation token always carries
    // the resolved tenant, so CLS attribution is correct here.
    this.eventEmitter?.emit(SysEventType.ResourceViewed, {
      responsibleEntityId: user.impersonatedBy,
      responsibleIp: req.ip || '127.0.0.1',
      resourceType: ResourceType.User,
      resourceId: user.id,
      correlationId: this.clsService.get('correlationId') ?? undefined,
      tenantId: this.clsService.get('tenantId') ?? user.tenantId ?? undefined,
      forceAuditLog: true,
      data: {
        action: 'USER_IMPERSONATION_ENDED',
        impersonatorUserId: user.impersonatedBy,
        targetUserId: user.id,
        tenantId: this.clsService.get('tenantId') ?? user.tenantId ?? null,
        endedAt: new Date().toISOString(),
      },
    });
    return { success: true };
  }

  /**
   * Get user roles from database.
   *
   * TASK-307 W6.1 (audit C-10) — delegates to `UserRoleAssignmentService`
   * which performs the `include: { Role: true }` join behind a typed
   * application-service boundary. Returned shape preserves the legacy
   * (`{ id, name, permissions? }`) contract `getUserPermissions` consumes.
   */
  private async getUserRoles(userId: string) {
    return this.userRoleAssignmentService.findActiveRolesForUser(userId);
  }

  /**
   * Get user permissions from roles
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getUserPermissions(roles: any[]): Promise<string[]> {
    const permissions = new Set<string>();

    for (const role of roles) {
      if (role.permissions && Array.isArray(role.permissions)) {
        role.permissions.forEach((permission: string) => permissions.add(permission));
      }
    }

    return Array.from(permissions);
  }

  /**
   * Resolve tenant by key — validates existence and enabled status
   */
  private async resolveTenant(tenantKey: string): Promise<{ id: string; key: string }> {
    const tenant = await this.tenantRepository.findFirst({
      filters: {
        key: tenantKey,
        resourceStatus: { equals: ResourceStatusType.ENABLED },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (!tenant) {
      throw new BadRequestException('Invalid or disabled tenant');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { id: tenant.id, key: (tenant as any).key ?? tenantKey };
  }
}
