import type { AuditLogJob } from '@arcaai/domains';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogFactory } from '@arcaai/domains';
import { AuditLogProcessor } from '../auditLog.processor';

const cls = () => ({
  run: vi.fn((...args: unknown[]) => (args.length === 1 ? (args[0] as () => unknown) : (args[1] as () => unknown))()),
  set: vi.fn(),
  get: vi.fn(),
});

describe('AuditLogProcessor trace persistence', () => {
  it('D3: the persisted row carries traceId and correlationId from the job', async () => {
    const create = vi.fn().mockResolvedValue({});
    const factory = vi.spyOn(AuditLogFactory, 'CreateAuditLog');
    const processor = new AuditLogProcessor({ create } as never, cls() as never);
    const data = {
      action: 'CREATE',
      responsibleUserId: 'u1',
      resourceType: 'User',
      data: {},
      previousData: {},
      correlationId: 'req-1',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      tenantId: 't1',
    } as unknown as AuditLogJob;

    await processor.process({ data, id: 'j1' } as unknown as Job<AuditLogJob>);

    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', correlationId: 'req-1' }));
    factory.mockRestore();
  });
});
