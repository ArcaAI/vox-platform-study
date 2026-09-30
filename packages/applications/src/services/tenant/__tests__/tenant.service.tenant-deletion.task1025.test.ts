/**
 * TASK-1025 G2 (owner decision OD-2) — deleting a tenant RETAINS its storage
 * (access cut immediately, objects kept); restoring it inside the retention
 * window restores access; after the purge, a restore must not pretend the data
 * exists.
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { ResourceStatusType, SysEventType, TenantFactory, type TenantEntity } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantService } from '../tenant.service';

const tenantRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
};
const tenantBucketService = {
  retainForTenantDeletion: vi.fn(),
  releaseTenantDeletionRetention: vi.fn(),
};
let clsTenant: string | null = 'working-tenant';
const cls = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : key === 'tenantId' ? clsTenant : null)),
  set: vi.fn((key: string, value: string | null) => {
    if (key === 'tenantId') clsTenant = value;
  }),
};
const events = { emit: vi.fn() };
const stub = {} as never;

function build(): TenantService {
  return new TenantService(tenantRepository as never, stub, stub, stub, stub, tenantBucketService as never, events as never, cls as never);
}

function tenant(): TenantEntity {
  const t = TenantFactory.CreateTenant({ name: 'Acme Health', key: 'ACME' });
  t.clearChanges();
  return t;
}

describe('TenantService — TASK-1025 G2 tenant deletion retains storage', () => {
  let service: TenantService;

  beforeEach(() => {
    vi.clearAllMocks();
    clsTenant = 'working-tenant';
    service = build();
  });

  describe('deleteById', () => {
    it('retains the tenant buckets (under the TARGET tenant context) BEFORE soft-deleting the tenant', async () => {
      const t = tenant();
      const order: string[] = [];
      tenantRepository.findById.mockResolvedValue(t);
      tenantBucketService.retainForTenantDeletion.mockImplementation(async (id: string) => {
        order.push(`retain:${id}:cls=${clsTenant}`);
        return 2;
      });
      tenantRepository.softDelete.mockImplementation(async () => {
        order.push('softDelete');
        return t;
      });

      await service.deleteById(t.id);

      expect(order).toEqual([`retain:${t.id}:cls=${t.id}`, 'softDelete']);
      expect(clsTenant).toBe('working-tenant');
    });

    it('does NOT delete the tenant when its buckets could not be retained', async () => {
      const t = tenant();
      tenantRepository.findById.mockResolvedValue(t);
      tenantBucketService.retainForTenantDeletion.mockRejectedValue(new Error('db down'));

      await expect(service.deleteById(t.id)).rejects.toThrow('db down');
      expect(tenantRepository.softDelete).not.toHaveBeenCalled();
    });

    it('gives bucket access back when the tenant soft-delete itself fails', async () => {
      const t = tenant();
      tenantRepository.findById.mockResolvedValue(t);
      tenantBucketService.retainForTenantDeletion.mockResolvedValue(2);
      tenantRepository.softDelete.mockRejectedValue(new Error('write conflict'));

      await expect(service.deleteById(t.id)).rejects.toThrow('write conflict');
      expect(tenantBucketService.releaseTenantDeletionRetention).toHaveBeenCalledWith(t.id);
    });

    it('records the retained-bucket count in the audit event', async () => {
      const t = tenant();
      tenantRepository.findById.mockResolvedValue(t);
      tenantBucketService.retainForTenantDeletion.mockResolvedValue(2);
      tenantRepository.softDelete.mockResolvedValue(t);

      await service.deleteById(t.id);

      expect(events.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({ data: expect.objectContaining({ storageRetainedBuckets: 2 }) }),
      );
    });
  });

  describe('restore of a DELETED tenant', () => {
    function deletedTenant(): TenantEntity {
      const t = tenant();
      t.delete();
      t.clearChanges();
      return t;
    }

    it('restores the tenant row and its retained buckets inside the retention window', async () => {
      const t = deletedTenant();
      tenantRepository.findById.mockRejectedValue(new DataNotFoundException('tenant', t.id));
      tenantRepository.findAll.mockResolvedValue([t]);
      tenantRepository.restore.mockImplementation(async () => t.enable());
      tenantBucketService.releaseTenantDeletionRetention.mockResolvedValue({ restored: 2, purged: 0 });

      await service.restore(t.id);

      expect(tenantRepository.findAll).toHaveBeenCalledWith({ filters: { id: t.id, resourceStatus: ResourceStatusType.DELETED } });
      expect(tenantRepository.restore).toHaveBeenCalledWith(t.id, 'admin-1');
      expect(tenantBucketService.releaseTenantDeletionRetention).toHaveBeenCalledWith(t.id);
      expect(events.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ restoredFromDeletion: true, storageRestoredBuckets: 2, storagePurged: false }) }),
      );
    });

    it('after the purge, restores the tenant but says its storage is gone (no bucket is brought back)', async () => {
      const t = deletedTenant();
      tenantRepository.findById.mockRejectedValue(new DataNotFoundException('tenant', t.id));
      tenantRepository.findAll.mockResolvedValue([t]);
      tenantRepository.restore.mockImplementation(async () => t.enable());
      tenantBucketService.releaseTenantDeletionRetention.mockResolvedValue({ restored: 0, purged: 2 });

      await service.restore(t.id);

      expect(events.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ storagePurged: true, storageRestoredBuckets: 0 }) }),
      );
    });

    it('still 404s an id that is neither live nor deleted', async () => {
      tenantRepository.findById.mockRejectedValue(new DataNotFoundException('tenant', 'nope'));
      tenantRepository.findAll.mockResolvedValue([]);

      await expect(service.restore('nope')).rejects.toBeInstanceOf(DataNotFoundException);
      expect(tenantRepository.restore).not.toHaveBeenCalled();
    });

    it('leaves the suspended/archived restore path unchanged (no storage calls)', async () => {
      const t = tenant();
      t.suspend();
      t.clearChanges();
      tenantRepository.findById.mockResolvedValue(t);
      tenantRepository.update.mockImplementation(async (_id: string, entity: TenantEntity) => entity);

      const result = await service.restore(t.id);

      expect(result.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(tenantBucketService.releaseTenantDeletionRetention).not.toHaveBeenCalled();
    });
  });
});
