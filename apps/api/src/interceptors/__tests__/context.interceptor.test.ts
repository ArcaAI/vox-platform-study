import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, firstValueFrom } from 'rxjs';

describe('ContextInterceptor', () => {
    let interceptor: any;
    let mockClsService: any;

    function createMockContext(overrides: {
        url?: string;
        method?: string;
        ip?: string;
        headers?: Record<string, string>;
        body?: any;
        requestId?: string;
    } = {}): ExecutionContext {
        const request: any = {
            url: overrides.url ?? '/api/v1/test',
            method: overrides.method ?? 'GET',
            ip: overrides.ip ?? '127.0.0.1',
            headers: overrides.headers ?? {},
            body: overrides.body ?? {},
        };
        if (overrides.requestId) {
            request.requestId = overrides.requestId;
        }

        return {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => ({ statusCode: 200 }),
            }),
        } as unknown as ExecutionContext;
    }

    function createMockHandler(): CallHandler {
        return { handle: () => of('response-value') };
    }

    describe('when CLS context is available', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            mockClsService = {
                get: vi.fn().mockReturnValue(undefined),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('should set correlationId in CLS context', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(mockClsService.set).toHaveBeenCalledWith(
                'correlationId',
                expect.any(String),
            );
        });

        it('should set requestIp in CLS context', async () => {
            const context = createMockContext({ ip: '10.0.0.1' });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(mockClsService.set).toHaveBeenCalledWith('requestIp', '10.0.0.1');
        });

        it('should pass through the handler response', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            const result = await firstValueFrom(result$);

            expect(result).toBe('response-value');
        });
    });

    describe('when CLS context is NOT available (e.g., /metrics endpoint)', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            mockClsService = {
                get: vi.fn().mockImplementation(() => {
                    throw new Error(
                        'Cannot set the key "correlationId". No CLS context available',
                    );
                }),
                set: vi.fn().mockImplementation(() => {
                    throw new Error(
                        'Cannot set the key "correlationId". No CLS context available',
                    );
                }),
                getId: vi.fn().mockImplementation(() => {
                    throw new Error('No CLS context available');
                }),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('should NOT throw when CLS context is unavailable', async () => {
            const context = createMockContext({ url: '/metrics' });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            const result = await firstValueFrom(result$);

            expect(result).toBe('response-value');
        });

        it('should still pass through the handler response when CLS is unavailable', async () => {
            const context = createMockContext({ url: '/metrics' });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            const result = await firstValueFrom(result$);

            expect(result).toBe('response-value');
        });

        it('should handle missing CLS on any route, not just /metrics', async () => {
            const context = createMockContext({ url: '/some-other-route' });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            const result = await firstValueFrom(result$);

            expect(result).toBe('response-value');
        });
    });

    describe('OTel trace context propagation', () => {
        const mockTraceId = 'abc123def456789012345678abcdef01';
        const mockSpanId = '1234567890abcdef';

        beforeEach(async () => {
            vi.clearAllMocks();
            vi.resetModules();

            vi.doMock('@opentelemetry/api', () => ({
                trace: {
                    getActiveSpan: vi.fn().mockReturnValue({
                        spanContext: () => ({
                            traceId: mockTraceId,
                            spanId: mockSpanId,
                        }),
                    }),
                },
            }));

            mockClsService = {
                get: vi.fn().mockReturnValue(undefined),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('should store traceId in CLS context when OTel span is active', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(mockClsService.set).toHaveBeenCalledWith('traceId', mockTraceId);
        });

        it('should store spanId in CLS context when OTel span is active', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(mockClsService.set).toHaveBeenCalledWith('spanId', mockSpanId);
        });

        it('should include traceId and spanId in request completion log', async () => {
            const logSpy = vi.spyOn(interceptor['logger'], 'log');
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    traceId: mockTraceId,
                    spanId: mockSpanId,
                }),
            );
        });
    });

    describe('OTel trace context when no active span', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            vi.resetModules();

            vi.doMock('@opentelemetry/api', () => ({
                trace: {
                    getActiveSpan: vi.fn().mockReturnValue(undefined),
                },
            }));

            mockClsService = {
                get: vi.fn().mockReturnValue(undefined),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('should not set traceId in CLS when no active span', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const traceIdCalls = mockClsService.set.mock.calls.filter(
                (call: unknown[]) => call[0] === 'traceId',
            );
            expect(traceIdCalls).toHaveLength(0);
        });

        it('should still complete request successfully without OTel', async () => {
            const context = createMockContext();
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            const result = await firstValueFrom(result$);

            expect(result).toBe('response-value');
        });
    });

    describe('request completion logging when CLS is unavailable', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            mockClsService = {
                get: vi.fn().mockImplementation(() => {
                    throw new Error('No CLS context available');
                }),
                set: vi.fn().mockImplementation(() => {
                    throw new Error('No CLS context available');
                }),
                getId: vi.fn().mockImplementation(() => {
                    throw new Error('No CLS context available');
                }),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('should complete the response tap without throwing', async () => {
            const context = createMockContext({ url: '/metrics', method: 'GET' });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await expect(firstValueFrom(result$)).resolves.not.toThrow();
        });
    });
});
