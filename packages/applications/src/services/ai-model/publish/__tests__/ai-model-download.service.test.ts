/**
 * AiModelDownloadService — the trigger + status-poll half of the publish lane.
 *
 * TASK-890 §3.11: the four bookkeeping COLUMNS (`downloadStatus`, `downloadedAt`,
 * `fileSizeMb`, `localPath`) are dropped by L2, so this service no longer reads
 * or writes any of them. The WIRE shape is unchanged — the same four status
 * values, the same field names — but every value now comes from the two things
 * that survive: the MEASURED `availability` and the `_metadata.download`
 * bookkeeping the job already wrote.
 *
 * Behavioral mock entity; mocked repository/queue/event-emitter/cls boundaries only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { AiModelDownloadService } from '../ai-model-download.service';

const AiModelAvailability = { UNKNOWN: 'UNKNOWN', AVAILABLE: 'AVAILABLE', MISSING: 'MISSING' } as const;

function createBehavioralModelEntity(overrides: Record<string, unknown> = {}) {
  let _metaData = (overrides.metaData as Record<string, unknown> | null | undefined) ?? null;
  let _updatedBy: string | null = null;
  const _changes: Record<string, unknown> = {};

  return {
    id: (overrides.id as string) ?? 'model-id-1',
    tenantId: (overrides.tenantId as string) ?? 'tenant-1',
    slug: (overrides.slug as string) ?? 'gemma4-e2b-it-qat',
    version: (overrides.version as number) ?? 3,
    checksum: (overrides.checksum as string | null) ?? null,
    bucketPrefix: (overrides.bucketPrefix as string | null) ?? null,
    primaryObject: (overrides.primaryObject as string | null) ?? null,
    availability: (overrides.availability as string) ?? AiModelAvailability.UNKNOWN,
    get metaData() {
      return _metaData;
    },
    set metaData(value: Record<string, unknown> | null | undefined) {
      _metaData = value ?? null;
      _changes.metaData = value;
    },
    get updatedBy() {
      return _updatedBy;
    },
    set updatedBy(value: string | null) {
      _updatedBy = value;
      _changes.updatedBy = value;
    },
    get changes() {
      return _changes;
    },
  };
}

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockModelRepository = { findById: vi.fn(), updateWithVersion: vi.fn() };
const mockDownloadQueue = { add: vi.fn() };

describe('AiModelDownloadService', () => {
  let service: AiModelDownloadService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      if (key === 'user') return { id: 'current-user-id' };
      if (key === 'tenantId') return 'tenant-1';
      return null;
    });
    service = new AiModelDownloadService(mockModelRepository as never, mockDownloadQueue as never, mockEventEmitter as never, mockClsService as never);
  });

  describe('triggerDownload', () => {
    it('throws NotFoundException for an unknown/cross-tenant id', async () => {
      mockModelRepository.findById.mockResolvedValue(null);
      await expect(service.triggerDownload('missing-id')).rejects.toThrow(NotFoundException);
      expect(mockDownloadQueue.add).not.toHaveBeenCalled();
    });

    it('throws ConflictException (409) when the bookkeeping says a job is still in flight', async () => {
      const model = createBehavioralModelEntity({ metaData: { download: { jobId: 'job-0', startedAt: 't0', finishedAt: null, error: null } } });
      mockModelRepository.findById.mockResolvedValue(model);
      await expect(service.triggerDownload('model-id-1')).rejects.toThrow(ConflictException);
      expect(mockDownloadQueue.add).not.toHaveBeenCalled();
    });

    it('claims the row through updateWithVersion, enqueues the job, and returns the frozen 202 shape', async () => {
      const model = createBehavioralModelEntity({ version: 5 });
      mockModelRepository.findById.mockResolvedValue(model);
      mockModelRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);

      const result = await service.triggerDownload('model-id-1');

      // The CLAIM is the metadata write — no `downloadStatus` column is touched.
      expect(model.changes.downloadStatus).toBeUndefined();
      expect(mockModelRepository.updateWithVersion).toHaveBeenCalledWith('model-id-1', model, 5);
      expect(mockDownloadQueue.add).toHaveBeenCalledTimes(1);
      const [, payload, options] = mockDownloadQueue.add.mock.calls[0];
      expect(payload).toMatchObject({ aiModelId: 'model-id-1', tenantId: 'tenant-1', jobId: result.jobId });
      expect(options).toMatchObject({ jobId: result.jobId });
      expect(result).toEqual({ jobId: result.jobId, status: 'DOWNLOADING' });
      expect(typeof result.jobId).toBe('string');
      expect(result.jobId.length).toBeGreaterThan(0);
    });

    it('records startedAt + jobId bookkeeping into metaData.download', async () => {
      const model = createBehavioralModelEntity();
      mockModelRepository.findById.mockResolvedValue(model);
      mockModelRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);

      const result = await service.triggerDownload('model-id-1');

      const download = model.metaData?.download as Record<string, unknown>;
      expect(download.jobId).toBe(result.jobId);
      expect(typeof download.startedAt).toBe('string');
      expect(download.finishedAt).toBeNull();
      expect(download.error).toBeNull();
    });

    it('broadcasts a ResourceUpdated sys-event on a successful trigger', async () => {
      const model = createBehavioralModelEntity();
      mockModelRepository.findById.mockResolvedValue(model);
      mockModelRepository.updateWithVersion.mockImplementation(async (_id: string, entity: typeof model) => entity);

      await service.triggerDownload('model-id-1');

      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });

    it('maps an OCC race on the claim to 409, not 412', async () => {
      const model = createBehavioralModelEntity();
      mockModelRepository.findById.mockResolvedValue(model);
      mockModelRepository.updateWithVersion.mockRejectedValue(new OptimisticConcurrencyException('AiModel', 'model-id-1', { expectedVersion: 3, currentVersion: 4 }));

      await expect(service.triggerDownload('model-id-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('getDownloadStatus', () => {
    it('throws NotFoundException for an unknown/cross-tenant id', async () => {
      mockModelRepository.findById.mockResolvedValue(null);
      await expect(service.getDownloadStatus('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('returns the frozen GET shape, every value derived from availability + bookkeeping', async () => {
      const model = createBehavioralModelEntity({
        availability: AiModelAvailability.AVAILABLE,
        checksum: 'abc123',
        bucketPrefix: 'gemma4-e2b-it-qat/q4-0-451faffb5a16',
        metaData: { download: { jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: null, sizeMb: 3350 } },
      });
      mockModelRepository.findById.mockResolvedValue(model);

      const result = await service.getDownloadStatus('model-id-1');

      expect(result).toEqual({
        status: 'DOWNLOADED',
        startedAt: new Date('t0'),
        finishedAt: new Date('t1'),
        fileSizeMb: 3350,
        sha256: 'abc123',
        // DERIVED from the bucket identity — the column is gone.
        localPath: '/mnt/models-bucket/gemma4-e2b-it-qat/q4-0-451faffb5a16/',
        error: null,
      });
    });

    it('reports NOT_DOWNLOADED with no bookkeeping and no measured weights', async () => {
      const model = createBehavioralModelEntity({ availability: AiModelAvailability.MISSING, metaData: null });
      mockModelRepository.findById.mockResolvedValue(model);

      const result = await service.getDownloadStatus('model-id-1');

      expect(result.status).toBe('NOT_DOWNLOADED');
      expect(result.startedAt).toBeNull();
      expect(result.finishedAt).toBeNull();
      expect(result.localPath).toBeNull();
      expect(result.error).toBeNull();
    });

    it('surfaces a recorded failure as DOWNLOAD_FAILED with its error, even on a row whose OLD weights are still present', async () => {
      const model = createBehavioralModelEntity({
        availability: AiModelAvailability.AVAILABLE,
        bucketPrefix: 'gemma4/1',
        metaData: { download: { jobId: 'job-1', startedAt: 't0', finishedAt: 't1', error: 'HuggingFace 404' } },
      });
      mockModelRepository.findById.mockResolvedValue(model);

      const result = await service.getDownloadStatus('model-id-1');

      expect(result.status).toBe('DOWNLOAD_FAILED');
      expect(result.error).toBe('HuggingFace 404');
    });
  });
});
