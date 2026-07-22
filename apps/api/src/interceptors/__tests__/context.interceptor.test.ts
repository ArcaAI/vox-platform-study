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

    describe('x-tenant-id header handling', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            vi.resetModules();

            mockClsService = {
                // Default to no JWT-derived tenantId in CLS.
                get: vi.fn().mockReturnValue(undefined),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('must NOT call clsService.set("tenantId", header) when x-tenant-id header is present', async () => {
            const context = createMockContext({
                headers: { 'x-tenant-id': 'attacker-tenant' },
            });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const tenantSetCalls = mockClsService.set.mock.calls.filter(
                (call: unknown[]) => call[0] === 'tenantId',
            );
            expect(tenantSetCalls).toHaveLength(0);
        });

        it('must NOT call clsService.set("tenantId", ...) at all (JWT strategy owns tenantId now)', async () => {
            const context = createMockContext({ headers: {} });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const tenantSetCalls = mockClsService.set.mock.calls.filter(
                (call: unknown[]) => call[0] === 'tenantId',
            );
            expect(tenantSetCalls).toHaveLength(0);
        });

        it('logs a warn AND rejects (400) when x-tenant-id diverges from the JWT-derived tenantId', async () => {
            // CLS user already populated by JwtStrategy with a different tenant.
            mockClsService.get = vi.fn((key: string) => {
                if (key === 'user') return { tenantId: 'tenant-A' };
                return undefined;
            });
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
            const warnSpy = vi.spyOn(interceptor['logger'], 'warn');

            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-B' },
            });
            const handler = createMockHandler();

            // Warn fires BEFORE the throw, then the request is rejected.
            let thrown: unknown;
            try {
                interceptor.intercept(context, handler);
            } catch (e) {
                thrown = e;
            }

            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('x-tenant-id'),
                    tenantIdHeader: 'tenant-B',
                    jwtTenantId: 'tenant-A',
                }),
            );
            expect(thrown).toBeDefined();
        });

        it('does NOT warn when x-tenant-id matches the JWT-derived tenantId', async () => {
            mockClsService.get = vi.fn((key: string) => {
                if (key === 'user') return { tenantId: 'tenant-A' };
                return undefined;
            });
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
            const warnSpy = vi.spyOn(interceptor['logger'], 'warn');

            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-A' },
            });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe('x-tenant-id divergence -> 400 BadRequest (audit)', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            vi.resetModules();
            mockClsService = {
                get: vi.fn((key: string) => {
                    if (key === 'user') return { tenantId: 'tenant-A' };
                    return undefined;
                }),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('throws BadRequestException when x-tenant-id header diverges from JWT-derived tenantId', async () => {
            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-B' },
            });
            const handler = createMockHandler();

            expect(() => interceptor.intercept(context, handler)).toThrow();
        });

        it('the thrown exception is HTTP 400 (BadRequestException, not 401 / 403 / 500)', async () => {
            const { BadRequestException } = await import('@nestjs/common');
            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-B' },
            });
            const handler = createMockHandler();

            let caught: unknown;
            try {
                interceptor.intercept(context, handler);
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(BadRequestException);
            expect((caught as InstanceType<typeof BadRequestException>).getStatus()).toBe(400);
        });

        it('does NOT throw when x-tenant-id matches the JWT-derived tenantId', async () => {
            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-A' },
            });
            const handler = createMockHandler();

            expect(() => interceptor.intercept(context, handler)).not.toThrow();
        });

        it('does NOT throw when x-tenant-id header is absent (no header, no divergence)', async () => {
            const context = createMockContext({ headers: {} });
            const handler = createMockHandler();

            expect(() => interceptor.intercept(context, handler)).not.toThrow();
        });

        it('does NOT throw when JWT has no tenantId (e.g., global-admin) even if x-tenant-id is present', async () => {
            mockClsService.get = vi.fn((key: string) => {
                if (key === 'user') return { tenantId: null };
                return undefined;
            });
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);

            const context = createMockContext({
                headers: { 'x-tenant-id': 'tenant-Z' },
            });
            const handler = createMockHandler();

            expect(() => interceptor.intercept(context, handler)).not.toThrow();
        });
    });

    describe('global-admin x-tenant-id → CLS elevation', () => {
        const VALID_TENANT = '0190b6e2-7e7a-7c3a-8b1a-2c3d4e5f6a7b';

        function buildCls(user: unknown) {
            return {
                get: vi.fn((key: string) => (key === 'user' ? user : undefined)),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
        }

        async function buildInterceptor(cls: unknown) {
            vi.resetModules();
            const { ContextInterceptor } = await import('../context.interceptor');
            return new ContextInterceptor(cls as any);
        }

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('elevates: sets CLS tenantId to the header for a global-admin with an empty JWT tenant', async () => {
            const cls = buildCls({ id: 'admin-1', tenantId: '', roles: ['GLOBAL_ADMIN'] });
            interceptor = await buildInterceptor(cls);

            const context = createMockContext({ headers: { 'x-tenant-id': VALID_TENANT } });
            await firstValueFrom(interceptor.intercept(context, createMockHandler()));

            expect(cls.set).toHaveBeenCalledWith('tenantId', VALID_TENANT);
        });

        it('emits a structured audit log line naming the elevated tenant', async () => {
            const cls = buildCls({ id: 'admin-1', tenantId: '', roles: ['GLOBAL_ADMIN'] });
            interceptor = await buildInterceptor(cls);
            const logSpy = vi.spyOn(interceptor['logger'], 'log');

            const context = createMockContext({ headers: { 'x-tenant-id': VALID_TENANT } });
            await firstValueFrom(interceptor.intercept(context, createMockHandler()));

            expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining('tenant'),
                    elevatedTenantId: VALID_TENANT,
                    superAdminId: 'admin-1',
                }),
            );
        });

        it('throws BadRequest("Invalid x-tenant-id format") when a global-admin passes a malformed header', async () => {
            const { BadRequestException } = await import('@nestjs/common');
            const cls = buildCls({ id: 'admin-1', tenantId: '', roles: ['GLOBAL_ADMIN'] });
            interceptor = await buildInterceptor(cls);

            const context = createMockContext({ headers: { 'x-tenant-id': 'not-a-uuid' } });

            let caught: unknown;
            try {
                interceptor.intercept(context, createMockHandler());
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(BadRequestException);
            expect((caught as InstanceType<typeof BadRequestException>).message).toContain('Invalid x-tenant-id format');
            expect(cls.set).not.toHaveBeenCalledWith('tenantId', expect.anything());
        });

        it('does NOT elevate a global-admin when no x-tenant-id header is present', async () => {
            const cls = buildCls({ id: 'admin-1', tenantId: '', roles: ['GLOBAL_ADMIN'] });
            interceptor = await buildInterceptor(cls);

            const context = createMockContext({ headers: {} });
            await firstValueFrom(interceptor.intercept(context, createMockHandler()));

            expect(cls.set).not.toHaveBeenCalledWith('tenantId', expect.anything());
        });

        it('does NOT elevate a non-global-admin with an empty JWT tenant even with a valid header', async () => {
            const cls = buildCls({ id: 'u-1', tenantId: '', roles: ['DEPARTMENT_ADMIN'] });
            interceptor = await buildInterceptor(cls);

            const context = createMockContext({ headers: { 'x-tenant-id': VALID_TENANT } });
            await firstValueFrom(interceptor.intercept(context, createMockHandler()));

            expect(cls.set).not.toHaveBeenCalledWith('tenantId', expect.anything());
        });

        it('keeps the reject path: a tenant-bound caller with a divergent header is still 400', async () => {
            const { BadRequestException } = await import('@nestjs/common');
            const cls = buildCls({ id: 'u-1', tenantId: 'tenant-A', roles: ['DEPARTMENT_ADMIN'] });
            interceptor = await buildInterceptor(cls);

            const context = createMockContext({ headers: { 'x-tenant-id': 'tenant-B' } });

            let caught: unknown;
            try {
                interceptor.intercept(context, createMockHandler());
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(BadRequestException);
            expect(cls.set).not.toHaveBeenCalledWith('tenantId', expect.anything());
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

    /**
     * requestId must come from the `x-request-id` header, never from the
     * client-controlled JSON body — reading `request?.body?.requestId` would
     * let any client pin its own correlation id by simply POSTing
     * `{ "requestId": "..." }`, polluting CLS / logs and letting two
     * unrelated requests share a correlation id. The value sources from the
     * standard header a load balancer / CDN would already set, falling back
     * to uuidv7().
     */
    describe('requestId precedence', () => {
        beforeEach(async () => {
            vi.clearAllMocks();
            vi.resetModules();
            vi.doUnmock('@opentelemetry/api');
            mockClsService = {
                get: vi.fn().mockReturnValue(undefined),
                set: vi.fn(),
                getId: vi.fn().mockReturnValue('test-request-id'),
            };
            const { ContextInterceptor } = await import('../context.interceptor');
            interceptor = new ContextInterceptor(mockClsService);
        });

        it('uses the x-request-id header verbatim when present', async () => {
            const context = createMockContext({
                headers: { 'x-request-id': 'header-correlation-id-123' },
            });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const request = context.switchToHttp().getRequest();
            expect(request.requestId).toBe('header-correlation-id-123');
            expect(mockClsService.set).toHaveBeenCalledWith('correlationId', 'header-correlation-id-123');
        });

        it('IGNORES request.body.requestId (no longer client-controlled)', async () => {
            const context = createMockContext({
                body: { requestId: 'attacker-controlled-id' },
            });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const request = context.switchToHttp().getRequest();
            expect(request.requestId).not.toBe('attacker-controlled-id');
            const correlationIdCalls = mockClsService.set.mock.calls.filter(
                (call: unknown[]) => call[0] === 'correlationId',
            );
            expect(correlationIdCalls).toHaveLength(1);
            expect(correlationIdCalls[0][1]).not.toBe('attacker-controlled-id');
        });

        it('prefers the x-request-id header over the body field even when both are set', async () => {
            const context = createMockContext({
                headers: { 'x-request-id': 'header-wins' },
                body: { requestId: 'body-loses' },
            });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const request = context.switchToHttp().getRequest();
            expect(request.requestId).toBe('header-wins');
        });

        it('falls back to a generated uuidv7 when neither header nor body is set', async () => {
            const context = createMockContext({ headers: {}, body: {} });
            const handler = createMockHandler();

            const result$ = interceptor.intercept(context, handler);
            await firstValueFrom(result$);

            const request = context.switchToHttp().getRequest();
            // uuidv7 -> 36 chars, dashes at the expected positions, version
            // nibble '7' at the 15th char (index 14). This pins "generated"
            // without coupling to a specific value.
            expect(typeof request.requestId).toBe('string');
            expect(request.requestId).toHaveLength(36);
            expect(request.requestId[14]).toBe('7');
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
