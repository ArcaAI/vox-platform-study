/**
 * SDKLogger Unit Tests
 *
 * Tests for the main SDK logger implementation.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SDKLogger, createSDKLogger, getGlobalLogger, setGlobalLogger } from '../SDKLogger';
import type { ILogTransport, LogEntry, LogLevel, LogMeta } from '../types';

// Mock transport for testing
class MockTransport implements ILogTransport {
  public logs: LogEntry[] = [];
  public initialized = false;
  public flushed = false;
  public wasShutdown = false;
  readonly name = 'mock';

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  log(entry: LogEntry): void {
    this.logs.push(entry);
  }

  async flush(): Promise<void> {
    this.flushed = true;
  }

  async shutdown(): Promise<void> {
    this.wasShutdown = true;
  }

  clear(): void {
    this.logs = [];
  }
}

describe('SDKLogger', () => {
  let mockTransport: MockTransport;

  beforeEach(() => {
    mockTransport = new MockTransport();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create logger with default config', () => {
      const logger = new SDKLogger({
        console: { enabled: false },
      });
      expect(logger).toBeDefined();
      expect(logger.getLevel()).toBe('info');
    });

    it('should use provided log level', () => {
      const logger = new SDKLogger({
        level: 'debug',
        console: { enabled: false },
      });
      expect(logger.getLevel()).toBe('debug');
    });

    it('should auto-generate correlation ID when enabled', () => {
      const logger = new SDKLogger({
        autoCorrelationId: true,
        console: { enabled: false },
      });
      expect(logger.getCorrelationId()).toBeDefined();
    });

    it('should not auto-generate correlation ID when disabled', () => {
      const logger = new SDKLogger({
        autoCorrelationId: false,
        console: { enabled: false },
      });
      expect(logger.getCorrelationId()).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('should initialize all transports', async () => {
      const logger = new SDKLogger({
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      await logger.initialize();

      expect(mockTransport.initialized).toBe(true);
    });

    it('should only initialize once', async () => {
      const logger = new SDKLogger({
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      await logger.initialize();
      await logger.initialize();

      // Should still only be initialized once
      expect(mockTransport.initialized).toBe(true);
    });
  });

  describe('log methods', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should log fatal messages', () => {
      logger.fatal('Fatal error');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('fatal');
      expect(mockTransport.logs[0].message).toBe('Fatal error');
    });

    it('should log error messages', () => {
      logger.error('Error occurred');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('error');
    });

    it('should log error with Error object', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', error);

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].error).toBeDefined();
      expect(mockTransport.logs[0].error?.name).toBe('Error');
    });

    it('should log warn messages', () => {
      logger.warn('Warning');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('warn');
    });

    it('should log info messages', () => {
      logger.info('Info message');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('info');
    });

    it('should log debug messages', () => {
      logger.debug('Debug message');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('debug');
    });

    it('should log trace messages', () => {
      logger.trace('Trace message');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].level).toBe('trace');
    });

    it('should not log when level is below minimum', () => {
      const warnLogger = new SDKLogger({
        level: 'warn',
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      warnLogger.trace('Trace');
      warnLogger.debug('Debug');
      warnLogger.info('Info');

      expect(mockTransport.logs).toHaveLength(0);
    });
  });

  describe('log entry structure', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        serviceName: 'test-service',
        serviceVersion: '1.0.0',
        environment: 'test',
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should include timestamp', () => {
      logger.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.timestamp).toBeDefined();
      expect(entry.timestampIso).toBeDefined();
    });

    it('should include severity number', () => {
      logger.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.severityNumber).toBe(9); // info = 9
    });

    it('should include resource info', () => {
      logger.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.resource).toBeDefined();
      expect(entry.resource?.serviceName).toBe('test-service');
      expect(entry.resource?.environment).toBe('test');
    });
  });

  describe('metadata handling', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should include correlation context', () => {
      logger.info('Test', {
        correlationId: 'corr-123',
        requestId: 'req-456',
        sessionId: 'sess-789',
      });

      const entry = mockTransport.logs[0];
      expect(entry.correlation?.correlationId).toBe('corr-123');
      expect(entry.correlation?.requestId).toBe('req-456');
      expect(entry.correlation?.sessionId).toBe('sess-789');
    });

    it('should include trace context', () => {
      logger.info('Test', {
        traceId: 'trace-123',
        spanId: 'span-456',
      });

      const entry = mockTransport.logs[0];
      expect(entry.trace?.traceId).toBe('trace-123');
      expect(entry.trace?.spanId).toBe('span-456');
    });

    it('should include user context — non-PHI passed through, PHI redacted per', () => {
      logger.info('Test', {
        userId: 'user-123',
        tenantId: 'tenant-456',
        doctorId: 'doctor-789',
        patientId: 'patient-012',
      });

      const entry = mockTransport.logs[0];
      expect(entry.user?.userId).toBe('user-123');
      expect(entry.user?.tenantId).toBe('tenant-456');
      // doctorId and patientId are now redacted by redactPHI before dispatch
      // The legacy assertion that they passed through verbatim
      // is intentionally inverted here — this is a HIPAA-driven contract change.
      expect(entry.user?.doctorId).toBe('[REDACTED]');
      expect(entry.user?.patientId).toBe('[REDACTED]');
    });

    it('should include operation context', () => {
      logger.info('Test', {
        operation: 'createUser',
        component: 'UserService',
        durationMs: 150,
        success: true,
      });

      const entry = mockTransport.logs[0];
      expect(entry.operation?.operation).toBe('createUser');
      expect(entry.operation?.component).toBe('UserService');
      expect(entry.operation?.durationMs).toBe(150);
      expect(entry.operation?.success).toBe(true);
    });

    it('should include custom attributes', () => {
      logger.info('Test', {
        attributes: { custom: 'value', count: 42 },
      });

      const entry = mockTransport.logs[0];
      expect(entry.attributes?.custom).toBe('value');
      expect(entry.attributes?.count).toBe(42);
    });

    it('should include tags', () => {
      logger.info('Test', {
        tags: ['tag1', 'tag2'],
      });

      const entry = mockTransport.logs[0];
      expect(entry.tags).toEqual(['tag1', 'tag2']);
    });
  });

  describe('child loggers', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        autoCorrelationId: true,
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should create child with context', () => {
      const child = logger.child('ChildContext');
      child.info('Child message');

      const entry = mockTransport.logs[0];
      expect(entry.context).toBe('ChildContext');
    });

    it('should inherit correlation ID', () => {
      const correlationId = logger.getCorrelationId();
      const child = logger.child('ChildContext');

      expect(child.getCorrelationId()).toBe(correlationId);
    });

    it('should share transports with parent', () => {
      const child = logger.child('ChildContext');
      child.info('Child message');

      expect(mockTransport.logs).toHaveLength(1);
    });
  });

  describe('withMeta', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should create logger with default metadata', () => {
      const withMeta = logger.withMeta({
        userId: 'user-123',
        tenantId: 'tenant-456',
      });

      withMeta.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.user?.userId).toBe('user-123');
      expect(entry.user?.tenantId).toBe('tenant-456');
    });

    it('should merge with log-specific metadata', () => {
      const withMeta = logger.withMeta({ userId: 'user-123' });
      withMeta.info('Test', { requestId: 'req-456' });

      const entry = mockTransport.logs[0];
      expect(entry.user?.userId).toBe('user-123');
      expect(entry.correlation?.requestId).toBe('req-456');
    });
  });

  describe('withCorrelation', () => {
    it('should create logger with correlation context', () => {
      const logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      const withCorr = logger.withCorrelation({
        correlationId: 'corr-123',
        requestId: 'req-456',
        traceId: 'trace-789',
      });

      withCorr.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.correlation?.correlationId).toBe('corr-123');
      expect(entry.correlation?.requestId).toBe('req-456');
      expect(entry.trace?.traceId).toBe('trace-789');
    });
  });

  describe('withUser', () => {
    it('should create logger with user context', () => {
      const logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      const withUser = logger.withUser({
        userId: 'user-123',
        tenantId: 'tenant-456',
      });

      withUser.info('Test');

      const entry = mockTransport.logs[0];
      expect(entry.user?.userId).toBe('user-123');
      expect(entry.user?.tenantId).toBe('tenant-456');
    });
  });

  describe('correlation ID management', () => {
    it('should set correlation ID', () => {
      const logger = new SDKLogger({
        autoCorrelationId: false,
        console: { enabled: false },
      });

      logger.setCorrelationId('custom-corr-id');
      expect(logger.getCorrelationId()).toBe('custom-corr-id');
    });

    it('should generate new correlation ID', () => {
      const logger = new SDKLogger({
        autoCorrelationId: false,
        console: { enabled: false },
      });

      const id = logger.generateCorrelationId();
      expect(id).toBeDefined();
      expect(id).toMatch(/^[0-9a-f-]+$/i);
    });
  });

  describe('startOperation', () => {
    let logger: SDKLogger;

    beforeEach(() => {
      logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });
    });

    it('should log operation start', () => {
      logger.startOperation('testOperation');

      expect(mockTransport.logs).toHaveLength(1);
      expect(mockTransport.logs[0].message).toContain('Operation started');
    });

    it('should log operation end with duration', () => {
      const timer = logger.startOperation('testOperation');

      vi.advanceTimersByTime(100);
      timer.end(true);

      expect(mockTransport.logs).toHaveLength(2);
      expect(mockTransport.logs[1].message).toContain('Operation completed');
      expect(mockTransport.logs[1].operation?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should log operation error', () => {
      const timer = logger.startOperation('testOperation');

      vi.advanceTimersByTime(50);
      timer.error(new Error('Test error'));

      expect(mockTransport.logs).toHaveLength(2);
      expect(mockTransport.logs[1].level).toBe('error');
      expect(mockTransport.logs[1].message).toContain('Operation failed');
    });
  });

  describe('http logging', () => {
    it('should log HTTP requests with http tag', () => {
      const logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      logger.http('HTTP request', {
        http: { method: 'GET', url: '/api/users', statusCode: 200 },
      });

      const entry = mockTransport.logs[0];
      expect(entry.tags).toContain('http');
      expect(entry.http?.method).toBe('GET');
    });
  });

  describe('level management', () => {
    it('should get current level', () => {
      const logger = new SDKLogger({
        level: 'warn',
        console: { enabled: false },
      });

      expect(logger.getLevel()).toBe('warn');
    });

    it('should set level dynamically', () => {
      const logger = new SDKLogger({
        level: 'info',
        console: { enabled: false },
      });

      logger.setLevel('debug');
      expect(logger.getLevel()).toBe('debug');
    });
  });

  describe('flush and shutdown', () => {
    it('should flush all transports', async () => {
      const logger = new SDKLogger({
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      await logger.flush();

      expect(mockTransport.flushed).toBe(true);
    });

    it('should shutdown all transports', async () => {
      const logger = new SDKLogger({
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      await logger.shutdown();

      expect(mockTransport.flushed).toBe(true);
      expect(mockTransport.wasShutdown).toBe(true);
    });
  });

  describe('transport management', () => {
    it('should add custom transport', () => {
      const logger = new SDKLogger({
        console: { enabled: false },
      });

      logger.addTransport(mockTransport);
      logger.info('Test');

      expect(mockTransport.logs).toHaveLength(1);
    });

    it('should get transport names', () => {
      const logger = new SDKLogger({
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      const names = logger.getTransportNames();
      expect(names).toContain('mock');
    });
  });

  describe('message truncation', () => {
    it('should truncate long messages', () => {
      const logger = new SDKLogger({
        level: 'trace',
        maxMessageLength: 20,
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      logger.info('This is a very long message that should be truncated');

      const entry = mockTransport.logs[0];
      expect(entry.message.length).toBe(20);
    });
  });

  describe('sensitive field redaction', () => {
    it('should redact configured fields', () => {
      const logger = new SDKLogger({
        level: 'trace',
        redactFields: ['password', 'secret'],
        console: { enabled: false },
        customTransports: [mockTransport],
      });

      logger.info('Test', {
        attributes: { password: 'secret123', username: 'user' },
      });

      const entry = mockTransport.logs[0];
      expect(entry.attributes?.password).toBe('[REDACTED]');
      expect(entry.attributes?.username).toBe('user');
    });
  });

  describe('factory functions', () => {
    it('createSDKLogger should create new instance', () => {
      const logger = createSDKLogger({ level: 'debug' });
      expect(logger).toBeInstanceOf(SDKLogger);
      expect(logger.getLevel()).toBe('debug');
    });

    it('getGlobalLogger should return singleton', () => {
      const logger1 = getGlobalLogger({ level: 'info' });
      const logger2 = getGlobalLogger();

      expect(logger1).toBe(logger2);
    });

    it('setGlobalLogger should replace singleton', () => {
      const customLogger = createSDKLogger({ level: 'error' });
      setGlobalLogger(customLogger);

      const globalLogger = getGlobalLogger();
      expect(globalLogger).toBe(customLogger);
    });
  });

  // =========================================================================
  // SEC-03: PHI redaction by default
  // =========================================================================

  describe('SEC-03: PHI field redaction', () => {
    it('should redact PHI fields by default even without explicit redactFields config', () => {
      const transport = new MockTransport();
      const logger = new SDKLogger({
        level: 'debug',
        console: { enabled: false },
      });
      (logger as any).transports.push(transport);
      (logger as any).initialized = true;

      logger.info('Processing consultation', {
        operation: 'test',
        attributes: {
          patientId: 'patient-123',
          doctorId: 'doctor-456',
          consultationId: 'consult-789',
          pipelineId: 'default',
        },
      });

      expect(transport.logs).toHaveLength(1);
      const attrs = transport.logs[0].attributes;
      expect(attrs?.patientId).toBe('[REDACTED]');
      expect(attrs?.doctorId).toBe('[REDACTED]');
      expect(attrs?.consultationId).toBe('[REDACTED]');
      expect(attrs?.pipelineId).toBe('default');
    });

    it('should merge user-provided redactFields with default PHI fields', () => {
      const transport = new MockTransport();
      const logger = new SDKLogger({
        level: 'debug',
        console: { enabled: false },
        redactFields: ['customSecret'],
      });
      (logger as any).transports.push(transport);
      (logger as any).initialized = true;

      logger.info('Test', {
        operation: 'test',
        attributes: {
          patientId: 'p-1',
          customSecret: 'secret-val',
          normalField: 'visible',
        },
      });

      expect(transport.logs).toHaveLength(1);
      const attrs = transport.logs[0].attributes;
      expect(attrs?.patientId).toBe('[REDACTED]');
      expect(attrs?.customSecret).toBe('[REDACTED]');
      expect(attrs?.normalField).toBe('visible');
    });
  });

  // =========================================================================
  // Defence-in-depth PHI redaction across the WHOLE log entry
  //
  // The legacy `redactSensitiveFields` only scrubbed `entry.attributes`. The
  // W0-2 contract requires redactPHI to walk the entire entry before any
  // transport sees it, so PHI nested in `user`, `sdk`, `error`, `meta`, etc.
  // is also scrubbed and `data:`/`blob:`/`file:` URLs become `[REDACTED-URL]`.
  // =========================================================================
  describe('PHI redaction reaches every transport surface', () => {
    let transport: MockTransport;
    let logger: SDKLogger;

    beforeEach(() => {
      transport = new MockTransport();
      logger = new SDKLogger({
        level: 'trace',
        console: { enabled: false },
        customTransports: [transport],
      });
    });

    it('redacts PHI in user context (patientId, doctorId) before dispatch', () => {
      logger.info('with user', {
        userId: 'user-keep',
        tenantId: 'tenant-keep',
        doctorId: 'doctor-PHI',
        patientId: 'patient-PHI',
      });

      const entry = transport.logs[0];
      expect(entry.user?.userId).toBe('user-keep');
      expect(entry.user?.tenantId).toBe('tenant-keep');
      expect(entry.user?.doctorId).toBe('[REDACTED]');
      expect(entry.user?.patientId).toBe('[REDACTED]');
    });

    it('redacts PHI in sdk context (consultationId)', () => {
      logger.info('with sdk', {
        sdk: { consultationId: 'consult-PHI', modelId: 'whisper-large' },
      });

      const entry = transport.logs[0];
      expect(entry.sdk?.consultationId).toBe('[REDACTED]');
      expect(entry.sdk?.modelId).toBe('whisper-large');
    });

    it('redacts PHI nested in attributes (transcript, sttResult, voiceEmbedding)', () => {
      logger.info('with phi attrs', {
        attributes: {
          transcript: 'Patient reports chest pain',
          sttResult: { text: 'PHI text' },
          voiceEmbedding: [0.1, 0.2, 0.3],
          safeField: 'visible',
        },
      });

      const attrs = transport.logs[0].attributes;
      expect(attrs?.transcript).toBe('[REDACTED]');
      expect(attrs?.sttResult).toBe('[REDACTED]');
      expect(attrs?.voiceEmbedding).toBe('[REDACTED]');
      expect(attrs?.safeField).toBe('visible');
    });

    it('rewrites data:/blob:/file: URLs to [REDACTED-URL] anywhere in the entry', () => {
      logger.info('with urls', {
        attributes: {
          audioSrc: 'blob:https://x/y',
          image: 'data:image/png;base64,abcdef==',
          diskPath: 'file:///etc/passwd',
          httpsOk: 'https://example.com/keep',
        },
      });

      const attrs = transport.logs[0].attributes;
      expect(attrs?.audioSrc).toBe('[REDACTED-URL]');
      expect(attrs?.image).toBe('[REDACTED-URL]');
      expect(attrs?.diskPath).toBe('[REDACTED-URL]');
      expect(attrs?.httpsOk).toBe('https://example.com/keep');
    });

    it('does not mutate the caller-provided meta object', () => {
      const meta: LogMeta = {
        attributes: { patientId: 'p-1', keep: 'safe' },
      };
      const snapshot = JSON.parse(JSON.stringify(meta));
      logger.info('immutability check', meta);
      expect(meta).toEqual(snapshot);
    });
  });
});
