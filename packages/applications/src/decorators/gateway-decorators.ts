import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PERMISSIONS_KEY, RATE_LIMIT_KEY } from '../services/auth/gateway-auth.guard';

/**
 * Rate limit configuration interface
 */
export interface RateLimitOptions {
    requests: number;
    windowMs: number;
    message?: string;
    skipIf?: (request: any) => boolean;
}

/**
 * Permissions decorator
 * Specifies required permissions for an endpoint
 */
export const Permissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Rate limit decorator
 * Configures rate limiting for an endpoint
 */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

/**
 * Medical endpoint decorator
 * Combines common decorators for medical data endpoints
 */
export const MedicalEndpoint = (permissions: string[], summary?: string) => {
    return applyDecorators(
        Permissions(...permissions),
        ApiBearerAuth(),
        ApiOperation({ summary: summary || 'Medical data endpoint' }),
        ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' }),
        ApiResponse({ status: 403, description: 'Forbidden - Insufficient permissions' }),
        ApiResponse({ status: 429, description: 'Too Many Requests - Rate limit exceeded' }),
        RateLimit({ requests: 100, windowMs: 60000 }) // Default rate limit for medical endpoints
    );
};

/**
 * Admin endpoint decorator
 * For administrative operations with higher rate limits
 */
export const AdminEndpoint = (permissions: string[], summary?: string) => {
    return applyDecorators(
        Permissions(...permissions),
        ApiBearerAuth(),
        ApiOperation({ summary: summary || 'Administrative endpoint' }),
        ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' }),
        ApiResponse({ status: 403, description: 'Forbidden - Admin access required' }),
        ApiResponse({ status: 429, description: 'Too Many Requests - Rate limit exceeded' }),
        RateLimit({ requests: 500, windowMs: 60000 }) // Higher rate limit for admin operations
    );
};

/**
 * Public endpoint decorator
 * For endpoints that don't require authentication
 */
export const PublicEndpoint = (summary?: string) => {
    return applyDecorators(
        ApiOperation({ summary: summary || 'Public endpoint' }),
        ApiResponse({ status: 200, description: 'Success' }),
        RateLimit({ requests: 50, windowMs: 60000 }) // Conservative rate limit for public endpoints
    );
};

/**
 * HIPAA audit decorator
 * Marks endpoints that require HIPAA audit logging
 */
export const HIPAAAudit = (auditAction: string) => {
    return SetMetadata('hipaa-audit', { action: auditAction, timestamp: new Date() });
};

/**
 * Session management decorator
 * For session-related endpoints with specific rate limits and permissions
 */
export const SessionEndpoint = (permissions: string[], summary?: string) => {
    return applyDecorators(
        Permissions(...permissions),
        ApiBearerAuth(),
        ApiOperation({ summary: summary || 'Session management endpoint' }),
        ApiResponse({ status: 401, description: 'Unauthorized - Invalid or missing token' }),
        ApiResponse({ status: 403, description: 'Forbidden - Session access required' }),
        ApiResponse({ status: 429, description: 'Too Many Requests - Rate limit exceeded' }),
        HIPAAAudit('session_access'),
        RateLimit({ requests: 200, windowMs: 60000 }) // Higher rate limit for session operations
    );
};