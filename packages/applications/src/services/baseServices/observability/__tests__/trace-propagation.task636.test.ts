/**
 * TASK-636 OBS-16 — W3C trace-context propagation seam (TypeScript side).
 *
 * These tests pin the three properties the streaming hot path depends on:
 *
 *  1. **No-op when tracing is off.** With no global propagator registered (the
 *     state of every process that never starts the OTel SDK) the injector must
 *     return an EMPTY carrier, so callers add zero fields to a Redis XADD and
 *     pay no per-message cost.
 *  2. **No-op when there is no active span.** Even with the W3C propagator
 *     registered, an unsampled/absent parent must not produce a bogus carrier.
 *  3. **Round-trip fidelity.** inject → serialise to a flat string map →
 *     extract must preserve the trace id and the parent span id EXACTLY, which
 *     is what makes a Redis Stream / SSE / WebSocket hop a continuation rather
 *     than a new trace.
 *
 * The test registers a minimal W3C `TextMapPropagator` implemented against
 * `@opentelemetry/api` only. `@opentelemetry/core` (which ships the real
 * `W3CTraceContextPropagator`) is not resolvable from this package, and adding
 * it would mean a lockfile change during a multi-agent ticket. The wire format
 * produced here is cross-checked against the REAL
 * `TraceContextTextMapPropagator` on the Python side via the shared golden
 * constant below — see `apps/stt/tests/test_trace_propagation_task636.py`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  extractTraceCarrier,
  hasTraceContext,
  injectTraceCarrier,
  traceCarrierFromFields,
  withTraceContext,
} from '../trace-propagation';

/**
 * Golden W3C traceparent. The SAME literal is asserted in the Python suite
 * against `opentelemetry.trace.propagation.tracecontext.TraceContextTextMapPropagator`,
 * so the two runtimes are pinned to one wire format.
 */
const GOLDEN_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const GOLDEN_SPAN_ID = '00f067aa0ba902b7';
const GOLDEN_TRACEPARENT = `00-${GOLDEN_TRACE_ID}-${GOLDEN_SPAN_ID}-01`;

/** Minimal W3C tracecontext propagator (test double for `@opentelemetry/core`). */
class TestW3CPropagator implements TextMapPropagator {
  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(context);
    if (!spanContext || !trace.isSpanContextValid(spanContext)) return;
    setter.set(
      carrier,
      TRACEPARENT_HEADER,
      `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 1).toString(16).padStart(2, '0')}`,
    );
    if (spanContext.traceState) {
      setter.set(carrier, TRACESTATE_HEADER, spanContext.traceState.serialize());
    }
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, TRACEPARENT_HEADER);
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return context;
    const parts = value.split('-');
    if (parts.length !== 4) return context;
    const [, traceId, spanId, flags] = parts;
    const spanContext = {
      traceId,
      spanId,
      traceFlags: Number.parseInt(flags, 16) & 1 ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: true,
    };
    if (!trace.isSpanContextValid(spanContext)) return context;
    return trace.setSpanContext(context, spanContext);
  }

  fields(): string[] {
    return [TRACEPARENT_HEADER, TRACESTATE_HEADER];
  }
}

/**
 * Synchronous stand-in for `AsyncLocalStorageContextManager` (which the API
 * package does not ship and `@opentelemetry/context-async-hooks` is not
 * resolvable here). `withTraceContext` is synchronous by design, so a
 * stack-based manager exercises exactly the code path production uses.
 *
 * This double also documents a real dependency: `context.with` only propagates
 * when a ContextManager is registered. In `apps/api` the NodeSDK registers one
 * — and when the SDK is DISABLED, `context.with` degrades to a plain call,
 * which is precisely the no-op posture TASK-411 requires.
 */
class StackContextManager implements ContextManager {
  private stack: Context[] = [ROOT_CONTEXT];

  active(): Context {
    return this.stack[this.stack.length - 1];
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
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

/** A context carrying a valid, sampled, non-recording span (no SDK required). */
function contextWithGoldenSpan(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: GOLDEN_TRACE_ID,
    spanId: GOLDEN_SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  });
}

describe('TASK-636 OBS-16 — trace-propagation seam', () => {
  beforeEach(() => {
    propagation.disable();
    context.disable();
    context.setGlobalContextManager(new StackContextManager().enable());
  });

  describe('no-op posture (TASK-411: default-off, zero hot-path cost)', () => {
    it('injectTraceCarrier returns an empty carrier when no propagator is registered', () => {
      const carrier = injectTraceCarrier(contextWithGoldenSpan());
      expect(carrier).toEqual({});
    });

    it('injectTraceCarrier returns an empty carrier when there is no valid span', () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      expect(injectTraceCarrier(ROOT_CONTEXT)).toEqual({});
    });

    it('hasTraceContext is false for a context without a valid span', () => {
      expect(hasTraceContext(ROOT_CONTEXT)).toBe(false);
    });

    it('hasTraceContext is true for a context with a valid span', () => {
      expect(hasTraceContext(contextWithGoldenSpan())).toBe(true);
    });

    it('extractTraceCarrier returns undefined for an empty carrier', () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      expect(extractTraceCarrier({})).toBeUndefined();
    });

    it('extractTraceCarrier returns undefined for a malformed traceparent', () => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
      expect(extractTraceCarrier({ traceparent: 'not-a-traceparent' })).toBeUndefined();
    });
  });

  describe('round trip across a flat string carrier (the Redis / SSE wire shape)', () => {
    beforeEach(() => {
      propagation.setGlobalPropagator(new TestW3CPropagator());
    });

    it('emits the golden W3C traceparent for the golden span context', () => {
      expect(injectTraceCarrier(contextWithGoldenSpan())).toEqual({
        [TRACEPARENT_HEADER]: GOLDEN_TRACEPARENT,
      });
    });

    it('preserves trace id and parent span id through inject → JSON → extract', () => {
      const carrier = injectTraceCarrier(contextWithGoldenSpan());
      // Simulate the Redis Stream hop: everything becomes a flat string map.
      const onTheWire = JSON.parse(JSON.stringify(carrier)) as Record<string, string>;

      const extracted = extractTraceCarrier(onTheWire);
      expect(extracted).toBeDefined();
      const spanContext = trace.getSpanContext(extracted!);
      expect(spanContext?.traceId).toBe(GOLDEN_TRACE_ID);
      expect(spanContext?.spanId).toBe(GOLDEN_SPAN_ID);
      expect(spanContext?.isRemote).toBe(true);
    });

    it('withTraceContext makes the extracted parent the ACTIVE context for the callback', () => {
      const carrier = injectTraceCarrier(contextWithGoldenSpan());
      let observedTraceId: string | undefined;
      withTraceContext(carrier, () => {
        observedTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
      expect(observedTraceId).toBe(GOLDEN_TRACE_ID);
    });

    it('withTraceContext still runs the callback when no context is present', () => {
      let ran = false;
      const result = withTraceContext({}, () => {
        ran = true;
        return 42;
      });
      expect(ran).toBe(true);
      expect(result).toBe(42);
    });
  });

  describe('traceCarrierFromFields (ioredis flat [k, v, k, v] reply shape)', () => {
    it('picks only the trace headers out of a flat field array', () => {
      const fields = ['type', 'segment', 'text', 'redacted', TRACEPARENT_HEADER, GOLDEN_TRACEPARENT];
      expect(traceCarrierFromFields(fields)).toEqual({ [TRACEPARENT_HEADER]: GOLDEN_TRACEPARENT });
    });

    it('returns an empty carrier when the entry carries no trace headers', () => {
      expect(traceCarrierFromFields(['type', 'status', 'status', 'closed'])).toEqual({});
    });

    it('never lets a payload field leak into the carrier', () => {
      const carrier = traceCarrierFromFields(['text', 'patient says hello', TRACEPARENT_HEADER, GOLDEN_TRACEPARENT]);
      expect(Object.keys(carrier)).toEqual([TRACEPARENT_HEADER]);
    });
  });
});
