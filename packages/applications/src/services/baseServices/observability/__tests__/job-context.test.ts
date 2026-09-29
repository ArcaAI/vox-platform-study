import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
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
import { attachJobTrace, runJobInContext } from '../job-context';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

class W3C implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const sc = trace.getSpanContext(ctx);
    if (!sc || !trace.isSpanContextValid(sc)) return;
    setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
  }
  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, 'traceparent');
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== 'string') return ctx;
    const [, traceId, spanId] = v.split('-');
    return trace.setSpanContext(ctx, { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });
  }
  fields(): string[] {
    return ['traceparent'];
  }
}

class AlsContextManager implements ContextManager {
  private als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
    return this.als.run(ctx, () => fn.call(thisArg as ThisParameterType<F>, ...args));
  }
  bind<T>(_c: Context, t: T): T {
    return t;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

describe('BullMQ trace carrier', () => {
  let cls: ClsService;

  beforeEach(() => {
    context.setGlobalContextManager(new AlsContextManager());
    propagation.setGlobalPropagator(new W3C());
    cls = new ClsService(new AsyncLocalStorage() as never);
  });
  afterEach(() => {
    context.disable();
    propagation.disable();
  });

  const inSpan = <T>(fn: () => T): T =>
    context.with(trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }), fn);

  it('D1: attachJobTrace stamps _trace with the active traceparent', () => {
    const out = inSpan(() => attachJobTrace({ a: 1 })) as { a: number; _trace?: { traceparent?: string } };
    expect(out._trace?.traceparent).toBe(TRACEPARENT);
    expect(out.a).toBe(1);
  });

  it('D1: does not overwrite a caller-supplied _trace and adds nothing when nothing is known', () => {
    const preset = { _trace: { requestId: 'mine' } };
    expect(inSpan(() => attachJobTrace(preset))).toBe(preset);
    expect(attachJobTrace({ a: 1 })).toEqual({ a: 1 });
  });

  it('D2: process body runs in the restored span with the request id as CLS id', async () => {
    const seen: { traceId?: string; id?: string } = {};
    await runJobInContext(cls, { id: 7, data: { _trace: { traceparent: TRACEPARENT, requestId: 'req-9' } } }, async () => {
      seen.traceId = trace.getSpanContext(context.active())?.traceId;
      seen.id = cls.getId();
    });
    expect(seen).toEqual({ traceId: TRACE_ID, id: 'req-9' });
  });

  it('D2: falls back to job:<id> when the producer had no request id', async () => {
    let id: string | undefined;
    await runJobInContext(cls, { id: 42, data: {} }, async () => {
      id = cls.getId();
    });
    expect(id).toBe('job:42');
  });

  it('D2: logs a failed job once with queue/jobId/attemptsMade/errorName and rethrows', async () => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const err = new TypeError('boom');
    await expect(
      runJobInContext(cls, { id: 3, queueName: 'q', attemptsMade: 2, data: {} }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ queue: 'q', jobId: 3, attemptsMade: 2, errorName: 'TypeError', error: err });
    spy.mockRestore();
  });
});
