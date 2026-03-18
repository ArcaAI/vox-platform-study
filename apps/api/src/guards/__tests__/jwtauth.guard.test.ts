import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { JwtAuthGuard } from '../jwtauth.guard';

const mockSuperCanActivate = vi.fn();

vi.mock('@nestjs/passport', () => {
    return {
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

const createMockContext = (): ExecutionContext => ({
    getHandler: vi.fn(() => 'handlerRef'),
    getClass: vi.fn(() => 'classRef'),
    switchToHttp: vi.fn(),
    switchToRpc: vi.fn(),
    switchToWs: vi.fn(),
    getType: vi.fn(),
    getArgs: vi.fn(),
    getArgByIndex: vi.fn(),
}) as unknown as ExecutionContext;

describe('JwtAuthGuard', () => {
    let guard: JwtAuthGuard;
    let reflector: Reflector;

    beforeEach(() => {
        vi.clearAllMocks();

        reflector = {
            getAllAndOverride: vi.fn(),
        } as unknown as Reflector;

        guard = new JwtAuthGuard(reflector);
    });

    describe('canActivate', () => {
        it('should return true when SKIP_AUTH_KEY metadata is true (public route)', () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            const result = guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
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
