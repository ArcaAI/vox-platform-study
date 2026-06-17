import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { OidcAuthGuard } from '../oidcauth.guard';

const mockSuperCanActivate = vi.fn();
// Hoisted so the @nestjs/common Logger mock (which is hoisted above this line)
// can reference it. With @arcaai/applications now resolved from source, its
// barrel instantiates a Logger at import time, before this const would
// otherwise initialize — see auth.service.module.
const mockLoggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@nestjs/passport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nestjs/passport')>();
    return {
        ...actual,
        AuthGuard: () => {
            class MockAuthGuard {
                canActivate(context: ExecutionContext) {
                    return mockSuperCanActivate(context);
                }
            }
            return MockAuthGuard;
        },
    };
});

vi.mock('@nestjs/common', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@nestjs/common')>();
    return {
        ...actual,
        Logger: class MockLogger {
            debug = mockLoggerDebug;
            log = vi.fn();
            warn = vi.fn();
            error = vi.fn();
        },
    };
});

const createMockContext = (options: {
    method?: string;
    url?: string;
} = {}): ExecutionContext => {
    const request = {
        method: options.method ?? 'GET',
        url: options.url ?? '/api/v1/test',
    };

    return {
        getHandler: vi.fn(() => 'handlerRef'),
        getClass: vi.fn(() => 'classRef'),
        switchToHttp: vi.fn(() => ({
            getRequest: vi.fn(() => request),
        })),
        switchToRpc: vi.fn(),
        switchToWs: vi.fn(),
        getType: vi.fn(),
        getArgs: vi.fn(),
        getArgByIndex: vi.fn(),
    } as unknown as ExecutionContext;
};

describe('OidcAuthGuard', () => {
    let guard: OidcAuthGuard;
    let reflector: Reflector;

    beforeEach(() => {
        vi.clearAllMocks();

        reflector = {
            getAllAndOverride: vi.fn(),
        } as unknown as Reflector;

        guard = new OidcAuthGuard(reflector);
    });

    describe('canActivate', () => {
        it('should return true when SKIP_AUTH_KEY metadata is true (public route)', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            const result = guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
        });

        it('should log debug message with method and path when skipping auth', () => {
            const context = createMockContext({ method: 'POST', url: '/api/v1/health' });
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            guard.canActivate(context);

            expect(mockLoggerDebug).toHaveBeenCalledWith({
                message: 'Auth skipped',
                reason: 'public_route',
                method: 'POST',
                path: '/api/v1/health',
            });
        });

        it('should delegate to super.canActivate when SKIP_AUTH_KEY is false', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(false);
            mockSuperCanActivate.mockReturnValue(true);

            const result = guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockSuperCanActivate).toHaveBeenCalledWith(context);
        });

        it('should delegate to super.canActivate when SKIP_AUTH_KEY is undefined', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
            mockSuperCanActivate.mockReturnValue(false);

            const result = guard.canActivate(context);

            expect(result).toBe(false);
            expect(mockSuperCanActivate).toHaveBeenCalledWith(context);
        });

        it('should extract method and url from the HTTP request', () => {
            const context = createMockContext({ method: 'DELETE', url: '/api/v1/users/123' });
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            guard.canActivate(context);

            expect(context.switchToHttp).toHaveBeenCalled();
            expect(mockLoggerDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'DELETE',
                    path: '/api/v1/users/123',
                }),
            );
        });

        it('should query reflector with SKIP_AUTH_KEY against both handler and class', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            guard.canActivate(context);

            expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
                SKIP_AUTH_KEY,
                ['handlerRef', 'classRef'],
            );
            expect(context.getHandler).toHaveBeenCalled();
            expect(context.getClass).toHaveBeenCalled();
        });

        it('should not log when auth is not skipped', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(false);
            mockSuperCanActivate.mockReturnValue(true);

            guard.canActivate(context);

            expect(mockLoggerDebug).not.toHaveBeenCalled();
        });

        it('should forward the execution context to super.canActivate', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(false);
            mockSuperCanActivate.mockReturnValue(true);

            guard.canActivate(context);

            expect(mockSuperCanActivate).toHaveBeenCalledTimes(1);
            expect(mockSuperCanActivate.mock.calls[0][0]).toBe(context);
        });
    });
});
