import {
  IActiveUserContext,
  IAppSettingsService,
  IAuthService,
  IJwtRevocationService,
  IRefreshTokenService,
  IUserDepartmentService,
  IUserRoleAssignmentService,
  IUserService,
  IWorkflowRunService,
  SecretsService,
  createJwt,
  // Password rotation surfaced at login (warning-only).
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
  Logger,
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
import { StreamSessionTenantBindingService } from '../../common';
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

// SUPER_ADMIN (formerly SUPER_ADMIN, renamed ) is the single
// elevated role; the earlier, unrelated retired SUPER_ADMIN role ()
// stays retired under its own reserved id.
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

// A previous class-wide `@Throttle({ default: { limit: 10,
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
  private readonly logger = new Logger(AuthController.name);

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
    // Login enforces full membership (role + department);
    // this resolves the department half via a pre-auth baseClient lookup.
    @Inject(IUserDepartmentService) private readonly userDepartmentService: IUserDepartmentService,
    // Emits the explicit impersonation start/stop audit bracket.
    // EventEmitter2 is globally provided via EventEmitterModule (same source the
    // ImpersonationAuditInterceptor uses for the per-request rows).
    private readonly eventEmitter: EventEmitter2,
    // Mint-time tenant-ownership check for live-summary stream
    // tickets (defense-in-depth alongside the SSE route's @TenantOwnedResource).
    private readonly consultationRepository: ConsultationRepository,
    // Mint-time tenant-ownership check for `stt_session:*`
    // tickets, resolved via the gateway-side sessionId → tenantId binding
    // written at session create (same instance the WS gateway and the
    // DELETE-route interceptor consult).
    private readonly streamSessionTenantBinding: StreamSessionTenantBindingService,
    // Mint-time tenant-ownership check for `workflow_run:<runId>` tickets (TASK-722 Task 7).
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
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
  // 5 req/min: tight bound vs credential stuffing.
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
    // The audit row's failure reason. Set immediately before each
    // throw and emitted once from the catch below, so there is a single
    // emission site rather than one per rejection branch. Server-side only:
    // the 401 RESPONSE stays deliberately uniform ('Invalid credentials' for
    // both unknown-user and bad-password) so it is never an account oracle.
    let failureReason = 'authentication_failed';
    let failedUserId: string | undefined;

    try {
      if (!request.username || !request.password) {
        failureReason = 'missing_credentials';
        throw new BadRequestException('Username and password are required');
      }

      // `Repository.findFirst` THROWS `DataNotFoundException` on
      // a miss (it never returns null), so the unknown-username case used to
      // land in the catch-all below and answer 'Authentication failed' while a
      // WRONG PASSWORD answered 'Invalid credentials'. That difference was a
      // username-enumeration oracle, contradicting the stated intent of the
      // identical-message rule further down. Normalising here makes both
      // branches indistinguishable to the client while still recording
      // distinct audit reasons server-side.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the repository's generic find props aren't narrowed to UserEntity here; the value is immediately guarded by the `if (!user)` below
      let user: any;
      try {
        user = await this.userRepository.findFirst({
          filters: {
            username: request.username,
            resourceStatus: { equals: ResourceStatusType.ENABLED },
          },
          relations: { UserProfile: true },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      } catch {
        user = null;
      }

      if (!user) {
        failureReason = 'unknown_or_disabled_user';
        throw new UnauthorizedException('Invalid credentials');
      }

      failedUserId = user.id;

      const isPasswordValid = await bcrypt.compare(request.password, user.password);
      if (!isPasswordValid) {
        failureReason = 'invalid_password';
        throw new UnauthorizedException('Invalid credentials');
      }

      // Service accounts are API-only principals (they authenticate
      // with API keys). Interactive login is refused AFTER the password check
      // so the response cannot be used as an account-type oracle for guessed
      // credentials, and no lastLoginAt/lastActiveAt stamp is written.
      if (user.isServiceAccount) {
        failureReason = 'service_account_interactive_login';
        throw new UnauthorizedException('Service accounts cannot sign in interactively');
      }

      const userRoles = await this.getUserRoles(user.id);
      const roles = userRoles.map((role) => role.name);
      const isSuperAdmin = roles.includes(SUPER_ADMIN_ROLE);

      // Tenant validation: required for non-super-admin users
      let resolvedTenantId = '';
      let resolvedTenantKey = '';

      if (isSuperAdmin) {
        // Super Admins can optionally scope to a tenant
        if (request.tenantKey) {
          const tenant = await this.resolveTenant(request.tenantKey);
          resolvedTenantId = tenant.id;
          resolvedTenantKey = tenant.key;
        }
      } else {
        if (!request.tenantKey) {
          failureReason = 'tenant_key_required';
          throw new BadRequestException('Tenant key is required for non-admin users');
        }

        const tenant = await this.resolveTenant(request.tenantKey);
        resolvedTenantId = tenant.id;
        resolvedTenantKey = tenant.key;

        // Tenant validation flows through
        // `UserRoleAssignmentService` instead of touching Prisma directly.
        const tenantRoleAssignment = await this.userRoleAssignmentService.findActiveAssignmentForUserInTenant(user.id, resolvedTenantId);

        if (!tenantRoleAssignment) {
          failureReason = 'tenant_access_denied';
          throw new UnauthorizedException('User does not have access to the specified tenant');
        }

        // Full tenant membership = an enabled role AND an
        // enabled department. The 401 message is intentionally identical to
        // the role miss above so the response never reveals which half of the
        // membership is incomplete. (Service accounts never reach this point —
        // they are rejected right after the password check; the guard is
        // kept as defence-in-depth.)
        if (!user.isServiceAccount) {
          const tenantDepartment = await this.userDepartmentService.findActiveDepartmentForUserInTenant(user.id, resolvedTenantId);

          if (!tenantDepartment) {
            failureReason = 'tenant_access_denied';
            throw new UnauthorizedException('User does not have access to the specified tenant');
          }
        }
      }

      const permissions = await this.getUserPermissions(userRoles);

      // JWT_SECRET_KEY is sourced
      // from SecretsService (cache-warmed at bootstrap, placeholder
      // refused by main.ts's boot assertion). Unifies the sign-path with
      // JwtStrategy.verify-path so the two cannot diverge.
      // JWT_EXPIRES_IN stays on AppSettings (it's a tunable, not a
      // secret — same rationale as oidc.strategy.ts:82-83).
      const jwtSecretKey = await this.resolveJwtSecretKey();
      if (!jwtSecretKey) {
        throw new UnauthorizedException('Authentication system not configured');
      }
      const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;

      // jti is randomBytes(16).hex — unpredictable, no
      // userId or timestamp leak. The legacy `auth-${user.id}-${Date.now()}`
      // shape was guessable and tied the jti's information density to the
      // user id, which is itself sometimes assumed-public elsewhere.
      const jti = randomBytes(16).toString('hex');

      // Persist the refresh token in Redis so it
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
        // Ride the family id through the access-token
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

      // Rotation check (warning only, never blocks). Disabled by
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
      // Persist the rejected attempt (AuditLogService writes a
      // LOGIN row with success=false). Fire-and-forget: an audit failure must
      // never turn a 401 into a 500, and the handler swallows its own errors.
      this.emitAuthenticationFailed({
        userId: failedUserId,
        attemptedUsername: request.username,
        reason: failureReason,
        endpoint: '/auth/login',
        method: 'POST',
        tenantKey: request.tenantKey,
        req,
      });

      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      throw new UnauthorizedException('Authentication failed');
    }
  }

  /**
   * Emit the failed-authentication audit event.
   *
   * Deliberately carries only whitelisted, non-secret fields: the attempted
   * username (never the password), a stable machine-readable reason slug
   * (never the raw exception message, which could leak internals into the
   * persisted row), and request provenance.
   */
  private emitAuthenticationFailed(params: {
    userId?: string;
    attemptedUsername?: string;
    reason: string;
    endpoint: string;
    method: string;
    tenantKey?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Express request; only `.ip` and `.headers['user-agent']` are read, both optional
    req?: any;
  }): void {
    // `EventEmitter2.emit` is SYNCHRONOUS, so a listener (or a downed event
    // bus) throwing here would replace the caller's 401 with a 500 — turning
    // an audit outage into an authentication outage, and handing attackers a
    // way to distinguish failure modes. Contained unconditionally.
    try {
      this.eventEmitter?.emit(EventTypes.UserAuthenticationFailed, {
        userId: params.userId,
        attemptedUsername: params.attemptedUsername,
        reason: params.reason,
        endpoint: params.endpoint,
        method: params.method,
        tenantKey: params.tenantKey,
        ip: params.req?.ip || '127.0.0.1',
        userAgent: params.req?.headers?.['user-agent'] || 'Unknown',
        timestamp: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to emit authentication-failure audit event (reason=${params.reason}): ${error instanceof Error ? error.message : String(error)}`,
      );
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

    // Revoke the access token's jti so any in-flight
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

    // Revoke the ENTIRE refresh-token family so the
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

    // Best-effort tracking of the logout event.
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
        roles,
        permissions,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Failed to retrieve user information');
    }
  }

  /**
   * Record a DENIED impersonation attempt as a dedicated
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
  // 10 req/min: same envelope as the retired class-wide
  // throttle, kept explicit. Impersonation is an admin-tier action and
  // does not need the more permissive SDK-poll bound.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  // A SUPER_ADMIN MAY impersonate a TENANT_ADMIN (and any
  // non-super-admin) cross-tenant; only SUPER_ADMIN TARGETS can never be
  // impersonated. A TENANT_ADMIN may impersonate only non-admin users within
  // its OWN tenant.
  @ApiOperation({
    summary: 'Impersonate another user (admin only)',
    description:
      'Mints a short-lived impersonation token. A SUPER_ADMIN may impersonate any ' +
      'non-super-admin user cross-tenant — including a TENANT_ADMIN. A TENANT_ADMIN may impersonate ' +
      'only non-admin users within its own tenant. SUPER_ADMIN targets ' +
      'can never be impersonated.',
  })
  @ApiResponse({
    status: 200,
    description: 'Impersonation token generated',
    type: ImpersonateResponse,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - caller is not an administrator' })
  @ApiResponse({ status: 403, description: 'Forbidden - tenant admin cannot impersonate outside its own tenant' })
  @ApiResponse({ status: 400, description: 'Invalid target (e.g. a super-admin target) or missing tenant assignment' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async impersonate(@Body() request: ImpersonateRequest, @Request() req: any): Promise<ImpersonateResponse> {
    const adminUser = this.clsService.get('user');
    if (!adminUser) {
      throw new UnauthorizedException('User not found in context');
    }

    // Nested impersonation is never allowed: an impersonated
    // session (impersonatedBy claim present) cannot start another. Backported
    // to this legacy route so no nesting path remains.
    if (adminUser.impersonatedBy) {
      this.recordImpersonationDenied(req, adminUser.id, request.targetUserId, ImpersonationDeniedReason.NestedImpersonation);
      throw new ForbiddenException('An impersonated session cannot start another impersonation');
    }

    // Self-impersonation guard (backported alongside the nested one).
    if (request.targetUserId === adminUser.id) {
      this.recordImpersonationDenied(req, adminUser.id, request.targetUserId, ImpersonationDeniedReason.SelfImpersonation);
      throw new BadRequestException('You cannot impersonate yourself');
    }

    const adminRoles = await this.getUserRoles(adminUser.id);
    const adminRoleNames = adminRoles.map((r) => r.name);
    // SUPER_ADMIN is the elevated cross-tenant
    // role (unrestricted); it carries the cross-tenant bypass below.
    const isSuperAdmin = adminRoleNames.includes(SUPER_ADMIN_ROLE);
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

    // A service account is an API-only principal; impersonating one
    // would mint the interactive session it must never have.
    if (targetUser.isServiceAccount) {
      this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.TargetIsServiceAccount);
      throw new BadRequestException('Cannot impersonate a service account');
    }

    const targetRoles = await this.getUserRoles(targetUser.id);
    const targetRoleNames = targetRoles.map((r) => r.name);
    // A SUPER_ADMIN target can never be
    // impersonated.
    const targetIsSuperAdmin = targetRoleNames.includes(SUPER_ADMIN_ROLE);
    const targetIsTenantAdmin = targetRoleNames.some((r) => ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r));

    if (targetIsSuperAdmin) {
      this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.TargetIsSuperAdmin);
      throw new BadRequestException('Cannot impersonate a super administrator');
    }

    if (isTenantAdmin && !isSuperAdmin && targetIsTenantAdmin) {
      this.recordImpersonationDenied(req, adminUser.id, targetUser.id, ImpersonationDeniedReason.TenantAdminTargetNotAllowed);
      throw new BadRequestException('Tenant administrators cannot impersonate other administrators');
    }

    const targetPermissions = await this.getUserPermissions(targetRoles);

    // Resolve the impersonation
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

    // Tenant admins must not impersonate users outside their
    // own tenant. SUPER_ADMIN remains unrestricted (cross-tenant impersonation
    // is part of the business requirement for super admins).
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

    // See login() for the JWT_SECRET_KEY resolution rationale.
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
      // Unpredictable jti (randomBytes(16).hex), same hygiene as
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

    // Explicit IMPERSONATION start bracket. The AuditAction enum
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

    // Dedicated, semantically named start event (in addition
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

    // Resolve the target's PRIMARY department for the
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
  // 60 req/min: the SDK rotates refresh tokens aggressively
  // (single-use refresh); the previous 10/min class-wide
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

    // Server-side validation through
    // RefreshTokenService. A prior `parts.split('_')` parser took
    // client-supplied input as the userId — a security hole, and the reason
    // that parser is retired. RefreshTokenService.consume:
    //   - looks the token up by sha256(token)
    //   - returns the ORIGINAL session's userId, tenantId, jti, and family
    //   - deletes the record (single-use) and flags reuse for family-revoke
    //   - throws UnauthorizedException on miss / reuse (let it bubble up)
    // A miss/reuse here is the single strongest token-theft
    // signal the platform emits (RFC 6749 §10.4 family reuse), so it gets an
    // audit row before the 401 bubbles up.
    let consumed: Awaited<ReturnType<typeof this.refreshTokenService.consume>>;
    try {
      consumed = await this.refreshTokenService.consume(body.refreshToken);
    } catch (error) {
      this.emitAuthenticationFailed({
        reason: 'refresh_token_rejected',
        endpoint: '/auth/refresh',
        method: 'POST',
      });
      throw error;
    }

    // Same `findFirst`-throws contract as login(): without this the
    // disabled-account branch below was unreachable, so the request surfaced
    // a raw DataNotFoundException (mapped to 404) instead of the intended
    // 401 — and emitted no audit row.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as login(): repository find props aren't narrowed to UserEntity, and the value is guarded by the `if (!user)` below
    let user: any;
    try {
      user = await this.userRepository.findFirst({
        filters: {
          id: consumed.userId,
          resourceStatus: { equals: ResourceStatusType.ENABLED },
        },
        relations: { UserProfile: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    } catch {
      user = null;
    }

    if (!user) {
      // The refresh token was valid but the account has since been disabled or
      // deleted — the exact window the access-token not-before stamp also
      // covers.
      this.emitAuthenticationFailed({
        userId: consumed.userId,
        reason: 'user_disabled_or_missing',
        endpoint: '/auth/refresh',
        method: 'POST',
      });
      throw new UnauthorizedException('User not found or disabled');
    }

    const userRoles = await this.getUserRoles(user.id);
    const roles = userRoles.map((role) => role.name);
    const permissions = await this.getUserPermissions(userRoles);

    // See login() for the JWT_SECRET_KEY resolution rationale.
    const jwtSecretKey = await this.resolveJwtSecretKey();
    if (!jwtSecretKey) {
      throw new UnauthorizedException('Authentication system not configured');
    }
    const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;

    // Fresh unpredictable jti per rotation.
    const newJti = randomBytes(16).toString('hex');

    // Refresh stays scoped to the tenant that ORIGINALLY
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
    summary: 'Issue a single-use, 30-second ticket for authenticating SSE streams',
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
    // The ACTIVE (CLS) tenant wins so a super admin's selected
    // `X-Tenant-Id` propagates into the ticket (`??` would have kept an empty-
    // string JWT tenant); fall back to the JWT tenant, then null.
    const tenantId = this.clsService.get('tenantId') || user.tenantId || null;

    // Defense-in-depth: any consultation-id-keyed
    // `consultation_*:<id>` ticket may only be minted for a consultation in the
    // caller's (active) tenant. The SSE routes are `@TenantOwnedResource`, but
    // the ticket bypasses that interceptor, so we re-check ownership here
    // before issuing.
    await this.assertConsultationScopeOwnership(body.scope, tenantId);

    // Same posture for `stt_session:<sessionId>` (live
    // transcript WS): the session must be bound to the caller's (active)
    // tenant. Fail-closed: a missing binding 404s too.
    await this.assertSttSessionScopeOwnership(body.scope, tenantId);

    // Same posture for `workflow_run:<runId>` (TASK-722's exposure-plane SSE
    // route): the run must belong to the caller's (active) tenant.
    // Fail-closed: a missing/foreign run 404s too.
    await this.assertWorkflowRunScopeOwnership(body.scope, tenantId);

    const issued = await this.streamTicketService.issueTicket({
      userId: user.id,
      tenantId,
      scope: body.scope,
      // Carry the impersonatedBy claim through the
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
   * For any consultation-id-keyed
   * `consultation_*:<id>` ticket scope (live-summary, harness-progress, and any
   * future sibling), verify the consultation belongs to the caller's active
   * tenant before minting. A missing OR cross-tenant consultation both yield
   * 404 (no existence leak), matching the SSE routes' `@TenantOwnedResource`
   * semantics. Non-consultation scopes pass through untouched. The explicit
   * tenant match is belt-and-suspenders for super admins whose `findById` may
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

  /** Scope prefix for live-transcript WS tickets consumed by `SttWsGateway`. */
  private static readonly STT_SESSION_SCOPE_PREFIX = 'stt_session:';

  /**
   * `stt_session:<sessionId>` tickets used to silently bypass the
   * consultation-only check above, so any authenticated user who learned a
   * foreign sessionId could mint a live-transcript WS ticket for it. Resolve
   * the session's owning tenant via the gateway-side binding written at
   * session create and require it to match the caller's active tenant. A
   * missing binding, a mismatch, and a lookup failure all yield 404 (no
   * existence leak) — mirroring the DELETE route's
   * `assertStreamSessionOwnership`. Non-`stt_session` scopes pass through
   * untouched.
   */
  private async assertSttSessionScopeOwnership(scope: string, activeTenantId: string | null): Promise<void> {
    if (!scope?.startsWith(AuthController.STT_SESSION_SCOPE_PREFIX)) {
      return;
    }
    const sessionId = scope.slice(AuthController.STT_SESSION_SCOPE_PREFIX.length);
    let boundTenantId: string | null;
    try {
      boundTenantId = await this.streamSessionTenantBinding.lookup(sessionId);
    } catch {
      boundTenantId = null;
    }
    if (boundTenantId === null || boundTenantId !== activeTenantId) {
      throw new NotFoundException('Session not found');
    }
  }

  /** Scope prefix for `workflow_run:<runId>` tickets consumed by the exposure-plane SSE route
   *  (`WorkflowsController.streamRunStatus`, TASK-722). */
  private static readonly WORKFLOW_RUN_SCOPE_PREFIX = 'workflow_run:';

  /**
   * `workflow_run:<runId>` tickets must be bound to the caller's active tenant. Reuses
   * `IWorkflowRunService.getRun`, which already 404s a foreign-tenant or unknown runId
   * (404-over-403) — rather than adding a second lookup path here. `activeTenantId === null`
   * fails closed the same way `assertSttSessionScopeOwnership` does (no active tenant can own
   * any run). Non-`workflow_run` scopes pass through untouched.
   */
  private async assertWorkflowRunScopeOwnership(scope: string, activeTenantId: string | null): Promise<void> {
    if (!scope?.startsWith(AuthController.WORKFLOW_RUN_SCOPE_PREFIX)) {
      return;
    }
    if (!activeTenantId) {
      throw new NotFoundException('Run not found');
    }
    const runId = scope.slice(AuthController.WORKFLOW_RUN_SCOPE_PREFIX.length);
    try {
      await this.workflowRunService.getRun(activeTenantId, runId);
    } catch {
      throw new NotFoundException('Run not found');
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

    // Only an actively-impersonated token may be revoked.
    if (!user.impersonatedBy) {
      throw new BadRequestException('Not currently impersonating');
    }

    // Actually revoke the JWT by adding its jti to the
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

    // Explicit IMPERSONATION stop bracket (mirrors the START in
    // impersonate()). `user.impersonatedBy` is guaranteed by the guard
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

    // Dedicated, semantically named end event (in addition to
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

    // Forced audit row for the lifecycle END, symmetric with the
    // USER_IMPERSONATION_STARTED row minted by AdminImpersonationController.
    // The impersonation token always carries
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
   * Delegates to `UserRoleAssignmentService`
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
