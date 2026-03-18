import { Injectable, UnauthorizedException, Logger, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';
import { IAuthService } from './IAuthService';

/**
 * API Gateway JWT Strategy
 * Enhanced JWT authentication for API Gateway with additional security checks
 */
@Injectable()
export class GatewayJwtStrategy extends PassportStrategy(Strategy, 'gateway-jwt') {
    private readonly logger = new Logger(GatewayJwtStrategy.name);

    constructor(
        @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
        @Inject(IAuthService) private readonly authService: IAuthService,
    ) {
        // JWT secret is now managed exclusively via AppSettingsService (database-stored settings)
        const jwtSecret = appSettingsService.getValueWithDefault(
            'JWT_SECRET_KEY',
            'default-jwt-secret-key-change-in-production'
        );

        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: jwtSecret,
            algorithms: ['HS256'],
            passReqToCallback: true,
        });
    }

    async validate(request: any, payload: any): Promise<any> {
        try {
            // Enhanced validation for API Gateway
            const { sub: userId, jti: tokenId, roles, permissions, organizationId } = payload;

            // Validate token hasn't been revoked
            const isRevoked = await this.authService.isTokenRevoked(tokenId);
            if (isRevoked) {
                this.logger.warn({
                    message: 'Revoked token attempted access',
                    userId,
                    tokenId,
                    ip: request.ip,
                    userAgent: request.headers['user-agent'],
                });
                throw new UnauthorizedException('Token has been revoked');
            }

            // Validate user is still active
            const user = await this.authService.validateUser(userId);
            if (!user || !user.isActive) {
                this.logger.warn({
                    message: 'Inactive user attempted access',
                    userId,
                    ip: request.ip,
                });
                throw new UnauthorizedException('User account is inactive');
            }

            // Enhanced user context for gateway
            const gatewayUser = {
                id: userId,
                email: user.email,
                roles: roles || [],
                permissions: permissions || [],
                organizationId,
                departmentId: user.departmentId,
                isActive: user.isActive,
                lastLoginAt: user.lastLoginAt,
                tokenId,
                // Gateway-specific metadata
                gateway: {
                    accessLevel: this.determineAccessLevel(roles),
                    rateLimit: this.determineRateLimit(roles, organizationId),
                    allowedEndpoints: await this.getAllowedEndpoints(userId, roles),
                },
            };

            // Track successful authentication
            await this.authService.trackAuthentication(userId, {
                ip: request.ip,
                userAgent: request.headers['user-agent'],
                endpoint: request.path,
                method: request.method,
            });

            return gatewayUser;
        } catch (error) {
            this.logger.error({
                message: 'Authentication failed',
                error: error instanceof Error ? error.message : String(error),
                ip: request.ip,
                userAgent: request.headers['user-agent'],
            });
            throw new UnauthorizedException('Authentication failed');
        }
    }

    /**
     * Determine access level based on user roles
     */
    private determineAccessLevel(roles: string[]): 'basic' | 'elevated' | 'admin' {
        if (roles.includes('admin') || roles.includes('system-admin')) {
            return 'admin';
        }
        if (roles.includes('physician') || roles.includes('nurse') || roles.includes('manager')) {
            return 'elevated';
        }
        return 'basic';
    }

    /**
     * Determine rate limit based on user roles and organization
     */
    private determineRateLimit(
        roles: string[],
        organizationId: string,
    ): {
        requests: number;
        windowMs: number;
    } {
        // Admin users get higher limits
        if (roles.includes('admin')) {
            return { requests: 1000, windowMs: 60000 }; // 1000 requests per minute
        }

        // Healthcare professionals get elevated limits
        if (roles.includes('physician') || roles.includes('nurse')) {
            return { requests: 500, windowMs: 60000 }; // 500 requests per minute
        }

        // Default limits for other users
        return { requests: 100, windowMs: 60000 }; // 100 requests per minute
    }

    /**
     * Get allowed endpoints for user based on roles and permissions
     */
    private async getAllowedEndpoints(userId: string, roles: string[]): Promise<string[]> {
        // This would typically query a permissions service
        // For now, return basic endpoints based on roles
        const baseEndpoints = ['/api/v1/health', '/api/v1/auth/refresh'];

        if (roles.includes('physician')) {
            baseEndpoints.push('/api/patients/*', '/api/sessions/*', '/api/medical/*');
        }

        if (roles.includes('nurse')) {
            baseEndpoints.push('/api/patients/read', '/api/sessions/read');
        }

        if (roles.includes('admin')) {
            baseEndpoints.push('/api/*'); // Admin access to all endpoints
        }

        return baseEndpoints;
    }
}
