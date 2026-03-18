import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
    ForbiddenException,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

/**
 * Permission metadata key for decorator
 */
export const PERMISSIONS_KEY = 'permissions';

/**
 * Rate limit metadata key for decorator
 */
export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * API Gateway Authentication Guard
 * Combines JWT authentication with additional gateway-specific security checks
 */
@Injectable()
export class GatewayAuthGuard extends AuthGuard('gateway-jwt') implements CanActivate {
    private readonly logger = new Logger(GatewayAuthGuard.name);

    constructor(private reflector: Reflector) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();

        // Skip authentication for health check and public endpoints
        if (this.isPublicEndpoint(request.path)) {
            return true;
        }

        // Perform JWT authentication
        const isAuthenticated = await super.canActivate(context);
        if (!isAuthenticated) {
            return false;
        }

        // Get user from request (set by JWT strategy)
        const user = request.user;
        if (!user) {
            throw new UnauthorizedException('User not found in request');
        }

        // Check endpoint permissions
        const hasPermission = await this.checkPermissions(context, user);
        if (!hasPermission) {
            this.logger.warn({
                message: 'Permission denied',
                userId: user.id,
                endpoint: request.path,
                method: request.method,
                userRoles: user.roles,
            });
            throw new ForbiddenException('Insufficient permissions for this endpoint');
        }

        // Log successful access for audit
        this.logger.debug({
            message: 'Access granted',
            userId: user.id,
            endpoint: request.path,
            method: request.method,
            accessLevel: user.gateway?.accessLevel,
        });

        return true;
    }

    /**
     * Check if endpoint is public (doesn't require authentication)
     */
    private isPublicEndpoint(path: string): boolean {
        const publicPaths = [
            '/api/v1/health',
            '/api/v1/auth/login',
            '/api/v1/auth/callback',
            '/api/v1/docs',
        ];

        return publicPaths.some(publicPath => path.startsWith(publicPath));
    }

    /**
     * Check if user has required permissions for the endpoint
     */
    private async checkPermissions(context: ExecutionContext, user: any): Promise<boolean> {
        const request = context.switchToHttp().getRequest();

        // Get required permissions from decorator
        const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
            PERMISSIONS_KEY,
            [context.getHandler(), context.getClass()]
        );

        // If no specific permissions required, check basic access
        if (!requiredPermissions || requiredPermissions.length === 0) {
            return this.checkBasicAccess(request.path, user);
        }

        // Check if user has any of the required permissions
        const userPermissions = user.permissions || [];
        const hasRequiredPermission = requiredPermissions.some(permission =>
            userPermissions.includes(permission)
        );

        if (!hasRequiredPermission) {
            // Check role-based access as fallback
            return this.checkRoleBasedAccess(requiredPermissions, user.roles || []);
        }

        return true;
    }

    /**
     * Check basic access based on user roles and endpoint patterns
     */
    private checkBasicAccess(path: string, user: any): boolean {
        const roles = user.roles || [];

        // Admin has access to everything
        if (roles.includes('admin') || roles.includes('system-admin')) {
            return true;
        }

        // Healthcare professionals have access to medical endpoints
        if (roles.includes('physician') || roles.includes('nurse')) {
            const medicalEndpoints = ['/api/patients', '/api/sessions', '/api/medical'];
            if (medicalEndpoints.some(endpoint => path.startsWith(endpoint))) {
                return true;
            }
        }

        // Basic authenticated users have access to profile and general endpoints
        const basicEndpoints = ['/api/auth/profile', '/api/auth/refresh', '/api/auth/logout'];
        return basicEndpoints.some(endpoint => path.startsWith(endpoint));
    }

    /**
     * Check role-based access as fallback when specific permissions are not found
     */
    private checkRoleBasedAccess(requiredPermissions: string[], userRoles: string[]): boolean {
        // Map permissions to roles
        const permissionRoleMap: Record<string, string[]> = {
            'medical:read': ['physician', 'nurse', 'medical-assistant'],
            'medical:write': ['physician', 'nurse'],
            'medical:delete': ['physician'],
            'patient:read': ['physician', 'nurse', 'medical-assistant'],
            'patient:write': ['physician', 'nurse'],
            'patient:delete': ['physician'],
            'session:read': ['physician', 'nurse', 'medical-assistant'],
            'session:write': ['physician', 'nurse'],
            'session:delete': ['physician'],
            'admin:read': ['admin', 'system-admin'],
            'admin:write': ['admin', 'system-admin'],
            'admin:delete': ['system-admin'],
        };

        return requiredPermissions.some(permission => {
            const allowedRoles = permissionRoleMap[permission] || [];
            return allowedRoles.some(role => userRoles.includes(role));
        });
    }

    handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
        const request = context.switchToHttp().getRequest();

        if (err || !user) {
            this.logger.warn({
                message: 'Authentication failed',
                endpoint: request.path,
                method: request.method,
                error: err?.message,
                info: info?.message,
                ip: request.ip,
                userAgent: request.headers['user-agent'],
            });
            throw err || new UnauthorizedException('Invalid token');
        }

        return user;
    }
}