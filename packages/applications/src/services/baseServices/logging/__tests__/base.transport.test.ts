/**
 * BaseTransport Unit Tests
 *
 * Tests for the abstract base transport class functionality.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseTransport } from '../transports/base.transport';
import type { BaseTransportConfig, LogEntry, LogLevel, TransportState } from '../transports/types';

// Concrete implementation for testing abstract class
class TestTransport extends BaseTransport {
  public loggedEntries: LogEntry[] = [];

  constructor(config: BaseTransportConfig) {
    super(config);
  }

  log(entry: LogEntry): void {
    if (this.shouldLog(entry.level)) {
      this.loggedEntries.push(entry);
    }
  }

  // Expose protected methods for testing
  public testFormatError(error: unknown) {
    return this.formatError(error);
  }

  public testToStructuredLog(entry: LogEntry) {
    return this.toStructuredLog(entry);
  }

  public testGetLevelColor(level: LogLevel) {
    return this.getLevelColor(level);
  }

  public getResetColor() {
    return this.resetColor;
  }
}

describe('BaseTransport', () => {
  const createEntry = (level: LogLevel, message: string = 'test message'): LogEntry => ({
    level,
    levelNumber: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level],
    message,
    timestamp: '2024-01-15T10:30:00.000Z',
    timestampMs: 1705315800000,
  });

  describe('constructor', () => {
    it('should initialize with default level when not specified', () => {
      const transport = new TestTransport({ name: 'test' });
      expect(transport.name).toBe('test');
      expect(transport.state).toBe('initialized');
    });

    it('should use provided level', () => {
      const transport = new TestTransport({ name: 'test', level: 'warn' });
      transport.log(createEntry('info'));
      transport.log(createEntry('warn'));
      expect(transport.loggedEntries).toHaveLength(1);
      expect(transport.loggedEntries[0].level).toBe('warn');
    });

    it('should handle includeLevels configuration', () => {
      const transport = new TestTransport({
        name: 'test',
        includeLevels: ['error', 'fatal'],
      });
      transport.log(createEntry('info'));
      transport.log(createEntry('warn'));
      transport.log(createEntry('error'));
      transport.log(createEntry('fatal'));
      expect(transport.loggedEntries).toHaveLength(2);
    });

    it('should handle excludeLevels configuration', () => {
      const transport = new TestTransport({
        name: 'test',
        excludeLevels: ['debug', 'trace'],
      });
      transport.log(createEntry('trace'));
      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));
      expect(transport.loggedEntries).toHaveLength(1);
      expect(transport.loggedEntries[0].level).toBe('info');
    });
  });

  describe('shouldLog', () => {
    it('should return false when transport is disabled', () => {
      const transport = new TestTransport({ name: 'test', enabled: false });
      transport.log(createEntry('error'));
      expect(transport.loggedEntries).toHaveLength(0);
    });

    it('should return true when enabled is not specified (defaults to true)', () => {
      const transport = new TestTransport({ name: 'test' });
      transport.log(createEntry('info'));
      expect(transport.loggedEntries).toHaveLength(1);
    });

    it('should filter by minimum level', () => {
      const transport = new TestTransport({ name: 'test', level: 'warn' });

      transport.log(createEntry('trace'));
      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));
      expect(transport.loggedEntries).toHaveLength(0);

      transport.log(createEntry('warn'));
      transport.log(createEntry('error'));
      transport.log(createEntry('fatal'));
      expect(transport.loggedEntries).toHaveLength(3);
    });

    it('should respect includeLevels over minLevel', () => {
      const transport = new TestTransport({
        name: 'test',
        level: 'trace',
        includeLevels: ['info', 'error'],
      });

      transport.log(createEntry('trace'));
      transport.log(createEntry('debug'));
      transport.log(createEntry('info'));
      transport.log(createEntry('warn'));
      transport.log(createEntry('error'));
      transport.log(createEntry('fatal'));

      expect(transport.loggedEntries).toHaveLength(2);
      expect(transport.loggedEntries.map((e) => e.level)).toEqual(['info', 'error']);
    });

    it('should exclude levels in excludeLevels', () => {
      const transport = new TestTransport({
        name: 'test',
        excludeLevels: ['warn'],
      });

      transport.log(createEntry('info'));
      transport.log(createEntry('warn'));
      transport.log(createEntry('error'));

      expect(transport.loggedEntries).toHaveLength(2);
      expect(transport.loggedEntries.map((e) => e.level)).toEqual(['info', 'error']);
    });
  });

  describe('lifecycle methods', () => {
    it('should set state to running on initialize', async () => {
      const transport = new TestTransport({ name: 'test' });
      expect(transport.state).toBe('initialized');

      await transport.initialize();
      expect(transport.state).toBe('running');
    });

    it('should set state to stopped on shutdown', async () => {
      const transport = new TestTransport({ name: 'test' });
      await transport.initialize();
      expect(transport.state).toBe('running');

      await transport.shutdown();
      expect(transport.state).toBe('stopped');
    });

    it('should call flush before shutdown', async () => {
      const transport = new TestTransport({ name: 'test' });
      const flushSpy = vi.spyOn(transport, 'flush');

      await transport.shutdown();

      expect(flushSpy).toHaveBeenCalled();
    });
  });

  describe('formatError', () => {
    it('should format Error objects correctly', () => {
      const transport = new TestTransport({ name: 'test' });
      const error = new Error('Test error message');
      error.stack = 'Error: Test error message\n    at test.ts:1:1';

      const formatted = transport.testFormatError(error);

      expect(formatted).toEqual({
        name: 'Error',
        message: 'Test error message',
        stack: 'Error: Test error message\n    at test.ts:1:1',
      });
    });

    it('should handle Error with cause', () => {
      const transport = new TestTransport({ name: 'test' });
      const cause = new Error('Root cause');
      const error = new Error('Wrapper error', { cause });

      const formatted = transport.testFormatError(error);

      expect(formatted).toHaveProperty('cause');
      expect((formatted as any).cause).toHaveProperty('message', 'Root cause');
    });

    it('should handle plain objects', () => {
      const transport = new TestTransport({ name: 'test' });
      const errorObj = { code: 'ERR_001', details: 'Something went wrong' };

      const formatted = transport.testFormatError(errorObj);

      expect(formatted).toEqual(errorObj);
    });

    it('should handle string errors', () => {
      const transport = new TestTransport({ name: 'test' });
      const formatted = transport.testFormatError('String error');

      expect(formatted).toEqual({ message: 'String error' });
    });

    it('should handle number errors', () => {
      const transport = new TestTransport({ name: 'test' });
      const formatted = transport.testFormatError(500);

      expect(formatted).toEqual({ message: '500' });
    });

    it('should return undefined for null/undefined', () => {
      const transport = new TestTransport({ name: 'test' });

      expect(transport.testFormatError(null)).toBeUndefined();
      expect(transport.testFormatError(undefined)).toBeUndefined();
    });
  });

  describe('toStructuredLog', () => {
    it('should create basic structured log', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry = createEntry('info', 'Test message');

      const log = transport.testToStructuredLog(entry);

      expect(log).toMatchObject({
        level: 'info',
        message: 'Test message',
        timestamp: '2024-01-15T10:30:00.000Z',
        timestampMs: 1705315800000,
      });
    });

    it('should include context when present', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        context: 'UserService',
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.context).toBe('UserService');
    });

    it('should include trace context when present', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        traceId: 'abc123',
        spanId: 'def456',
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.traceId).toBe('abc123');
      expect(log.spanId).toBe('def456');
    });

    it('should include request and user context', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        requestId: 'req-123',
        userId: 'user-456',
        tenantId: 'tenant-789',
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.requestId).toBe('req-123');
      expect(log.userId).toBe('user-456');
      expect(log.tenantId).toBe('tenant-789');
    });

    it('should include service info', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        serviceName: 'api',
        serviceVersion: '1.0.0',
        environment: 'production',
        hostname: 'server-1',
        pid: 12345,
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.service).toBe('api');
      expect(log.version).toBe('1.0.0');
      expect(log.env).toBe('production');
      expect(log.hostname).toBe('server-1');
      expect(log.pid).toBe(12345);
    });

    it('should format error when present', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('error'),
        error: new Error('Test error'),
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.error).toBeDefined();
      expect((log.error as any).message).toBe('Test error');
    });

    it('should merge metadata into log', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        meta: {
          customField: 'value',
          duration: 150,
        },
      };

      const log = transport.testToStructuredLog(entry);

      expect(log.customField).toBe('value');
      expect(log.duration).toBe(150);
    });

    it('should not include empty meta', () => {
      const transport = new TestTransport({ name: 'test' });
      const entry: LogEntry = {
        ...createEntry('info'),
        meta: {},
      };

      const log = transport.testToStructuredLog(entry);

      // Should not have any extra keys from empty meta
      const expectedKeys = ['level', 'message', 'timestamp', 'timestampMs'];
      expect(Object.keys(log).sort()).toEqual(expectedKeys.sort());
    });
  });

  describe('getLevelColor', () => {
    it('should return correct ANSI colors for each level', () => {
      const transport = new TestTransport({ name: 'test' });

      expect(transport.testGetLevelColor('trace')).toBe('\x1b[90m'); // Gray
      expect(transport.testGetLevelColor('debug')).toBe('\x1b[36m'); // Cyan
      expect(transport.testGetLevelColor('info')).toBe('\x1b[32m'); // Green
      expect(transport.testGetLevelColor('warn')).toBe('\x1b[33m'); // Yellow
      expect(transport.testGetLevelColor('error')).toBe('\x1b[31m'); // Red
      expect(transport.testGetLevelColor('fatal')).toBe('\x1b[35m'); // Magenta
    });

    it('should have reset color constant', () => {
      const transport = new TestTransport({ name: 'test' });
      expect(transport.getResetColor()).toBe('\x1b[0m');
    });
  });

  describe('enabled property', () => {
    it('should return true when enabled is not specified', () => {
      const transport = new TestTransport({ name: 'test' });
      expect(transport.enabled).toBe(true);
    });

    it('should return true when enabled is true', () => {
      const transport = new TestTransport({ name: 'test', enabled: true });
      expect(transport.enabled).toBe(true);
    });

    it('should return false when enabled is false', () => {
      const transport = new TestTransport({ name: 'test', enabled: false });
      expect(transport.enabled).toBe(false);
    });
  });

  describe('config property', () => {
    it('should expose the configuration', () => {
      const config: BaseTransportConfig = {
        name: 'test-transport',
        level: 'warn',
        enabled: true,
        includeLevels: ['error', 'fatal'],
      };
      const transport = new TestTransport(config);

      expect(transport.config).toEqual(config);
    });
  });
});
