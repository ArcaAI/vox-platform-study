/**
 * TASK-1019 P9 — the unregister job: shared prefix kept, sole owner deleted
 * (with the requested purge), row soft-deleted, availability MISSING,
 * `_metadata.unregister` completed, `ResourceDeleted` broadcast; a failure
 * records the error and does NOT soft-delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SysEventType } from '@arcaai/domains';
import { AiModelUnregisterService, deriveWeightsPrefix } from '../model-unregister.service';
import { readUnregisterMeta } from '../model-download-meta.util';
import type { UnregisterAiModelJobPayload } from '../publisher-job.contract';
import { MODEL_IN_USE, MODEL_STORE_CREDENTIAL_MISSING, ModelPublisherError, isNonRetryablePublisherError } from '../model-publisher.errors';

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    slug: 'gemma',
    tenantId: SYSTEM,
    version: 3,
    bucketPrefix: 'gemma/q4-0-abcdef012345/',
    availability: 'AVAILABLE',
    updatedBy: null as string | null,
    metaData: {
      unregister: {
        jobId: 'u-1',
        startedAt: '2026-09-29T10:00:00.000Z',
        deleteWeights: true,
        purge: false,
        finishedAt: null,
        error: null,
        weights: 'deleting',
      },
    } as Record<string, unknown>,
    markAvailability: vi.fn(function (this: { availability: string }, availability: string) {
      this.availability = availability;
    }),
    ...overrides,
  };
}

const payload = (overrides: Partial<UnregisterAiModelJobPayload> = {}): UnregisterAiModelJobPayload => ({
  kind: 'unregister',
  jobId: 'u-1',
  aiModelId: 'model-1',
  tenantId: SYSTEM,
  userId: 'admin-1',
  deleteWeights: true,
  purge: false,
  ...overrides,
});

describe('AiModelUnregisterService (P9)', () => {
  const repository = { findByIdOrNull: vi.fn(), findById: vi.fn(), findAll: vi.fn(), updateWithVersion: vi.fn(), softDelete: vi.fn() };
  const store = { deletePrefix: vi.fn() };
  const storeFactory = { create: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? SYSTEM : undefined)), exit: vi.fn((fn: () => unknown) => fn()) };
  const usage = { referrersOf: vi.fn() };
  let service: AiModelUnregisterService;
  let row: ReturnType<typeof modelRow>;

  beforeEach(() => {
    vi.clearAllMocks();
    row = modelRow();
    repository.findByIdOrNull.mockResolvedValue(row);
    repository.findById.mockResolvedValue(row);
    repository.findAll.mockResolvedValue([]);
    repository.updateWithVersion.mockImplementation(async (_id: string, entity: unknown) => entity);
    repository.softDelete.mockResolvedValue(row);
    storeFactory.create.mockResolvedValue(store);
    store.deletePrefix.mockResolvedValue({ objects: 4, versions: 0 });
    usage.referrersOf.mockResolvedValue([]);
    service = new AiModelUnregisterService(repository as never, storeFactory as never, usage as never, eventEmitter as never, cls as never);
  });

  it('keeps a prefix another live row still references: soft-deletes the row, never touches the bucket → kept-shared', async () => {
    repository.findAll.mockResolvedValue([{ id: 'model-2', bucketPrefix: 'gemma/q4-0-abcdef012345/' }]);

    const result = await service.execute(payload(), { finalAttempt: true });

    expect(result.weights).toBe('kept-shared');
    expect(storeFactory.create).not.toHaveBeenCalled();
    expect(store.deletePrefix).not.toHaveBeenCalled();
    expect(repository.softDelete).toHaveBeenCalledWith('model-1', 'admin-1');
    expect(row.markAvailability).not.toHaveBeenCalled();
    expect(readUnregisterMeta(row.metaData)).toMatchObject({ weights: 'kept-shared', error: null, finishedAt: expect.any(String) });
    // The sharing query excludes the row itself and looks at the prefix AND its ancestors.
    const where = repository.findAll.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: 'model-1' });
    expect(JSON.stringify(where)).toContain('gemma/q4-0-abcdef012345/');
  });

  it('sole owner: deletes the prefix with the requested purge, marks MISSING, soft-deletes, broadcasts ResourceDeleted', async () => {
    store.deletePrefix.mockResolvedValue({ objects: 4, versions: 9 });

    const result = await service.execute(payload({ purge: true }), { finalAttempt: true });

    expect(store.deletePrefix).toHaveBeenCalledWith('gemma/q4-0-abcdef012345/', { purge: true });
    expect(row.markAvailability).toHaveBeenCalledWith('MISSING', null);
    expect(repository.updateWithVersion).toHaveBeenCalledWith('model-1', row, 3);
    expect(repository.softDelete).toHaveBeenCalledWith('model-1', 'admin-1');
    // Bookkeeping lands BEFORE the soft delete (a deleted row is no longer writable through the scoped client).
    expect(repository.updateWithVersion.mock.invocationCallOrder[0]).toBeLessThan(repository.softDelete.mock.invocationCallOrder[0]);
    expect(readUnregisterMeta(row.metaData)).toMatchObject({ weights: 'deleted', deletedObjects: 4, deletedVersions: 9, purge: true, error: null });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceDeleted,
      expect.objectContaining({ resourceId: 'model-1', data: expect.objectContaining({ weights: 'deleted', purge: true }) }),
    );
    expect(result).toMatchObject({ aiModelId: 'model-1', weights: 'deleted', deletedObjects: 4, deletedVersions: 9 });
  });

  it('deletes the WHOLE repo directory of an HF-cache row (refs + every snapshot), not just its snapshot', async () => {
    row = modelRow({ bucketPrefix: 'hf/hub/models--blaze999--Medical-NER/snapshots/deadbeef/' });
    repository.findByIdOrNull.mockResolvedValue(row);
    repository.findById.mockResolvedValue(row);

    await service.execute(payload(), { finalAttempt: true });

    expect(store.deletePrefix).toHaveBeenCalledWith('hf/hub/models--blaze999--Medical-NER/', { purge: false });
  });

  it('deleteWeights=false keeps the weights, keeps availability, still unregisters the row → kept', async () => {
    const result = await service.execute(payload({ deleteWeights: false }), { finalAttempt: true });

    expect(result.weights).toBe('kept');
    expect(repository.findAll).not.toHaveBeenCalled();
    expect(storeFactory.create).not.toHaveBeenCalled();
    expect(row.markAvailability).not.toHaveBeenCalled();
    expect(repository.softDelete).toHaveBeenCalled();
  });

  it('a failure records the error and does NOT soft-delete (final attempt)', async () => {
    store.deletePrefix.mockRejectedValue(new Error('AccessDenied'));

    await expect(service.execute(payload(), { finalAttempt: true })).rejects.toThrow('AccessDenied');

    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
    expect(readUnregisterMeta(row.metaData)).toMatchObject({ error: 'AccessDenied', finishedAt: expect.any(String) });
  });

  it('a failure with retries left leaves the row UNREGISTERING (no error written) for the retry', async () => {
    store.deletePrefix.mockRejectedValue(new Error('timeout'));

    await expect(service.execute(payload(), { finalAttempt: false })).rejects.toThrow('timeout');

    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(readUnregisterMeta(row.metaData)).toMatchObject({ error: null, finishedAt: null });
  });

  it('I4 — a NON-retryable failure on the first attempt records the error and finishedAt (BullMQ will not retry it)', async () => {
    storeFactory.create.mockRejectedValue(new ModelPublisherError(MODEL_STORE_CREDENTIAL_MISSING, 'not set'));

    await expect(service.execute(payload(), { finalAttempt: false })).rejects.toThrow(/^MODEL_STORE_CREDENTIAL_MISSING/);

    expect(repository.softDelete).not.toHaveBeenCalled();
    expect(readUnregisterMeta(row.metaData)).toMatchObject({
      error: expect.stringMatching(/^MODEL_STORE_CREDENTIAL_MISSING/),
      finishedAt: expect.any(String),
    });
  });

  describe('I9 — referrers re-checked in the worker, before anything is deleted', () => {
    const referrer = { kind: 'agent', tenantId: 'tenant-a', id: 'agent-1', name: 'Scribe (scribe v3)' };

    it('a binding made after the gateway accepted the job: records MODEL_IN_USE, keeps the weights, never deletes, never soft-deletes', async () => {
      usage.referrersOf.mockResolvedValue([referrer]);

      const failure = await service.execute(payload(), { finalAttempt: false }).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ModelPublisherError);
      expect((failure as ModelPublisherError).code).toBe(MODEL_IN_USE);
      expect(isNonRetryablePublisherError(failure)).toBe(true);
      expect(storeFactory.create).not.toHaveBeenCalled();
      expect(store.deletePrefix).not.toHaveBeenCalled();
      expect(repository.softDelete).not.toHaveBeenCalled();
      expect(row.markAvailability).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.anything());
      expect(readUnregisterMeta(row.metaData)).toMatchObject({
        error: expect.stringMatching(/^MODEL_IN_USE: .*Scribe/),
        finishedAt: expect.any(String),
        weights: 'kept',
      });
    });

    it('re-checks even when the weights are kept (a soft-deleted row would still be referenced)', async () => {
      usage.referrersOf.mockResolvedValue([referrer]);

      await expect(service.execute(payload({ deleteWeights: false }), { finalAttempt: true })).rejects.toThrow(/^MODEL_IN_USE/);
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('reads usage ACROSS tenants — outside the job’s tenant-scoped CLS context — and before any store call', async () => {
      await service.execute(payload(), { finalAttempt: true });

      expect(cls.exit).toHaveBeenCalledTimes(1);
      expect(usage.referrersOf).toHaveBeenCalledWith(expect.objectContaining({ id: 'model-1' }));
      expect(usage.referrersOf.mock.invocationCallOrder[0]).toBeLessThan(storeFactory.create.mock.invocationCallOrder[0]);
    });
  });

  it('refuses a row owned by another tenant than the payload names', async () => {
    repository.findByIdOrNull.mockResolvedValue(modelRow({ tenantId: 'tenant-x' }));

    await expect(service.execute(payload(), { finalAttempt: true })).rejects.toThrow();
    expect(store.deletePrefix).not.toHaveBeenCalled();
  });
});

describe('deriveWeightsPrefix', () => {
  it.each([
    ['gemma/q4-0-abcdef012345/', 'gemma/q4-0-abcdef012345/'],
    ['hf/hub/models--o--n/snapshots/abc/', 'hf/hub/models--o--n/'],
    ['hf/hub/models--o--n/', 'hf/hub/models--o--n/'],
    ['slug/v1', 'slug/v1/'],
    [null, null],
    ['', null],
    ['/', null],
    ['hf/hub/', null],
  ])('%s → %s', (input, expected) => {
    expect(deriveWeightsPrefix(input as string | null)).toBe(expected);
  });
});
