/**
 * BUG-042 — a realtime session's row had exactly one close path: a 200 teardown summary.
 * Every other ending (STT already gone, a crash, exhausted retries) left it PROCESSING
 * forever. `failStreamSessionJob` is the second close path: FAILED + `STT_SESSION_GONE`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT_SESSION_GONE_ERROR_CODE } from '../transcriptionJob.service';
import { TranscriptionJobService } from '../transcriptionJob.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function row(overrides: Record<string, any> = {}): any {
  const r: any = {
    id: 'job-1',
    tenantId: 'tenant-1',
    jobType: 'STREAMING',
    streamSessionId: 'sess-1',
    status: 'PROCESSING',
    completedAt: null,
    ...overrides,
  };
  r.fail = vi.fn((message: string, code?: string) => {
    r.status = 'FAILED';
    r.completedAt = new Date();
    r.errorMessage = message;
    r.errorCode = code;
  });
  return r;
}

describe('BUG-042 — failStreamSessionJob', () => {
  let jobRepository: any;
  let eventEmitter: any;
  let service: TranscriptionJobService;

  beforeEach(() => {
    jobRepository = { findAll: vi.fn().mockResolvedValue([]), update: vi.fn() };
    eventEmitter = { emit: vi.fn() };
    service = new TranscriptionJobService(jobRepository, eventEmitter, { get: vi.fn() } as any);
  });

  it('fails the open row found by streamSessionId with STT_SESSION_GONE', async () => {
    const job = row();
    jobRepository.findAll.mockResolvedValue([job]);

    const result = await service.failStreamSessionJob('sess-1', 'STT no longer had the session at teardown');

    expect(jobRepository.findAll.mock.calls[0][0].filters).toEqual({ streamSessionId: 'sess-1' });
    expect(job.fail).toHaveBeenCalledWith('STT no longer had the session at teardown', STT_SESSION_GONE_ERROR_CODE);
    expect(jobRepository.update).toHaveBeenCalledWith('job-1', job);
    expect(result).toEqual({ jobId: 'job-1', alreadyCompleted: false });
    expect(STT_SESSION_GONE_ERROR_CODE).toBe('STT_SESSION_GONE');
  });

  it('closes a QUEUED row too', async () => {
    const job = row({ status: 'QUEUED' });
    jobRepository.findAll.mockResolvedValue([job]);

    await service.failStreamSessionJob('sess-1', 'gone');

    expect(job.fail).toHaveBeenCalled();
  });

  it('writes nothing when another teardown path already closed the row', async () => {
    const job = row({ status: 'COMPLETED', completedAt: new Date() });
    jobRepository.findAll.mockResolvedValue([job]);

    const result = await service.failStreamSessionJob('sess-1', 'gone');

    expect(job.fail).not.toHaveBeenCalled();
    expect(jobRepository.update).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-1', alreadyCompleted: true });
  });

  it('is null for a session with no row', async () => {
    expect(await service.failStreamSessionJob('sess-x', 'gone')).toBeNull();
  });
});
