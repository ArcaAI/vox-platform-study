import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    UnauthorizedException,
    ForbiddenException,
    ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

let superCanActivateResult: boolean | Promise<boolean> = true;

vi.mock('@nestjs/passport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nestjs/passport')>();
    return {
        ...actual,
        AuthGuard: (_strategyName: string) => {
            return class MockAuthGuard {
                canActivate(_context: ExecutionContext): boolean | Promise<boolean> {
                    return superCanActivateResult;
                }
            };
        },
    };
});

import { GatewayAuthGuard, PERMISSIONS_KEY, RATE_LIMIT_KEY } from '../gateway-auth.guard';

function createMockExecutionContext(overrides: {
    path?: string;
    method?: string;
    user?: any;
    ip?: string;
    userAgent?: string;
}): ExecutionContext {
    const request = {
        path: overrides.path ?? '/some-endpoint',
        method: overrides.method ?? 'GET',
        user: overrides.user,
        ip: overrides.ip ?? '127.0.0.1',
        headers: { 'user-agent': overrides.userAgent ?? 'test-agent' },
    };

    const handler = vi.fn();
    const klass = class {};

    return {
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => ({}),
            getNext: () => vi.fn(),
        }),
        getHandler: () => handler,
        getClass: () => klass,
        getType: () => 'http',
        getArgs: () => [request],
        getArgByIndex: (index: number) => [request][index],
        switchToRpc: () => ({} as any),
        switchToWs: () => ({} as any),
    } as unknown as ExecutionContext;
}

describe('GatewayAuthGuard', () => {
    let guard: GatewayAuthGuard;
    let mockReflector: Reflector & { getAllAndOverride: ReturnType<typeof vi.fn> };
    let guardProto: any;

    beforeEach(() => {
        vi.clearAllMocks();
        superCanActivateResult = true;
        mockReflector = {
            getAllAndOverride: vi.fn().mockReturnValue(undefined),
        } as unknown as Reflector & { getAllAndOverride: ReturnType<typeof vi.fn> };
        guard = new GatewayAuthGuard(mockReflector);
        guardProto = Object.getPrototypeOf(guard);
    });

    describe('exported constants', () => {
        it('should export PERMISSIONS_KEY as "permissions"', () => {
            expect(PERMISSIONS_KEY).toBe('permissions');
        });

        it('should export RATE_LIMIT_KEY as "rateLimit"', () => {
            expect(RATE_LIMIT_KEY).toBe('rateLimit');
        });
    });

    describe('canActivate — public endpoints', () => {
        it.each([
            ['/api/v1/health', 'health check'],
            ['/api/v1/auth/login', 'login'],
            ['/api/v1/auth/callback', 'OAuth callback'],
            ['/api/v1/docs', 'Swagger docs'],
            ['/api/v1/docs/swagger.json', 'nested Swagger path'],
            ['/api/v1/health/ready', 'nested health path'],
        ])('should return true for %s (%s)', async (path) => {
            const context = createMockExecutionContext({ path });
            const result = await guard.canActivate(context);
            expect(result).toBe(true);
        });
    });

    describe('canActivate — non-public', () => {
        it('should invoke super.canActivate and proceed for non-public endpoints', async () => {
            superCanActivateResult = Promise.resolve(true);
            const adminUser = {
                id: 'user-1',
                roles: ['admin'],
                permissions: [],
            };
            const context = createMockExecutionContext({
                path: '/internal/metrics',
                user: adminUser,
            });

            const result = await guard.canActivate(context);
            expect(result).toBe(true);
        });

        it('should return false when super.canActivate returns false', async () => {
            superCanActivateResult = Promise.resolve(false);
            const context = createMockExecutionContext({
                path: '/internal/metrics',
            });

            const result = await guard.canActivate(context);
            expect(result).toBe(false);
        });
    });

    describe('canActivate — no user', () => {
        it('should throw UnauthorizedException when user not set after JWT', async () => {
            superCanActivateResult = true;
            const context = createMockExecutionContext({
                path: '/internal/data',
                user: undefined,
            });

            await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
            await expect(guard.canActivate(context)).rejects.toThrow('User not found in request');
        });
    });

    describe('canActivate — permission denied', () => {
        it('should throw ForbiddenException when permission check fails', async () => {
            superCanActivateResult = true;
            const basicUser = {
                id: 'user-basic',
                roles: ['user'],
                permissions: [],
            };
            const context = createMockExecutionContext({
                path: '/internal/admin-only',
                user: basicUser,
            });

            await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
            await expect(guard.canActivate(context)).rejects.toThrow(
                'Insufficient permissions for this endpoint',
            );
        });
    });

    describe('checkPermissions — no required', () => {
        it('should use checkBasicAccess when no permissions metadata', async () => {
            superCanActivateResult = true;
            const adminUser = {
                id: 'user-admin',
                roles: ['admin'],
                permissions: [],
            };
            const context = createMockExecutionContext({
                path: '/internal/endpoint',
                user: adminUser,
            });
            mockReflector.getAllAndOverride.mockReturnValue(undefined);

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockReflector.getAllAndOverride).toHaveBeenCalledWith(PERMISSIONS_KEY, [
                context.getHandler(),
                context.getClass(),
            ]);
        });

        it('should use checkBasicAccess when permissions array is empty', async () => {
            superCanActivateResult = true;
            const adminUser = {
                id: 'user-admin',
                roles: ['admin'],
                permissions: [],
            };
            const context = createMockExecutionContext({
                path: '/internal/endpoint',
                user: adminUser,
            });
            mockReflector.getAllAndOverride.mockReturnValue([]);

            const result = await guard.canActivate(context);
            expect(result).toBe(true);
        });
    });

    describe('checkPermissions — user has permission', () => {
        it('should return true when user has required permission', async () => {
            superCanActivateResult = true;
            const user = {
                id: 'user-1',
                roles: ['physician'],
                permissions: ['medical:read', 'patient:read'],
            };
            const context = createMockExecutionContext({
                path: '/internal/records',
                user,
            });
            mockReflector.getAllAndOverride.mockReturnValue(['medical:read']);

            const result = await guard.canActivate(context);
            expect(result).toBe(true);
        });
    });

    describe('checkPermissions — fallback to role', () => {
        it('should check role-based access when user lacks direct permission', async () => {
            superCanActivateResult = true;
            const user = {
                id: 'user-1',
                roles: ['physician'],
                permissions: [],
            };
            const context = createMockExecutionContext({
                path: '/internal/records',
                user,
            });
            mockReflector.getAllAndOverride.mockReturnValue(['medical:read']);

            const result = await guard.canActivate(context);
            expect(result).toBe(true);
        });
    });

    describe('checkBasicAccess', () => {
        function callCheckBasicAccess(path: string, user: any): boolean {
            return guardProto.checkBasicAccess.call(guard, path, user);
        }

        it('should grant access to admin roles for any path', () => {
            expect(callCheckBasicAccess('/api/patients', { roles: ['admin'] })).toBe(true);
            expect(callCheckBasicAccess('/anything', { roles: ['system-admin'] })).toBe(true);
        });

        it('should grant access to physician for medical endpoints', () => {
            expect(callCheckBasicAccess('/api/patients', { roles: ['physician'] })).toBe(true);
            expect(callCheckBasicAccess('/api/sessions', { roles: ['physician'] })).toBe(true);
            expect(callCheckBasicAccess('/api/medical', { roles: ['physician'] })).toBe(true);
        });

        it('should grant access to nurse for medical endpoints', () => {
            expect(callCheckBasicAccess('/api/patients/123', { roles: ['nurse'] })).toBe(true);
            expect(callCheckBasicAccess('/api/sessions/list', { roles: ['nurse'] })).toBe(true);
        });

        it('should only allow basic user to access profile/refresh/logout endpoints', () => {
            expect(callCheckBasicAccess('/api/auth/profile', { roles: ['user'] })).toBe(true);
            expect(callCheckBasicAccess('/api/auth/refresh', { roles: ['user'] })).toBe(true);
            expect(callCheckBasicAccess('/api/auth/logout', { roles: ['user'] })).toBe(true);
        });

        it('should deny basic user access to non-basic endpoints', () => {
            expect(callCheckBasicAccess('/api/patients', { roles: ['user'] })).toBe(false);
            expect(callCheckBasicAccess('/api/sessions', { roles: ['user'] })).toBe(false);
            expect(callCheckBasicAccess('/api/medical', { roles: ['user'] })).toBe(false);
            expect(callCheckBasicAccess('/api/admin/settings', { roles: ['user'] })).toBe(false);
        });

        it('should handle user with no roles array', () => {
            expect(callCheckBasicAccess('/api/patients', {})).toBe(false);
            expect(callCheckBasicAccess('/api/auth/profile', {})).toBe(true);
        });
    });

    describe('checkRoleBasedAccess', () => {
        function callCheckRoleBasedAccess(
            requiredPermissions: string[],
            userRoles: string[],
        ): boolean {
            return guardProto.checkRoleBasedAccess.call(guard, requiredPermissions, userRoles);
        }

        it('should allow physician for medical:read', () => {
            expect(callCheckRoleBasedAccess(['medical:read'], ['physician'])).toBe(true);
        });

        it('should allow nurse for medical:read', () => {
            expect(callCheckRoleBasedAccess(['medical:read'], ['nurse'])).toBe(true);
        });

        it('should allow medical-assistant for medical:read', () => {
            expect(callCheckRoleBasedAccess(['medical:read'], ['medical-assistant'])).toBe(true);
        });

        it('should deny basic user for admin:write', () => {
            expect(callCheckRoleBasedAccess(['admin:write'], ['user'])).toBe(false);
        });

        it('should deny basic user for medical:delete', () => {
            expect(callCheckRoleBasedAccess(['medical:delete'], ['user'])).toBe(false);
        });

        it('should deny for unknown permission', () => {
            expect(callCheckRoleBasedAccess(['nonexistent:action'], ['physician'])).toBe(false);
        });

        it('should allow admin for admin:read', () => {
            expect(callCheckRoleBasedAccess(['admin:read'], ['admin'])).toBe(true);
        });

        it('should allow system-admin for admin:delete', () => {
            expect(callCheckRoleBasedAccess(['admin:delete'], ['system-admin'])).toBe(true);
        });

        it('should deny admin for admin:delete', () => {
            expect(callCheckRoleBasedAccess(['admin:delete'], ['admin'])).toBe(false);
        });

        it('should allow when any required permission matches any user role', () => {
            expect(
                callCheckRoleBasedAccess(['admin:write', 'medical:read'], ['nurse']),
            ).toBe(true);
        });
    });

    describe('handleRequest', () => {
        function callHandleRequest(err: any, user: any, info: any): any {
            const context = createMockExecutionContext({ path: '/api/test' });
            return guard.handleRequest(err, user, info, context);
        }

        it('should throw UnauthorizedException when err is set', () => {
            const error = new Error('JWT expired');
            expect(() => callHandleRequest(error, null, null)).toThrow(error);
        });

        it('should throw UnauthorizedException when user is null', () => {
            expect(() => callHandleRequest(null, null, null)).toThrow(UnauthorizedException);
            expect(() => callHandleRequest(null, null, null)).toThrow('Invalid token');
        });

        it('should return user when valid', () => {
            const user = { id: 'user-1', email: 'test@example.com' };
            const result = callHandleRequest(null, user, null);
            expect(result).toBe(user);
            expect(result.id).toBe('user-1');
        });

        it('should prefer throwing err over generic UnauthorizedException', () => {
            const specificError = new ForbiddenException('Custom error');
            expect(() => callHandleRequest(specificError, null, null)).toThrow(ForbiddenException);
            expect(() => callHandleRequest(specificError, null, null)).toThrow('Custom error');
        });
    });
});
