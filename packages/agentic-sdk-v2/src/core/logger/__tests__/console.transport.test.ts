/**
 * SDK Console Transport Unit Tests
 *
 * Tests for the SDK console transport implementation.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsoleTransport } from '../transports/console.transport';
import type { LogEntry, LogLevel } from '../types';

describe('SDK ConsoleTransport', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
    debug: ReturnType<typeof vi.spyOn>;
    trace: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      trace: vi.spyOn(console, 'trace').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createEntry = (level: LogLevel, message: string = 'test message', overrides: Partial<LogEntry> = {}): LogEntry => ({
    timestamp: 1705315800000,
    timestampIso: '2024-01-15T10:30:00.000Z',
    level,
    severityNumber: { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 }[level],
    message,
    ...overrides,
  });

  describe('constructor', () => {
    it('should create transport with config', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'info',
      });
      expect(transport.name).toBe('console');
    });

    it('should use default level when not specified', () => {
      const transport = new ConsoleTransport({ enabled: true });
      // Should log info and above by default
      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    it('should initialize without error', async () => {
      const transport = new ConsoleTransport({ enabled: true });
      await expect(transport.initialize()).resolves.not.toThrow();
    });
  });

  describe('log', () => {
    it('should log to console.info for info level', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(createEntry('info', 'Info message'));

      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should log to console.warn for warn level', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(createEntry('warn', 'Warning message'));

      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should log to console.error for error level', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(createEntry('error', 'Error message'));

      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should log to console.error for fatal level', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(createEntry('fatal', 'Fatal message'));

      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should not log when level is below minimum', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'warn',
      });

      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('JSON format', () => {
    it('should output JSON when prettyPrint is false', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(createEntry('info', 'Test message'));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include all fields in JSON output', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          context: 'TestContext',
          correlation: { correlationId: 'corr-123', requestId: 'req-456' },
          trace: { traceId: 'trace-789', spanId: 'span-012' },
          user: { userId: 'user-1', tenantId: 'tenant-1' },
          operation: { operation: 'test', durationMs: 100 },
        }),
      );

      const output = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(output.context).toBe('TestContext');
      expect(output.correlationId).toBe('corr-123');
      expect(output.requestId).toBe('req-456');
      expect(output.traceId).toBe('trace-789');
      expect(output.userId).toBe('user-1');
    });
  });

  describe('Pretty print format', () => {
    it('should include timestamp when configured', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        includeTimestamp: true,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test'));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    it('should include level label', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test'));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toContain('INFO');
    });

    it('should include context in brackets', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test', { context: 'MyContext' }));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toContain('[MyContext]');
    });

    it('should include truncated correlation ID', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          correlation: { correlationId: 'abcdef1234567890' },
        }),
      );

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toContain('(abcdef12)');
    });

    it('should include operation info', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          operation: { operation: 'createUser', durationMs: 150 },
        }),
      );

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toContain('op=createUser');
      expect(output).toContain('duration=150ms');
    });

    it('should include HTTP info', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          http: { method: 'GET', url: '/api/users', statusCode: 200 },
        }),
      );

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toContain('GET /api/users');
      expect(output).toContain('status=200');
    });
  });

  describe('colorized output', () => {
    it('should include ANSI codes when colorize is true', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: true,
      });

      transport.log(createEntry('info', 'Test'));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).toMatch(/\x1b\[\d+m/);
    });

    it('should not include ANSI codes when colorize is false', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test'));

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });
  });

  describe('error logging', () => {
    it('should log error stack trace in pretty mode', () => {
      const transport = new ConsoleTransport({
        enabled: true,
        level: 'trace',
        prettyPrint: true,
        colorize: false,
      });

      transport.log(
        createEntry('error', 'Error occurred', {
          error: {
            name: 'Error',
            code: 'ERR_001',
            stack: 'Error: Test\n    at test.ts:10:5',
          },
        }),
      );

      // Should log the stack trace separately
      expect(consoleSpy.error).toHaveBeenCalledTimes(2);
    });
  });

  describe('flush and shutdown', () => {
    it('should flush without error', async () => {
      const transport = new ConsoleTransport({ enabled: true });
      await expect(transport.flush()).resolves.not.toThrow();
    });

    it('should shutdown without error', async () => {
      const transport = new ConsoleTransport({ enabled: true });
      await expect(transport.shutdown()).resolves.not.toThrow();
    });
  });
});
