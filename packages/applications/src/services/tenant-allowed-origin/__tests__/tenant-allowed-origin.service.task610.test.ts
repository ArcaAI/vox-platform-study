/**
 * TenantAllowedOriginService unit tests (TASK-610, lane W2-B).
 *
 * Mirrors the DepartmentService test conventions (mocked repository /
 * EventEmitter2 / ClsService). Beyond standard CRUD coverage, this suite
 * locks down the three behaviors the ticket calls out explicitly:
 *
 *  - `normalizeOrigin()` runs BEFORE persistence on both create and update
 *    (never the raw string).
 *  - A duplicate origin is rejected cleanly (409) both via the pre-check
 *    AND via the DB unique-constraint race (`findByOrigin` returns null but
 *    the write still collides).
 *  - Every successful mutation emits `origin-registry.invalidate` — the
 *    frozen invalidation contract W2-A's `OriginRegistryService` listens on
 *    (README §4.1). A failed mutation must NOT emit it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { SysEventType } from '@arcaai/domains';
import { TenantAllowedOriginService } from '../tenant-allowed-origin.service';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockRepository = {
  findAll: vi.fn(),
  findById: vi.fn(),
  findByOrigin: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  restore: vi.fn(),
  softDelete: vi.fn(),
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    TenantAllowedOriginFactory: {
      CreateTenantAllowedOrigin: vi.fn((data) => ({
        ...data,
        id: 'new-origin-id',
        createdAt: new Date('2026-08-04T00:00:00Z'),
        updatedAt: new Date('2026-08-04T00:00:00Z'),
        version: 1,
      })),
    },
  };
});

const createMockEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    origin: string;
    label: string;
    description: string | null;
    resourceStatus: string;
    createdAt: Date;
    updatedAt: Date;
    version: number;
  }> = {},
) => ({
  id: overrides.id ?? 'origin-id-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  origin: overrides.origin ?? 'https://arcaai-staging.bcmch.org',
  label: overrides.label ?? 'ArcaAI staging',
  description: overrides.description ?? null,
  resourceStatus: overrides.resourceStatus ?? 'ENABLED',
  createdAt: overrides.createdAt ?? new Date('2026-08-04T00:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-08-04T00:00:00Z'),
  version: overrides.version ?? 1,
});

// Update-path helper — mirrors `createMockDepartmentEntityWithChanges`: a
// plain object, so `hasChanges`/`changes` are pre-configured by the test
// rather than computed by real BaseEntity change tracking.
const createMockEntityWithChanges = (
  overrides: {
    id?: string;
    tenantId?: string;
    hasChanges?: boolean;
    changes?: Record<string, unknown>;
    version?: number;
    origin?: string;
  } = {},
) => {
  const base = createMockEntity({ id: overrides.id, tenantId: overrides.tenantId, version: overrides.version, origin: overrides.origin });
  return {
    ...base,
    hasChanges: overrides.hasChanges ?? true,
    changes: overrides.changes ?? {},
    toObject() {
      return { ...base, hasChanges: this.hasChanges, changes: this.changes };
    },
  };
};

/** Structurally mimics a Prisma unique-constraint violation (P2002). */
const uniqueConstraintError = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('TenantAllowedOriginService', () => {
  let service: TenantAllowedOriginService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'user-id-1' };
        case 'tenantId':
          return 'tenant-1';
        case 'correlationId':
          return 'corr-123';
        case 'requestIp':
          return '192.168.1.1';
        default:
          return null;
      }
    });

    service = new TenantAllowedOriginService(mockRepository as any, mockEventEmitter as any, mockClsService as any);
  });

  describe('getAll', () => {
    it('throws BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : { id: 'user-id-1' }));

      await expect(service.getAll()).rejects.toThrow(BadRequestException);
    });

    it('lists rows mapped to response DTOs', async () => {
      mockRepository.findAll.mockResolvedValue([createMockEntity({ id: 'origin-1' }), createMockEntity({ id: 'origin-2' })]);

      const result = await service.getAll();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('origin-1');
      expect(result[0].origin).toBe('https://arcaai-staging.bcmch.org');
      expect(result[0].isPlatform).toBe(false);
    });
  });

  describe('getById', () => {
    it('throws NotFoundException when the row does not exist', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(service.getById('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException (not Forbidden) on cross-tenant access — no existence leak', async () => {
      mockRepository.findById.mockResolvedValue(createMockEntity({ id: 'origin-1', tenantId: 'tenant-OTHER' }));

      await expect(service.getById('origin-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the mapped row for a same-tenant id', async () => {
      mockRepository.findById.mockResolvedValue(createMockEntity({ id: 'origin-1', tenantId: 'tenant-1' }));

      const result = await service.getById('origin-1');

      expect(result.id).toBe('origin-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'origin-1' }));
    });
  });

  describe('create', () => {
    it('normalizes the raw origin BEFORE checking for a duplicate and persisting', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.create.mockResolvedValue(createMockEntity({ id: 'new-origin-id', origin: 'https://arcaai-staging.bcmch.org' }));

      await service.create({ origin: 'HTTPS://ArcaAI-Staging.bcmch.org:443/', label: 'ArcaAI staging' } as any);

      // Default port stripped + host lowercased + trailing slash dropped —
      // proves normalizeOrigin ran, and that the NORMALIZED form (not the
      // raw string) is what gets checked and persisted.
      expect(mockRepository.findByOrigin).toHaveBeenCalledWith('https://arcaai-staging.bcmch.org');
      const { TenantAllowedOriginFactory } = await import('@arcaai/domains');
      expect(TenantAllowedOriginFactory.CreateTenantAllowedOrigin).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'https://arcaai-staging.bcmch.org', tenantId: 'tenant-1' }),
      );
    });

    it('propagates ArgumentInvalidException for a malformed origin and never reaches the repository', async () => {
      await expect(service.create({ origin: 'not-a-valid-origin', label: 'Bad' } as any)).rejects.toThrow(ArgumentInvalidException);
      expect(mockRepository.findByOrigin).not.toHaveBeenCalled();
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a pre-existing duplicate with ConflictException (no factory / create call)', async () => {
      mockRepository.findByOrigin.mockResolvedValue(createMockEntity({ id: 'existing-origin' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.create).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('origin-registry.invalidate', expect.anything());
    });

    it('rejects a check-then-write RACE (findByOrigin misses, DB unique constraint catches it) with ConflictException', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(null); // no soft-deleted row either — a genuine live collision
      mockRepository.create.mockRejectedValue(uniqueConstraintError());

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Race' } as any)).rejects.toThrow(
        "Origin 'https://arcaai-staging.bcmch.org' is already registered.",
      );
    });

    it('re-throws a non-unique-constraint error from create() unchanged', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      const boom = new Error('boom');
      mockRepository.create.mockRejectedValue(boom);

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'X' } as any)).rejects.toBe(boom);
    });

    it('uses the factory (not `new`) and broadcasts ResourceCreated + emits origin-registry.invalidate on success', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      const saved = createMockEntity({ id: 'new-origin-id' });
      mockRepository.create.mockResolvedValue(saved);

      const result = await service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'ArcaAI staging' } as any);

      const { TenantAllowedOriginFactory } = await import('@arcaai/domains');
      expect(TenantAllowedOriginFactory.CreateTenantAllowedOrigin).toHaveBeenCalled();
      expect(result.id).toBe('new-origin-id');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: 'new-origin-id' }));
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('origin-registry.invalidate');
    });

    it('throws BadRequestException when tenant ID is not available', async () => {
      mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? null : { id: 'user-id-1' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'X' } as any)).rejects.toThrow(BadRequestException);
    });
  });

  // W4-R finding: the global unique index on `origin` is NOT partial, so a
  // soft-deleted row still occupies the value. `findByOrigin` only sees
  // ENABLED rows, so delete -> re-add must RESTORE the deleted row rather
  // than reporting a conflict the admin list cannot explain (the origin
  // does not appear anywhere, yet a create is refused as "already
  // registered").
  describe('create — soft-deleted-origin restore', () => {
    it('create -> delete -> create again with the same origin succeeds and yields a usable row', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null); // no LIVE row on this origin
      const deletedRow = createMockEntity({
        id: 'origin-1',
        origin: 'https://x.bcmch.org',
        label: 'Old label',
        description: 'old note',
        resourceStatus: 'DELETED',
        version: 2,
      });
      mockRepository.findFirst.mockResolvedValue(deletedRow);
      const restoredEntity: any = {
        ...createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', resourceStatus: 'ENABLED', version: 3 }),
        hasChanges: true,
        changes: {},
      };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await service.create({ origin: 'https://x.bcmch.org', label: 'New label', description: 'new note' } as any);

      expect(mockRepository.create).not.toHaveBeenCalled();
      expect(mockRepository.restore).toHaveBeenCalledWith('origin-1', 'user-id-1');
      expect(mockRepository.update).toHaveBeenCalled();
      expect(result.id).toBe('origin-1');
      expect(result.origin).toBe('https://x.bcmch.org');
    });

    it('the restored row carries the NEW label/description, not the old ones', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', label: 'Old label', description: 'old note', resourceStatus: 'DELETED' }),
      );
      const restoredEntity: any = {
        ...createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', label: 'Old label', description: 'old note' }),
        hasChanges: true,
        changes: {},
      };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      await service.create({ origin: 'https://x.bcmch.org', label: 'New label', description: 'new note' } as any);

      const persisted = mockRepository.update.mock.calls[0][1];
      expect(persisted.label).toBe('New label');
      expect(persisted.description).toBe('new note');
    });

    it('an omitted description on re-add CLEARS the old note rather than carrying it forward', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', description: 'old note', resourceStatus: 'DELETED' }),
      );
      const restoredEntity: any = {
        ...createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', description: 'old note' }),
        hasChanges: true,
        changes: {},
      };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      await service.create({ origin: 'https://x.bcmch.org', label: 'New label' } as any);

      const persisted = mockRepository.update.mock.calls[0][1];
      expect(persisted.description).toBeNull();
    });

    it('restore broadcasts ResourceCreated and emits origin-registry.invalidate', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }));
      const restoredEntity: any = { ...createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org' }), hasChanges: true, changes: {} };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      await service.create({ origin: 'https://x.bcmch.org', label: 'X' } as any);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({ resourceId: 'origin-1', data: expect.objectContaining({ revivedFromDeleted: true }) }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('origin-registry.invalidate');
    });

    it('creating an origin that collides with a LIVE row still raises the conflict (no restore attempted)', async () => {
      mockRepository.findByOrigin.mockResolvedValue(createMockEntity({ id: 'existing-origin', origin: 'https://arcaai-staging.bcmch.org' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.findFirst).not.toHaveBeenCalled();
      expect(mockRepository.restore).not.toHaveBeenCalled();
    });

    it('the conflict message for a LIVE duplicate is accurate ("already registered")', async () => {
      mockRepository.findByOrigin.mockResolvedValue(createMockEntity({ id: 'existing-origin', origin: 'https://arcaai-staging.bcmch.org' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(
        "Origin 'https://arcaai-staging.bcmch.org' is already registered.",
      );
    });

    it('the race backstop also restores when the P2002 collision turns out to be a soft-deleted row', async () => {
      mockRepository.findByOrigin.mockResolvedValue(null);
      // First lookup (pre-check) misses; a concurrent delete lands, so the
      // create() write 409s; the retry lookup then finds the now-deleted row.
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }),
      );
      mockRepository.create.mockRejectedValue(uniqueConstraintError());
      const restoredEntity: any = { ...createMockEntity({ id: 'origin-1', origin: 'https://x.bcmch.org' }), hasChanges: true, changes: {} };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await service.create({ origin: 'https://x.bcmch.org', label: 'Recovered' } as any);

      expect(mockRepository.restore).toHaveBeenCalledWith('origin-1', 'user-id-1');
      expect(result.id).toBe('origin-1');
    });
  });

  describe('update', () => {
    it('throws NotFoundException when the row does not exist', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(service.update('missing-id', { label: 'New', expectedVersion: 1 } as any)).rejects.toThrow(NotFoundException);
      expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (not Forbidden) on cross-tenant access', async () => {
      const entity = createMockEntityWithChanges({ id: 'origin-1', tenantId: 'tenant-OTHER' });
      mockRepository.findById.mockResolvedValue(entity);

      await expect(service.update('origin-1', { label: 'New', expectedVersion: 1 } as any)).rejects.toThrow(NotFoundException);
      expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('origin-registry.invalidate', expect.anything());
    });

    it('re-normalizes `origin` when the DTO changes it', async () => {
      const entity = createMockEntityWithChanges({
        id: 'origin-1',
        tenantId: 'tenant-1',
        version: 3,
        origin: 'https://old.example.com',
        hasChanges: true,
        changes: { origin: 'https://new.example.com' },
      });
      mockRepository.findById.mockResolvedValue(entity);
      mockRepository.findByOrigin.mockResolvedValue(null);
      mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', origin: 'https://new.example.com', version: 4 }));

      await service.update('origin-1', { origin: 'HTTPS://New.Example.com:443/', expectedVersion: 3 } as any);

      expect(mockRepository.findByOrigin).toHaveBeenCalledWith('https://new.example.com');
    });

    it('rejects a re-normalized origin that collides with ANOTHER row', async () => {
      const entity = createMockEntityWithChanges({
        id: 'origin-1',
        tenantId: 'tenant-1',
        origin: 'https://old.example.com',
        hasChanges: true,
        changes: { origin: 'https://taken.example.com' },
      });
      mockRepository.findById.mockResolvedValue(entity);
      mockRepository.findByOrigin.mockResolvedValue(createMockEntity({ id: 'some-other-row', origin: 'https://taken.example.com' }));

      await expect(service.update('origin-1', { origin: 'https://taken.example.com', expectedVersion: 1 } as any)).rejects.toThrow(
        ConflictException,
      );
      expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('does NOT duplicate-check when `origin` in the DTO normalizes to the row unchanged value', async () => {
      const entity = createMockEntityWithChanges({
        id: 'origin-1',
        tenantId: 'tenant-1',
        origin: 'https://arcaai-staging.bcmch.org',
        hasChanges: true,
        changes: { label: 'Renamed' },
      });
      mockRepository.findById.mockResolvedValue(entity);
      mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', version: 2 }));

      await service.update('origin-1', { origin: 'https://arcaai-staging.bcmch.org', label: 'Renamed', expectedVersion: 1 } as any);

      expect(mockRepository.findByOrigin).not.toHaveBeenCalled();
    });

    it('throws ArgumentInvalidException when there are no changes to write', async () => {
      const entity = createMockEntityWithChanges({ id: 'origin-1', tenantId: 'tenant-1', hasChanges: false });
      mockRepository.findById.mockResolvedValue(entity);

      await expect(service.update('origin-1', { label: 'Same', expectedVersion: 1 } as any)).rejects.toThrow(ArgumentInvalidException);
      expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
    });

    it('routes through updateWithVersion, broadcasts ResourceUpdated with previous/new version, and emits origin-registry.invalidate', async () => {
      const entity = createMockEntityWithChanges({
        id: 'origin-1',
        tenantId: 'tenant-1',
        version: 4,
        hasChanges: true,
        changes: { label: 'Renamed' },
      });
      mockRepository.findById.mockResolvedValue(entity);
      mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', label: 'Renamed', version: 5 }));

      const result = await service.update('origin-1', { label: 'Renamed', expectedVersion: 4 } as any);

      expect(result.id).toBe('origin-1');
      expect(mockRepository.updateWithVersion).toHaveBeenCalledWith('origin-1', entity, 4);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({ resourceId: 'origin-1', data: expect.objectContaining({ previousVersion: 4, newVersion: 5 }) }),
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('origin-registry.invalidate');
    });

    it('propagates OptimisticConcurrencyException on version drift and does NOT emit the invalidation event', async () => {
      const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
      const entity = createMockEntityWithChanges({ id: 'origin-1', tenantId: 'tenant-1', version: 4, hasChanges: true, changes: { label: 'X' } });
      mockRepository.findById.mockResolvedValue(entity);
      const occErr = new OptimisticConcurrencyException('TenantAllowedOrigin', 'origin-1', { expectedVersion: 4, currentVersion: 5 });
      mockRepository.updateWithVersion.mockRejectedValue(occErr);

      await expect(service.update('origin-1', { label: 'X', expectedVersion: 4 } as any)).rejects.toBe(occErr);
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('origin-registry.invalidate', expect.anything());
    });
  });

  describe('deleteById', () => {
    it('throws NotFoundException when the row does not exist', async () => {
      mockRepository.findById.mockResolvedValue(null);

      await expect(service.deleteById('missing-id')).rejects.toThrow(NotFoundException);
      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (not Forbidden) on cross-tenant access', async () => {
      mockRepository.findById.mockResolvedValue(createMockEntity({ id: 'origin-1', tenantId: 'tenant-OTHER' }));

      await expect(service.deleteById('origin-1')).rejects.toThrow(NotFoundException);
      expect(mockRepository.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes, broadcasts ResourceDeleted, and emits origin-registry.invalidate', async () => {
      mockRepository.findById.mockResolvedValue(createMockEntity({ id: 'origin-1', tenantId: 'tenant-1' }));
      const deleted = createMockEntityWithChanges({ id: 'origin-1', tenantId: 'tenant-1', resourceStatus: 'DELETED' } as any);
      mockRepository.softDelete.mockResolvedValue(deleted);

      const result = await service.deleteById('origin-1');

      expect(result.id).toBe('origin-1');
      expect(mockRepository.softDelete).toHaveBeenCalledWith('origin-1', 'user-id-1');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceDeleted, expect.objectContaining({ resourceId: 'origin-1' }));
      expect(mockEventEmitter.emit).toHaveBeenCalledWith('origin-registry.invalidate');
    });
  });
});
