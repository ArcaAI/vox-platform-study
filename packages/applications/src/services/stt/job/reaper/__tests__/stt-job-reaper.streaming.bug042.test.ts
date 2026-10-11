/**
 * BUG-042 — stranded STREAMING rows. The batch pass deliberately skips them (a live session's
 * row is never written mid-consultation, so `updatedAt` is no heartbeat). This pass asks STT
 * instead: a stale QUEUED/PROCESSING streaming row whose session STT no longer has is failed
 * as STT_SESSION_GONE; a live session, or an STT that cannot be asked, is left alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT_STREAMING_DEFAULTS, STT_STREAMING_STALE_MINUTES_KEY } from '../../../../settings-registry/descriptors/stt-gateway.descriptors';
import { SttJobReaperService } from '../stt-job-reaper.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
function streamRow(overrides: Record<string, any> = {}): any {
  const r: any = {
    id: 'job-s1',
    tenantId: 'tenant-1',
    jobType: 'STREAMING',
    status: 'PROCESSING',
    streamSessionId: 'sess-1',
    createdBy: 'u-1',
    isTerminal: false,
    ...overrides,
  };
  r.fail = vi.fn((message: string, code?: string) => {
    r.status = 'FAILED';
    r.errorMessage = message;
    r.errorCode = code;
  });
  return r;
}

describe('SttJobReaperService — stranded STREAMING rows (BUG-042)', () => {
  let repository: any;
  let sessions: { getSessionStatus: ReturnType<typeof vi.fn> };
  let eventEmitter: any;
  let service: SttJobReaperService;

  beforeEach(() => {
    repository = { findStaleProcessingJobs: vi.fn().mockResolvedValue([]), findStaleStreamingJobs: vi.fn().mockResolvedValue([]), update: vi.fn() };
    sessions = { getSessionStatus: vi.fn().mockResolvedValue(null) };
    eventEmitter = { emit: vi.fn() };
    service = new SttJobReaperService(
      repository,
      eventEmitter,
      { run: vi.fn(async (cb: () => Promise<void>) => cb()), set: vi.fn(), get: vi.fn() } as any,
      { getValueWithDefault: vi.fn((_k: string, d: unknown) => d) } as any,
      { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
      sessions as any,
    );
  });

  it('queries streaming rows older than the configured window', async () => {
    const before = Date.now();
    await service.sweepStreamingOnce();
    const cutoff: Date = repository.findStaleStreamingJobs.mock.calls[0][0];
    const minutes = STT_STREAMING_DEFAULTS[STT_STREAMING_STALE_MINUTES_KEY];
    expect(before - cutoff.getTime()).toBeGreaterThanOrEqual(minutes * 60_000 - 50);
  });

  it('fails a row whose STT session is gone', async () => {
    const job = streamRow();
    repository.findStaleStreamingJobs.mockResolvedValue([job]);

    const result = await service.sweepStreamingOnce();

    expect(sessions.getSessionStatus).toHaveBeenCalledWith('sess-1', 'tenant-1');
    expect(job.fail).toHaveBeenCalledWith(expect.any(String), 'STT_SESSION_GONE');
    expect(repository.update).toHaveBeenCalledWith('job-s1', job);
    expect(result).toEqual({ eligible: 1, reaped: 1, failed: 0, live: 0, unknown: 0 });
  });

  it('leaves a session STT still has alone', async () => {
    const job = streamRow();
    repository.findStaleStreamingJobs.mockResolvedValue([job]);
    sessions.getSessionStatus.mockResolvedValue({ sessionId: 'sess-1', status: 'active' });

    const result = await service.sweepStreamingOnce();

    expect(job.fail).not.toHaveBeenCalled();
    expect(result.live).toBe(1);
  });

  it('leaves the row alone when STT cannot be asked (fails safe)', async () => {
    const job = streamRow();
    repository.findStaleStreamingJobs.mockResolvedValue([job]);
    sessions.getSessionStatus.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.sweepStreamingOnce();

    expect(job.fail).not.toHaveBeenCalled();
    expect(result.unknown).toBe(1);
  });

  it('fails a row that never got a session id (QUEUED and never opened)', async () => {
    const job = streamRow({ status: 'QUEUED', streamSessionId: null });
    repository.findStaleStreamingJobs.mockResolvedValue([job]);

    await service.sweepStreamingOnce();

    expect(sessions.getSessionStatus).not.toHaveBeenCalled();
    expect(job.fail).toHaveBeenCalledWith(expect.any(String), 'STT_SESSION_GONE');
  });

  it('isolates a per-row write failure', async () => {
    const a = streamRow({ id: 'a' });
    const b = streamRow({ id: 'b', streamSessionId: 'sess-2' });
    repository.findStaleStreamingJobs.mockResolvedValue([a, b]);
    repository.update.mockRejectedValueOnce(new Error('version conflict'));

    const result = await service.sweepStreamingOnce();

    expect(result).toMatchObject({ eligible: 2, reaped: 1, failed: 1 });
  });

  it('does nothing without a session client (no streaming module wired)', async () => {
    const bare = new SttJobReaperService(
      repository,
      eventEmitter,
      { run: vi.fn(), set: vi.fn(), get: vi.fn() } as any,
      { getValueWithDefault: vi.fn((_k: string, d: unknown) => d) } as any,
      { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() } as any,
    );
    repository.findStaleStreamingJobs.mockResolvedValue([streamRow()]);

    expect(await bare.sweepStreamingOnce()).toEqual({ eligible: 0, reaped: 0, failed: 0, live: 0, unknown: 0 });
  });
});
