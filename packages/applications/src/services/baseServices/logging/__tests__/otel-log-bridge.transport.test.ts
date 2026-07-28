import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LogEntry, LogLevel } from '../transports/types';

const mockEmit = vi.fn();
const mockGetLogger = vi.fn().mockReturnValue({ emit: mockEmit });
const mockGetSpan = vi.fn();

vi.mock('@opentelemetry/api-logs', () => ({
  logs: { getLogger: mockGetLogger },
  SeverityNumber: {
    UNSPECIFIED: 0,
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  },
}));

vi.mock('@opentelemetry/api', () => ({
  trace: { getSpan: mockGetSpan },
  context: { active: vi.fn().mockReturnValue({}) },
}));

function createEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 'info',
    levelNumber: 30,
    message: 'Test message',
    timestamp: '2026-04-03T12:00:00.000Z',
    timestampMs: 1743681600000,
    ...overrides,
  };
}

describe('OTelLogBridgeTransport', () => {
  let transport: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGetSpan.mockReturnValue(undefined);

    const { OTelLogBridgeTransport } = await import('../transports/otel-log-bridge.transport');
    transport = new OTelLogBridgeTransport({
      name: 'otel-bridge',
      enabled: true,
      level: 'trace',
      serviceName: 'test-api',
      serviceVersion: '1.0.0',
    });
  });

  it('should call otelLogger.emit() when log() is called', () => {
    transport.log(createEntry());

    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('should include log message as body', () => {
    transport.log(createEntry({ message: 'Hello world' }));

    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hello world' }));
  });

  describe('severity mapping', () => {
    const cases: Array<[LogLevel, number, string]> = [
      ['trace', 1, 'TRACE'],
      ['debug', 5, 'DEBUG'],
      ['info', 9, 'INFO'],
      ['warn', 13, 'WARN'],
      ['error', 17, 'ERROR'],
      ['fatal', 21, 'FATAL'],
    ];

    it.each(cases)('should map %s to SeverityNumber %d', (level, expectedNumber, expectedText) => {
      transport.log(createEntry({ level, levelNumber: expectedNumber * 10 }));

      expect(mockEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: expectedNumber,
          severityText: expectedText,
        }),
      );
    });
  });

  it('should include context as nestjs.context attribute', () => {
    transport.log(createEntry({ context: 'UserController' }));

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'nestjs.context': 'UserController',
        }),
      }),
    );
  });

  it('should include requestId as request.id attribute', () => {
    transport.log(createEntry({ requestId: 'req-123' }));

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'request.id': 'req-123',
        }),
      }),
    );
  });

  it('should include tenantId and userId as attributes', () => {
    transport.log(createEntry({ tenantId: 'tenant-1', userId: 'user-42' }));

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'tenant.id': 'tenant-1',
          'user.id': 'user-42',
        }),
      }),
    );
  });

  it('should include error details as exception attributes', () => {
    const error = new Error('Something failed');
    error.name = 'ValidationError';

    transport.log(createEntry({ level: 'error', levelNumber: 50, error }));

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'exception.type': 'ValidationError',
          'exception.message': 'Something failed',
          'exception.stacktrace': expect.any(String),
        }),
      }),
    );
  });

  it('should include metadata as attributes', () => {
    transport.log(
      createEntry({
        meta: { duration: 150, action: 'login' },
      }),
    );

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          duration: 150,
          action: 'login',
        }),
      }),
    );
  });

  it('should stringify object metadata values', () => {
    transport.log(
      createEntry({
        meta: { nested: { key: 'value' } },
      }),
    );

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          nested: '{"key":"value"}',
        }),
      }),
    );
  });

  it('should respect shouldLog() level filtering', async () => {
    const { OTelLogBridgeTransport } = await import('../transports/otel-log-bridge.transport');
    const filteredTransport = new OTelLogBridgeTransport({
      name: 'otel-bridge',
      enabled: true,
      level: 'warn',
      serviceName: 'test-api',
    });

    filteredTransport.log(createEntry({ level: 'debug', levelNumber: 20 }));

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('should not emit when transport is disabled', async () => {
    const { OTelLogBridgeTransport } = await import('../transports/otel-log-bridge.transport');
    const disabledTransport = new OTelLogBridgeTransport({
      name: 'otel-bridge',
      enabled: false,
      serviceName: 'test-api',
    });

    disabledTransport.log(createEntry());

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('should include pid as process.pid attribute', () => {
    transport.log(createEntry({ pid: 12345 }));

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'process.pid': 12345,
        }),
      }),
    );
  });

  it('should skip null and undefined metadata values', () => {
    transport.log(
      createEntry({
        meta: { present: 'yes', absent: undefined, nothing: null },
      }),
    );

    const emittedAttrs = mockEmit.mock.calls[0][0].attributes;
    expect(emittedAttrs.present).toBe('yes');
    expect(emittedAttrs).not.toHaveProperty('absent');
    expect(emittedAttrs).not.toHaveProperty('nothing');
  });

  it('should get logger with service name and version', () => {
    expect(mockGetLogger).toHaveBeenCalledWith('test-api', '1.0.0');
  });
});

describe('createOTelLogBridgeTransport', () => {
  it('should create transport with correct defaults', async () => {
    vi.resetModules();

    const { createOTelLogBridgeTransport } = await import('../transports/otel-log-bridge.transport');
    const t = createOTelLogBridgeTransport({
      enabled: true,
      serviceName: 'my-service',
      serviceVersion: '2.0.0',
    });

    expect(t).toBeDefined();
    expect(t.name).toBe('otel-bridge');
    expect(t.config.enabled).toBe(true);
  });
});
