import { DelayedError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationCompletionTimeoutProcessor } from '../consultation-completion-timeout.processor';

const job = () => ({
  id: 'j1',
  data: { tenantId: 'T', consultationId: 'C' },
  moveToDelayed: vi.fn().mockResolvedValue(undefined),
});

describe('ConsultationCompletionTimeoutProcessor — tenant lock', () => {
  it('postpones while the tenant is locked', async () => {
    const harness = { closeOnCompletionTimeout: vi.fn() };
    const lock = { state: vi.fn().mockResolvedValue({ locked: true, restoreId: 'R' }), publishChange: vi.fn() };
    const processor = new ConsultationCompletionTimeoutProcessor(harness as never, lock as never);
    const j = job();
    await expect(processor.process(j as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(harness.closeOnCompletionTimeout).not.toHaveBeenCalled();
  });

  it('closes the consultation when unlocked', async () => {
    const harness = { closeOnCompletionTimeout: vi.fn().mockResolvedValue(undefined) };
    const lock = { state: vi.fn().mockResolvedValue({ locked: false }), publishChange: vi.fn() };
    const processor = new ConsultationCompletionTimeoutProcessor(harness as never, lock as never);
    await processor.process(job() as never, 'tok');
    expect(harness.closeOnCompletionTimeout).toHaveBeenCalledWith('C', 'T');
  });
});
