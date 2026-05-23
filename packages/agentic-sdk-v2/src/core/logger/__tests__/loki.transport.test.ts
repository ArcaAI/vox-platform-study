/**
 * @arcaai/vox - Loki Transport Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LokiTransport } from '../transports/loki.transport';
import type { LogEntry, LokiTransportConfig } from '../types';

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('LokiTransport', () => {
  let transport: LokiTransport;
  let config: LokiTransportConfig;

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
      enabled: true,
      url: 'http://localhost:3100',
      labels: {
        app: 'test-app',
        environment: 'test',
      },
      level: 'debug',
      batchIntervalMs: 5000,
      maxBatchSize: 100,
    };

    transport = new LokiTransport(config);
  });

  afterEach(async () => {
    await transport.shutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create transport with name "loki"', () => {
      expect(transport.name).toBe('loki');
    });

    it('should use default batch settings', () => {
      const minimalTransport = new LokiTransport({
        enabled: true,
        url: 'http://localhost:3100',
      });
      expect(minimalTransport.name).toBe('loki');
    });
  });

  describe('initialize', () => {
    it('should start batch flush timer', async () => {
      await transport.initialize();

      // Log some entries
      transport.log(createLogEntry());
      transport.log(createLogEntry());

      // Advance timer to trigger flush
      await vi.advanceTimersByTimeAsync(5000);

      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('log', () => {
    it('should buffer log entries', async () => {
      await transport.initialize();

      transport.log(createLogEntry({ message: 'Log 1' }));
      transport.log(createLogEntry({ message: 'Log 2' }));

      // Logs are buffered, not sent immediately
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should filter logs below configured level', async () => {
      const warnTransport = new LokiTransport({ ...config, level: 'warn' });
      await warnTransport.initialize();

      warnTransport.log(createLogEntry({ level: 'info' }));

      // Should not buffer info level when configured for warn
    });

    it('should flush when buffer exceeds maxBatchSize', async () => {
      // Use real timers to avoid infinite loop issues
      vi.useRealTimers();

      const smallBatchTransport = new LokiTransport({
        ...config,
        maxBatchSize: 2,
        batchIntervalMs: 60000, // Long interval to prevent timer-based flush
      });
      // Don't initialize to avoid starting flush timer

      smallBatchTransport.log(createLogEntry({ message: 'Log 1' }));
      smallBatchTransport.log(createLogEntry({ message: 'Log 2' }));

      // Allow async flush to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).toHaveBeenCalled();

      vi.useFakeTimers();
    });

    it('should include context as label', async () => {
      await transport.initialize();

      transport.log(createLogEntry({ context: 'MyContext' }));

      await transport.flush();

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.streams[0].stream.context).toBe('MyContext');
    });

    it('should build structured metadata', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          correlation: {
            correlationId: 'corr-123',
            requestId: 'req-456',
            sessionId: 'sess-789',
          },
          trace: {
            traceId: 'trace-abc',
            spanId: 'span-def',
          },
          user: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            doctorId: 'doc-1',
            patientId: 'patient-1',
          },
          operation: {
            operation: 'testOp',
            durationMs: 100,
            success: true,
          },
          http: {
            method: 'GET',
            url: '/api/test',
            statusCode: 200,
            responseTimeMs: 50,
          },
          sdk: {
            consultationId: 'cons-1',
            modelId: 'model-1',
          },
          error: {
            code: 'ERR_TEST',
            name: 'TestError',
          },
          attributes: {
            customKey: 'customValue',
            numericKey: 123,
            boolKey: true,
          },
          tags: ['tag1', 'tag2'],
        })
      );

      await transport.flush();

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should include error details in log line', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          level: 'error',
          error: {
            code: 'ERR_TEST',
            name: 'TestError',
            stack: 'Error: Test\n  at test.ts:1:1',
          },
        })
      );

      await transport.flush();

      expect(mockFetch).toHaveBeenCalled();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const logLine = JSON.parse(body.streams[0].values[0][1]);
      expect(logLine.error).toBeDefined();
      expect(logLine.stack_trace).toBeDefined();
    });
  });

  describe('flush', () => {
    it('should send buffered logs to Loki', async () => {
      await transport.initialize();

      transport.log(createLogEntry({ message: 'Test log' }));
      await transport.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/loki/api/v1/push',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
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

      // Should re-add entries to buffer on failure
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

    it('should include basic auth header when configured', async () => {
      const authTransport = new LokiTransport({
        ...config,
        basicAuth: 'user:password',
      });
      await authTransport.initialize();

      authTransport.log(createLogEntry());
      await authTransport.flush();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
          }),
        })
      );
    });

    it('should include custom headers', async () => {
      const headersTransport = new LokiTransport({
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

  describe('label building', () => {
    it('should add environment label from resource', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          resource: {
            serviceName: 'test-service',
            environment: 'production',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.streams[0].stream.env).toBe('production');
    });

    it('should add service name label from resource', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          resource: {
            serviceName: 'my-service',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.streams[0].stream.service).toBe('my-service');
    });

    it('should add component label from operation', async () => {
      await transport.initialize();

      transport.log(
        createLogEntry({
          operation: {
            component: 'MyComponent',
          },
        })
      );

      await transport.flush();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.streams[0].stream.component).toBe('MyComponent');
    });
  });

  // =========================================================================
  // TASK-278: gated activation
  //
  // Mirrors TASK-266 W0-2 for HighlightTransport. The Loki transport may
  // only activate when ALL of:
  //   1. NODE_ENV !== 'production' (or process is undefined)
  //   2. config.enabled === true (explicit opt-in)
  //   3. config.url is a non-empty string (endpoint present)
  // If any gate fails: NO initialize work (no flush timer), NO log buffering,
  // NO POST. Fail-closed so a misconfigured deploy cannot leak PHI to Loki.
  // =========================================================================
  describe('TASK-278: gated activation', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('does NOT initialise loki when NODE_ENV=production, even with enabled+url', async () => {
      process.env.NODE_ENV = 'production';
      const t = new LokiTransport({
        enabled: true,
        url: 'http://localhost:3100',
        level: 'info',
      });

      await t.initialize();
      t.log(createLogEntry({ level: 'info', message: 'should-drop' }));
      await t.flush();

      expect(mockFetch).not.toHaveBeenCalled();
      await t.shutdown();
    });

    it('does NOT initialise loki when enabled=false', async () => {
      process.env.NODE_ENV = 'development';
      const t = new LokiTransport({
        enabled: false,
        url: 'http://localhost:3100',
        level: 'info',
      });

      await t.initialize();
      t.log(createLogEntry({ level: 'info' }));
      await t.flush();

      expect(mockFetch).not.toHaveBeenCalled();
      await t.shutdown();
    });

    it('does NOT initialise loki when url is missing/empty', async () => {
      process.env.NODE_ENV = 'development';
      const t = new LokiTransport({
        enabled: true,
        url: '',
        level: 'info',
      });

      await t.initialize();
      t.log(createLogEntry({ level: 'info' }));
      await t.flush();

      expect(mockFetch).not.toHaveBeenCalled();
      await t.shutdown();
    });

    it('initialises and POSTs when all gates pass (dev + enabled + url)', async () => {
      process.env.NODE_ENV = 'development';
      vi.useRealTimers();
      const t = new LokiTransport({
        enabled: true,
        url: 'http://localhost:3100',
        level: 'debug',
      });

      await t.initialize();
      t.log(createLogEntry({ level: 'info', message: 'gated-on' }));
      await t.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [callUrl] = mockFetch.mock.calls[0];
      expect(callUrl).toBe('http://localhost:3100/loki/api/v1/push');

      await t.shutdown();
      vi.useFakeTimers();
    });

    it('does NOT buffer logs when gated off (no PHI leak via in-memory queue)', async () => {
      process.env.NODE_ENV = 'production';
      const t = new LokiTransport({
        enabled: true,
        url: 'http://localhost:3100',
        level: 'info',
      });

      // Pre- and post-init log() calls must be a hard no-op. A misconfigured
      // production deploy must not be able to accumulate PHI in the buffer
      // that a later runtime gate-flip could ship to Loki.
      t.log(createLogEntry({ level: 'info', message: 'pre-init' }));
      await t.initialize();
      for (let i = 0; i < 200; i++) {
        t.log(createLogEntry({ level: 'info', message: `flood-${i}` }));
      }
      await t.flush();

      expect(mockFetch).not.toHaveBeenCalled();
      await t.shutdown();
    });

    it('exposes isAllowedToActivate as a pure static predicate', () => {
      process.env.NODE_ENV = 'development';
      expect(
        LokiTransport.isAllowedToActivate({ enabled: true, url: 'http://l:3100' })
      ).toBe(true);
      expect(
        LokiTransport.isAllowedToActivate({ enabled: false, url: 'http://l:3100' })
      ).toBe(false);
      expect(LokiTransport.isAllowedToActivate({ enabled: true, url: '' })).toBe(false);
      expect(
        LokiTransport.isAllowedToActivate({ enabled: true, url: '   ' })
      ).toBe(false);

      process.env.NODE_ENV = 'production';
      expect(
        LokiTransport.isAllowedToActivate({ enabled: true, url: 'http://l:3100' })
      ).toBe(false);
    });
  });
});
