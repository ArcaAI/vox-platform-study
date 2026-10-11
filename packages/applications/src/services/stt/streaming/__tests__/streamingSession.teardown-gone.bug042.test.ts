/**
 * BUG-042 — `removeSession` returned early on an STT 404 and did nothing on a 204, so the
 * session's STREAMING row stayed PROCESSING ("Running") forever. Both now close it as
 * FAILED/STT_SESSION_GONE (owner OD-1); neither invents a usage row (OD-2).
 */
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingSessionService } from '../streamingSession.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('BUG-042 — teardown without a summary closes the row', () => {
  let httpService: any;
  let ledger: { recordUsage: ReturnType<typeof vi.fn> };
  let jobs: { completeStreamSessionJob: ReturnType<typeof vi.fn>; failStreamSessionJob: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    httpService = { get: vi.fn(), post: vi.fn(), delete: vi.fn() };
    ledger = { recordUsage: vi.fn() };
    jobs = { completeStreamSessionJob: vi.fn(), failStreamSessionJob: vi.fn().mockResolvedValue({ jobId: 'job-1', alreadyCompleted: false }) };
  });

  const build = () =>
    new StreamingSessionService(
      httpService,
      { config: { STT_URL: 'http://stt.internal:9000' } } as any,
      ledger as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jobs as any,
    );

  it('fails the row when STT answers 404 (the session was already gone)', async () => {
    httpService.delete.mockReturnValue(throwError(() => ({ response: { status: 404 } })));

    await build().removeSession('sess-1');

    expect(jobs.failStreamSessionJob).toHaveBeenCalledWith('sess-1', expect.stringContaining('404'));
    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });

  it('fails the row when STT answers 204 with no summary', async () => {
    httpService.delete.mockReturnValue(of({ status: 204, data: undefined }));

    await build().removeSession('sess-1');

    expect(jobs.failStreamSessionJob).toHaveBeenCalledWith('sess-1', expect.stringContaining('204'));
    expect(ledger.recordUsage).not.toHaveBeenCalled();
  });

  it('a failing row write never fails the teardown', async () => {
    httpService.delete.mockReturnValue(throwError(() => ({ response: { status: 404 } })));
    jobs.failStreamSessionJob.mockRejectedValue(new Error('db down'));

    await expect(build().removeSession('sess-1')).resolves.toBeUndefined();
  });

  it('a 200 with a summary still completes the row and never fails it', async () => {
    httpService.delete.mockReturnValue(
      of({ status: 200, data: { session_id: 'sess-1', tenant_id: 'tenant-1', audio_seconds: 1, session_seconds: 2, engine: 'whisper_cpp' } }),
    );
    jobs.completeStreamSessionJob.mockResolvedValue({ jobId: 'job-1', resolvedSpec: null, servedBy: null, alreadyCompleted: false });

    await build().removeSession('sess-1');

    expect(jobs.completeStreamSessionJob).toHaveBeenCalled();
    expect(jobs.failStreamSessionJob).not.toHaveBeenCalled();
  });
});
