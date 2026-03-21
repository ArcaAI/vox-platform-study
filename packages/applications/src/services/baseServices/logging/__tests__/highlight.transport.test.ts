/**
 * HighlightTransport Unit Tests
 *
 * Tests for the Highlight.io transport implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HighlightTransport, createHighlightTransport } from '../transports/highlight.transport';
import type { HighlightTransportConfig, LogEntry, LogLevel } from '../transports/types';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('HighlightTransport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
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
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            expect(transport.name).toBe('highlight');
        });

        it('should use default backend URL', () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            expect(transport.config).toBeDefined();
        });

        it('should allow custom backend URL', () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
                backendUrl: 'https://custom.highlight.io',
            });
            expect(transport.config).toBeDefined();
        });

        it('should allow custom OTLP endpoint', () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
                otlpEndpoint: 'https://custom.endpoint/v1/logs',
            });
            expect(transport.config).toBeDefined();
        });
    });

    describe('initialize', () => {
        it('should start flush timer on initialize', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });

            await transport.initialize();

            transport.log(createEntry('info'));

            // Fast-forward timer (default 5000ms)
            await vi.advanceTimersByTimeAsync(5000);

            expect(mockFetch).toHaveBeenCalled();
        });

        it('should set state to running', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });

            await transport.initialize();

            expect(transport.state).toBe('running');
        });
    });

    describe('log', () => {
        it('should buffer log entries', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Message 1'));
            transport.log(createEntry('info', 'Message 2'));

            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('should flush when batch size is reached', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            // Default batch size is 100, log 100 entries
            for (let i = 0; i < 100; i++) {
                transport.log(createEntry('info', `Message ${i}`));
            }

            // Allow async flush to complete (advance just enough for the promise)
            await vi.advanceTimersByTimeAsync(10);

            expect(mockFetch).toHaveBeenCalled();

            await transport.shutdown();
        });

        it('should not log when level is below minimum', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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
        it('should send logs to Highlight OTLP endpoint', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info'));
            await transport.flush();

            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('/v1/logs'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Content-Type': 'application/json',
                        'x-highlight-project': 'proj-123',
                    }),
                })
            );
        });

        it('should not send when buffer is empty', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            await transport.flush();

            expect(mockFetch).not.toHaveBeenCalled();
        });
    });

    describe('OTLP formatting', () => {
        it('should format payload as OTLP resource logs', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
                serviceName: 'my-service',
                serviceVersion: '2.0.0',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { environment: 'production' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const resource = body.resourceLogs[0].resource;

            const attrs = resource.attributes;
            expect(attrs).toContainEqual({
                key: 'service.name',
                value: { stringValue: 'my-service' },
            });
            expect(attrs).toContainEqual({
                key: 'service.version',
                value: { stringValue: '2.0.0' },
            });
            expect(attrs).toContainEqual({
                key: 'highlight.project_id',
                value: { stringValue: 'proj-123' },
            });
        });

        it('should include scope logs', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('error', 'Error message', {
                timestampMs: 1705315800000,
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.timeUnixNano).toBe('1705315800000000000');
            expect(logRecord.severityNumber).toBe(17); // ERROR
            expect(logRecord.severityText).toBe('ERROR');
            expect(logRecord.body.stringValue).toBe('Error message');
        });

        it('should include context as attribute', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', { context: 'UserService' }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.attributes).toContainEqual({
                key: 'context',
                value: { stringValue: 'UserService' },
            });
        });

        it('should include trace context as attributes', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                traceId: 'abc123',
                spanId: 'def456',
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.attributes).toContainEqual({
                key: 'trace_id',
                value: { stringValue: 'abc123' },
            });
            expect(logRecord.attributes).toContainEqual({
                key: 'span_id',
                value: { stringValue: 'def456' },
            });
        });

        it('should include user context as attributes', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.attributes).toContainEqual({
                key: 'request_id',
                value: { stringValue: 'req-123' },
            });
            expect(logRecord.attributes).toContainEqual({
                key: 'user_id',
                value: { stringValue: 'user-456' },
            });
            expect(logRecord.attributes).toContainEqual({
                key: 'tenant_id',
                value: { stringValue: 'tenant-789' },
            });
        });

        it('should include error as attribute', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            const error = new Error('Test error');
            transport.log(createEntry('error', 'Error occurred', { error }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            const errorAttr = logRecord.attributes.find((a: any) => a.key === 'error');
            expect(errorAttr).toBeDefined();
            const errorValue = JSON.parse(errorAttr.value.stringValue);
            expect(errorValue.message).toBe('Test error');
        });

        it('should include metadata as attributes', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info', 'Test', {
                meta: {
                    duration: 150,
                    method: 'GET',
                    success: true,
                },
            }));
            await transport.flush();

            const fetchCall = mockFetch.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

            expect(logRecord.attributes).toContainEqual({
                key: 'duration',
                value: { intValue: '150' },
            });
            expect(logRecord.attributes).toContainEqual({
                key: 'method',
                value: { stringValue: 'GET' },
            });
            expect(logRecord.attributes).toContainEqual({
                key: 'success',
                value: { boolValue: true },
            });
        });

        it('should map severity numbers correctly', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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

    describe('shutdown', () => {
        it('should stop flush timer on shutdown', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            await transport.shutdown();

            expect(transport.state).toBe('stopped');
        });

        it('should flush remaining logs on shutdown', async () => {
            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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

            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
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
            });

            const transport = new HighlightTransport({
                name: 'highlight',
                projectId: 'proj-123',
            });
            await transport.initialize();

            transport.log(createEntry('info'));

            await expect(transport.flush()).resolves.not.toThrow();
        });
    });

    describe('createHighlightTransport factory', () => {
        it('should create transport with correct name', () => {
            const transport = createHighlightTransport({
                projectId: 'proj-123',
            });
            expect(transport.name).toBe('highlight');
        });

        it('should create enabled transport by default', () => {
            const transport = createHighlightTransport({
                projectId: 'proj-123',
            });
            expect(transport.enabled).toBe(true);
        });

        it('should allow disabling transport', () => {
            const transport = createHighlightTransport({
                projectId: 'proj-123',
                enabled: false,
            });
            expect(transport.enabled).toBe(false);
        });
    });
});
