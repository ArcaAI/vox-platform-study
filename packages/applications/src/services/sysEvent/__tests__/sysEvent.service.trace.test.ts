import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLS_ID, ClsService, ClsServiceManager } from 'nestjs-cls';
import { ROOT_CONTEXT, TraceFlags, context, trace } from '@opentelemetry/api';
import { ResourceType, type AuditLogJob, type SysEvent } from '@arcaai/domains';
import { Logger } from '@nestjs/common';
import { SysEventService } from '../sysEvent.service';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

const event = (overrides: Partial<SysEvent> = {}): SysEvent =>
  ({
    id: 'e1',
    resourceId: 'r1',
    resourceType: ResourceType.User,
    responsibleEntityId: 'u1',
    responsibleEntityType: ResourceType.User,
    disableAuditLog: false,
    data: {},
    previousData: {},
    createdAt: new Date(),
    correlationId: null,
    tenantId: 't1',
    ...overrides,
  }) as unknown as SysEvent;

describe('SysEventService audit trace capture', () => {
  let addJob: ReturnType<typeof vi.fn>;
  let service: SysEventService;
  let cls: ClsService;

  beforeEach(() => {
    addJob = vi.fn().mockResolvedValue(undefined);
    service = new SysEventService({ addJob } as never, {} as never);
    cls = new ClsService(new AsyncLocalStorage() as never);
    (ClsServiceManager as unknown as { clsService: ClsService }).clsService = cls;
  });
  afterEach(() => vi.restoreAllMocks());

  const auditJob = (): AuditLogJob => addJob.mock.calls.map((c) => c[0]).find((c) => c.data && 'action' in c.data).data as AuditLogJob;

  it('D3: audit job carries traceId from the active span and correlationId from the CLS id when the event has none', async () => {
    const spy = vi.spyOn(context, 'active').mockReturnValue(trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }));
    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-5');
      await service.handleResourceCreatedEvent(event());
    });
    spy.mockRestore();
    expect(auditJob()).toMatchObject({ traceId: TRACE_ID, correlationId: 'req-5' });
  });

  it('D3: an explicit event correlationId wins over the CLS id', async () => {
    await cls.run(async () => {
      (cls as ClsService<Record<symbol, unknown>>).set(CLS_ID, 'req-5');
      await service.handleResourceCreatedEvent(event({ correlationId: 'from-event' } as never));
    });
    expect(auditJob().correlationId).toBe('from-event');
    expect(auditJob().traceId).toBeUndefined();
  });

  it('D3: a queue-add failure log names tenantId, resourceId, correlationId and the error', async () => {
    const err = new Error('redis down');
    addJob.mockRejectedValue(err);
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await service.handleResourceCreatedEvent(event({ correlationId: 'c9' } as never));
    const failure = logged.mock.calls.map((c) => c[0] as Record<string, unknown>).find((c) => c.message === 'Failed to queue job');
    expect(failure).toMatchObject({ tenantId: 't1', resourceId: 'r1', correlationId: 'c9', error: err });
  });
});
