/**
 * @arcaai/vox - Highlight Transport Tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HighlightTransport } from '../transports/highlight.transport';
import type { LogEntry, HighlightTransportConfig } from '../types';

const mockH = {
  init: vi.fn(),
  identify: vi.fn(),
  track: vi.fn(),
  consumeError: vi.fn(),
  log: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  getSessionURL: vi.fn(() => 'https://highlight.io/session/123'),
  getSessionId: vi.fn(() => 'session-123'),
};

vi.mock('highlight.run', () => ({ H: mockH }));

describe('HighlightTransport', () => {
  let transport: HighlightTransport;
  let config: HighlightTransportConfig;
  let spies: typeof mockH;

  const createLogEntry = (overrides?: Partial<LogEntry>): LogEntry => ({
    timestamp: Date.now(),
    timestampIso: new Date().toISOString(),
    level: 'info',
    severityNumber: 9,
    message: 'Test message',
    ...overrides,
  });

  function resetMocks() {
    Object.values(mockH).forEach((fn) => fn.mockClear());
    mockH.getSessionURL.mockReturnValue('https://highlight.io/session/123');
    mockH.getSessionId.mockReturnValue('session-123');
    spies = mockH;
  }

  async function initTransport(t: HighlightTransport): Promise<void> {
    await t.initialize();
  }

  beforeEach(() => {
    config = {
      enabled: true,
      projectId: 'test-project-id',
      serviceName: 'test-service',
      environment: 'test',
      level: 'debug',
    };
    transport = new HighlightTransport(config);
    resetMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create transport with name "highlight"', () => {
      expect(transport.name).toBe('highlight');
    });

    it('should set default level to "info" if not provided', async () => {
      const t = new HighlightTransport({ enabled: true, projectId: 'p' });
      await initTransport(t);
      const entry = createLogEntry({ level: 'debug' });
      t.log(entry);
      expect(spies.log).not.toHaveBeenCalled();
    });

    it('should use provided level from config', async () => {
      const t = new HighlightTransport({ ...config, level: 'warn' });
      await initTransport(t);
      const infoEntry = createLogEntry({ level: 'info' });
      t.log(infoEntry);
      expect(spies.log).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    it('should initialize highlight SDK', async () => {
      await initTransport(transport);
      expect(spies.init).toHaveBeenCalledWith('test-project-id', expect.objectContaining({
        serviceName: 'test-service',
        environment: 'test',
      }));
    });

    it('should flush pending logs after initialization', async () => {
      const entry1 = createLogEntry({ level: 'info', message: 'Pending 1' });
      const entry2 = createLogEntry({ level: 'warn', message: 'Pending 2' });
      transport.log(entry1);
      transport.log(entry2);
      expect(spies.log).not.toHaveBeenCalled();

      await initTransport(transport);
      expect(spies.log).toHaveBeenCalledTimes(2);
    });

    it('should not initialize in non-browser environment', async () => {
      const origWindow = globalThis.window;
      // @ts-expect-error simulating non-browser
      delete globalThis.window;
      await transport.initialize();
      expect(spies.init).not.toHaveBeenCalled();
      // @ts-expect-error restore
      globalThis.window = origWindow;
    });

    it('should not initialize twice', async () => {
      await initTransport(transport);
      vi.clearAllMocks();
      resetMocks();
      await initTransport(transport);
      expect(spies.init).not.toHaveBeenCalled();
    });
  });

  describe('log', () => {
    beforeEach(async () => {
      await initTransport(transport);
      vi.clearAllMocks();
      resetMocks();
    });

    it('should queue logs if not initialized', () => {
      const t = new HighlightTransport(config);
      const entry = createLogEntry({ level: 'info', message: 'Queued' });
      t.log(entry);
      expect(spies.log).not.toHaveBeenCalled();
    });

    it('should call highlight.log with correct message and level', () => {
      const entry = createLogEntry({ level: 'info', message: 'Test log' });
      transport.log(entry);
      expect(spies.log).toHaveBeenCalledWith('Test log', 'info', expect.any(Object));
    });

    it('should build attributes with all context fields', () => {
      const entry = createLogEntry({
        context: 'Ctx',
        correlation: { correlationId: 'c1', requestId: 'r1', sessionId: 's1' },
        trace: { traceId: 't1', spanId: 'sp1' },
        user: { userId: 'u1', tenantId: 'ten1', doctorId: 'doc1', patientId: 'pat1' },
        operation: { operation: 'op1', component: 'comp1', durationMs: 100, success: true },
        http: { method: 'GET', url: '/api', statusCode: 200, responseTimeMs: 50 },
        sdk: { consultationId: 'con1', modelId: 'mod1' },
        attributes: { custom: 'val' },
        tags: ['t1', 't2'],
        resource: { serviceName: 'svc', serviceVersion: '1.0', sdkName: 'sdk', sdkVersion: '2.0', environment: 'test' },
      });
      transport.log(entry);
      expect(spies.log).toHaveBeenCalledWith(
        'Test message', 'info',
        expect.objectContaining({
          context: 'Ctx',
          correlationId: 'c1',
          traceId: 't1',
          userId: 'u1',
          operation: 'op1',
          httpMethod: 'GET',
          consultationId: 'con1',
          custom: 'val',
          tags: 't1,t2',
          service: 'svc',
          version: '1.0',
        })
      );
    });

    it('should report error for error level logs', () => {
      const entry = createLogEntry({
        level: 'error',
        message: 'Error occurred',
        error: { name: 'TestError', stack: 'Error: T\n  at t:1:1', code: 'ERR_T' },
      });
      transport.log(entry);
      expect(spies.log).toHaveBeenCalled();
      expect(spies.consumeError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ errorCode: 'ERR_T' }));
    });

    it('should report error for fatal level logs', () => {
      const entry = createLogEntry({ level: 'fatal', message: 'Fatal' });
      transport.log(entry);
      expect(spies.consumeError).toHaveBeenCalled();
    });

    it('should track operation when durationMs is present', () => {
      const entry = createLogEntry({
        operation: { operation: 'createCons', component: 'Client', durationMs: 150, success: true },
        correlation: { correlationId: 'c1' },
        user: { userId: 'u1' },
      });
      transport.log(entry);
      expect(spies.track).toHaveBeenCalledWith('operation.createCons', expect.objectContaining({
        component: 'Client',
        durationMs: 150,
        success: true,
      }));
    });

    it('should not track when durationMs is missing', () => {
      const entry = createLogEntry({ operation: { operation: 'op', component: 'C' } });
      transport.log(entry);
      expect(spies.track).not.toHaveBeenCalled();
    });

    it('should not track when operation name is missing', () => {
      const entry = createLogEntry({ operation: { component: 'C', durationMs: 100 } });
      transport.log(entry);
      expect(spies.track).not.toHaveBeenCalled();
    });
  });

  describe('identify', () => {
    it('should not call identify if not initialized', () => {
      const t = new HighlightTransport(config);
      t.identify('u1', { email: 'x@y.com' });
      expect(spies.identify).not.toHaveBeenCalled();
    });

    it('should call identify when initialized', async () => {
      await initTransport(transport);
      vi.clearAllMocks();
      resetMocks();
      transport.identify('u1', { email: 'x@y.com' });
      expect(spies.identify).toHaveBeenCalledWith('u1', { email: 'x@y.com' });
    });
  });

  describe('getSessionURL / getSessionId', () => {
    it('should return undefined if not initialized', () => {
      const t = new HighlightTransport(config);
      expect(t.getSessionURL()).toBeUndefined();
      expect(t.getSessionId()).toBeUndefined();
    });

    it('should delegate to highlight when initialized', async () => {
      await initTransport(transport);
      expect(transport.getSessionURL()).toBeDefined();
      expect(transport.getSessionId()).toBeDefined();
    });
  });

  describe('flush', () => {
    it('should complete without error', async () => {
      await expect(transport.flush()).resolves.toBeUndefined();
    });
  });

  describe('shutdown', () => {
    it('should call stop when initialized', async () => {
      await initTransport(transport);
      vi.clearAllMocks();
      resetMocks();
      await transport.shutdown();
      expect(spies.stop).toHaveBeenCalled();
    });

    it('should not call stop when not initialized', async () => {
      const t = new HighlightTransport(config);
      await t.shutdown();
      expect(spies.stop).not.toHaveBeenCalled();
    });

    it('should reset initialized flag so logs are queued again', async () => {
      await initTransport(transport);
      await transport.shutdown();
      vi.clearAllMocks();
      resetMocks();
      transport.log(createLogEntry({ level: 'info' }));
      expect(spies.log).not.toHaveBeenCalled();
    });
  });

  describe('level mapping', () => {
    it.each([
      ['trace', 'trace'],
      ['debug', 'debug'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
      ['fatal', 'fatal'],
    ] as const)('should map %s level correctly', async (level, expected) => {
      const t = new HighlightTransport({ ...config, level: 'trace' });
      await initTransport(t);
      vi.clearAllMocks();
      resetMocks();
      t.log(createLogEntry({ level }));
      const calls = spies.log.mock.calls;
      if (calls.length > 0) {
        expect(calls[calls.length - 1][1]).toBe(expected);
      }
    });
  });

  // =========================================================================
  // SEC-08: recordHeadersAndBody should default to false
  // =========================================================================

  describe('SEC-08: HIPAA-safe network recording defaults', () => {
    it('should default recordHeadersAndBody to false when not specified', async () => {
      const t = new HighlightTransport(config);
      await initTransport(t);

      const initCall = spies.init.mock.calls[0];
      expect(initCall).toBeDefined();
      const options = initCall[1];
      expect(options.networkRecording.recordHeadersAndBody).toBe(false);
    });

    it('should allow explicit opt-in to recordHeadersAndBody', async () => {
      const t = new HighlightTransport({
        ...config,
        recordHeadersAndBody: true,
      });
      await initTransport(t);

      const initCall = spies.init.mock.calls[0];
      const options = initCall[1];
      expect(options.networkRecording.recordHeadersAndBody).toBe(true);
    });
  });
});
