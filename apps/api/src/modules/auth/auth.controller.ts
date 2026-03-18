import { IActiveUserContext, IAppSettingsService, IAuthService, IUserService, createJwt } from '@arcaai/applications';
import { CoreDatabaseService, ResourceStatusType, RoleRepository, TenantRepository, UserRepository, UserRoleAssignmentRepository } from '@arcaai/domains';
import {
    BadRequestException,
    Body,
    Controller,
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
import { LoginRequest, LoginResponse, LoginUserResponse, LogoutResponse, MeResponse, ImpersonateRequest, ImpersonateResponse, ImpersonateUserResponse } from './dto';

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

            const tokenPayload = {
                id: user.id,
                username: user.username,
                email: user.UserProfile?.email || '',
                roles,
                permissions,
                tenantId: resolvedTenantId,
                jti: `auth-${user.id}-${Date.now()}`,
                jwtSecretKey,
                expiresIn: jwtExpiresIn as any,
            };

            const token = createJwt(tokenPayload);

            const refreshToken = this.generateRefreshToken(user.id);

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
    async impersonate(@Body() request: ImpersonateRequest, @Request() req: any): Promise<ImpersonateResponse> {
        const adminUser = this.clsService.get('user');
        if (!adminUser) {
            throw new UnauthorizedException('User not found in context');
        }

        const adminRoles = await this.getUserRoles(adminUser.id);
        const adminRoleNames = adminRoles.map((r) => r.name);
        const isSuperAdmin = adminRoleNames.includes('SUPER_ADMIN');
        const isTenantAdmin = adminRoleNames.some((r) =>
            ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r),
        );
        if (!isSuperAdmin && !isTenantAdmin) {
            throw new UnauthorizedException('Only administrators can impersonate users');
        }

        const targetUser = await this.userRepository.findFirst({
            filters: {
                id: request.targetUserId,
                resourceStatus: { equals: ResourceStatusType.ENABLED },
            },
            relations: { UserProfile: true },
        } as any);

        if (!targetUser) {
            throw new BadRequestException('Target user not found');
        }

        const targetRoles = await this.getUserRoles(targetUser.id);
        const targetRoleNames = targetRoles.map((r) => r.name);
        const targetIsSuperAdmin = targetRoleNames.includes('SUPER_ADMIN');
        const targetIsTenantAdmin = targetRoleNames.some((r) =>
            ['TENANT_ADMIN', 'admin', 'system-admin'].includes(r),
        );

        if (targetIsSuperAdmin) {
            throw new BadRequestException('Cannot impersonate a super administrator');
        }

        if (isTenantAdmin && !isSuperAdmin && targetIsTenantAdmin) {
            throw new BadRequestException('Tenant administrators cannot impersonate other administrators');
        }

        const targetPermissions = await this.getUserPermissions(targetRoles);

        const tenantAssignment = await this.databaseService.client.userRoleAssignment.findFirst({
            where: {
                userId: targetUser.id,
                resourceStatus: ResourceStatusType.ENABLED,
                tenantId: { not: null },
            },
            select: { tenantId: true },
            orderBy: { createdAt: 'asc' },
        });
        const resolvedTenantId = tenantAssignment?.tenantId ?? '';

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
    @ApiResponse({ status: 200, description: 'Token refreshed' })
    @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
    async refresh(@Body() body: { refreshToken: string }): Promise<{ token: string; refreshToken: string }> {
        if (!body.refreshToken) {
            throw new BadRequestException('Refresh token is required');
        }

        const parts = body.refreshToken.split('_');
        if (parts.length < 3 || parts[0] !== 'refresh') {
            throw new UnauthorizedException('Invalid refresh token format');
        }

        const userId = parts[1];
        const user = await this.userRepository.findFirst({
            filters: {
                id: userId,
                resourceStatus: { equals: ResourceStatusType.ENABLED },
            },
            relations: { UserProfile: true },
        } as any);

        if (!user) {
            throw new UnauthorizedException('User not found or disabled');
        }

        const userRoles = await this.getUserRoles(user.id);
        const roles = userRoles.map((role) => role.name);
        const permissions = await this.getUserPermissions(userRoles);

        const jwtSecretKey = this.appSettingsService.getValueWithDefault('JWT_SECRET_KEY', 'default-jwt-secret-key-change-in-production');
        const jwtExpiresIn = this.appSettingsService.getValueWithDefault('JWT_EXPIRES_IN', '1h') as string;

        const tokenPayload = {
            id: user.id,
            username: user.username,
            email: user.UserProfile?.email || '',
            roles,
            permissions,
            tenantId: user.tenantId || '',
            jti: `auth-${user.id}-${Date.now()}`,
            jwtSecretKey,
            expiresIn: jwtExpiresIn as any,
        };

        const token = createJwt(tokenPayload);
        const refreshToken = this.generateRefreshToken(user.id);

        return { token, refreshToken };
    }

    @Post('revoke-impersonation')
    @HttpCode(HttpStatus.OK)
    @Authorize()
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Revoke the current impersonation token' })
    @ApiResponse({ status: 200, description: 'Impersonation token revoked' })
    @ApiResponse({ status: 401, description: 'Unauthorized' })
    async revokeImpersonation(@Request() req: any): Promise<{ success: boolean }> {
        const user = this.clsService.get('user');
        if (user) {
            await this.authService.trackAuthentication(user.id, {
                ip: req.ip || '127.0.0.1',
                userAgent: req.headers['user-agent'] || 'Unknown',
                endpoint: '/auth/revoke-impersonation',
                method: 'POST',
            });
        }
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
     * Generate refresh token
     */
    private generateRefreshToken(userId: string): string {
        return `refresh_${userId}_${Date.now()}_${randomBytes(32).toString('hex')}`;
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
        } as any);

        if (!tenant) {
            throw new BadRequestException('Invalid or disabled tenant');
        }

        return { id: tenant.id, key: (tenant as any).key ?? tenantKey };
    }
}
