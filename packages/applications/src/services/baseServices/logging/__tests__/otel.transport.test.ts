/**
 * OTelTransport Unit Tests
 *
 * Tests for the OpenTelemetry transport implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OTelTransport, createOTelTransport } from '../transports/otel.transport';
import type { OTelTransportConfig, LogEntry, LogLevel } from '../transports/types';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OTelTransport', () => {
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
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            expect(transport.name).toBe('otel');
        });

        it('should remove trailing slash from endpoint', () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318/',
                serviceName: 'my-service',
            });
            expect(transport.config).toBeDefined();
        });

        it('should use default protocol', () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            expect(transport.config).toBeDefined();
        });
    });

    describe('initialize', () => {
        it('should start flush timer on initialize', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });

            await transport.initialize();

            transport.log(createEntry('info'));

            // Fast-forward timer (default 5000ms)
            await vi.advanceTimersByTimeAsync(5000);

            expect(mockFetch).toHaveBeenCalled();
        });

        it('should set state to running', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });

            await transport.initialize();

            expect(transport.state).toBe('running');
        });
    });

    describe('log', () => {
        it('should buffer log entries', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Message 1'));
            transport.log(createEntry('info', 'Message 2'));

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should flush when batch size is reached', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            // Default batch size is 100
            for (let i = 0; i < 100; i++) {
                transport.log(createEntry('info', `Message ${i}`));
            }

            // Allow async flush to complete (advance just enough for the promise)
            await vi.advanceTimersByTimeAsync(10);

            expect(mockFetch).toHaveBeenCalled();

            await transport.shutdown();
        });

        it('should not log when level is below minimum', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                level: 'error',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            transport.log(createEntry('warn'));

            await transport.flush();

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe('flush', () => {
        it('should send logs to OTLP endpoint', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            expect(mockFetch).toHaveBeenCalledWith(
                'http://collector:4318/v1/logs',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                    }),
                })
            );
        });

        it('should handle endpoint with /v1/logs suffix', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318/v1/logs',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            expect(mockFetch).toHaveBeenCalledWith(
                'http://collector:4318/v1/logs',
                expect.any(Object)
            );
        });

        it('should not send when buffer is empty', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            await transport.flush();

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should include custom headers when configured', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                headers: {
                    'Authorization': 'Bearer token123',
                    'X-Custom-Header': 'value',
                },
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const headers = fetchCall[1].headers;
            expect(headers.Authorization).toBe('Bearer token123');
            expect(headers['X-Custom-Header']).toBe('value');
        });
    });

    describe('OTLP formatting', () => {
        it('should format payload as ExportLogsServiceRequest', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            expect(body).toHaveProperty('resourceLogs');
            expect(Array.isArray(body.resourceLogs)).toBe(true);
        });

        it('should include resource attributes', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                serviceVersion: '2.0.0',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                environment: 'production',
                hostname: 'server-1',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].resource.attributes;

            expect(attrs).toContainEqual({
                key: 'service.name',
                value: { stringValue: 'my-service' },
            });
            expect(attrs).toContainEqual({
                key: 'service.version',
                value: { stringValue: '2.0.0' },
            });
        });

        it('should include custom resource attributes', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                resourceAttributes: {
                    'custom.attr': 'custom-value',
                    'deployment.region': 'us-east-1',
                },
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].resource.attributes;

            expect(attrs).toContainEqual({
                key: 'custom.attr',
                value: { stringValue: 'custom-value' },
            });
            expect(attrs).toContainEqual({
                key: 'deployment.region',
                value: { stringValue: 'us-east-1' },
            });
        });

        it('should include scope logs', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const scopeLogs = body.resourceLogs[0].scopeLogs;

            expect(scopeLogs).toHaveLength(1);
            expect(scopeLogs[0].scope.name).toBe('@arcaai/applications/logging');
        });

        it('should format log records correctly', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('warn', 'Warning message', {
                timestampMs: 1705315800000,
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.timeUnixNano).toBe('1705315800000000000');
            expect(logRecord.severityNumber).toBe(13); // WARN
            expect(logRecord.severityText).toBe('WARN');
            expect(logRecord.body.stringValue).toBe('Warning message');
        });

        it('should include observedTimeUnixNano', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.observedTimeUnixNano).toBeDefined();
        });

        it('should map severity numbers correctly', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
            const expectedSeverities = [1, 5, 9, 13, 17, 21];

            for (const level of levels) {
                transport.log(createEntry(level));
            }
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecords = body.resourceLogs[0].scopeLogs[0].logRecords;

            logRecords.forEach((record: any, index: number) => {
                expect(record.severityNumber).toBe(expectedSeverities[index]);
            });
        });
    });

    describe('log attributes', () => {
        it('should include context as attribute', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { context: 'UserService' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            expect(attrs).toContainEqual({
                key: 'context',
                value: { stringValue: 'UserService' },
            });
        });

        it('should include request context as attributes', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                requestId: 'req-123',
                userId: 'user-456',
                tenantId: 'tenant-789',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            expect(attrs).toContainEqual({
                key: 'request.id',
                value: { stringValue: 'req-123' },
            });
            expect(attrs).toContainEqual({
                key: 'user.id',
                value: { stringValue: 'user-456' },
            });
            expect(attrs).toContainEqual({
                key: 'tenant.id',
                value: { stringValue: 'tenant-789' },
            });
        });

        it('should include PID as attribute', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { pid: 12345 }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            expect(attrs).toContainEqual({
                key: 'process.pid',
                value: { intValue: '12345' },
            });
        });

        it('should include error details as attributes', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            const error = new Error('Test error');
            error.stack = 'Error: Test error\n    at test.ts:10:5';
            transport.log(createEntry('error', 'Error occurred', { error }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            expect(attrs).toContainEqual({
                key: 'exception.type',
                value: { stringValue: 'Error' },
            });
            expect(attrs).toContainEqual({
                key: 'exception.message',
                value: { stringValue: 'Test error' },
            });
            expect(attrs).toContainEqual(
                expect.objectContaining({
                    key: 'exception.stacktrace',
                })
            );
        });

        it('should include metadata as attributes', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                meta: {
                    duration: 150,
                    method: 'GET',
                    success: true,
                    data: { nested: 'value' },
                },
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            expect(attrs).toContainEqual({
                key: 'duration',
                value: { intValue: '150' },
            });
            expect(attrs).toContainEqual({
                key: 'method',
                value: { stringValue: 'GET' },
            });
            expect(attrs).toContainEqual({
                key: 'success',
                value: { boolValue: true },
            });
        });

        it('should handle array values in metadata', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                meta: {
                    tags: ['tag1', 'tag2', 'tag3'],
                },
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            const tagsAttr = attrs.find((a: any) => a.key === 'tags');
            expect(tagsAttr).toBeDefined();
            expect(tagsAttr.value.arrayValue).toBeDefined();
        });

        it('should normalize metadata keys with dots', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                meta: {
                    'http.method': 'GET',
                    'http.status_code': 200,
                },
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

            // Dots should be converted to underscores
            expect(attrs).toContainEqual({
                key: 'http_method',
                value: { stringValue: 'GET' },
            });
        });
    });

    describe('trace context injection', () => {
        it('should include trace context when enabled', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                injectTraceContext: true,
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                traceId: 'abc123def456',
                spanId: '789xyz',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.traceId).toBeDefined();
            expect(logRecord.spanId).toBeDefined();
        });

        it('should not include trace context when disabled', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                injectTraceContext: false,
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                traceId: 'abc123def456',
                spanId: '789xyz',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.traceId).toBeUndefined();
            expect(logRecord.spanId).toBeUndefined();
        });

        it('should convert hex trace ID to base64', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                injectTraceContext: true,
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                traceId: 'abcdef1234567890abcdef1234567890',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            // Should be base64 encoded
            expect(logRecord.traceId).toBeDefined();
            expect(typeof logRecord.traceId).toBe('string');
        });
    });

    describe('shutdown', () => {
        it('should stop flush timer on shutdown', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            await transport.shutdown();

            expect(transport.state).toBe('stopped');
        });

        it('should flush remaining logs on shutdown', async () => {
            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
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

            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            await expect(transport.flush()).resolves.not.toThrow();
        });

        it('should handle non-ok responses', async () => {
            mockFetch.mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: () => Promise.resolve('Server error'),
            });

            const transport = new OTelTransport({
                name: 'otel',
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            await expect(transport.flush()).resolves.not.toThrow();
        });
    });

    describe('createOTelTransport factory', () => {
        it('should create transport with correct name', () => {
            const transport = createOTelTransport({
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            expect(transport.name).toBe('otel');
        });

        it('should create enabled transport by default', () => {
            const transport = createOTelTransport({
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
            });
            expect(transport.enabled).toBe(true);
        });

        it('should allow disabling transport', () => {
            const transport = createOTelTransport({
                endpoint: 'http://collector:4318',
                serviceName: 'my-service',
                enabled: false,
            });
            expect(transport.enabled).toBe(false);
        });
    });
});
