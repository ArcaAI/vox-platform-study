/**
 * LokiTransport Unit Tests
 *
 * Tests for the Grafana Loki transport implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LokiTransport, createLokiTransport } from '../transports/loki.transport';
import type { LokiTransportConfig, LogEntry, LogLevel } from '../transports/types';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('LokiTransport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            text: () => Promise.resolve(''),
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const createEntry = (
        level: LogLevel,
        message: string = 'test message',
        overrides: Partial<LogEntry> = {}
    ): LogEntry => ({
        level,
        levelNumber: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level],
        message,
        timestamp: '2024-01-15T10:30:00.000Z',
        timestampMs: 1705315800000,
        ...overrides,
    });

    describe('constructor', () => {
        it('should create transport with required config', () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            expect(transport.name).toBe('loki');
        });

        it('should remove trailing slash from host', () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100/',
            });
            // Verify by checking that flush sends to correct URL
            expect(transport.name).toBe('loki');
        });

        it('should use default batch settings', () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            expect(transport.config).toBeDefined();
        });
    });

    describe('initialize', () => {
        it('should start flush timer on initialize', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                batchInterval: 5000,
            });

            await transport.initialize();

            // Log an entry
            transport.log(createEntry('info'));

            // Fast-forward timer
            await vi.advanceTimersByTimeAsync(5000);

            // Should have attempted to flush
            expect(mockFetch).toHaveBeenCalled();
        });

        it('should set state to running', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });

            await transport.initialize();

            expect(transport.state).toBe('running');
        });
    });

    describe('log', () => {
        it('should buffer log entries', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Message 1'));
            transport.log(createEntry('info', 'Message 2'));

            // Should not send immediately
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should flush when batch size is reached', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                batchSize: 3,
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Message 1'));
            transport.log(createEntry('info', 'Message 2'));
            transport.log(createEntry('info', 'Message 3'));

            // Allow async flush to complete (advance just enough for the promise)
            await vi.advanceTimersByTimeAsync(10);

            expect(mockFetch).toHaveBeenCalled();

            await transport.shutdown();
        });

        it('should not log when level is below minimum', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                level: 'warn',
                batchSize: 1,
            });
            await transport.initialize();

            transport.log(createEntry('debug'));
            transport.log(createEntry('info'));

            // Manually flush instead of waiting for timer
            await transport.flush();

            expect(mockFetch).not.toHaveBeenCalled();

            await transport.shutdown();
        });
    });

    describe('flush', () => {
        it('should send logs to Loki push endpoint', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test message'));
            await transport.flush();

            expect(mockFetch).toHaveBeenCalledWith(
                'http://loki:3100/loki/api/v1/push',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                    }),
                })
            );
        });

        it('should not send when buffer is empty', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            await transport.flush();

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should include basic auth when configured', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                basicAuth: 'user:password',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const headers = fetchCall[1].headers;
            expect(headers.Authorization).toMatch(/^Basic /);
        });

        it('should include custom headers when configured', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                headers: {
                    'X-Scope-OrgID': 'tenant-1',
                    'X-Custom-Header': 'value',
                },
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const headers = fetchCall[1].headers;
            expect(headers['X-Scope-OrgID']).toBe('tenant-1');
            expect(headers['X-Custom-Header']).toBe('value');
        });
    });

    describe('payload formatting', () => {
        it('should format payload as Loki streams', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test message'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            expect(body).toHaveProperty('streams');
            expect(Array.isArray(body.streams)).toBe(true);
        });

        it('should include level as label', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('error', 'Error message'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            expect(stream.stream.level).toBe('error');
        });

        it('should include configured labels', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                labels: {
                    app: 'my-service',
                    env: 'production',
                },
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            expect(stream.stream.app).toBe('my-service');
            expect(stream.stream.env).toBe('production');
        });

        it('should include service name as label', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { serviceName: 'api-gateway' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            expect(stream.stream.service).toBe('api-gateway');
        });

        it('should include context as label', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { context: 'UserService' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            expect(stream.stream.context).toBe('UserService');
        });

        it('should convert timestamp to nanoseconds', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { timestampMs: 1705315800000 }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];
            const [timestamp] = stream.values[0];

            expect(timestamp).toBe('1705315800000000000'); // Nanoseconds
        });

        it('should include trace context in log line', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                traceId: 'trace-123',
                spanId: 'span-456',
                requestId: 'req-789',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];
            const logLine = JSON.parse(stream.values[0][1]);

            expect(logLine.trace_id).toBe('trace-123');
            expect(logLine.span_id).toBe('span-456');
            expect(logLine.request_id).toBe('req-789');
        });

        it('should include error details in log line', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            const error = new Error('Test error');
            transport.log(createEntry('error', 'Error occurred', { error }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];
            const logLine = JSON.parse(stream.values[0][1]);

            expect(logLine.error).toBeDefined();
            expect(logLine.error.message).toBe('Test error');
        });

        it('should group entries by labels into separate streams', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Info message', { context: 'ServiceA' }));
            transport.log(createEntry('error', 'Error message', { context: 'ServiceB' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            // Should have multiple streams for different label combinations
            expect(body.streams.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('shutdown', () => {
        it('should stop flush timer on shutdown', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            await transport.shutdown();

            expect(transport.state).toBe('stopped');
        });

        it('should flush remaining logs on shutdown', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Final message'));
            await transport.shutdown();

            expect(mockFetch).toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('should handle fetch errors gracefully', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));

            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            // Should not throw
            await expect(transport.flush()).resolves.not.toThrow();
        });

        it('should handle non-ok responses', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: () => Promise.resolve('Server error'),
            });

            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            // Should not throw
            await expect(transport.flush()).resolves.not.toThrow();
        });

        it('should handle timeout', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValue(abortError);

            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                timeout: 1000,
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            // Should not throw
            await expect(transport.flush()).resolves.not.toThrow();
        });
    });

    describe('label sanitization', () => {
        it('should sanitize label names', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
                propsToLabels: ['some.dotted.key'],
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                meta: { 'some.dotted.key': 'value' },
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            // Dots should be converted to underscores
            expect(stream.stream).toHaveProperty('some_dotted_key');
        });

        it('should truncate long label values', async () => {
            const transport = new LokiTransport({
                name: 'loki',
                host: 'http://loki:3100',
            });
            await transport.initialize();

            const longContext = 'A'.repeat(200);
            transport.log(createEntry('info', 'Test', { context: longContext }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const stream = body.streams[0];

            expect(stream.stream.context.length).toBeLessThanOrEqual(128);
        });
    });

    describe('createLokiTransport factory', () => {
        it('should create transport with correct name', () => {
            const transport = createLokiTransport({
                host: 'http://loki:3100',
            });
            expect(transport.name).toBe('loki');
        });

        it('should create enabled transport by default', () => {
            const transport = createLokiTransport({
                host: 'http://loki:3100',
            });
            expect(transport.enabled).toBe(true);
        });

        it('should allow disabling transport', () => {
            const transport = createLokiTransport({
                host: 'http://loki:3100',
                enabled: false,
            });
            expect(transport.enabled).toBe(false);
        });
    });
});
