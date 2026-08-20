/**
 * RbacRoleRepository / RbacRoleFactory /
 * RbacRoleEntityMapper unit tests.
 *
 * Pinned behaviour (mirrors the Prisma calls inlined in the legacy
 * `RbacRoleService` so the W6 RBAC E2E suite stays green):
 *
 *   • `findMany`/`count` are pass-through.
 *   • `findByIdWithPolicies` encapsulates the verbatim
 *     `ROLE_POLICIES_INCLUDE` shape that used to live as a static on
 *     `RbacRoleService` — `RolePolicies` filtered to ENABLED, with
 *     `Policy` projected to `{ id, name }`, ordered by `priority asc`.
 *   • `findByIdGuardSelect(id)` returns `{ isSystemRole, name }` for the
 *     system-role-guard pre-check used by update/patch/softDelete (three
 *     callsites — see README §4.1 inventory).
 *   • Parent / cycle-walk helpers expose narrow `select` projections so
 *     the service-level `validateParentRole` stays free of inline
 *     Prisma calls.
 *   • `softDelete` flips `resourceStatus → DELETED` and stamps audit
 *     fields (already soft in the legacy code).
 */
import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType } from '../../../enums';
import { RbacRoleFactory } from '../RbacRoleFactory';
import { mapRoleRowToRecord, ROLE_POLICIES_INCLUDE } from '../RbacRoleEntityMapper';
import { RbacRoleRepository } from '../RbacRoleRepository';

function makePrismaMock() {
  return {
    role: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

function makeRepo() {
  const prisma = makePrismaMock();
  const databaseService = { client: prisma };
  const repo = new RbacRoleRepository(databaseService as never);
  return { repo, prisma };
}

describe('RbacRoleRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findMany', () => {
    it('forwards args to client.role.findMany verbatim', async () => {
      const { repo, prisma } = makeRepo();
      const args = {
        where: { resourceStatus: ResourceStatusType.ENABLED },
        skip: 5,
        take: 5,
        include: ROLE_POLICIES_INCLUDE,
        orderBy: { name: 'asc' as const },
      };
      const rows = [{ id: 'role-1' }];
      prisma.role.findMany.mockResolvedValue(rows);

      const result = await repo.findMany(args);

      expect(prisma.role.findMany).toHaveBeenCalledWith(args);
      expect(result).toBe(rows);
    });
  });

  describe('count', () => {
    it('forwards args to client.role.count verbatim', async () => {
      const { repo, prisma } = makeRepo();
      const args = { where: { resourceStatus: ResourceStatusType.ENABLED } };
      prisma.role.count.mockResolvedValue(7);

      const result = await repo.count(args);

      expect(prisma.role.count).toHaveBeenCalledWith(args);
      expect(result).toBe(7);
    });
  });

  describe('findByIdWithPolicies', () => {
    it('calls findUnique with ROLE_POLICIES_INCLUDE (ENABLED, ordered by priority)', async () => {
      const { repo, prisma } = makeRepo();
      const row = { id: 'role-1', name: 'doctor', RolePolicies: [] };
      prisma.role.findUnique.mockResolvedValue(row);

      const result = await repo.findByIdWithPolicies('role-1');

      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        include: ROLE_POLICIES_INCLUDE,
      });
      expect(result).toBe(row);
    });

    it('forwards a caller-supplied include override verbatim (member counts)', async () => {
      const { repo, prisma } = makeRepo();
      const include = {
        ...ROLE_POLICIES_INCLUDE,
        _count: {
          select: {
            UserRoleAssignments: {
              where: { resourceStatus: { not: ResourceStatusType.DELETED }, tenantId: 'tenant-001' },
            },
          },
        },
      };
      prisma.role.findUnique.mockResolvedValue({ id: 'role-1', _count: { UserRoleAssignments: 3 } });

      const result = await repo.findByIdWithPolicies('role-1', include as never);

      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        include,
      });
      expect(result).toEqual({ id: 'role-1', _count: { UserRoleAssignments: 3 } });
    });
  });

  describe('findByIdGuardSelect', () => {
    // TASK-766 OD-1: the projection also carries `tenantId`, so the service can
    // tell an own-tenant custom role from a SYSTEM-owned platform one before it
    // writes.
    it('selects isSystemRole, name and tenantId', async () => {
      const { repo, prisma } = makeRepo();
      prisma.role.findUnique.mockResolvedValue({ isSystemRole: false, name: 'doctor', tenantId: 'tenant-1' });

      const result = await repo.findByIdGuardSelect('role-1');

      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        select: { isSystemRole: true, name: true, tenantId: true },
      });
      expect(result).toEqual({ isSystemRole: false, name: 'doctor', tenantId: 'tenant-1' });
    });
  });

  describe('findParentRoleById', () => {
    it('selects { id, parentRoleId } for the parent existence check', async () => {
      const { repo, prisma } = makeRepo();
      prisma.role.findUnique.mockResolvedValue({ id: 'parent-1', parentRoleId: null });

      const result = await repo.findParentRoleById('parent-1');

      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'parent-1' },
        select: { id: true, parentRoleId: true },
      });
      expect(result).toEqual({ id: 'parent-1', parentRoleId: null });
    });
  });

  describe('findParentRoleIdById', () => {
    it('selects { parentRoleId } only for cycle-walk steps', async () => {
      const { repo, prisma } = makeRepo();
      prisma.role.findUnique.mockResolvedValue({ parentRoleId: 'role-1' });

      const result = await repo.findParentRoleIdById('parent-1');

      expect(prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'parent-1' },
        select: { parentRoleId: true },
      });
      expect(result).toEqual({ parentRoleId: 'role-1' });
    });
  });

  describe('create', () => {
    it('forwards data to client.role.create wrapped in { data }', async () => {
      const { repo, prisma } = makeRepo();
      const data = {
        name: 'manager',
        description: undefined,
        externalName: undefined,
        externalId: undefined,
        parentRoleId: undefined,
        isSystemRole: false,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      };
      prisma.role.create.mockResolvedValue({ id: 'role-99', ...data });

      const result = await repo.create(data as never);

      expect(prisma.role.create).toHaveBeenCalledWith({ data });
      expect(result).toMatchObject({ id: 'role-99', name: 'manager' });
    });
  });

  describe('update', () => {
    it('wraps update with where, data, and ROLE_POLICIES_INCLUDE', async () => {
      const { repo, prisma } = makeRepo();
      const data = { name: 'doctor-v2', updatedBy: 'user-1' };
      const updated = { id: 'role-1', ...data, RolePolicies: [] };
      prisma.role.update.mockResolvedValue(updated);

      const result = await repo.update('role-1', data as never);

      expect(prisma.role.update).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        data,
        include: ROLE_POLICIES_INCLUDE,
      });
      expect(result).toBe(updated);
    });
  });

  describe('softDelete', () => {
    it('flips resourceStatus to DELETED and stamps audit fields', async () => {
      const { repo, prisma } = makeRepo();
      prisma.role.update.mockResolvedValue({ id: 'role-1' });

      await repo.softDelete('role-1', 'user-1');

      const call = prisma.role.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'role-1' });
      expect(call.data.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(call.data.resourceStatusUpdatedBy).toBe('user-1');
    });
  });
});

describe('RbacRoleFactory', () => {
  describe('buildCreateInput', () => {
    it('produces a role create input with isSystemRole=false and ENABLED status', () => {
      const input = RbacRoleFactory.buildCreateInput({
        tenantId: 'tenant-1',
        name: 'manager',
        description: 'Mid-management',
        externalName: 'ext-mgr',
        externalId: 'ext-99',
        parentRoleId: 'parent-1',
        createdBy: 'user-1',
      });

      expect(input).toEqual({
        tenantId: 'tenant-1',
        name: 'manager',
        description: 'Mid-management',
        externalName: 'ext-mgr',
        externalId: 'ext-99',
        parentRoleId: 'parent-1',
        isSystemRole: false,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      });
    });

    it('preserves undefined for optional fields (no clobber)', () => {
      const input = RbacRoleFactory.buildCreateInput({
        tenantId: 'tenant-1',
        name: 'orphan',
        createdBy: 'user-1',
      });

      expect(input.name).toBe('orphan');
      expect(input.description).toBeUndefined();
      expect(input.parentRoleId).toBeUndefined();
      expect(input.isSystemRole).toBe(false);
      expect(input.resourceStatus).toBe(ResourceStatusType.ENABLED);
    });

    it('honours an explicit isSystemRole:true (super-admin SYSTEM-role create)', () => {
      const input = RbacRoleFactory.buildCreateInput({
        tenantId: '00000000-0000-0000-0000-000000000000',
        name: 'CLINICIAN',
        isSystemRole: true,
        createdBy: 'admin-1',
      });

      expect(input.isSystemRole).toBe(true);
    });

    it('defaults isSystemRole to false when omitted', () => {
      const input = RbacRoleFactory.buildCreateInput({ tenantId: 'tenant-1', name: 'orphan', createdBy: 'user-1' });

      expect(input.isSystemRole).toBe(false);
    });
  });

  describe('buildUpdateInput', () => {
    it('returns only provided fields plus updatedBy when resourceStatus is omitted', () => {
      const input = RbacRoleFactory.buildUpdateInput({ name: 'doctor-v2' }, 'user-1');

      expect(input).toEqual({
        name: 'doctor-v2',
        updatedBy: 'user-1',
      });
    });

    it('honours description=null as an explicit clear, but skips undefined', () => {
      const input = RbacRoleFactory.buildUpdateInput({ description: null as unknown as string, externalName: undefined }, 'user-1');

      expect(input).toHaveProperty('description', null);
      expect(input).not.toHaveProperty('externalName');
    });

    it('honours parentRoleId=null as an explicit clear', () => {
      const input = RbacRoleFactory.buildUpdateInput({ parentRoleId: null as unknown as string }, 'user-1');

      expect(input).toHaveProperty('parentRoleId', null);
    });

    it('stamps resource-status fields when resourceStatus is provided', () => {
      const input = RbacRoleFactory.buildUpdateInput({ resourceStatus: 'DISABLED' }, 'user-1');

      expect(input.resourceStatus).toBe('DISABLED');
      expect(input.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(input.resourceStatusUpdatedBy).toBe('user-1');
      expect(input.updatedBy).toBe('user-1');
    });
  });
});

describe('RbacRoleEntityMapper', () => {
  it('ROLE_POLICIES_INCLUDE matches the original shape verbatim', () => {
    expect(ROLE_POLICIES_INCLUDE).toEqual({
      RolePolicies: {
        where: { resourceStatus: ResourceStatusType.ENABLED },
        include: { Policy: { select: { id: true, name: true } } },
        orderBy: { priority: 'asc' },
      },
    });
  });

  it('mapRoleRowToRecord projects a Prisma row + RolePolicies onto the public record', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-01-02T00:00:00Z');
    const record = mapRoleRowToRecord({
      id: 'role-1',
      name: 'doctor',
      description: 'Practising doctor',
      externalName: null,
      externalId: null,
      isSystemRole: false,
      parentRoleId: null,
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt,
      updatedAt,
      RolePolicies: [
        { Policy: { id: 'policy-1', name: 'p1' }, priority: 0 },
        { Policy: { id: 'policy-2', name: 'p2' }, priority: 5 },
      ],
    } as never);

    expect(record).toEqual({
      id: 'role-1',
      name: 'doctor',
      description: 'Practising doctor',
      externalName: null,
      externalId: null,
      isSystemRole: false,
      parentRoleId: null,
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt,
      updatedAt,
      RolePolicies: [
        { Policy: { id: 'policy-1', name: 'p1' }, priority: 0 },
        { Policy: { id: 'policy-2', name: 'p2' }, priority: 5 },
      ],
    });
  });

  it('defaults RolePolicies to [] when the include was not loaded', () => {
    const record = mapRoleRowToRecord({
      id: 'role-1',
      name: 'doctor',
      description: null,
      externalName: null,
      externalId: null,
      isSystemRole: false,
      parentRoleId: null,
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(record.RolePolicies).toEqual([]);
  });
});
