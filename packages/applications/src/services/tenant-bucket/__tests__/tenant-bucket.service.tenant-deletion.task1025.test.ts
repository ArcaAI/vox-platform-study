/**
 * TASK-1025 G2 (owner decision OD-2) — deleting a tenant RETAINS its buckets
 * with access cut; restoring it inside the retention window gives them back.
 *
 * Row states (no schema change): ENABLED → ARCHIVED on tenant delete (objects
 * kept, every data-plane path refuses the row) → ENABLED on tenant restore.
 * The purge job takes ARCHIVED → SUSPENDED (purge in progress, never
 * restorable) → DELETED.
 */
import { NotFoundException } from '@nestjs/common';
import { ResourceStatusType, SysEventType, TenantBucketFactory } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantBucketService } from '../tenant-bucket.service';

const repo = {
  findAllByTenant: vi.fn(),
  findAll: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
};
const tenantRepo = { findById: vi.fn() };
const blob = {
  bucketExists: vi.fn(),
  createBucket: vi.fn(),
  listObjects: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  presignGet: vi.fn(),
};
const s3 = { setBucketPolicy: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

function row(slug: string, status: ResourceStatusType, system = true) {
  const entity = system
    ? TenantBucketFactory.CreateSystemBucket('tenant-1', 'acme', slug)
    : TenantBucketFactory.CreateCustomBucket('tenant-1', 'acme', slug);
  if (status === ResourceStatusType.ARCHIVED) entity.archive();
  if (status === ResourceStatusType.DISABLED) entity.disable();
  if (status === ResourceStatusType.SUSPENDED) entity.suspend();
  entity.clearChanges();
  return entity;
}

describe('TenantBucketService — TASK-1025 G2 tenant-deletion retention', () => {
  let service: TenantBucketService;

  beforeEach(() => {
    vi.clearAllMocks();
    cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'admin-1' } : null));
    repo.update.mockImplementation(async (_id: string, entity: unknown) => entity);
    repo.findAll.mockResolvedValue([]);
    blob.bucketExists.mockResolvedValue(true);
    service = new TenantBucketService(repo as never, tenantRepo as never, blob as never, s3 as never, events as never, cls as never);
  });

  describe('retainForTenantDeletion', () => {
    it('moves every ENABLED bucket row of the tenant to ARCHIVED and leaves the objects alone', async () => {
      const attachments = row('attachments', ResourceStatusType.ENABLED);
      const recordings = row('recordings', ResourceStatusType.ENABLED);
      repo.findAllByTenant.mockResolvedValue([attachments, recordings]);

      const retained = await service.retainForTenantDeletion('tenant-1');

      expect(retained).toBe(2);
      expect(repo.findAllByTenant).toHaveBeenCalledWith('tenant-1', { includeDisabled: true });
      expect(repo.update).toHaveBeenCalledTimes(2);
      for (const [, entity] of repo.update.mock.calls) {
        expect((entity as { resourceStatus: string }).resourceStatus).toBe(ResourceStatusType.ARCHIVED);
      }
      expect(blob.listObjects).not.toHaveBeenCalled();
    });

    it('leaves a DISABLED row as it is (restore must not turn it on)', async () => {
      repo.findAllByTenant.mockResolvedValue([row('attachments', ResourceStatusType.ENABLED), row('old', ResourceStatusType.DISABLED, false)]);

      await service.retainForTenantDeletion('tenant-1');

      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('broadcasts a ResourceUpdated sys-event per retained bucket', async () => {
      repo.findAllByTenant.mockResolvedValue([row('attachments', ResourceStatusType.ENABLED)]);

      await service.retainForTenantDeletion('tenant-1');

      expect(events.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ resourceStatus: ResourceStatusType.ARCHIVED, reason: 'tenant-deleted' }) }),
      );
    });
  });

  describe('releaseTenantDeletionRetention', () => {
    it('re-enables every ARCHIVED row and reports nothing purged', async () => {
      repo.findAllByTenant.mockResolvedValue([row('attachments', ResourceStatusType.ARCHIVED), row('recordings', ResourceStatusType.ARCHIVED)]);

      const outcome = await service.releaseTenantDeletionRetention('tenant-1');

      expect(outcome).toEqual({ restored: 2, purged: 0 });
      for (const [, entity] of repo.update.mock.calls) {
        expect((entity as { resourceStatus: string }).resourceStatus).toBe(ResourceStatusType.ENABLED);
      }
    });

    it('never restores a bucket the purge has started on (SUSPENDED) or finished (DELETED) — and says so', async () => {
      repo.findAllByTenant.mockResolvedValue([row('attachments', ResourceStatusType.SUSPENDED)]);
      repo.findAll.mockResolvedValue([row('recordings', ResourceStatusType.ENABLED)]); // the explicit DELETED-row lookup

      const outcome = await service.releaseTenantDeletionRetention('tenant-1');

      expect(outcome).toEqual({ restored: 0, purged: 2 });
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.findAll).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-1', resourceStatus: ResourceStatusType.DELETED } });
    });
  });

  describe('data-plane refusal of a retained or purging bucket', () => {
    for (const status of [ResourceStatusType.ARCHIVED, ResourceStatusType.SUSPENDED]) {
      it(`404s every object path on a ${status} bucket without touching storage`, async () => {
        repo.findById.mockResolvedValue(row('recordings', status));

        await expect(service.listObjects('b')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.getBucketTree('b')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.uploadObject('b', 'k.wav', Buffer.from('x'))).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.deleteObject('b', 'k.wav')).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.getPresignedUrl('b', 'k.wav')).rejects.toBeInstanceOf(NotFoundException);

        expect(blob.listObjects).not.toHaveBeenCalled();
        expect(blob.putObject).not.toHaveBeenCalled();
        expect(blob.deleteObject).not.toHaveBeenCalled();
        expect(blob.presignGet).not.toHaveBeenCalled();
        expect(blob.createBucket).not.toHaveBeenCalled();
      });
    }

    it('still serves an ENABLED bucket', async () => {
      repo.findById.mockResolvedValue(row('recordings', ResourceStatusType.ENABLED));
      blob.listObjects.mockResolvedValue({ objects: [], isTruncated: false });

      await expect(service.listObjects('b')).resolves.toEqual([]);
    });
  });
});
