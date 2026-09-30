/**
 * TASK-1025 G2 (owner decisions OD-2 + OD-4, 2026-09-30) — deleting a tenant
 * RETAINS its storage (access cut immediately, objects kept) for the retention
 * window (default 45 days). Inside the window a platform admin can restore the
 * tenant WITH all its data; once the window has passed — or any of its buckets
 * has been purged — the tenant can no longer be restored at all (409).
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { ResourceStatusType, SysEventType, TenantFactory, type TenantEntity } from '@arcaai/domains';
import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  countPurgedForTenantDeletion: vi.fn(),
};
let retentionSetting: unknown = undefined;
const appSettings = {
  getValueWithDefault: vi.fn((_key: string, fallback: unknown) => (retentionSetting === undefined ? fallback : retentionSetting)),
};
const DAY_MS = 86_400_000;
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
  return new TenantService(
    tenantRepository as never,
    stub,
    stub,
    stub,
    stub,
    tenantBucketService as never,
    events as never,
    cls as never,
    undefined,
    undefined,
    undefined,
    undefined,
    appSettings as never,
  );
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

    const T0 = new Date('2026-09-01T00:00:00Z');

    function deletedAt(daysAgo: number): TenantEntity {
      vi.setSystemTime(new Date(T0.getTime() - daysAgo * DAY_MS));
      const t = deletedTenant();
      vi.setSystemTime(T0);
      return t;
    }

    function arrange(t: TenantEntity, purged = 0): void {
      tenantRepository.findById.mockRejectedValue(new DataNotFoundException('tenant', t.id));
      tenantRepository.findAll.mockResolvedValue([t]);
      tenantRepository.restore.mockImplementation(async () => t.enable());
      tenantBucketService.countPurgedForTenantDeletion.mockResolvedValue(purged);
      tenantBucketService.releaseTenantDeletionRetention.mockResolvedValue({ restored: 2, purged: 0 });
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
      retentionSetting = undefined;
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('restores the tenant row and ALL its retained buckets inside the retention window', async () => {
      const t = deletedAt(44);
      arrange(t);

      await service.restore(t.id);

      expect(tenantRepository.findAll).toHaveBeenCalledWith({ filters: { id: t.id, resourceStatus: ResourceStatusType.DELETED } });
      expect(tenantRepository.restore).toHaveBeenCalledWith(t.id, 'admin-1');
      expect(tenantBucketService.releaseTenantDeletionRetention).toHaveBeenCalledWith(t.id);
      expect(events.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ data: expect.objectContaining({ restoredFromDeletion: true, storageRestoredBuckets: 2 }) }),
      );
    });

    it('refuses (409) once the 45-day default window has passed, even before the purge job has run', async () => {
      const t = deletedAt(45);
      arrange(t, 0);

      await expect(service.restore(t.id)).rejects.toBeInstanceOf(ConflictException);
      expect(tenantRepository.restore).not.toHaveBeenCalled();
      expect(tenantBucketService.releaseTenantDeletionRetention).not.toHaveBeenCalled();
    });

    it('reads the window from storage.tenantDeletion.retentionDays', async () => {
      retentionSetting = 60;
      const t = deletedAt(50);
      arrange(t);

      await service.restore(t.id);

      expect(appSettings.getValueWithDefault).toHaveBeenCalledWith('storage.tenantDeletion.retentionDays', 45);
      expect(tenantRepository.restore).toHaveBeenCalled();
    });

    it('refuses (409) inside the window when any of its buckets has already been purged', async () => {
      const t = deletedAt(10);
      arrange(t, 1);

      await expect(service.restore(t.id)).rejects.toBeInstanceOf(ConflictException);
      expect(tenantRepository.restore).not.toHaveBeenCalled();
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
