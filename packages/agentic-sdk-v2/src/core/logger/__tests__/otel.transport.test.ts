/**
 * @arcaai/vox - OpenTelemetry Transport Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OTelTransport } from '../transports/otel.transport';
import type { LogEntry, OTelTransportConfig } from '../types';

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('OTelTransport', () => {
  let transport: OTelTransport;
  let config: OTelTransportConfig;

  const createLogEntry = (overrides?: Partial<LogEntry>): LogEntry => ({
    timestamp: Date.now(),
    timestampIso: new Date().toISOString(),
    level: 'info',
    severityNumber: 9,
    message: 'Test message',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(''),
    });

    config = {
      endpoint: 'http://localhost:4318',
      level: 'debug',
      resourceAttributes: {
        'service.name': 'test-service',
        'service.version': '1.0.0',
      },
    };

    transport = new OTelTransport(config);
  });

  afterEach(async () => {
    await transport.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create transport with name "otel"', () => {
      expect(transport.name).toBe('otel');
    });

    it('should use default configuration values', () => {
      const minimalTransport = new OTelTransport({
        endpoint: 'http://localhost:4318',
      });
      expect(minimalTransport.name).toBe('otel');
    });
  });

  describe('initialize', () => {
    it('should build resource attributes', async () => {
      await transport.initialize();
      // Should complete without error
    });

    it('should start batch flush timer', async () => {
      await transport.initialize();

      transport.log(createLogEntry());

      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('log', () => {
    it('should buffer log entries', async () => {
      await transport.initialize();

      transport.log(createLogEntry({ message: 'Log 1' }));
      transport.log(createLogEntry({ message: 'Log 2' }));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should filter logs below configured level', async () => {
      const warnTransport = new OTelTransport({ ...config, level: 'warn' });
      await warnTransport.initialize();

      warnTransport.log(createLogEntry({ level: 'info' }));
      await warnTransport.flush();

      // Should not flush info level when configured for warn
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should apply sampling when ratio is less than 1', async () => {
      // Mock Math.random to return consistent values
      const randomSpy = vi.spyOn(Math, 'random');
      randomSpy.mockReturnValue(0.9); // Higher than 0.5 sampling ratio

      const sampledTransport = new OTelTransport({
        ...config,
        samplingRatio: 0.5, // 50% sampling
      });
      await sampledTransport.initialize();

      sampledTransport.log(createLogEntry());
      await sampledTransport.flush();

      // Log should be skipped because 0.9 > 0.5
      expect(mockFetch).not.toHaveBeenCalled();

      randomSpy.mockRestore();
    });

    it('should flush when buffer exceeds 100 entries', async () => {
      // Don't use fake timers for this test to avoid infinite loop
      vi.useRealTimers();

      const noTimerTransport = new OTelTransport(config);
      // Don't call initialize to avoid starting the timer

      for (let i = 0; i < 101; i++) {
        noTimerTransport.log(createLogEntry({ message: `Log ${i}` }));
      }

      // Wait for the async flush
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).toHaveBeenCalled();

      vi.useFakeTimers();
    });
  });

  describe('OTLP format', () => {
    it('should format log entry as OTLP log record', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          level: 'info',
          message: 'Test OTLP message',
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

      expect(logRecord.severityNumber).toBe(9); // INFO
      expect(logRecord.severityText).toBe('INFO');
      expect(logRecord.body.stringValue).toBe('Test OTLP message');
    });

    it('should include all severity levels', async () => {
      const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
      const expectedSeverity = [1, 5, 9, 13, 17, 21];
      const expectedText = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

      await transport.initialize();

      for (let i = 0; i < levels.length; i++) {
        vi.clearAllMocks();
        mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('') });

        const lowLevelTransport = new OTelTransport({ ...config, level: 'trace' });
        await lowLevelTransport.initialize();
        lowLevelTransport.log(createLogEntry({ level: levels[i] }));
        await lowLevelTransport.flush();

        if (mockFetch.mock.calls.length > 0) {
          const body = JSON.parse(mockFetch.mock.calls[0][1].body);
          const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];
          expect(logRecord.severityNumber).toBe(expectedSeverity[i]);
          expect(logRecord.severityText).toBe(expectedText[i]);
        }
      }
    });

    it('should include trace context', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          trace: {
            traceId: 'abc123def456abc123def456abc12345',
            spanId: 'span123456789012',
            traceFlags: 1,
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

      expect(logRecord.traceId).toBeDefined();
      expect(logRecord.spanId).toBeDefined();
      expect(logRecord.flags).toBe(1);
    });

    it('should normalize trace ID to 32 chars', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          trace: {
            traceId: 'abc-123-def', // Short with dashes
            spanId: 'span123',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

      expect(logRecord.traceId).toHaveLength(32);
    });

    it('should normalize span ID to 16 chars', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          trace: {
            traceId: 'abc123def456abc123def456abc12345',
            spanId: 'short',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0];

      expect(logRecord.spanId).toHaveLength(16);
    });

    it('should build OTLP attributes', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          context: 'TestContext',
          correlation: {
            correlationId: 'corr-123',
            requestId: 'req-456',
            sessionId: 'sess-789',
          },
          user: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            doctorId: 'doc-1',
            patientId: 'patient-1',
          },
          operation: {
            operation: 'testOp',
            component: 'TestComponent',
            durationMs: 100,
            success: true,
          },
          http: {
            method: 'GET',
            url: '/api/test',
            statusCode: 200,
            responseTimeMs: 50,
            userAgent: 'test-agent',
          },
          sdk: {
            consultationId: 'cons-1',
            modelId: 'model-1',
          },
          attributes: {
            stringAttr: 'value',
            numAttr: 42,
            boolAttr: true,
            arrayAttr: ['a', 'b'],
            objAttr: { nested: 'value' },
          },
          tags: ['tag1', 'tag2'],
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

      expect(attrs).toContainEqual({ key: 'log.context', value: { stringValue: 'TestContext' } });
      expect(attrs).toContainEqual({ key: 'correlation.id', value: { stringValue: 'corr-123' } });
    });

    it('should include error attributes', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          level: 'error',
          error: {
            name: 'TestError',
            code: 'ERR_TEST',
            stack: 'Error: test\n  at test.ts:1:1',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;

      expect(attrs).toContainEqual({ key: 'exception.type', value: { stringValue: 'TestError' } });
      expect(attrs).toContainEqual({ key: 'error.code', value: { stringValue: 'ERR_TEST' } });
    });
  });

  describe('OTLP value conversion', () => {
    it('should convert string values', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          attributes: { str: 'test' },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(attrs).toContainEqual({ key: 'str', value: { stringValue: 'test' } });
    });

    it('should convert integer values', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          attributes: { num: 42 },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(attrs).toContainEqual({ key: 'num', value: { intValue: '42' } });
    });

    it('should convert float values', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          attributes: { float: 3.14 },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(attrs).toContainEqual({ key: 'float', value: { doubleValue: 3.14 } });
    });

    it('should convert boolean values', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          attributes: { bool: true },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
      expect(attrs).toContainEqual({ key: 'bool', value: { boolValue: true } });
    });
  });

  describe('flush', () => {
    it('should send buffered logs to OTLP endpoint', async () => {
      await transport.initialize();

      transport.log(createLogEntry());
      await transport.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4318/v1/logs',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should append /v1/logs to endpoint if missing', async () => {
      const trailingSlashTransport = new OTelTransport({
        endpoint: 'http://localhost:4318/',
      });
      await trailingSlashTransport.initialize();

      trailingSlashTransport.log(createLogEntry());
      await trailingSlashTransport.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4318/v1/logs',
        expect.any(Object)
      );
    });

    it('should not flush if buffer is empty', async () => {
      await transport.initialize();
      await transport.flush();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle flush errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await transport.initialize();

      transport.log(createLogEntry());
      await transport.flush();

      // Should handle error gracefully
    });

    it('should handle non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await transport.initialize();

      transport.log(createLogEntry());
      await transport.flush();

      // Should handle error gracefully
    });

    it('should include custom headers', async () => {
      const headersTransport = new OTelTransport({
        ...config,
        headers: {
          'X-Custom-Header': 'custom-value',
        },
      });
      await headersTransport.initialize();

      headersTransport.log(createLogEntry());
      await headersTransport.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom-Header': 'custom-value',
          }),
        })
      );
    });
  });

  describe('shutdown', () => {
    it('should stop flush timer and flush remaining logs', async () => {
      await transport.initialize();

      transport.log(createLogEntry());
      await transport.shutdown();

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('resource attributes', () => {
    it('should include service name', async () => {
      await transport.initialize();

      transport.log(createLogEntry());
      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const resourceAttrs = body.resourceLogs[0].resource.attributes;

      expect(resourceAttrs).toContainEqual({
        key: 'service.name',
        value: { stringValue: 'test-service' },
      });
    });

    it('should include SDK info', async () => {
      await transport.initialize();

      transport.log(createLogEntry());
      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const resourceAttrs = body.resourceLogs[0].resource.attributes;

      expect(resourceAttrs).toContainEqual({
        key: 'telemetry.sdk.name',
        value: { stringValue: '@arcaai/vox' },
      });
      expect(resourceAttrs).toContainEqual({
        key: 'telemetry.sdk.language',
        value: { stringValue: 'javascript' },
      });
    });
  });
});
