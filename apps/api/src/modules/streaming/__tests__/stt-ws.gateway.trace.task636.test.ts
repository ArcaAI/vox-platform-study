/**
 * The WebSocket boundary is where an STT trace is ROOTED.
 *
 * `@opentelemetry/instrumentation-http` continues a trace for ordinary
 * requests, but it patches the server's `request` event — NOT `upgrade`. A
 * WebSocket handshake therefore reaches this gateway with no active span, so
 * everything a streaming session does (minutes of audio, every utterance,
 * every result relayed back) was previously a set of orphans even on the one
 * service that does emit spans.
 *
 * The gateway now:
 *   1. continues an inbound `traceparent` on the upgrade request when one is
 *      present (server-to-server callers, the Node SDK, proxies), otherwise
 *      roots a fresh session trace;
 *   2. derives the session's trace carrier ONCE and hands it to every audio
 *      frame, so the hot path costs two extra XADD arguments and no propagator
 *      work per frame;
 *   3. ends the session span exactly where the session is finalized.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  Context,
  ContextManager,
  ROOT_CONTEXT,
  TextMapGetter,
  TextMapPropagator,
  TextMapSetter,
  TraceFlags,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { SttWsGateway } from '../stt-ws.gateway';

const GOLDEN_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const GOLDEN_SPAN_ID = '00f067aa0ba902b7';
const GOLDEN_TRACEPARENT = `00-${GOLDEN_TRACE_ID}-${GOLDEN_SPAN_ID}-01`;

class TestW3CPropagator implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (!sc || !trace.isSpanContextValid(sc)) return;
    setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-${(sc.traceFlags & 1).toString(16).padStart(2, '0')}`);
  }
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, 'traceparent');
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return ctx;
    const p = value.split('-');
    if (p.length !== 4) return ctx;
    const sc = { traceId: p[1], spanId: p[2], traceFlags: Number.parseInt(p[3], 16) & 1 ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true };
    return trace.isSpanContextValid(sc) ? trace.setSpanContext(ctx, sc) : ctx;
  }
  fields(): string[] {
    return ['traceparent'];
  }
}

class StackContextManager implements ContextManager {
  private stack: Context[] = [ROOT_CONTEXT];
  active(): Context {
    return this.stack[this.stack.length - 1];
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    this.stack.push(ctx);
    try {
      return fn.call(thisArg as ThisParameterType<F>, ...args);
    } finally {
      this.stack.pop();
    }
  }
  bind<T>(_c: Context, t: T): T {
    return t;
  }
  enable(): this {
    this.stack = [ROOT_CONTEXT];
    return this;
  }
  disable(): this {
    this.stack = [ROOT_CONTEXT];
    return this;
  }
}

/**
 * Minimal recording tracer: `startSpan` returns a span with a VALID span
 * context (so the W3C propagator will serialise it) and records `end()` calls.
 * Stands in for the SDK tracer without pulling in `@opentelemetry/sdk-trace-*`.
 */
function installRecordingTracer() {
  const spans: Array<{ name: string; ended: boolean; attributes: Record<string, unknown>; traceId: string; spanId: string }> = [];
  let counter = 0;
  const provider = {
    getTracer: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startSpan: (name: string, options?: any, ctx?: Context) => {
        counter += 1;
        const parent = trace.getSpanContext(ctx ?? context.active());
        const traceId = parent?.traceId ?? '9'.repeat(32);
        const spanId = counter.toString(16).padStart(16, '0');
        const record = { name, ended: false, attributes: { ...(options?.attributes ?? {}) }, traceId, spanId };
        spans.push(record);
        const spanContext = { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: false };
        return {
          spanContext: () => spanContext,
          setAttribute(k: string, v: unknown) {
            record.attributes[k] = v;
            return this;
          },
          setAttributes: () => undefined,
          addEvent: () => undefined,
          setStatus: () => undefined,
          updateName: () => undefined,
          recordException: () => undefined,
          isRecording: () => true,
          end: () => {
            record.ended = true;
          },
        };
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trace.setGlobalTracerProvider(provider as any);
  return spans;
}

const createMockSocket = () => ({ send: vi.fn(), close: vi.fn(), on: vi.fn(), readyState: 1, OPEN: 1 });

const createMocks = () => ({
  sessionService: { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) },
  bridgeService: {
    connect: vi.fn(),
    writeAudioFrame: vi.fn().mockResolvedValue(undefined),
    writeControlCommand: vi.fn().mockResolvedValue(undefined),
    subscribeToResults: vi.fn().mockReturnValue(new Subject().asObservable()),
    unsubscribeFromResults: vi.fn(),
  },
  streamTicketService: {
    consumeTicket: vi.fn().mockResolvedValue({ userId: 'u-1', tenantId: 't-1', scope: 'stt_session:s-1', exp: Date.now() + 30_000, impersonatedBy: null }),
  },
  sessionBinding: {
    lookup: vi.fn().mockResolvedValue('t-1'),
    // Owner matches the userId this suite's ticket mock carries, so the
    // handshake's ownership gate passes and tracing is what's under test.
    lookupBinding: vi.fn().mockResolvedValue({ tenantId: 't-1', userId: 'u-1' }),
    lookupSessionMeta: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
  },
  removalRetry: { enqueue: vi.fn() },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildReq = (headers: Record<string, string> = {}): any => ({
  url: '/ws/stt/stream?sessionId=s-1&ticket=t',
  headers,
});

describe('SttWsGateway trace rooting + propagation', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mocks: any;
  let gateway: SttWsGateway;
  let spans: ReturnType<typeof installRecordingTracer>;

  beforeEach(() => {
    vi.clearAllMocks();
    propagation.disable();
    context.disable();
    trace.disable();
    context.setGlobalContextManager(new StackContextManager().enable());
    propagation.setGlobalPropagator(new TestW3CPropagator());
    spans = installRecordingTracer();
    mocks = createMocks();
    gateway = new SttWsGateway(mocks.sessionService, mocks.bridgeService, mocks.streamTicketService, mocks.sessionBinding, mocks.removalRetry);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    propagation.disable();
    trace.disable();
    context.disable();
  });

  it('continues an inbound traceparent from the WebSocket upgrade request', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq({ traceparent: GOLDEN_TRACEPARENT }));

    const sessionSpan = spans.find((s) => s.name === 'stt.stream.session');
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.traceId).toBe(GOLDEN_TRACE_ID);
  });

  it('roots a NEW session trace when the handshake carries no traceparent (browsers cannot set one)', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq());

    const sessionSpan = spans.find((s) => s.name === 'stt.stream.session');
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.traceId).not.toBe(GOLDEN_TRACE_ID);
  });

  it('stamps only the session id — never patient, transcript or ticket data', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq({ traceparent: GOLDEN_TRACEPARENT }));

    const sessionSpan = spans.find((s) => s.name === 'stt.stream.session')!;
    expect(sessionSpan.attributes).toEqual({ 'hope.stt.session_id': 's-1' });
  });

  it('hands the SAME session carrier to every audio frame', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq({ traceparent: GOLDEN_TRACEPARENT }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = gateway as any;
    const session = g.sessionsById.get('s-1');
    g.forwardAudioFrame(session, 1, Buffer.alloc(4));
    g.forwardAudioFrame(session, 2, Buffer.alloc(4));

    const calls = mocks.bridgeService.writeAudioFrame.mock.calls;
    expect(calls).toHaveLength(2);
    const carrierA = calls[0][6];
    const carrierB = calls[1][6];
    expect(carrierA).toEqual(carrierB);
    expect(carrierA.traceparent).toMatch(new RegExp(`^00-${GOLDEN_TRACE_ID}-[0-9a-f]{16}-01$`));
  });

  it('ends the session span when the session is finalized', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq({ traceparent: GOLDEN_TRACEPARENT }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = gateway as any;
    const session = g.sessionsById.get('s-1');
    expect(spans.find((s) => s.name === 'stt.stream.session')!.ended).toBe(false);

    g.finalizeSession(session, 'session closed by client');

    expect(spans.find((s) => s.name === 'stt.stream.session')!.ended).toBe(true);
  });

  it('never starts a second span for a session that is finalized twice', async () => {
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = gateway as any;
    const session = g.sessionsById.get('s-1');

    g.finalizeSession(session, 'session closed by client');
    g.finalizeSession(session, 'grace window expired');

    expect(spans.filter((s) => s.name === 'stt.stream.session')).toHaveLength(1);
  });

  it('a rejected handshake never opens a session span', async () => {
    mocks.streamTicketService.consumeTicket.mockResolvedValue(null);
    const socket = createMockSocket();

    await gateway.handleConnection(socket as never, buildReq({ traceparent: GOLDEN_TRACEPARENT }));

    expect(spans.filter((s) => s.name === 'stt.stream.session')).toHaveLength(0);
    expect(socket.close).toHaveBeenCalled();
  });

  it('is a no-op when tracing is disabled — no carrier reaches the audio path', async () => {
    trace.disable(); // back to the no-op tracer provider
    propagation.disable(); // and no propagator
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = gateway as any;
    g.forwardAudioFrame(g.sessionsById.get('s-1'), 1, Buffer.alloc(4));

    expect(mocks.bridgeService.writeAudioFrame.mock.calls[0][6]).toEqual({});
  });
});
