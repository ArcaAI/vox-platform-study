/**
 * TASK-1001 wave 6 (owner decision 2026-09-23) — the consultation COMPLETION TIMEOUT, enforced by the
 * gateway whatever engine wrote the note.
 *
 * Found on hope-v2-dev: ArcaAI consultations are documented by the tenant workflow's own graph, whose
 * review gate ALaaS releases at once — so the harness clinician gate (where waves 5-6 first put the
 * timeout) never started, and a note nobody approved sat in PENDING_REVIEW until the 2-hour sweep. The
 * one point every engine passes through is the gateway persisting the draft: that is "ready to
 * complete". It schedules ONE delayed job per consultation (a re-finalise replaces it; a resumed
 * recording cancels it); when it fires, the consultation is closed unsigned if it is still waiting.
 */
import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from '@arcaai/domains';
import { ConsultationCompletionTimeoutScheduler, completionTimeoutJobId } from '../consultation-completion-timeout.scheduler';
import { ConsultationCompletionTimeoutProcessor } from '../consultation-completion-timeout.processor';
import { CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY } from '../../../settings-registry/descriptors/consultation-completion.descriptors';

const TENANT = 'tenant-1';
const CID = 'consultation-1';

function queueDouble(existing: { remove: ReturnType<typeof vi.fn> } | null = null) {
  return { add: vi.fn().mockResolvedValue({ id: 'job' }), getJob: vi.fn().mockResolvedValue(existing) };
}
const settingsReturning = (value: unknown) => ({
  resolveEffective: vi.fn(async (key: string) => ({ value: key === CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY ? value : undefined })),
});

describe('ConsultationCompletionTimeoutScheduler', () => {
  it('schedules one delayed job for the tenant timeout, replacing any pending one', async () => {
    const pending = { remove: vi.fn().mockResolvedValue(undefined) };
    const queue = queueDouble(pending);
    const scheduler = new ConsultationCompletionTimeoutScheduler(queue as never, settingsReturning(7) as never);

    const scheduled = await scheduler.schedule(TENANT, CID);

    expect(queue.getJob).toHaveBeenCalledWith(completionTimeoutJobId(CID));
    expect(pending.remove).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      JobQueue.ConsultationCompletionTimeout,
      { tenantId: TENANT, consultationId: CID },
      expect.objectContaining({ jobId: completionTimeoutJobId(CID), delay: 7 * 60_000 }),
    );
    expect(scheduled?.timeoutMinutes).toBe(7);
  });

  it('falls to the platform default (5 min) when the setting is unusable or the lookup fails', async () => {
    for (const settings of [
      settingsReturning(0),
      settingsReturning('soon'),
      { resolveEffective: vi.fn().mockRejectedValue(new Error('down')) },
      undefined,
    ]) {
      const queue = queueDouble();
      await new ConsultationCompletionTimeoutScheduler(queue as never, settings as never).schedule(TENANT, CID);
      expect(queue.add.mock.calls[0][2]).toMatchObject({ delay: 5 * 60_000 });
    }
  });

  it('a pending job that cannot be removed (already running) does not stop the new window', async () => {
    const queue = queueDouble({ remove: vi.fn().mockRejectedValue(new Error('job is locked')) });
    await new ConsultationCompletionTimeoutScheduler(queue as never, settingsReturning(5) as never).schedule(TENANT, CID);
    expect(queue.add).toHaveBeenCalled();
  });

  it('cancel removes the pending job — the consultation is no longer ready to complete', async () => {
    const pending = { remove: vi.fn().mockResolvedValue(undefined) };
    const queue = queueDouble(pending);
    await new ConsultationCompletionTimeoutScheduler(queue as never, undefined).cancel(CID);
    expect(pending.remove).toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('never throws — the caller is persisting a clinical note or starting a recording', async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error('redis down')), getJob: vi.fn().mockRejectedValue(new Error('redis down')) };
    const scheduler = new ConsultationCompletionTimeoutScheduler(queue as never, undefined);
    await expect(scheduler.schedule(TENANT, CID)).resolves.toBeNull();
    await expect(scheduler.cancel(CID)).resolves.toBeUndefined();
  });
});

describe('ConsultationCompletionTimeoutProcessor', () => {
  it('closes the consultation unsigned through the harness-internal lifecycle writer', async () => {
    const harness = { closeOnCompletionTimeout: vi.fn().mockResolvedValue(undefined) };
    const processor = new ConsultationCompletionTimeoutProcessor(harness as never);

    await processor.process({ data: { tenantId: TENANT, consultationId: CID } } as never);

    expect(harness.closeOnCompletionTimeout).toHaveBeenCalledWith(CID, TENANT);
  });
});
