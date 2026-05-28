/**
 * TASK-311 AC-1/AC-2/AC-6 — RolePolicyRepository / RolePolicyFactory /
 * RolePolicyEntityMapper unit tests.
 *
 * Pinned behaviour (mirrors the Prisma calls inlined in the pre-TASK-311
 * `RbacRoleService.assignPolicy` / `.removePolicy`):
 *
 *   • `findFirstByRoleAndPolicy(roleId, policyId)` — existence
 *     pre-check; matches an assignment whether ENABLED or DELETED so
 *     the assign path can re-enable a soft-deleted row.
 *   • `create(data)` — wraps `client.rolePolicy.create({ data })`.
 *   • `reEnable(id, data)` — wraps `client.rolePolicy.update({ where: { id }, data })`.
 *   • `softDeleteByRoleAndPolicy(roleId, policyId, updatedBy?)` —
 *     wraps `client.rolePolicy.updateMany({ where: { roleId, policyId }, data: { DELETED stamps } })`.
 *     Uses `updateMany` (not `update`) per the verbatim pre-TASK-311
 *     code — `update` would require `where: { id }` which the
 *     service doesn't carry.
 */
import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType } from '../../../enums';
import { RolePolicyFactory } from '../RolePolicyFactory';
import { mapRolePolicyRowToRecord } from '../RolePolicyEntityMapper';
import { RolePolicyRepository } from '../RolePolicyRepository';

function makePrismaMock() {
  return {
    rolePolicy: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

function makeRepo() {
  const prisma = makePrismaMock();
  const databaseService = { client: prisma };
  const repo = new RolePolicyRepository(databaseService as never);
  return { repo, prisma };
}

describe('TASK-311 — RolePolicyRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findFirstByRoleAndPolicy', () => {
    it('matches by (roleId, policyId) without filtering on resourceStatus', async () => {
      const { repo, prisma } = makeRepo();
      const row = { id: 'rp-1', priority: 5, resourceStatus: ResourceStatusType.DELETED };
      prisma.rolePolicy.findFirst.mockResolvedValue(row);

      const result = await repo.findFirstByRoleAndPolicy('role-1', 'policy-1');

      expect(prisma.rolePolicy.findFirst).toHaveBeenCalledWith({
        where: { roleId: 'role-1', policyId: 'policy-1' },
      });
      expect(result).toBe(row);
    });
  });

  describe('create', () => {
    it('forwards data to client.rolePolicy.create wrapped in { data }', async () => {
      const { repo, prisma } = makeRepo();
      const data = {
        roleId: 'role-1',
        policyId: 'policy-1',
        priority: 5,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      };
      prisma.rolePolicy.create.mockResolvedValue({ id: 'rp-1', ...data });

      const result = await repo.create(data as never);

      expect(prisma.rolePolicy.create).toHaveBeenCalledWith({ data });
      expect(result).toMatchObject({ id: 'rp-1', roleId: 'role-1', policyId: 'policy-1' });
    });
  });

  describe('reEnable', () => {
    it('wraps update with where: { id } and the re-enable data payload', async () => {
      const { repo, prisma } = makeRepo();
      const data = {
        priority: 3,
        resourceStatus: ResourceStatusType.ENABLED,
        updatedBy: 'user-1',
      };
      prisma.rolePolicy.update.mockResolvedValue({ id: 'rp-1', ...data });

      const result = await repo.reEnable('rp-1', data as never);

      expect(prisma.rolePolicy.update).toHaveBeenCalledWith({
        where: { id: 'rp-1' },
        data,
      });
      expect(result).toMatchObject({ id: 'rp-1' });
    });
  });

  describe('softDeleteByRoleAndPolicy', () => {
    it('updateMany flips resourceStatus to DELETED and stamps audit fields', async () => {
      const { repo, prisma } = makeRepo();
      prisma.rolePolicy.updateMany.mockResolvedValue({ count: 1 });

      await repo.softDeleteByRoleAndPolicy('role-1', 'policy-1', 'user-1');

      const call = prisma.rolePolicy.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ roleId: 'role-1', policyId: 'policy-1' });
      expect(call.data.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(call.data.resourceStatusUpdatedBy).toBe('user-1');
    });
  });
});

describe('TASK-311 — RolePolicyFactory', () => {
  describe('buildCreateInput', () => {
    it('produces a rolePolicy create input with ENABLED status', () => {
      const input = RolePolicyFactory.buildCreateInput({
        roleId: 'role-1',
        policyId: 'policy-1',
        priority: 5,
        createdBy: 'user-1',
      });

      expect(input).toEqual({
        roleId: 'role-1',
        policyId: 'policy-1',
        priority: 5,
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      });
    });
  });

  describe('buildReEnableInput', () => {
    it('forces resourceStatus → ENABLED and applies the given priority', () => {
      const input = RolePolicyFactory.buildReEnableInput({
        priority: 7,
        updatedBy: 'user-1',
      });

      expect(input).toEqual({
        priority: 7,
        resourceStatus: ResourceStatusType.ENABLED,
        updatedBy: 'user-1',
      });
    });
  });
});

describe('TASK-311 — RolePolicyEntityMapper', () => {
  it('mapRolePolicyRowToRecord projects a Prisma row onto the public join record', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-01-02T00:00:00Z');
    const record = mapRolePolicyRowToRecord({
      id: 'rp-1',
      roleId: 'role-1',
      policyId: 'policy-1',
      priority: 5,
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt,
      updatedAt,
      version: 3,
      metaData: { hidden: true },
    } as never);

    expect(record).toEqual({
      id: 'rp-1',
      roleId: 'role-1',
      policyId: 'policy-1',
      priority: 5,
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt,
      updatedAt,
    });
  });
});
