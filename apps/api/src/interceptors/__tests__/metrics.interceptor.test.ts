import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError, firstValueFrom } from 'rxjs';
import { MetricsInterceptor } from '../metrics.interceptor';

describe('MetricsInterceptor', () => {
    let interceptor: any;
    let mockMonitoringService: any;

    function createMockContext(overrides: {
        url?: string;
        method?: string;
        route?: { path: string };
        statusCode?: number;
    } = {}): ExecutionContext {
        const request: any = {
            url: overrides.url ?? '/api/v1/test',
            method: overrides.method ?? 'GET',
            route: overrides.route,
        };

        return {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => ({ statusCode: overrides.statusCode ?? 200 }),
            }),
        } as unknown as ExecutionContext;
    }

    function createMockHandler(value: unknown = 'response-value'): CallHandler {
        return { handle: () => of(value) };
    }

    function createErrorHandler(err: Error & { status?: number }): CallHandler {
        return { handle: () => throwError(() => err) };
    }

    beforeEach(() => {
        vi.clearAllMocks();

        mockMonitoringService = {
            recordHttpRequest: vi.fn().mockResolvedValue(undefined),
        };

        interceptor = new MetricsInterceptor(mockMonitoringService);
    });

    it('should record HTTP request metrics on success', async () => {
        const context = createMockContext({
            method: 'GET',
            route: { path: '/api/v1/users' },
            statusCode: 200,
        });
        const handler = createMockHandler();

        const result$ = interceptor.intercept(context, handler);
        await firstValueFrom(result$);

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'GET',
            '/api/v1/users',
            200,
            expect.any(Number),
        );
    });

    it('should record duration in seconds', async () => {
        const context = createMockContext();
        const handler = createMockHandler();

        const result$ = interceptor.intercept(context, handler);
        await firstValueFrom(result$);

        const duration = mockMonitoringService.recordHttpRequest.mock.calls[0][3];
        expect(duration).toBeGreaterThanOrEqual(0);
        expect(duration).toBeLessThan(1);
    });

    /**
     * Prometheus cardinality guard.
     *
     * Labelling the `http_requests_total` metric with
     * `request.route?.path || request.url` would blow up cardinality:
     * unmatched / 404 / OPTIONS requests have an undefined `route`, so the
     * fallback would expand to the raw URL and every
     * `/api/v1/<scanner-noise>/<uuid>` would ship a new Prometheus series,
     * growing linearly with traffic.
     *
     * Unmatched routes are labelled with the literal `<unmatched>` instead,
     * so the series count stays bounded by the templated-route set.
     */
    it('falls back to "<unmatched>" (not request.url) when route.path is unavailable', async () => {
        const context = createMockContext({
            url: '/api/v1/some-noise-9c7f4',
            method: 'POST',
        });
        const handler = createMockHandler();

        const result$ = interceptor.intercept(context, handler);
        await firstValueFrom(result$);

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'POST',
            '<unmatched>',
            200,
            expect.any(Number),
        );
    });

    it('still emits "<unmatched>" on the error path when route.path is unavailable', async () => {
        const error = new Error('Bad route') as Error & { status: number };
        error.status = 404;
        const context = createMockContext({
            url: '/api/v1/<unique-noise-1c9e3>',
            method: 'GET',
        });
        const handler = createErrorHandler(error);

        const result$ = interceptor.intercept(context, handler);

        await expect(firstValueFrom(result$)).rejects.toThrow('Bad route');

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'GET',
            '<unmatched>',
            404,
            expect.any(Number),
        );
    });

    it('should record error status code on failure', async () => {
        const error = new Error('Not found') as Error & { status: number };
        error.status = 404;

        const context = createMockContext({ method: 'GET' });
        const handler = createErrorHandler(error);

        const result$ = interceptor.intercept(context, handler);

        await expect(firstValueFrom(result$)).rejects.toThrow('Not found');

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'GET',
            expect.any(String),
            404,
            expect.any(Number),
        );
    });

    it('should default to 500 when error has no status', async () => {
        const error = new Error('Internal error');

        const context = createMockContext({ method: 'POST' });
        const handler = createErrorHandler(error);

        const result$ = interceptor.intercept(context, handler);

        await expect(firstValueFrom(result$)).rejects.toThrow('Internal error');

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'POST',
            expect.any(String),
            500,
            expect.any(Number),
        );
    });

    it('should pass through the response value unchanged', async () => {
        const context = createMockContext();
        const handler = createMockHandler({ data: 'payload' });

        const result$ = interceptor.intercept(context, handler);
        const result = await firstValueFrom(result$);

        expect(result).toEqual({ data: 'payload' });
    });

    it('should use route path for parameterized routes', async () => {
        const context = createMockContext({
            url: '/api/v1/users/123',
            route: { path: '/api/v1/users/:id' },
            method: 'GET',
        });
        const handler = createMockHandler();

        const result$ = interceptor.intercept(context, handler);
        await firstValueFrom(result$);

        expect(mockMonitoringService.recordHttpRequest).toHaveBeenCalledWith(
            'GET',
            '/api/v1/users/:id',
            200,
            expect.any(Number),
        );
    });
});
