import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { TtsWsGateway } from '../tts-ws.gateway';

type Handler = (...args: unknown[]) => void;

const makeSocket = () => {
  const handlers: Record<string, Handler[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    bufferedAmount: 0,
    on: vi.fn((ev: string, cb: Handler) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit: (ev: string, ...args: unknown[]) => (handlers[ev] || []).forEach((cb) => cb(...args)),
  };
};

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('TtsWsGateway correlation', () => {
  let gateway: TtsWsGateway;
  let upstream: ReturnType<typeof makeSocket>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const tickets = { consumeTicket: vi.fn(async () => ({ userId: 'u1', tenantId: 't1', scope: 'tts_session:sess-1', exp: Date.now() + 30_000 })) };
    const config = { getConfigValue: vi.fn(() => 'http://tts:8865') };
    const secrets = { getSecretSync: vi.fn(() => 'svc-token') };
    gateway = new TtsWsGateway(tickets as never, config as never, secrets as never);
    upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    propagation.setGlobalPropagator({
      inject: (ctx, carrier, setter) => {
        const sc = trace.getSpanContext(ctx);
        if (sc) setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
      },
      extract: (ctx) => ctx,
      fields: () => ['traceparent'],
    });
  });
  afterEach(() => {
    propagation.disable();
    vi.restoreAllMocks();
  });

  it('D5: upstream handshake headers carry traceparent, X-Request-Id and X-Tenant-Id', async () => {
    vi.spyOn(context, 'active').mockReturnValue(trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }));
    await gateway.handleConnection(makeSocket() as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t', headers: { 'x-request-id': 'req-abc' } } as never);
    expect(gateway.createUpstreamSocket).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, 'X-Request-Id': 'req-abc', 'X-Tenant-Id': 't1' }),
    );
  });

  it('D5: a malformed inbound request id falls back to the session id', async () => {
    await gateway.handleConnection(makeSocket() as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t', headers: { 'x-request-id': 'bad id\n' } } as never);
    expect(gateway.createUpstreamSocket).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ 'X-Request-Id': 'sess-1' }));
  });

  it('D5: an upstream error logs sessionId/tenantId/userId/errorName and sends the client a correlationId frame', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, { url: '/ws/tts/stream?sessionId=sess-1&ticket=t', headers: {} } as never);
    const err = new Error('upstream boom');
    upstream.emit('error', err);

    const logged = warn.mock.calls.map((c) => c[0] as Record<string, unknown>).find((c) => c.message === 'Upstream TTS socket error');
    expect(logged).toMatchObject({ sessionId: 'sess-1', tenantId: 't1', userId: 'u1', errorName: 'Error', error: err, correlationId: 'sess-1' });
    const frame = JSON.parse(String((client.send.mock.calls[0][0] as Buffer).toString()));
    expect(frame).toEqual({ type: 'error', code: 'upstream_error', message: 'TTS upstream error', correlationId: 'sess-1' });
    expect(JSON.stringify(frame)).not.toContain('boom');
  });
});
