import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_AUTH_KEY } from '@arcaai/applications';
import { JwtAuthGuard } from '../jwtauth.guard';
import { STREAM_SCOPE_METADATA } from '../../modules/auth/decorators/stream-scope.decorator';

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

interface MockRequest {
    query: Record<string, unknown>;
    params: Record<string, string>;
    user?: unknown;
}

function createMockContext(request: MockRequest = { query: {}, params: {} }): ExecutionContext {
    return {
        getHandler: vi.fn(() => 'handlerRef'),
        getClass: vi.fn(() => 'classRef'),
        switchToHttp: vi.fn(() => ({
            getRequest: vi.fn(() => request),
            getResponse: vi.fn(),
            getNext: vi.fn(),
        })),
        switchToRpc: vi.fn(),
        switchToWs: vi.fn(),
        getType: vi.fn(),
        getArgs: vi.fn(),
        getArgByIndex: vi.fn(),
    } as unknown as ExecutionContext;
}

function createMockTicketService(consumeResult: Awaited<ReturnType<JwtAuthGuard['canActivate']>> extends unknown ? unknown : never = null) {
    return {
        issueTicket: vi.fn(),
        consumeTicket: vi.fn().mockResolvedValue(consumeResult),
    };
}

describe('JwtAuthGuard', () => {
    let guard: JwtAuthGuard;
    let reflector: Reflector;
    let streamTicketService: ReturnType<typeof createMockTicketService>;

    beforeEach(() => {
        vi.clearAllMocks();
        reflector = {
            getAllAndOverride: vi.fn(),
        } as unknown as Reflector;
        streamTicketService = createMockTicketService();
        guard = new JwtAuthGuard(reflector, streamTicketService as never);
    });

    describe('canActivate — base behaviour', () => {
        it('should return true when SKIP_AUTH_KEY metadata is true (public route)', async () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
            expect(streamTicketService.consumeTicket).not.toHaveBeenCalled();
        });

        it('should delegate to super.canActivate when SKIP_AUTH_KEY is false and no ticket', async () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(false);
            mockSuperCanActivate.mockReturnValue(true);

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(mockSuperCanActivate).toHaveBeenCalledWith(context);
        });

        it('should delegate to super.canActivate when SKIP_AUTH_KEY is undefined and no ticket', async () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
            mockSuperCanActivate.mockReturnValue(false);

            const result = await guard.canActivate(context);

            expect(result).toBe(false);
            expect(mockSuperCanActivate).toHaveBeenCalledWith(context);
        });

        it('should query reflector with SKIP_AUTH_KEY against both handler and class', async () => {
            const context = createMockContext();
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockReturnValue(true);

            await guard.canActivate(context);

            expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
                SKIP_AUTH_KEY,
                ['handlerRef', 'classRef'],
            );
        });
    });

    // ─── TASK-263 W0-1: ticket-aware path ────────────────────────────────────
    describe('canActivate — ?ticket= fallback (TASK-263 W0-1)', () => {
        function whenScopeMetadataIs(config: { namespace: string; param: string } | undefined) {
            (reflector.getAllAndOverride as ReturnType<typeof vi.fn>).mockImplementation((key: unknown) => {
                if (key === SKIP_AUTH_KEY) return false;
                if (key === STREAM_SCOPE_METADATA) return config;
                return undefined;
            });
        }

        it('consumes the ticket, populates req.user, and returns true on a valid match', async () => {
            const request: MockRequest = {
                query: { ticket: 'tkt-1' },
                params: { jobId: 'job-1' },
            };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            streamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'user-1',
                tenantId: 'tenant-1',
                scope: 'consultation_job:job-1',
                exp: Date.now() + 30_000,
            });

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(streamTicketService.consumeTicket).toHaveBeenCalledWith('tkt-1');
            expect(request.user).toEqual({ id: 'user-1', tenantId: 'tenant-1' });
            // The base-class passport path must NOT run when a ticket is honoured.
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
        });

        it('throws UnauthorizedException when the ticket is unknown or already consumed', async () => {
            const request: MockRequest = {
                query: { ticket: 'tkt-bad' },
                params: { jobId: 'job-1' },
            };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            streamTicketService.consumeTicket.mockResolvedValueOnce(null);

            await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
            expect(streamTicketService.consumeTicket).toHaveBeenCalledWith('tkt-bad');
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
        });

        it('throws UnauthorizedException when the ticket scope does not match the route', async () => {
            const request: MockRequest = {
                query: { ticket: 'tkt-1' },
                params: { jobId: 'job-1' },
            };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            streamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'user-1',
                tenantId: 'tenant-1',
                scope: 'consultation_job:some-other-job', // mismatched
                exp: Date.now() + 30_000,
            });

            await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
            expect(mockSuperCanActivate).not.toHaveBeenCalled();
        });

        it('throws UnauthorizedException when the route does not declare @StreamScope', async () => {
            const request: MockRequest = {
                query: { ticket: 'tkt-1' },
                params: { jobId: 'job-1' },
            };
            const context = createMockContext(request);
            whenScopeMetadataIs(undefined); // No @StreamScope on the route
            streamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'user-1',
                tenantId: 'tenant-1',
                scope: 'consultation_job:job-1',
                exp: Date.now() + 30_000,
            });

            await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        });

        it('throws UnauthorizedException when the scope param is missing from the route', async () => {
            const request: MockRequest = {
                query: { ticket: 'tkt-1' },
                params: {}, // jobId is missing
            };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            streamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'user-1',
                tenantId: 'tenant-1',
                scope: 'consultation_job:job-1',
                exp: Date.now() + 30_000,
            });

            await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        });

        it('falls through to passport when no ?ticket= is present (does not consume any ticket)', async () => {
            const request: MockRequest = { query: {}, params: {} };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            mockSuperCanActivate.mockReturnValue(true);

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(streamTicketService.consumeTicket).not.toHaveBeenCalled();
            expect(mockSuperCanActivate).toHaveBeenCalledWith(context);
        });

        it('handles ticket presented as an array (Express query parsing artefact) by taking the first value', async () => {
            const request: MockRequest = {
                query: { ticket: ['tkt-1', 'tkt-2'] },
                params: { jobId: 'job-1' },
            };
            const context = createMockContext(request);
            whenScopeMetadataIs({ namespace: 'consultation_job', param: 'jobId' });
            streamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'user-1',
                tenantId: null,
                scope: 'consultation_job:job-1',
                exp: Date.now() + 30_000,
            });

            const result = await guard.canActivate(context);

            expect(result).toBe(true);
            expect(streamTicketService.consumeTicket).toHaveBeenCalledWith('tkt-1');
        });
    });
});
