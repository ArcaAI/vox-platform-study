import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { TranscriptionRealtimeService } from '../transcriptionRealtime.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'test-uuid-1234') }));

const SPEC = { runtimeKey: 'agent-v-1', models: { asr: { slug: 'whisper' } }, audioFrontEnd: { diarization: { enabled: false } } } as never;
const BASE = { jobId: 'job-1', tenantId: 'tenant-1', resolvedSpec: SPEC, audioUri: 's3://recordings/a.wav' };
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

function build() {
  const cache = { hset: vi.fn().mockResolvedValue(undefined), rpush: vi.fn().mockResolvedValue(1), publish: vi.fn().mockResolvedValue(undefined) };
  const jobService = { recordDispatchEnvelope: vi.fn().mockResolvedValue(undefined) };
  const service = new TranscriptionRealtimeService({ subscribeToChannel: vi.fn() } as never, jobService as never, cache as never);
  return { service, cache };
}

afterEach(() => {
  propagation.disable();
  vi.restoreAllMocks();
});

describe('dispatchDramatiqJob trace options', () => {
  it('D4: options.hope_trace carries traceparent and requestId next to redis_message_id', async () => {
    propagation.setGlobalPropagator({
      inject: (ctx, carrier, setter) => {
        const sc = trace.getSpanContext(ctx);
        if (sc) setter.set(carrier, 'traceparent', `00-${sc.traceId}-${sc.spanId}-01`);
      },
      extract: (ctx) => ctx,
      fields: () => ['traceparent'],
    });
    vi.spyOn(context, 'active').mockReturnValue(
      trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    );
    const cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
    const { service, cache } = build();

    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-8');
      await service.dispatchDramatiqJob(BASE);
    });

    const message = JSON.parse(cache.hset.mock.calls[0][2]);
    expect(message.options.redis_message_id).toBeDefined();
    expect(message.options.hope_trace).toEqual({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, requestId: 'req-8' });
  });

  it('D4: no hope_trace key when nothing is known', async () => {
    const { service, cache } = build();
    await service.dispatchDramatiqJob(BASE);
    expect(JSON.parse(cache.hset.mock.calls[0][2]).options).not.toHaveProperty('hope_trace');
  });
});
