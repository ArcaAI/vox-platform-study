/**
 * TASK-307 W6.3 — `RoleService` pins the behaviour that used to live
 * inside `RolesController` (audit C-10 / F-1 / H-9). The service is the
 * only legitimate owner of `databaseService.client.role.*` and
 * `databaseService.client.rolePolicy.*` after the W6 sweep.
 *
 * Coverage targets:
 *   - `findAll` / `findOne`               (pagination + RolePolicies include)
 *   - `create`                            (parent-role validation; audit
 *                                          event with ResourceType.Role)
 *   - `update`                            (system-role guard; cycle
 *                                          detection; cache invalidation
 *                                          + audit)
 *   - `patch`                             (resourceStatus stamping;
 *                                          previousData on audit)
 *   - `softDelete`                        (system-role guard; cache
 *                                          invalidation; ResourceDeleted)
 *   - `assignPolicy` / `removePolicy`     (upsert-or-update of the join
 *                                          row; ResourceType.RolePermission
 *                                          on audit)
 */

import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType, ResourceType, SysEventType } from '@arcaai/domains';
import { RbacRoleService } from '../role.service';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };
const TENANT_ID = 'tenant-001';

function makeRoleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'role-1',
    name: 'doctor',
    description: 'Practising doctor',
    externalName: null,
    externalId: null,
    isSystemRole: false,
    parentRoleId: null,
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    RolePolicies: [],
    ...overrides,
  };
}

function makeMocks() {
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return ADMIN_USER;
      if (key === 'tenantId') return TENANT_ID;
      if (key === 'correlationId') return 'corr-1';
      if (key === 'requestIp') return '10.0.0.1';
      return null;
    }),
    set: vi.fn(),
  };

  const eventEmitter = { emit: vi.fn() };

  const prisma = {
    role: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    rolePolicy: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  const engine = { invalidateRole: vi.fn().mockResolvedValue(undefined) };

  return { cls, eventEmitter, prisma, engine };
}

function buildService(mocks: ReturnType<typeof makeMocks>) {
  return new RbacRoleService(
    { client: mocks.prisma } as never,
    mocks.engine as never,
    mocks.eventEmitter as never,
    mocks.cls as never,
  );
}

describe('TASK-307 W6.3 — RbacRoleService (closes C-10 / H-9 / AC-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findAll', () => {
    it('paginates and includes ENABLED RolePolicies ordered by priority', async () => {
      const mocks = makeMocks();
      mocks.prisma.role.findMany.mockResolvedValue([makeRoleRow()]);
      mocks.prisma.role.count.mockResolvedValue(1);
      const service = buildService(mocks);

      const result = await service.findAll({ page: 2, pageSize: 5, search: 'doc' });

      expect(mocks.prisma.role.findMany).toHaveBeenCalledWith({
        where: {
          resourceStatus: ResourceStatusType.ENABLED,
          OR: [
            { name: { contains: 'doc', mode: 'insensitive' } },
            { description: { contains: 'doc', mode: 'insensitive' } },
          ],
        },
        skip: 5,
        take: 5,
        include: {
          RolePolicies: {
            where: { resourceStatus: ResourceStatusType.ENABLED },
            include: { Policy: { select: { id: true, name: true } } },
            orderBy: { priority: 'asc' },
          },
        },
        orderBy: { name: 'asc' },
      });
      expect(result.total).toBe(1);
    });
  });

  describe('findOne', () => {
    it('uses findUnique with the RolePolicies include', async () => {
      const mocks = makeMocks();
      const row = makeRoleRow();
      mocks.prisma.role.findUnique.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.findOne('role-1');

      expect(mocks.prisma.role.findUnique).toHaveBeenCalledWith({
        where: { id: 'role-1' },
        include: {
          RolePolicies: {
            where: { resourceStatus: ResourceStatusType.ENABLED },
            include: { Policy: { select: { id: true, name: true } } },
            orderBy: { priority: 'asc' },
          },
        },
      });
      expect(result).toBe(row);
    });
  });

  describe('create', () => {
    it('rejects creates whose parentRoleId does not exist', async () => {
      const mocks = makeMocks();
      mocks.prisma.role.findUnique.mockResolvedValue(null);
      const service = buildService(mocks);

      await expect(
        service.create({ name: 'orphan', parentRoleId: 'missing' }),
      ).rejects.toThrow(/Parent role 'missing' not found/);
      expect(mocks.prisma.role.create).not.toHaveBeenCalled();
    });

    it('persists with createdBy from CLS and emits a Role audit event', async () => {
      const mocks = makeMocks();
      const row = makeRoleRow({ id: 'role-99', name: 'manager' });
      mocks.prisma.role.create.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.create({ name: 'manager' });

      expect(mocks.prisma.role.create).toHaveBeenCalledWith({
        data: {
          name: 'manager',
          description: undefined,
          externalName: undefined,
          externalId: undefined,
          parentRoleId: undefined,
          isSystemRole: false,
          resourceStatus: ResourceStatusType.ENABLED,
          createdBy: ADMIN_USER.id,
        },
      });
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'role-99',
          resourceType: ResourceType.Role,
          responsibleEntityId: ADMIN_USER.id,
          data: row,
        }),
      );
      expect(result.RolePolicies).toEqual([]);
    });
  });

  describe('update', () => {
    it('refuses to modify a system role', async () => {
      const mocks = makeMocks();
      mocks.prisma.role.findUnique.mockResolvedValue({ isSystemRole: true, name: 'SUPER_ADMIN' });
      const service = buildService(mocks);

      await expect(service.update('role-sys', { name: 'x' })).rejects.toThrow(
        /Cannot modify system role 'SUPER_ADMIN'/,
      );
      expect(mocks.prisma.role.update).not.toHaveBeenCalled();
    });

    it('detects circular parentRoleId before issuing the write', async () => {
      const mocks = makeMocks();
      // 1st findUnique: existence + isSystemRole check for the target role
      // 2nd findUnique: parent lookup (returns a parent whose parent is the target → cycle)
      mocks.prisma.role.findUnique
        .mockResolvedValueOnce({ isSystemRole: false, name: 'doctor' })
        .mockResolvedValueOnce({ id: 'parent-1', parentRoleId: 'role-1' });
      const service = buildService(mocks);

      await expect(
        service.update('role-1', { parentRoleId: 'parent-1' }),
      ).rejects.toThrow(/Circular reference detected/);
      expect(mocks.prisma.role.update).not.toHaveBeenCalled();
    });

    it('invalidates cache and emits Updated event with previousData', async () => {
      const mocks = makeMocks();
      const updated = makeRoleRow({ name: 'doctor-v2' });
      const existing = { isSystemRole: false, name: 'doctor' };
      mocks.prisma.role.findUnique.mockResolvedValue(existing);
      mocks.prisma.role.update.mockResolvedValue(updated);
      const service = buildService(mocks);

      await service.update('role-1', { name: 'doctor-v2' });

      const call = mocks.prisma.role.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'role-1' });
      expect(call.data).toEqual({ name: 'doctor-v2', updatedBy: ADMIN_USER.id });

      expect(mocks.engine.invalidateRole).toHaveBeenCalledWith('role-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'role-1',
          resourceType: ResourceType.Role,
          data: updated,
          previousData: existing,
        }),
      );
    });
  });

  describe('patch', () => {
    it('stamps resource-status fields when resourceStatus is provided', async () => {
      const mocks = makeMocks();
      const updated = makeRoleRow({ resourceStatus: 'DISABLED' });
      mocks.prisma.role.findUnique.mockResolvedValue({ isSystemRole: false, name: 'doctor' });
      mocks.prisma.role.update.mockResolvedValue(updated);
      const service = buildService(mocks);

      await service.patch('role-1', { resourceStatus: 'DISABLED' });

      const call = mocks.prisma.role.update.mock.calls[0][0];
      expect(call.data.resourceStatus).toBe('DISABLED');
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(call.data.resourceStatusUpdatedBy).toBe(ADMIN_USER.id);
      expect(call.data.updatedBy).toBe(ADMIN_USER.id);
    });
  });

  describe('softDelete', () => {
    it('refuses to delete a system role', async () => {
      const mocks = makeMocks();
      mocks.prisma.role.findUnique.mockResolvedValue({ isSystemRole: true, name: 'SUPER_ADMIN' });
      const service = buildService(mocks);

      await expect(service.softDelete('role-sys')).rejects.toThrow(/Cannot delete system role/);
      expect(mocks.prisma.role.update).not.toHaveBeenCalled();
    });

    it('flips resourceStatus to DELETED, invalidates cache, and emits Deleted event', async () => {
      const mocks = makeMocks();
      mocks.prisma.role.findUnique.mockResolvedValue({ isSystemRole: false, name: 'doctor' });
      mocks.prisma.role.update.mockResolvedValue(makeRoleRow({ resourceStatus: ResourceStatusType.DELETED }));
      const service = buildService(mocks);

      const result = await service.softDelete('role-1');

      const call = mocks.prisma.role.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'role-1' });
      expect(call.data.resourceStatus).toBe(ResourceStatusType.DELETED);

      expect(mocks.engine.invalidateRole).toHaveBeenCalledWith('role-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'role-1',
          resourceType: ResourceType.Role,
          data: { name: 'doctor' },
        }),
      );
      expect(result).toEqual({ id: 'role-1', name: 'doctor' });
    });
  });

  describe('assignPolicy', () => {
    it('creates a new rolePolicy row when none exists, and emits with ResourceType.RolePermission', async () => {
      const mocks = makeMocks();
      mocks.prisma.rolePolicy.findFirst.mockResolvedValue(null);
      const service = buildService(mocks);

      await service.assignPolicy('role-1', 'policy-1', { priority: 5 });

      expect(mocks.prisma.rolePolicy.create).toHaveBeenCalledWith({
        data: {
          roleId: 'role-1',
          policyId: 'policy-1',
          priority: 5,
          resourceStatus: ResourceStatusType.ENABLED,
          createdBy: ADMIN_USER.id,
        },
      });
      expect(mocks.prisma.rolePolicy.update).not.toHaveBeenCalled();
      expect(mocks.engine.invalidateRole).toHaveBeenCalledWith('role-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'role-1:policy-1',
          resourceType: ResourceType.RolePermission,
          data: { roleId: 'role-1', policyId: 'policy-1', priority: 5 },
        }),
      );
    });

    it('updates priority (and re-enables) when a soft-deleted assignment exists', async () => {
      const mocks = makeMocks();
      mocks.prisma.rolePolicy.findFirst.mockResolvedValue({
        id: 'rp-1',
        priority: 9,
        resourceStatus: ResourceStatusType.DELETED,
      });
      const service = buildService(mocks);

      await service.assignPolicy('role-1', 'policy-1', { priority: 3 });

      expect(mocks.prisma.rolePolicy.update).toHaveBeenCalledWith({
        where: { id: 'rp-1' },
        data: {
          priority: 3,
          resourceStatus: ResourceStatusType.ENABLED,
          updatedBy: ADMIN_USER.id,
        },
      });
      expect(mocks.prisma.rolePolicy.create).not.toHaveBeenCalled();
    });

    it('preserves existing priority when dto.priority is omitted', async () => {
      const mocks = makeMocks();
      mocks.prisma.rolePolicy.findFirst.mockResolvedValue({
        id: 'rp-1',
        priority: 7,
        resourceStatus: ResourceStatusType.ENABLED,
      });
      const service = buildService(mocks);

      await service.assignPolicy('role-1', 'policy-1', {});

      const call = mocks.prisma.rolePolicy.update.mock.calls[0][0];
      expect(call.data.priority).toBe(7);
    });
  });

  describe('removePolicy', () => {
    it('soft-deletes the rolePolicy and emits ResourceDeleted with RolePermission', async () => {
      const mocks = makeMocks();
      const service = buildService(mocks);

      await service.removePolicy('role-1', 'policy-1');

      const call = mocks.prisma.rolePolicy.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ roleId: 'role-1', policyId: 'policy-1' });
      expect(call.data.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(call.data.resourceStatusUpdatedBy).toBe(ADMIN_USER.id);

      expect(mocks.engine.invalidateRole).toHaveBeenCalledWith('role-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'role-1:policy-1',
          resourceType: ResourceType.RolePermission,
          data: { roleId: 'role-1', policyId: 'policy-1' },
        }),
      );
    });
  });
});
