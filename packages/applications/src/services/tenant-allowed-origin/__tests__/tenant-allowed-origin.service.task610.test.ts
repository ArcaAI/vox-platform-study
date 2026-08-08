/**
 * TenantAllowedOriginService unit tests (TASK-610, lane W2-B; updated for
 * lane W6-C's §4B many-to-many model).
 *
 * Mirrors the DepartmentService test conventions (mocked repository /
 * EventEmitter2 / ClsService). Beyond standard CRUD coverage, this suite
 * locks down the behaviors the ticket calls out explicitly:
 *
 *  - `normalizeOrigin()` runs BEFORE persistence on both create and update
 *    (never the raw string).
 *  - §4B — a row is a (origin, tenantId) GRANT, not an owned origin. Two
 *    DIFFERENT tenants registering the same origin is the POINT of the
 *    model and must SUCCEED as two independent grants; only the SAME tenant
 *    registering the SAME origin twice is a conflict, both via the
 *    per-tenant pre-check AND via the DB unique-constraint race
 *    (`findByOriginAndTenant` returns null but the write still collides on
 *    the (origin, tenantId) compound key).
 *  - Every successful mutation emits `origin-registry.invalidate` — the
 *    frozen invalidation contract W2-A's `OriginRegistryService` listens on
 *    (README §4.1). A failed mutation must NOT emit it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
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
  findByOriginAndTenant: vi.fn(),
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
          // TASK-641: the acting user is made EXPLICITLY `GLOBAL_ADMIN`.
          // Under TASK-610 this whole resource was global-admin-only at the
          // controller, so every scenario in this suite — including its
          // wildcard/allow-all cases — was already, implicitly, a global
          // admin acting. TASK-641 moves the wildcard boundary INTO the
          // service (FR-2), which makes that implicit assumption load-bearing
          // and therefore something the fixture must state. Role-DEPENDENT
          // behavior is covered by `tenant-allowed-origin.privilege.task641.test.ts`,
          // which drives a real `ClsService`; this suite stays about CRUD,
          // normalization and the invalidation contract.
          return { id: 'user-id-1', roles: ['GLOBAL_ADMIN'] };
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.create.mockResolvedValue(createMockEntity({ id: 'new-origin-id', origin: 'https://arcaai-staging.bcmch.org' }));

      await service.create({ origin: 'HTTPS://ArcaAI-Staging.bcmch.org:443/', label: 'ArcaAI staging' } as any);

      // Default port stripped + host lowercased + trailing slash dropped —
      // proves normalizeOrigin ran, and that the NORMALIZED form (not the
      // raw string) is what gets checked and persisted.
      expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('https://arcaai-staging.bcmch.org', 'tenant-1');
      const { TenantAllowedOriginFactory } = await import('@arcaai/domains');
      expect(TenantAllowedOriginFactory.CreateTenantAllowedOrigin).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'https://arcaai-staging.bcmch.org', tenantId: 'tenant-1' }),
      );
    });

    it('propagates ArgumentInvalidException for a malformed origin and never reaches the repository', async () => {
      await expect(service.create({ origin: 'not-a-valid-origin', label: 'Bad' } as any)).rejects.toThrow(ArgumentInvalidException);
      expect(mockRepository.findByOriginAndTenant).not.toHaveBeenCalled();
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a pre-existing duplicate with ConflictException (no factory / create call)', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(createMockEntity({ id: 'existing-origin' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.create).not.toHaveBeenCalled();
      expect(mockEventEmitter.emit).not.toHaveBeenCalledWith('origin-registry.invalidate', expect.anything());
    });

    it('rejects a check-then-write RACE (findByOriginAndTenant misses, DB unique constraint catches it) with ConflictException', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(null); // no soft-deleted row either — a genuine live collision
      mockRepository.create.mockRejectedValue(uniqueConstraintError());

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Race' } as any)).rejects.toThrow(
        "Origin 'https://arcaai-staging.bcmch.org' is already registered for this tenant.",
      );
    });

    it('re-throws a non-unique-constraint error from create() unchanged', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      const boom = new Error('boom');
      mockRepository.create.mockRejectedValue(boom);

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'X' } as any)).rejects.toBe(boom);
    });

    it('uses the factory (not `new`) and broadcasts ResourceCreated + emits origin-registry.invalidate on success', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
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

  // W4-R finding, re-scoped for §4B (lane W6-C): the compound unique index
  // on (origin, tenantId) is NOT partial, so a soft-deleted GRANT still
  // occupies that pair for the tenant that held it. `findByOriginAndTenant`
  // only sees ENABLED rows, so delete -> re-add BY THE SAME TENANT must
  // RESTORE the deleted row rather than reporting a conflict the admin list
  // cannot explain (the origin does not appear anywhere in that tenant's
  // list, yet a create is refused as "already registered"). All lookups in
  // this describe block default to `tenant-1` (the `beforeEach` CLS setup);
  // the cross-tenant variants below make the tenant mismatch explicit.
  describe('create — soft-deleted-origin restore', () => {
    it('create -> delete -> create again with the same origin succeeds and yields a usable row', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null); // no LIVE row on this origin
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(createMockEntity({ id: 'existing-origin', origin: 'https://arcaai-staging.bcmch.org' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.findFirst).not.toHaveBeenCalled();
      expect(mockRepository.restore).not.toHaveBeenCalled();
    });

    it('the conflict message for a LIVE duplicate is accurate ("already registered")', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(createMockEntity({ id: 'existing-origin', origin: 'https://arcaai-staging.bcmch.org' }));

      await expect(service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'Dup' } as any)).rejects.toThrow(
        "Origin 'https://arcaai-staging.bcmch.org' is already registered for this tenant.",
      );
    });

    it('the race backstop also restores when the P2002 collision turns out to be a soft-deleted row', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
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

    // Coordinator-directed follow-up (post-review, W5-E). Today the
    // tenant-scope Prisma extension already narrows `findFirst` (and every
    // other read on `TenantAllowedOrigin`, since the model is in
    // `TENANT_SCOPED_MODELS`) to the caller's own tenant, so this cannot
    // actually happen while `TenantAllowedOrigin` stays OUT of
    // `SYSTEM_SHARED_READ_MODELS`. These tests simulate a WIDENED read (e.g.
    // a future `SYSTEM_SHARED_READ_MODELS` addition) by mocking the
    // repository to return a row owned by a different tenant — the shape a
    // real widened read would produce — and assert the service-level
    // defense-in-depth check catches it independently of the extension.
    it('does NOT restore a soft-deleted row owned by ANOTHER tenant — treats it as a conflict, same as a live duplicate', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', tenantId: 'tenant-OTHER', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }),
      );

      await expect(service.create({ origin: 'https://x.bcmch.org', label: 'New label' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.restore).not.toHaveBeenCalled();
      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it('the conflict message for a cross-tenant soft-deleted collision is the same "already registered" message', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', tenantId: 'tenant-OTHER', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }),
      );

      await expect(service.create({ origin: 'https://x.bcmch.org', label: 'New label' } as any)).rejects.toThrow(
        "Origin 'https://x.bcmch.org' is already registered for this tenant.",
      );
    });

    it('the race backstop also refuses to restore a soft-deleted row owned by ANOTHER tenant', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', tenantId: 'tenant-OTHER', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }),
      );
      mockRepository.create.mockRejectedValue(uniqueConstraintError());

      await expect(service.create({ origin: 'https://x.bcmch.org', label: 'Recovered' } as any)).rejects.toThrow(ConflictException);
      expect(mockRepository.restore).not.toHaveBeenCalled();
    });

    it('still restores normally when the soft-deleted row IS owned by the caller tenant (no regression)', async () => {
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(
        createMockEntity({ id: 'origin-1', tenantId: 'tenant-1', origin: 'https://x.bcmch.org', resourceStatus: 'DELETED' }),
      );
      const restoredEntity: any = {
        ...createMockEntity({ id: 'origin-1', tenantId: 'tenant-1', origin: 'https://x.bcmch.org' }),
        hasChanges: true,
        changes: {},
      };
      mockRepository.restore.mockResolvedValue(restoredEntity);
      mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

      const result = await service.create({ origin: 'https://x.bcmch.org', label: 'Same tenant' } as any);

      expect(mockRepository.restore).toHaveBeenCalledWith('origin-1', 'user-id-1');
      expect(result.id).toBe('origin-1');
    });
  });

  // TASK-610 §4B, lane W6-C. The headline case this rewrite exists for: two
  // DIFFERENT tenants registering the SAME origin was IMPOSSIBLE under the
  // old global-unique-on-origin model (the second tenant's create 409'd).
  // Under the (origin, tenantId) compound key it must succeed as two
  // independent grants.
  describe('§4B many-to-many — origins shared across tenants', () => {
    const setActingTenant = (tenantId: string) => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: 'user-id-1' };
          case 'tenantId':
            return tenantId;
          default:
            return null;
        }
      });
    };

    it('tenant A creating an origin, then tenant B creating the SAME origin, both succeed as separate grants', async () => {
      // Tenant A: no live or soft-deleted grant of its own on this origin.
      setActingTenant('tenant-A');
      mockRepository.findByOriginAndTenant.mockResolvedValueOnce(null);
      mockRepository.findFirst.mockResolvedValueOnce(null);
      mockRepository.create.mockResolvedValueOnce(createMockEntity({ id: 'grant-a', tenantId: 'tenant-A', origin: 'http://localhost:5173' }));

      const resultA = await service.create({ origin: 'http://localhost:5173', label: 'Tenant A dev' } as any);

      expect(resultA.id).toBe('grant-a');
      expect(mockRepository.findByOriginAndTenant).toHaveBeenNthCalledWith(1, 'http://localhost:5173', 'tenant-A');

      // Tenant B: `findByOriginAndTenant`/`findFirst` are scoped to
      // `tenant-B`, so tenant A's row (live or deleted) is invisible to
      // this lookup — the create must proceed as an ORDINARY, independent
      // grant, never a conflict and never a restore of tenant A's row.
      setActingTenant('tenant-B');
      mockRepository.findByOriginAndTenant.mockResolvedValueOnce(null);
      mockRepository.findFirst.mockResolvedValueOnce(null);
      mockRepository.create.mockResolvedValueOnce(createMockEntity({ id: 'grant-b', tenantId: 'tenant-B', origin: 'http://localhost:5173' }));

      const resultB = await service.create({ origin: 'http://localhost:5173', label: 'Tenant B dev' } as any);

      expect(resultB.id).toBe('grant-b');
      expect(mockRepository.findByOriginAndTenant).toHaveBeenNthCalledWith(2, 'http://localhost:5173', 'tenant-B');
      // Two distinct rows, both resolved — no conflict was ever raised for
      // tenant B despite tenant A already holding a grant on this origin.
      expect(mockRepository.create).toHaveBeenCalledTimes(2);
      expect(resultA.id).not.toBe(resultB.id);
    });

    it('the SAME tenant registering the SAME origin twice is still a conflict, with the corrected per-tenant message', async () => {
      setActingTenant('tenant-A');
      mockRepository.findByOriginAndTenant.mockResolvedValue(
        createMockEntity({ id: 'grant-a', tenantId: 'tenant-A', origin: 'http://localhost:5173' }),
      );

      await expect(service.create({ origin: 'http://localhost:5173', label: 'Dup' } as any)).rejects.toThrow(
        "Origin 'http://localhost:5173' is already registered for this tenant.",
      );
      expect(mockRepository.create).not.toHaveBeenCalled();
    });

    it("a soft-deleted grant belonging to tenant A neither blocks nor gets restored by tenant B's create of the same origin", async () => {
      setActingTenant('tenant-B');
      // Scoped to tenant-B: both the live and the soft-deleted lookup are
      // parameterized with tenant-B's id, so tenant A's soft-deleted row is
      // structurally invisible here — this is a brand-new grant, not a
      // restore.
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.findFirst.mockResolvedValue(null);
      mockRepository.create.mockResolvedValue(createMockEntity({ id: 'grant-b', tenantId: 'tenant-B', origin: 'http://localhost:5173' }));

      const result = await service.create({ origin: 'http://localhost:5173', label: 'Tenant B dev' } as any);

      expect(mockRepository.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({ origin: 'http://localhost:5173', tenantId: 'tenant-B', resourceStatus: 'DELETED' }),
      });
      expect(mockRepository.restore).not.toHaveBeenCalled();
      expect(mockRepository.create).toHaveBeenCalled();
      expect(result.id).toBe('grant-b');
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(null);
      mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', origin: 'https://new.example.com', version: 4 }));

      await service.update('origin-1', { origin: 'HTTPS://New.Example.com:443/', expectedVersion: 3 } as any);

      expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('https://new.example.com', 'tenant-1');
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
      mockRepository.findByOriginAndTenant.mockResolvedValue(createMockEntity({ id: 'some-other-row', origin: 'https://taken.example.com' }));

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

      expect(mockRepository.findByOriginAndTenant).not.toHaveBeenCalled();
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

  // TASK-610 §4A.2/§4A.3, lane W5-E. Before this lane's change, `create()` and
  // `update()` ran every raw origin through `normalizeOrigin`, which rejects
  // any `*` outright — so a wildcard pattern or the allow-all token could
  // never be created through the admin API at all, only seeded. This suite
  // was watched RED against the pre-change service (a create with
  // `https://*.bcmch.org:*` threw `ArgumentInvalidException` from
  // `normalizeOrigin`, not because the pattern was invalid).
  describe('wildcard pattern + allow-all support (TASK-610 §4A.2/§4A.3, lane W5-E)', () => {
    describe('create — routes by shape', () => {
      it('accepts a wildcard pattern, normalizing via normalizeOriginPattern (not normalizeOrigin)', async () => {
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.findFirst.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'pattern-id', origin: 'https://*.bcmch.org:*' }));

        await service.create({ origin: 'HTTPS://*.BCMCH.ORG:*', label: 'BCMCH wildcard' } as any);

        // Case-folded to the canonical pattern form — proves normalizeOriginPattern
        // ran (normalizeOrigin would have thrown on the `*` before ever reaching here).
        expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('https://*.bcmch.org:*', 'tenant-1');
        const { TenantAllowedOriginFactory } = await import('@arcaai/domains');
        expect(TenantAllowedOriginFactory.CreateTenantAllowedOrigin).toHaveBeenCalledWith(
          expect.objectContaining({ origin: 'https://*.bcmch.org:*' }),
        );
      });

      it('accepts the bare allow-all token `*`', async () => {
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.findFirst.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'allow-all-id', origin: '*' }));

        const result = await service.create({ origin: '*', label: 'Global — any origin' } as any);

        expect(result.origin).toBe('*');
        expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('*', 'tenant-1');
      });

      it('rejects a malformed pattern with the same clean ArgumentInvalidException an invalid origin gets — never a raw/internal error', async () => {
        await expect(service.create({ origin: 'https://**.evil.com:*', label: 'Bad' } as any)).rejects.toThrow(ArgumentInvalidException);
        expect(mockRepository.findByOriginAndTenant).not.toHaveBeenCalled();
        expect(mockRepository.create).not.toHaveBeenCalled();
      });

      it('still routes a `*`-free origin through normalizeOrigin, unaffected by the pattern routing', async () => {
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'exact-id', origin: 'https://arcaai-staging.bcmch.org' }));

        await service.create({ origin: 'HTTPS://ArcaAI-Staging.bcmch.org:443/', label: 'Exact' } as any);

        expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('https://arcaai-staging.bcmch.org', 'tenant-1');
      });
    });

    describe('update — routes by shape', () => {
      it('re-normalizes a pattern origin via normalizeOriginPattern', async () => {
        const entity = createMockEntityWithChanges({
          id: 'origin-1',
          tenantId: 'tenant-1',
          origin: 'https://old.example.com',
          hasChanges: true,
          changes: { origin: 'https://*.bcmch.org:*' },
        });
        mockRepository.findById.mockResolvedValue(entity);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', origin: 'https://*.bcmch.org:*', version: 2 }));

        await service.update('origin-1', { origin: 'HTTPS://*.BCMCH.ORG:*', expectedVersion: 1 } as any);

        expect(mockRepository.findByOriginAndTenant).toHaveBeenCalledWith('https://*.bcmch.org:*', 'tenant-1');
      });

      it('rejects a malformed pattern on update with ArgumentInvalidException', async () => {
        const entity = createMockEntityWithChanges({ id: 'origin-1', tenantId: 'tenant-1' });
        mockRepository.findById.mockResolvedValue(entity);

        await expect(service.update('origin-1', { origin: 'https://**.evil.com:*', expectedVersion: 1 } as any)).rejects.toThrow(
          ArgumentInvalidException,
        );
        expect(mockRepository.updateWithVersion).not.toHaveBeenCalled();
      });
    });

    // README W5-E brief: "Log allow-all creation loudly ... when a mutation
    // creates or restores it." — greppable, not silently equivalent to
    // registering one more host.
    describe('allow-all creation is logged loudly', () => {
      it('warns naming the acting user and owning tenant when create() establishes the `*` row', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.findFirst.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'allow-all-id', tenantId: 'tenant-1', origin: '*' }));

        await service.create({ origin: '*', label: 'Global' } as any);

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-id-1' }));
        warnSpy.mockRestore();
      });

      it('does NOT warn when creating an ordinary exact origin', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'x', origin: 'https://arcaai-staging.bcmch.org' }));

        await service.create({ origin: 'https://arcaai-staging.bcmch.org', label: 'X' } as any);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('does NOT warn when creating a non-allow-all wildcard pattern', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.findFirst.mockResolvedValue(null);
        mockRepository.create.mockResolvedValue(createMockEntity({ id: 'pattern-id', origin: 'https://*.bcmch.org:*' }));

        await service.create({ origin: 'https://*.bcmch.org:*', label: 'BCMCH wildcard' } as any);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });

      it('warns when a soft-deleted `*` row is RESTORED via create()', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.findFirst.mockResolvedValue(
          createMockEntity({ id: 'allow-all-id', tenantId: 'tenant-1', origin: '*', resourceStatus: 'DELETED' }),
        );
        const restoredEntity: any = {
          ...createMockEntity({ id: 'allow-all-id', tenantId: 'tenant-1', origin: '*' }),
          hasChanges: true,
          changes: {},
        };
        mockRepository.restore.mockResolvedValue(restoredEntity);
        mockRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

        await service.create({ origin: '*', label: 'Global again' } as any);

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        warnSpy.mockRestore();
      });

      it('warns when update() changes an origin so the row BECOMES `*`', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const entity = createMockEntityWithChanges({
          id: 'origin-1',
          tenantId: 'tenant-1',
          origin: 'https://old.example.com',
          hasChanges: true,
          changes: { origin: '*' },
        });
        mockRepository.findById.mockResolvedValue(entity);
        mockRepository.findByOriginAndTenant.mockResolvedValue(null);
        mockRepository.updateWithVersion.mockResolvedValue(createMockEntity({ id: 'origin-1', tenantId: 'tenant-1', origin: '*', version: 2 }));

        await service.update('origin-1', { origin: '*', expectedVersion: 1 } as any);

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        warnSpy.mockRestore();
      });

      it('does NOT re-warn on an update that only changes the label of an ALREADY-allow-all row', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const entity = createMockEntityWithChanges({
          id: 'origin-1',
          tenantId: 'tenant-1',
          origin: '*',
          hasChanges: true,
          changes: { label: 'Renamed' },
        });
        mockRepository.findById.mockResolvedValue(entity);
        mockRepository.updateWithVersion.mockResolvedValue(
          createMockEntity({ id: 'origin-1', tenantId: 'tenant-1', origin: '*', label: 'Renamed', version: 2 }),
        );

        await service.update('origin-1', { label: 'Renamed', expectedVersion: 1 } as any);

        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });
  });
});
