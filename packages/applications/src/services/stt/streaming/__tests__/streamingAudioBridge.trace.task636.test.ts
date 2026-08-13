/**
 * Trace context survives the gateway's Redis Streams hops.
 *
 * The gateway is BOTH a producer and a consumer on this boundary:
 *
 *   writeAudioFrame     -> XADD stt:audio:{sid}    -> apps/stt IngestionConsumer
 *   writeControlCommand -> XADD stt:control:{sid}  -> apps/stt ControlListener
 *   apps/stt ResultPublisher -> XADD stt:result:{sid} -> subscribeToResults
 *
 * The traceparent literal below is the same golden value asserted in
 * `apps/stt/tests/test_redis_streams_trace_task636.py`, so these tests describe
 * a real cross-runtime handshake rather than a self-consistent fiction.
 *
 * The audio hop is latency-sensitive (tens of frames a second per session), so
 * the contract asserted here is that `writeAudioFrame` takes a PRE-COMPUTED
 * carrier from its caller: the WS gateway derives it once per session, and the
 * hot path only spreads two extra XADD arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
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
import { StreamingAudioBridgeService } from '../streamingAudioBridge.service';
import { injectTraceCarrier } from '../../../baseServices/observability/trace-propagation';

const GOLDEN_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const GOLDEN_SPAN_ID = '00f067aa0ba902b7';
const GOLDEN_TRACEPARENT = `00-${GOLDEN_TRACE_ID}-${GOLDEN_SPAN_ID}-01`;

// ---------------------------------------------------------------------------
// OTel test doubles (see trace-propagation.task636.test.ts for the rationale)
// ---------------------------------------------------------------------------

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
    const parts = value.split('-');
    if (parts.length !== 4) return ctx;
    const sc = {
      traceId: parts[1],
      spanId: parts[2],
      traceFlags: Number.parseInt(parts[3], 16) & 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    };
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
  bind<T>(_ctx: Context, target: T): T {
    return target;
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

function goldenContext(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: GOLDEN_TRACE_ID,
    spanId: GOLDEN_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
}

// ---------------------------------------------------------------------------
// ioredis double
// ---------------------------------------------------------------------------

const mockXadd = vi.fn().mockResolvedValue('1-0');
const mockXreadgroup = vi.fn().mockResolvedValue(null);
const mockXack = vi.fn().mockResolvedValue(1);
const mockXgroup = vi.fn().mockResolvedValue('OK');
const mockXautoclaim = vi.fn().mockResolvedValue(['0-0', [], []]);

function MockRedis() {
  return {
    xadd: (...args: unknown[]) => mockXadd(...args),
    xreadgroup: (...args: unknown[]) => mockXreadgroup(...args),
    xack: (...args: unknown[]) => mockXack(...args),
    xgroup: (...args: unknown[]) => mockXgroup(...args),
    xautoclaim: (...args: unknown[]) => mockXautoclaim(...args),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}

vi.mock('ioredis', () => ({ default: MockRedis }));

function createMockConfigService() {
  return {
    isRedisConfigured: vi.fn().mockReturnValue(true),
    getRedisConfig: vi.fn().mockReturnValue({ host: 'localhost', port: 6379, password: undefined }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** The last XADD's flat argument list. */
function lastXaddArgs(): string[] {
  return mockXadd.mock.calls[mockXadd.mock.calls.length - 1] as unknown as string[];
}

describe('StreamingAudioBridgeService trace propagation', () => {
  let service: StreamingAudioBridgeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockXreadgroup.mockResolvedValue(null);
    propagation.disable();
    context.disable();
    context.setGlobalContextManager(new StackContextManager().enable());
    service = new StreamingAudioBridgeService(createMockConfigService());
    await service.connect();
  });

  afterEach(async () => {
    await service.disconnect();
    propagation.disable();
  });

  // =========================================================================
  // Gateway -> STT : stt:audio
  // =========================================================================

  describe('writeAudioFrame (the latency-sensitive hop)', () => {
    it('appends the caller-supplied traceparent to the XADD field list', async () => {
      await service.writeAudioFrame('s-1', 1, Buffer.alloc(4), 16000, 'pcm_s16le', false, {
        traceparent: GOLDEN_TRACEPARENT,
      });

      const args = lastXaddArgs();
      const idx = args.indexOf('traceparent');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe(GOLDEN_TRACEPARENT);
    });

    it('writes a byte-identical frame to the previous wire when no carrier is supplied', async () => {
      await service.writeAudioFrame('s-1', 1, Buffer.alloc(4));

      const args = lastXaddArgs();
      expect(args).not.toContain('traceparent');
      // Field list still ends on the original last field.
      expect(args[args.length - 2]).toBe('ts');
    });

    it('ignores an empty carrier (the tracing-disabled shape)', async () => {
      await service.writeAudioFrame('s-1', 1, Buffer.alloc(4), 16000, 'pcm_s16le', false, {});
      expect(lastXaddArgs()).not.toContain('traceparent');
    });

    it('does NOT read the ambient context — the caller owns the per-session carrier', async () => {
      // Injecting from the active context on every frame would put propagator
      // work on the clinical audio path. The WS gateway computes the carrier
      // once at connect; this asserts the bridge never does it per frame.
      propagation.setGlobalPropagator(new TestW3CPropagator());
      await context.with(goldenContext(), async () => {
        await service.writeAudioFrame('s-1', 1, Buffer.alloc(4));
      });
      expect(lastXaddArgs()).not.toContain('traceparent');
    });

    it('never lets audio bytes reach the carrier position', async () => {
      const audio = Buffer.from([1, 2, 3, 4]);
      await service.writeAudioFrame('s-1', 1, audio, 16000, 'pcm_s16le', false, {
        traceparent: GOLDEN_TRACEPARENT,
      });
      const args = lastXaddArgs();
      expect(args[args.indexOf('traceparent') + 1]).toBe(GOLDEN_TRACEPARENT);
      expect(args[args.indexOf('data') + 1]).toBe(audio);
    });
  });

  // =========================================================================
  // Gateway -> STT : stt:control
  // =========================================================================

  describe('writeControlCommand (low volume — injects from the active context)', () => {
    it('stamps the active trace context onto the control entry', async () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());

      await context.with(goldenContext(), async () => {
        await service.writeControlCommand('s-1', 'finalize');
      });

      const args = lastXaddArgs();
      expect(args[args.indexOf('traceparent') + 1]).toBe(GOLDEN_TRACEPARENT);
    });

    it('adds nothing when tracing is disabled', async () => {
      await service.writeControlCommand('s-1', 'finalize');
      expect(lastXaddArgs()).not.toContain('traceparent');
    });
  });

  // =========================================================================
  // STT -> Gateway : stt:result
  // =========================================================================

  describe('subscribeToResults (the return leg)', () => {
    /** One `stt:result` entry as ioredis returns it: flat [k, v, k, v]. */
    function resultEntry(fields: string[]) {
      return [['stt:result:s-1', [['1-0', fields]]]];
    }

    it('emits the transcript under the STT producer trace context', async () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      mockXreadgroup.mockResolvedValueOnce(
        resultEntry(['type', 'segment', 'text', 'hello', 'is_final', '1', 'traceparent', GOLDEN_TRACEPARENT]),
      );

      let observedTraceId: string | undefined;
      const sub = service.subscribeToResults('s-1').subscribe(() => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
      await new Promise((r) => setTimeout(r, 20));
      sub.unsubscribe();

      expect(observedTraceId).toBe(GOLDEN_TRACE_ID);
    });

    it('never puts traceparent on the client-facing message', async () => {
      // The browser wire stays unchanged: server-side trace ids are internal
      // and `packages/stt`'s transport hop drops unknown transcript fields
      // anyway. Propagation terminates at the gateway on purpose.
      propagation.setGlobalPropagator(new TestW3CPropagator());
      mockXreadgroup.mockResolvedValueOnce(
        resultEntry(['type', 'segment', 'text', 'hello', 'is_final', '1', 'traceparent', GOLDEN_TRACEPARENT]),
      );

      const msg = (await firstValueFrom(service.subscribeToResults('s-1'))) as Record<string, unknown>;

      expect(msg.type).toBe('transcript');
      expect(msg.text).toBe('hello');
      expect(msg).not.toHaveProperty('traceparent');
      expect(msg).not.toHaveProperty('traceContext');
    });

    it('still emits when the entry carries no trace context', async () => {
      mockXreadgroup.mockResolvedValueOnce(resultEntry(['type', 'segment', 'text', 'hello', 'is_final', '1']));

      const msg = (await firstValueFrom(service.subscribeToResults('s-1'))) as Record<string, unknown>;
      expect(msg.text).toBe('hello');
    });

    it('still emits when the entry carries a MALFORMED trace context', async () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      mockXreadgroup.mockResolvedValueOnce(resultEntry(['type', 'segment', 'text', 'hello', 'is_final', '1', 'traceparent', 'garbage']));

      const msg = (await firstValueFrom(service.subscribeToResults('s-1'))) as Record<string, unknown>;
      expect(msg.text).toBe('hello');
    });

    it('relays a status entry under its producer context too', async () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      mockXreadgroup.mockResolvedValueOnce(resultEntry(['type', 'status', 'status', 'finalizing', 'traceparent', GOLDEN_TRACEPARENT]));

      let observedTraceId: string | undefined;
      const sub = service.subscribeToResults('s-1').subscribe(() => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
      await new Promise((r) => setTimeout(r, 20));
      sub.unsubscribe();

      expect(observedTraceId).toBe(GOLDEN_TRACE_ID);
    });
  });

  // =========================================================================
  // End-to-end shape: gateway carrier -> wire -> gateway extraction
  // =========================================================================

  it('a carrier produced by injectTraceCarrier survives the audio XADD argument list', async () => {
    propagation.setGlobalPropagator(new TestW3CPropagator());
    const carrier = injectTraceCarrier(goldenContext());

    await service.writeAudioFrame('s-1', 1, Buffer.alloc(4), 16000, 'pcm_s16le', false, carrier);

    const args = lastXaddArgs();
    expect(args[args.indexOf('traceparent') + 1]).toBe(GOLDEN_TRACEPARENT);
  });
});
