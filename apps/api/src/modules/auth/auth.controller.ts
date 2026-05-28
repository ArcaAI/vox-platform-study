import { IActiveUserContext, IAppSettingsService, IAuthService, IJwtRevocationService, IRefreshTokenService, IUserService, createJwt } from '@arcaai/applications';
import {
  CoreDatabaseService,
  ResourceStatusType,
  RoleRepository,
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
  Post,
  Request,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { Authorize } from '../../decorators';
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
import { StreamTicketService } from './stream-ticket.service';

const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

@ApiTags('auth')
@Throttle({ default: { limit: 10, ttl: 60000 } })
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(IUserService) private readonly userService: IUserService,
    @Inject(IAuthService) private readonly authService: IAuthService,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    private readonly userRepository: UserRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly roleRepository: RoleRepository,
    private readonly tenantRepository: TenantRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly streamTicketService: StreamTicketService,
    @Inject(IJwtRevocationService) private readonly jwtRevocationService: IJwtRevocationService,
    @Inject(IRefreshTokenService) private readonly refreshTokenService: IRefreshTokenService,
  ) {}

  @Post('login')
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
      const isSuperAdmin = roles.includes(SUPER_ADMIN_ROLE);

      // Tenant validation: required for non-super-admin users
      let resolvedTenantId = '';
      let resolvedTenantKey = '';

      if (isSuperAdmin) {
        // Super admins can optionally scope to a tenant
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

        // Verify the user has at least one role assignment for this tenant
        const tenantRoleAssignment = await this.databaseService.client.userRoleAssignment.findFirst({
          where: {
            userId: user.id,
            tenantId: resolvedTenantId,
            resourceStatus: ResourceStatusType.ENABLED,
          },
        });

        if (!tenantRoleAssignment) {
          throw new UnauthorizedException('User does not have access to the specified tenant');
        }
      }

      const permissions = await this.getUserPermissions(userRoles);

      const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
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

      return {
        user: userResponse,
        token,
        refreshToken,
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
    try {
      const user = this.clsService.get('user');
      if (user) {
        // Track the logout
        await this.authService.trackAuthentication(user.id, {
          ip: req.ip || '127.0.0.1',
          userAgent: req.headers['user-agent'] || 'Unknown',
          endpoint: '/auth/logout',
          method: 'POST',
        });
      }
      return {
        success: true,
        message: 'Successfully logged out',
      };
    } catch {
      // Non-fatal: proceed with logout even if tracking fails
      return {
        success: true,
        message: 'Successfully logged out',
      };
    }
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

  @Post('impersonate')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Impersonate another user (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Impersonation token generated',
    type: ImpersonateResponse,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - requires admin role' })
  @ApiResponse({ status: 400, description: 'Cannot impersonate admin users' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async impersonate(@Body() request: ImpersonateRequest, @Request() req: any): Promise<ImpersonateResponse> {
    const adminUser = this.clsService.get('user');
    if (!adminUser) {
      throw new UnauthorizedException('User not found in context');
    }

    const adminRoles = await this.getUserRoles(adminUser.id);
    const adminRoleNames = adminRoles.map((r) => r.name);
    const isSuperAdmin = adminRoleNames.includes('SUPER_ADMIN');
    const isTenantAdmin = adminRoleNames.some((r) => ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r));
    if (!isSuperAdmin && !isTenantAdmin) {
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
    const targetIsSuperAdmin = targetRoleNames.includes('SUPER_ADMIN');
    const targetIsTenantAdmin = targetRoleNames.some((r) => ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r));

    if (targetIsSuperAdmin) {
      throw new BadRequestException('Cannot impersonate a super administrator');
    }

    if (isTenantAdmin && !isSuperAdmin && targetIsTenantAdmin) {
      throw new BadRequestException('Tenant administrators cannot impersonate other administrators');
    }

    const targetPermissions = await this.getUserPermissions(targetRoles);

    // TASK-295 H-3: resolve the impersonation tenant from the target user's
    // ENABLED userRoleAssignments. Caller may pin a specific tenant via
    // `targetTenantId`; otherwise we pick the oldest assignment for backward
    // compatibility with the previous behavior.
    const targetAssignments = await this.databaseService.client.userRoleAssignment.findMany({
      where: {
        userId: targetUser.id,
        resourceStatus: ResourceStatusType.ENABLED,
        tenantId: { not: null },
      },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });

    const targetTenantIds = Array.from(
      new Set(targetAssignments.map((row) => row.tenantId).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    );

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
    // own tenant. SUPER_ADMIN remains unrestricted (cross-tenant impersonation
    // is part of the business requirement for global admins).
    if (!isSuperAdmin) {
      const adminTenantId = adminUser.tenantId;
      if (!adminTenantId) {
        throw new BadRequestException('Tenant admin missing tenant context');
      }
      if (adminTenantId !== resolvedTenantId) {
        throw new ForbiddenException('Tenant admin cannot impersonate users outside their own tenant');
      }
    }

    const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
    const jwtImpersonationExpiresIn = this.appSettingsService.getValueWithDefault('JWT_IMPERSONATION_EXPIRES_IN', '15m') as string;

    const tokenPayload = {
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId,
      impersonatedBy: adminUser.id,
      jti: `impersonate-${adminUser.id}-${targetUser.id}-${Date.now()}`,
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

    const userResponse = new ImpersonateUserResponse({
      id: targetUser.id,
      username: targetUser.username,
      email: targetUser.UserProfile?.email || '',
      roles: targetRoleNames,
      permissions: targetPermissions,
      tenantId: resolvedTenantId || undefined,
    });

    return {
      user: userResponse,
      token,
      impersonatedBy: adminUser.id,
    };
  }

  @Post('refresh')
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

    const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
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
    const tenantId = user.tenantId ?? this.clsService.get('tenantId') ?? null;
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
    return { success: true };
  }

  /**
   * Get user roles from database
   */
  private async getUserRoles(userId: string) {
    // Use Prisma directly to include Roles relation (repository doesn't support dynamic includes)
    const userRoleAssignments = await this.databaseService.client.userRoleAssignment.findMany({
      where: {
        userId: userId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      include: {
        Role: true,
      },
    });

    return userRoleAssignments.map((assignment) => assignment.Role).filter((role) => role);
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
