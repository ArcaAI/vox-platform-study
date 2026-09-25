/**
 * TASK-999 (D-5(a), D-6(a)) — the job service's streaming-row lifecycle and the
 * `jobType` list filter.
 *
 * `TranscriptionJobService.list` filtered on `{ tenantId }` alone, so there was
 * no way to ask for one kind of job — which only mattered once realtime sessions
 * became rows and the list started carrying two.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobService } from '../transcriptionJob.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TranscriptionJobType = { BATCH: 'BATCH', STREAMING: 'STREAMING' } as const;
const TranscriptionJobStatus = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED' } as const;

/** A row as `findAll` hands it back: real setters, so state changes are observable. */
function rowEntity(overrides: Record<string, any> = {}): any {
  const state: Record<string, any> = {
    id: 'job-1',
    tenantId: 'tenant-1',
    jobType: TranscriptionJobType.STREAMING,
    streamSessionId: 'sess-1',
    status: TranscriptionJobStatus.PROCESSING,
    progress: 0,
    completedAt: null,
    servedBy: null,
    resultWordCount: null,
    resultCharCount: null,
    resolvedSpec: null,
    createdAt: new Date('2026-09-22T10:00:00Z'),
    ...overrides,
  };
  return state;
}

const spec = (): any => ({
  runtimeKey: 'agent-v1',
  agent: { slug: 'ml-en-consult', versionId: 'agent-version-1', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper-ml-en-f16', taskType: 'SPEECH_TO_TEXT', format: 'GGUF', provider: null, libraryName: 'whisper.cpp' } },
  fallback: {
    kind: 'model',
    autoSwitch: true,
    switchAfterConsecutiveFailures: 3,
    chain: [
      {
        runtimeKey: 'agent-v1:fb',
        agent: { slug: 'cloud-fallback', versionId: 'agent-version-2', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
        models: { asr: { role: 'asr', slug: 'sarvam-saarika-v2', taskType: 'SPEECH_TO_TEXT', format: 'API', provider: 'sarvam' } },
      },
    ],
    spec: null,
  },
});

describe('TASK-999 — streaming rows and the jobType filter', () => {
  let jobRepository: any;
  let pipelineRepository: any;
  let eventEmitter: any;
  let clsService: any;
  let service: TranscriptionJobService;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRepository = { findAll: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), create: vi.fn(), update: vi.fn() };
    pipelineRepository = { findById: vi.fn() };
    eventEmitter = { emit: vi.fn() };
    clsService = { get: vi.fn().mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : null)) };
    service = new TranscriptionJobService(jobRepository, eventEmitter, clsService);
  });

  describe('list', () => {
    it('returns BOTH kinds when no jobType is given', async () => {
      // RED before the change: `list` took only (page, limit) — there was nothing
      // to pass. Absent must stay "both": realtime rows are new, and defaulting to
      // BATCH would hide them from every existing reader.
      jobRepository.findAll.mockResolvedValue([]);

      await service.list(1, 20);

      expect(jobRepository.findAll.mock.calls[0][0].filters).toEqual({ tenantId: 'tenant-1' });
      expect(jobRepository.count.mock.calls[0][0].filters).toEqual({ tenantId: 'tenant-1' });
    });

    it('narrows to one kind when jobType is given — on the page AND the count', async () => {
      // RED before the change: there was no filter, so the total would have
      // disagreed with the page it paginated.
      await service.list(1, 20, TranscriptionJobType.STREAMING as any);

      expect(jobRepository.findAll.mock.calls[0][0].filters).toEqual({ tenantId: 'tenant-1', jobType: 'STREAMING' });
      expect(jobRepository.count.mock.calls[0][0].filters).toEqual({ tenantId: 'tenant-1', jobType: 'STREAMING' });
    });
  });

  describe('createForStreamSession', () => {
    it('writes ONE row, already PROCESSING, keyed to the STT session', async () => {
      // RED before the change: the method did not exist and `createStreamingJob`
      // had zero callers. A live session is PROCESSING from the instant it opens —
      // there is no queue and no worker to claim it.
      jobRepository.create.mockImplementation(async (entity: any) => entity);

      await service.createForStreamSession({
        tenantId: 'tenant-1',
        streamSessionId: 'sess-1',
        consultationId: 'consult-1',
        agentVersionId: 'agent-version-1',
        resolvedSpec: spec(),
        userId: 'doctor-1',
      });

      expect(jobRepository.create).toHaveBeenCalledTimes(1);
      const written = jobRepository.create.mock.calls[0][0];
      expect(written.jobType).toBe('STREAMING');
      expect(written.streamSessionId).toBe('sess-1');
      expect(written.status).toBe('PROCESSING');
      expect(written.startedAt).toBeInstanceOf(Date);
      // The session id names the process holding the job, so a stranded row can
      // be traced back to the session it belongs to.
      expect(written.workerId).toBe('sess-1');
    });
  });

  describe('completeStreamSessionJob', () => {
    it('closes the row found by streamSessionId and records which entry served', async () => {
      // RED before the change: nothing recorded which chain entry served, so a
      // primary and a fallback sharing a provider were indistinguishable.
      const row = rowEntity({ resolvedSpec: spec() });
      jobRepository.findAll.mockResolvedValue([row]);
      jobRepository.update.mockResolvedValue(row);

      const result = await service.completeStreamSessionJob('sess-1', { engine: 'sarvam' });

      expect(jobRepository.findAll.mock.calls[0][0].filters).toEqual({ streamSessionId: 'sess-1' });
      expect(jobRepository.update).toHaveBeenCalledTimes(1);
      expect(row.status).toBe('COMPLETED');
      expect(row.completedAt).toBeInstanceOf(Date);
      expect(row.servedBy).toMatchObject({ chainIndex: 0, source: 'fallback', modelSlug: 'sarvam-saarika-v2' });
      expect(result).toMatchObject({ jobId: 'job-1', alreadyCompleted: false });
      // Handed back so the caller can stamp the same model onto its usage rows.
      expect(result?.resolvedSpec).not.toBeNull();
    });

    it('writes nothing a second time when another teardown path already closed the row', async () => {
      // RED before the change: there was no row, so nothing to double-write. Both
      // `removeSession` and the STT reaper push-back can arrive for one session;
      // the first one to land owns the completion.
      const row = rowEntity({ completedAt: new Date('2026-09-22T10:05:00Z'), status: 'COMPLETED', resolvedSpec: spec() });
      jobRepository.findAll.mockResolvedValue([row]);

      const result = await service.completeStreamSessionJob('sess-1', { engine: 'whisper_cpp' });

      expect(jobRepository.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ alreadyCompleted: true });
      // Still answers with the spec, so a racing push-back can still meter.
      expect(result?.resolvedSpec).not.toBeNull();
    });

    it('is null for a session with no row — a session opened before this shipped', async () => {
      // RED before the change: no lookup existed. Teardown must not throw for a
      // session whose row predates this ticket, or whose row write failed.
      jobRepository.findAll.mockResolvedValue([]);

      await expect(service.completeStreamSessionJob('sess-unknown', { engine: 'whisper_cpp' })).resolves.toBeNull();
      expect(jobRepository.update).not.toHaveBeenCalled();
    });

    it('leaves the counts NULL when nothing measured the transcript', async () => {
      // NULL means never measured; 0 would claim a real empty transcript. A
      // realtime transcript is written as its own ContextItem, never onto this row.
      const row = rowEntity({ resolvedSpec: spec() });
      jobRepository.findAll.mockResolvedValue([row]);
      jobRepository.update.mockResolvedValue(row);

      await service.completeStreamSessionJob('sess-1', { engine: 'whisper_cpp' });

      expect(row.resultWordCount).toBeNull();
      expect(row.resultCharCount).toBeNull();
    });
  });
});
