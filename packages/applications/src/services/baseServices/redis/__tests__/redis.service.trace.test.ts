import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import type { ModuleRef } from '@nestjs/core';
import { RedisService } from '../redis.service';
import type { IConfigService } from '../../_meta/config';

vi.mock('@nestjs/bullmq', () => ({ getQueueToken: vi.fn((n: string) => `QUEUE_${n}`) }));
vi.mock('bullmq', () => ({ Queue: vi.fn() }));

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

describe('RedisService.addJob trace carrier', () => {
  let add: ReturnType<typeof vi.fn>;
  let service: RedisService;
  let cls: ClsService;

  beforeEach(async () => {
    add = vi.fn().mockResolvedValue({ id: 'j' });
    const config = { isRedisConfigured: () => true, getRedisConfig: () => ({ host: 'h', port: 1 }) } as unknown as IConfigService;
    service = new RedisService(['q'], config, { get: () => ({ add }) } as unknown as ModuleRef);
    await service.onModuleInit();
    cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
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
    context.disable();
  });

  it('D1: queue.add payload carries _trace with the active traceparent and request id', async () => {
    const spy = vi
      .spyOn(context, 'active')
      .mockReturnValue(trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }));
    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-77');
      await service.addJob({ queueName: 'q', jobType: 'x', data: { id: 1 } });
    });
    spy.mockRestore();
    expect(add).toHaveBeenCalledWith('x', { id: 1, _trace: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, requestId: 'req-77' } }, undefined);
  });
});
