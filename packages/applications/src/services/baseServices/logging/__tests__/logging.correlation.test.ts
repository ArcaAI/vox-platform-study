/**
 * Ambient correlation on every log line.
 *
 * The logger used to read correlation ONLY from explicit meta, so most gateway
 * lines carried no `traceId`/`requestId`/`tenantId` and the Loki -> Tempo link
 * was dead for them. It now fills those from the active span and the CLS
 * request context when the call site did not.
 */

import { trace, type Span, type SpanContext } from '@opentelemetry/api';
import { ClsServiceManager, CLS_ID } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoggingService } from '../logging.service';
import { ConsoleTransport } from '../transports/console.transport';
import type { ILogTransport, LogEntry, TransportState } from '../transports/types';

class RecordingTransport implements ILogTransport {
  public logs: LogEntry[] = [];
  public readonly name = 'recording';
  public readonly config = { name: 'recording', enabled: true };
  get state(): TransportState {
    return 'running';
  }
  async initialize(): Promise<void> {}
  log(entry: LogEntry): void {
    this.logs.push(entry);
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
  shouldLog(): boolean {
    return true;
  }
}

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

function fakeSpan(ctx: SpanContext): Span {
  return { spanContext: () => ctx } as unknown as Span;
}

function inCls<T>(values: Record<string, unknown>, fn: () => T): T {
  const cls = ClsServiceManager.getClsService();
  return cls.run(() => {
    for (const [k, v] of Object.entries(values)) {
      if (k === 'id') cls.set(CLS_ID, v);
      else cls.set(k, v);
    }
    return fn();
  });
}

describe('LoggingService ambient correlation', () => {
  const originalEnv = process.env;
  let service: LoggingService;
  let t: RecordingTransport;

  beforeEach(() => {
    process.env = { ...originalEnv, LOG_CONSOLE_ENABLED: 'false', LOG_FILE_ENABLED: 'false' };
    service = new LoggingService();
    t = new RecordingTransport();
    service.addTransport(t);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("carries the active span's traceId/spanId", () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(fakeSpan({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }));

    service.info('in span');

    expect(t.logs[0].traceId).toBe(TRACE_ID);
    expect(t.logs[0].spanId).toBe(SPAN_ID);
  });

  it('drops an invalid (all-zero) span context rather than emitting zeros', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(fakeSpan({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }));

    service.info('noop span');

    expect(t.logs[0].traceId).toBeUndefined();
    expect(t.logs[0].spanId).toBeUndefined();
  });

  it('carries requestId/tenantId/userId/credentialClass from the CLS context', () => {
    inCls({ id: 'req-abc', tenantId: 'tenant-1', userId: 'user-1', credentialClass: 'apiKey' }, () => service.info('in cls'));

    const e = t.logs[0];
    expect(e.requestId).toBe('req-abc');
    expect(e.tenantId).toBe('tenant-1');
    expect(e.userId).toBe('user-1');
    expect(e.credentialClass).toBe('apiKey');
  });

  it('explicit meta wins over the ambient context', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(fakeSpan({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }));

    inCls({ id: 'req-abc', tenantId: 'tenant-1' }, () =>
      service.info('explicit', { requestId: 'req-explicit', tenantId: 'tenant-explicit', traceId: 'a'.repeat(32) }),
    );

    const e = t.logs[0];
    expect(e.requestId).toBe('req-explicit');
    expect(e.tenantId).toBe('tenant-explicit');
    expect(e.traceId).toBe('a'.repeat(32));
    expect(e.spanId).toBe(SPAN_ID);
  });

  it('withMeta() defaults win over the ambient context', () => {
    inCls({ id: 'req-abc' }, () => service.withMeta({ requestId: 'req-default' }).info('defaulted'));

    expect(t.logs[0].requestId).toBe('req-default');
  });

  it('outside both, the keys are absent — never "0" or empty', () => {
    service.info('bare');

    const e = t.logs[0];
    for (const key of ['traceId', 'spanId', 'requestId', 'tenantId', 'userId', 'credentialClass'] as const) {
      expect(e[key], key).toBeUndefined();
    }
  });

  it('a CLS read that throws is treated as absent', () => {
    vi.spyOn(ClsServiceManager, 'getClsService').mockImplementation(() => {
      throw new Error('no cls');
    });

    expect(() => service.info('safe')).not.toThrow();
    expect(t.logs[0].requestId).toBeUndefined();
  });

  it('an active-span read that throws is treated as absent', () => {
    vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => {
      throw new Error('no otel');
    });

    expect(() => service.info('safe')).not.toThrow();
    expect(t.logs[0].traceId).toBeUndefined();
  });

  it('the JSON line carries userId and credentialClass as top-level keys', () => {
    const console = new ConsoleTransport({ name: 'console', json: true, level: 'trace' });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    service.addTransport(console);

    inCls({ id: 'req-1', tenantId: 'tenant-1', userId: 'user-1', credentialClass: 'jwt' }, () => service.info('line'));

    const line = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({ requestId: 'req-1', tenantId: 'tenant-1', userId: 'user-1', credentialClass: 'jwt' });
  });
});
