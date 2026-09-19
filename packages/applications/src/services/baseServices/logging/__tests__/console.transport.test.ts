/**
 * ConsoleTransport Unit Tests
 *
 * Tests for the console transport implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsoleTransport, createConsoleTransport } from '../transports/console.transport';
import type { ConsoleTransportConfig, LogEntry, LogLevel } from '../transports/types';

describe('ConsoleTransport', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  const createEntry = (level: LogLevel, message: string = 'test message', overrides: Partial<LogEntry> = {}): LogEntry => ({
    level,
    levelNumber: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level],
    message,
    timestamp: '2024-01-15T10:30:00.000Z',
    timestampMs: 1705315800000,
    ...overrides,
  });

  describe('constructor', () => {
    it('should create transport with default config', () => {
      const transport = new ConsoleTransport({ name: 'console' });
      expect(transport.name).toBe('console');
    });

    it('should use development defaults in development mode', () => {
      process.env.NODE_ENV = 'development';
      const transport = new ConsoleTransport({ name: 'console' });

      transport.log(createEntry('info'));

      // In development, should use pretty print (not JSON)
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).not.toMatch(/^\{/); // Not JSON
    });

    it('should use production defaults in production mode', () => {
      process.env.NODE_ENV = 'production';
      const transport = new ConsoleTransport({ name: 'console' });

      transport.log(createEntry('info'));

      // In production, should use JSON
      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/^\{/); // JSON format
    });
  });

  describe('log', () => {
    it('should write to stdout for non-error levels', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      transport.log(createEntry('info'));
      transport.log(createEntry('debug'));
      transport.log(createEntry('warn'));

      expect(stdoutWriteSpy).toHaveBeenCalledTimes(3);
      expect(stderrWriteSpy).not.toHaveBeenCalled();
    });

    it('should write to stderr for error and fatal levels', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      transport.log(createEntry('error'));
      transport.log(createEntry('fatal'));

      expect(stderrWriteSpy).toHaveBeenCalledTimes(2);
    });

    it('should not log when level is below minimum', () => {
      const transport = new ConsoleTransport({ name: 'console', level: 'warn', json: true });

      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));

      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('should append newline to output', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      transport.log(createEntry('info'));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\n$/);
    });
  });

  describe('JSON format', () => {
    it('should output valid JSON', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });

      transport.log(createEntry('info', 'Test message'));

      const output = (stdoutWriteSpy.mock.calls[0][0] as string).trim();
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('should include all standard fields in JSON', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });
      const entry = createEntry('info', 'Test message', {
        context: 'TestService',
        traceId: 'trace-123',
        spanId: 'span-456',
        requestId: 'req-789',
        userId: 'user-001',
        tenantId: 'tenant-002',
        serviceName: 'api',
        serviceVersion: '1.0.0',
        environment: 'test',
        hostname: 'test-host',
        pid: 12345,
      });

      transport.log(entry);

      const output = JSON.parse((stdoutWriteSpy.mock.calls[0][0] as string).trim());
      expect(output.level).toBe('info');
      expect(output.message).toBe('Test message');
      expect(output.context).toBe('TestService');
      expect(output.traceId).toBe('trace-123');
      expect(output.spanId).toBe('span-456');
      expect(output.requestId).toBe('req-789');
      expect(output.userId).toBe('user-001');
      expect(output.tenantId).toBe('tenant-002');
      expect(output.service).toBe('api');
      expect(output.version).toBe('1.0.0');
      expect(output.env).toBe('test');
      expect(output.hostname).toBe('test-host');
      expect(output.pid).toBe(12345);
    });

    it('should include error details in JSON', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });
      const error = new Error('Test error');
      const entry = createEntry('error', 'Error occurred', { error });

      transport.log(entry);

      const output = JSON.parse((stderrWriteSpy.mock.calls[0][0] as string).trim());
      expect(output.error).toBeDefined();
      expect(output.error.message).toBe('Test error');
      expect(output.error.name).toBe('Error');
    });

    it('should include metadata in JSON', () => {
      const transport = new ConsoleTransport({ name: 'console', json: true });
      const entry = createEntry('info', 'Test', {
        meta: { duration: 150, method: 'GET', path: '/api/users' },
      });

      transport.log(entry);

      const output = JSON.parse((stdoutWriteSpy.mock.calls[0][0] as string).trim());
      expect(output.duration).toBe(150);
      expect(output.method).toBe('GET');
      expect(output.path).toBe('/api/users');
    });
  });

  describe('Pretty print format', () => {
    it('should include timestamp when configured', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
        includeTimestamp: true,
      });

      transport.log(createEntry('info', 'Test message'));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/); // HH:MM:SS.mmm
    });

    it('should include PID when configured', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
        includePid: true,
      });

      transport.log(createEntry('info', 'Test', { pid: 12345 }));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('[12345]');
    });

    it('should include context in brackets', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test', { context: 'UserService' }));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('[UserService]');
    });

    it('should include message', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'This is the log message'));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('This is the log message');
    });

    it('should include truncated trace ID', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test', { traceId: 'abcdef1234567890' }));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('trace=abcdef12...');
    });

    it('should include truncated request ID', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test', { requestId: 'req-abcdef1234567890' }));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('req=req-abcd...');
    });

    it('should format error with stack trace', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n    at test.ts:10:5';

      transport.log(createEntry('error', 'Error occurred', { error }));

      const output = stderrWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('Error: Test error');
      expect(output).toContain('at test.ts:10:5');
    });

    it('should format metadata as key=value pairs', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          meta: { duration: 150, method: 'GET' },
        }),
      );

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('duration=150');
      expect(output).toContain('method=GET');
    });

    it('should not include empty metadata', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test', { meta: {} }));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('{}');
    });
  });

  describe('colorized output', () => {
    it('should include ANSI color codes when colorize is true', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: true,
      });

      transport.log(createEntry('info', 'Test'));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\x1b\[\d+m/); // ANSI escape codes
    });

    it('should not include ANSI codes when colorize is false', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(createEntry('info', 'Test'));

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).not.toMatch(/\x1b\[\d+m/);
    });

    it('should use different colors for different levels', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: true,
      });

      transport.log(createEntry('info', 'Info message'));
      transport.log(createEntry('warn', 'Warn message'));

      const infoOutput = stdoutWriteSpy.mock.calls[0][0] as string;
      const warnOutput = stdoutWriteSpy.mock.calls[1][0] as string;

      // Info should have green color (\x1b[32m)
      expect(infoOutput).toContain('\x1b[32m');
      // Warn should have yellow color (\x1b[33m)
      expect(warnOutput).toContain('\x1b[33m');
    });
  });

  describe('createConsoleTransport factory', () => {
    it('should create transport with default name', () => {
      const transport = createConsoleTransport();
      expect(transport.name).toBe('console');
    });

    it('should create enabled transport by default', () => {
      const transport = createConsoleTransport();
      expect(transport.enabled).toBe(true);
    });

    it('should merge provided config with defaults', () => {
      const transport = createConsoleTransport({
        level: 'warn',
        colorize: true,
      });

      expect(transport.name).toBe('console');
      expect(transport.config.level).toBe('warn');
    });
  });

  describe('edge cases', () => {
    it('should handle object errors in pretty format', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(
        createEntry('error', 'Error', {
          error: { code: 'ERR_001', details: 'Something went wrong' } as any,
        }),
      );

      const output = stderrWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('ERR_001');
    });

    it('should handle metadata with object values', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          meta: { nested: { key: 'value' } },
        }),
      );

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('nested=');
    });

    it('should filter out undefined/null metadata values', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
      });

      transport.log(
        createEntry('info', 'Test', {
          meta: { valid: 'value', empty: null, missing: undefined, blank: '' },
        }),
      );

      const output = stdoutWriteSpy.mock.calls[0][0] as string;
      expect(output).toContain('valid=value');
      expect(output).not.toContain('empty=');
      expect(output).not.toContain('missing=');
      expect(output).not.toContain('blank=');
    });

    it('should handle invalid timestamp gracefully', () => {
      const transport = new ConsoleTransport({
        name: 'console',
        prettyPrint: true,
        json: false,
        colorize: false,
        includeTimestamp: true,
      });

      transport.log({
        ...createEntry('info'),
        timestamp: 'invalid-timestamp',
      });

      // Should not throw and should output something
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });
  });
});
