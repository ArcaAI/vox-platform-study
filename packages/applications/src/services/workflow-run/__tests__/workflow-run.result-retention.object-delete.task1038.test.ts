/**
 * TASK-1038 E2 (fix 7) — the OD-25 purge removes a claim-checked result's OBJECT, not just the
 * pointer to it.
 *
 * Before: the purge tombstoned `WorkflowRun.resultRef` and left the object in the bucket, so the
 * PHI the retention window promised to remove stayed readable by anyone with storage access (and
 * metered). Now, for a `{ kind: 'ref' }` result, the purge deletes the object — best effort — and
 * only then writes the tombstone. It deletes ONLY when:
 *   - the key is under the run tenant's prefix `<tenantId>/` (a key outside it is not provably the
 *     tenant's and is never deleted on its behalf), and
 *   - no OTHER live run row of the tenant still references the same bucket + key (a
 *     content-addressed key may be shared within the tenant).
 * A failed delete never blocks the tombstone. The delete runs under the row tenant's CLS context,
 * so the storage provider resolves exactly as it did when the result was signed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunResultRetentionService } from '../workflow-run-result-retention.service';

const NOW = new Date('2026-10-04T04:45:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SHA = 'a'.repeat(64);

function refRow(id: string, tenantId: string, key: string) {
  return {
    id,
    tenantId,
    endedAt: new Date(NOW.getTime() - 40 * DAY),
    resultRef: { kind: 'ref', bucket: 'harness-claim-check', key, sizeBytes: 10, sha256: SHA },
    version: 2,
  };
}

function build(rows: ReturnType<typeof refRow>[], opts: { sharers?: number; deleteFails?: boolean } = {}) {
  const order: string[] = [];
  const repository = {
    findAll: vi.fn(async (props: { limit?: number }) => rows.splice(0, props.limit ?? rows.length)),
    count: vi.fn(async () => opts.sharers ?? 0),
    updateWithVersion: vi.fn(async (id: string, entity: unknown) => {
      order.push(`tombstone:${id}`);
      return entity;
    }),
  };
  const blobStorage = {
    deleteObject: vi.fn(async (params: { bucket: string; key: string }) => {
      order.push(`delete:${params.key}`);
      if (opts.deleteFails) throw new Error('storage down');
    }),
  };
  const tenantsSeen: string[] = [];
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      if (key === 'tenantId') tenantsSeen.push(value as string);
    }),
  };
  const settings = { resolve: vi.fn(() => ({ value: undefined })) };
  const service = new WorkflowRunResultRetentionService(repository as never, settings as never, undefined, blobStorage as never, cls as never);
  service.now = () => NOW;
  return { service, repository, blobStorage, order, tenantsSeen };
}

beforeEach(() => vi.clearAllMocks());

describe('purgeExpired — a claim-checked result’s object', () => {
  it('deletes the object under the tenant prefix FIRST, then writes the tombstone', async () => {
    const { service, blobStorage, order, tenantsSeen } = build([refRow('r1', 'tenant-a', 'tenant-a/runs/r1/result.json')]);
    const outcome = await service.purgeExpired();
    expect(outcome.expired).toBe(1);
    expect(blobStorage.deleteObject).toHaveBeenCalledWith({ bucket: 'harness-claim-check', key: 'tenant-a/runs/r1/result.json' });
    expect(order).toEqual(['delete:tenant-a/runs/r1/result.json', 'tombstone:r1']);
    expect(tenantsSeen).toContain('tenant-a');
  });

  it('never deletes a key outside the tenant prefix (legacy or foreign) — the tombstone is still written', async () => {
    const { service, blobStorage, repository } = build([refRow('r2', 'tenant-a', `sha256/${SHA}`), refRow('r3', 'tenant-a', 'tenant-b/x.json')]);
    const outcome = await service.purgeExpired();
    expect(outcome.expired).toBe(2);
    expect(blobStorage.deleteObject).not.toHaveBeenCalled();
    expect(repository.updateWithVersion).toHaveBeenCalledTimes(2);
  });

  it('keeps an object another live run of the tenant still references', async () => {
    const { service, blobStorage, repository } = build([refRow('r4', 'tenant-a', 'tenant-a/sha256/abc')], { sharers: 1 });
    await service.purgeExpired();
    expect(blobStorage.deleteObject).not.toHaveBeenCalled();
    const [countProps] = repository.count.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(JSON.stringify(countProps.where)).toContain('tenant-a/sha256/abc');
    expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('a failed delete is best effort: the tombstone is written anyway', async () => {
    const { service, repository } = build([refRow('r5', 'tenant-a', 'tenant-a/runs/r5/result.json')], { deleteFails: true });
    const outcome = await service.purgeExpired();
    expect(outcome.expired).toBe(1);
    expect(repository.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('an inline result has no object: nothing is deleted', async () => {
    const rows = [{ ...refRow('r6', 'tenant-a', 'unused'), resultRef: { kind: 'inline', value: { note: 'x' } } }] as never;
    const { service, blobStorage } = build(rows);
    await service.purgeExpired();
    expect(blobStorage.deleteObject).not.toHaveBeenCalled();
  });
});
