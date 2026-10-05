import { describe, expect, it, vi } from 'vitest';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import type { Job } from 'bullmq';
import { UsageOutboxProcessor } from '../usage-outbox.processor';

// The outbox drain is cross-tenant system work. The tenant-scope extension passes a
// query through only when NO CLS scope is active; an open scope without a
// tenant makes it refuse ("tenant context required"). So the processor must
// run its body outside any CLS scope — the trace is still restored.
const clsActive = (): boolean => {
  try {
    return ClsServiceManager.getClsService().isActive();
  } catch {
    return false;
  }
};

const job = (data: unknown): Job => ({ id: 'j-1', queueName: 'q', attemptsMade: 0, data }) as unknown as Job;
// The process-wide CLS service — the one Nest injects and the tenant-scope extension reads.
const realCls = (): ClsService => ClsServiceManager.getClsService();

describe('cross-tenant processors run outside any CLS scope', () => {
  it('UsageOutboxProcessor drains with no CLS scope active', async () => {
    let activeDuringDrain: boolean | undefined;
    const drainer = { drainBatch: vi.fn(async () => ((activeDuringDrain = clsActive()), { drained: 0 })) };
    const processor = new (UsageOutboxProcessor as unknown as new (...args: unknown[]) => UsageOutboxProcessor)(drainer, realCls());

    await processor.process(job({}));

    expect(drainer.drainBatch).toHaveBeenCalledOnce();
    expect(activeDuringDrain).toBe(false);
  });
});
