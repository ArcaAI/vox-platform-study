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

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    tenantId: SYSTEM,
    version: 3,
    bucketPrefix: 'gemma/q4-0-abcdef012345/',
    availability: 'AVAILABLE',
    updatedBy: null as string | null,
    metaData: { unregister: { jobId: 'u-1', startedAt: '2026-09-29T10:00:00.000Z', deleteWeights: true, purge: false, finishedAt: null, error: null, weights: 'deleting' } } as Record<string, unknown>,
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
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? SYSTEM : undefined)) };
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
    service = new AiModelUnregisterService(repository as never, storeFactory as never, eventEmitter as never, cls as never);
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
