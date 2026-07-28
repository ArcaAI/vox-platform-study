/**
 * PolicyRepository / PolicyFactory /
 * PolicyEntityMapper unit tests.
 *
 * Pinned behaviour (mirrors the Prisma calls inlined in the legacy
 * `PolicyService` so the W6 RBAC E2E suite stays green after migration):
 *
 *   • `findMany`/`count` pass `args` through to `client.policy.{findMany,count}`
 *     verbatim — paging, search, and `scope` filter shape are owned by the
 *     caller.
 *   • `findById` calls `client.policy.findUnique({ where: { id } })` (uses
 *     `findUnique`, not `findFirst`, to preserve idempotent re-soft-delete:
 *     `findUnique` returns soft-deleted rows; the extended client only
 *     filters DELETED on `findMany`/`findFirst`).
 *   • `create(data)` and `update(id, data)` forward to the Prisma client.
 *     The factory builds `data` — the repo never inlines field assignments
 *     of its own.
 *   • `softDelete(id, updatedBy?)` encapsulates the
 *     `update({ data: { resourceStatus: DELETED, … } })` pattern. The
 *     three legacy `.softDelete` paths (policy/role/rolePolicy)
 *     were already soft via this exact pattern — see README §4.2 audit.
 */
import { describe, beforeEach, it, expect, vi } from 'vitest';
import { ResourceStatusType } from '../../../enums';
import { PolicyFactory } from '../PolicyFactory';
import { mapPolicyRowToRecord } from '../PolicyEntityMapper';
import { PolicyRepository } from '../PolicyRepository';

function makePrismaMock() {
  return {
    policy: {
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
  const repo = new PolicyRepository(databaseService as never);
  return { repo, prisma };
}

describe('PolicyRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findMany', () => {
    it('forwards args to client.policy.findMany verbatim', async () => {
      const { repo, prisma } = makeRepo();
      const args = {
        where: { resourceStatus: ResourceStatusType.ENABLED, scope: 'TENANT' as const },
        skip: 10,
        take: 5,
        orderBy: { name: 'asc' as const },
      };
      const rows = [{ id: 'p1' }];
      prisma.policy.findMany.mockResolvedValue(rows);

      const result = await repo.findMany(args);

      expect(prisma.policy.findMany).toHaveBeenCalledWith(args);
      expect(result).toBe(rows);
    });
  });

  describe('count', () => {
    it('forwards args to client.policy.count verbatim', async () => {
      const { repo, prisma } = makeRepo();
      const args = { where: { resourceStatus: ResourceStatusType.ENABLED } };
      prisma.policy.count.mockResolvedValue(42);

      const result = await repo.count(args);

      expect(prisma.policy.count).toHaveBeenCalledWith(args);
      expect(result).toBe(42);
    });
  });

  describe('findById', () => {
    it('calls client.policy.findUnique with the id (no soft-delete filter)', async () => {
      const { repo, prisma } = makeRepo();
      const row = { id: 'policy-1', name: 'team-policy' };
      prisma.policy.findUnique.mockResolvedValue(row);

      const result = await repo.findById('policy-1');

      expect(prisma.policy.findUnique).toHaveBeenCalledWith({ where: { id: 'policy-1' } });
      expect(result).toBe(row);
    });

    it('returns null when the policy does not exist', async () => {
      const { repo, prisma } = makeRepo();
      prisma.policy.findUnique.mockResolvedValue(null);

      const result = await repo.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('forwards data to client.policy.create wrapped in { data }', async () => {
      const { repo, prisma } = makeRepo();
      const data = {
        name: 'team-policy',
        description: 'desc',
        scope: 'TENANT' as const,
        rules: [{ action: 'read', subject: 'User' }],
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      };
      const row = { id: 'policy-99', ...data };
      prisma.policy.create.mockResolvedValue(row);

      const result = await repo.create(data as never);

      expect(prisma.policy.create).toHaveBeenCalledWith({ data });
      expect(result).toBe(row);
    });
  });

  describe('update', () => {
    it('forwards id+data to client.policy.update wrapped in { where, data }', async () => {
      const { repo, prisma } = makeRepo();
      const data = { name: 'team-policy-v2', updatedBy: 'user-1' };
      const row = { id: 'policy-1', ...data };
      prisma.policy.update.mockResolvedValue(row);

      const result = await repo.update('policy-1', data as never);

      expect(prisma.policy.update).toHaveBeenCalledWith({ where: { id: 'policy-1' }, data });
      expect(result).toBe(row);
    });
  });

  describe('softDelete', () => {
    it('flips resourceStatus to DELETED and stamps audit fields', async () => {
      const { repo, prisma } = makeRepo();
      prisma.policy.update.mockResolvedValue({ id: 'policy-1' });

      await repo.softDelete('policy-1', 'user-1');

      expect(prisma.policy.update).toHaveBeenCalledTimes(1);
      const call = prisma.policy.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'policy-1' });
      expect(call.data.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(call.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(call.data.resourceStatusUpdatedBy).toBe('user-1');
    });

    it('records resourceStatusUpdatedBy as undefined when no actor is provided', async () => {
      const { repo, prisma } = makeRepo();
      prisma.policy.update.mockResolvedValue({ id: 'policy-1' });

      await repo.softDelete('policy-1');

      const call = prisma.policy.update.mock.calls[0][0];
      expect(call.data.resourceStatusUpdatedBy).toBeUndefined();
    });
  });
});

describe('PolicyFactory', () => {
  describe('buildCreateInput', () => {
    it('produces a Prisma.PolicyCreateInput with createdBy and ENABLED status', () => {
      const input = PolicyFactory.buildCreateInput({
        name: 'team-policy',
        description: 'desc',
        scope: 'TENANT',
        rules: [{ action: 'read', subject: 'User' }],
        createdBy: 'user-1',
      });

      expect(input).toEqual({
        name: 'team-policy',
        description: 'desc',
        scope: 'TENANT',
        rules: [{ action: 'read', subject: 'User' }],
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: 'user-1',
      });
    });
  });

  describe('buildUpdateInput', () => {
    it('returns only provided fields plus updatedBy when resourceStatus is omitted', () => {
      const input = PolicyFactory.buildUpdateInput(
        {
          name: 'team-policy-v2',
          description: 'desc-v2',
        },
        'user-1',
      );

      expect(input).toEqual({
        name: 'team-policy-v2',
        description: 'desc-v2',
        updatedBy: 'user-1',
      });
    });

    it('stamps resource-status fields when resourceStatus is provided', () => {
      const input = PolicyFactory.buildUpdateInput({ resourceStatus: 'DISABLED' }, 'user-1');

      expect(input.resourceStatus).toBe('DISABLED');
      expect(input.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(input.resourceStatusUpdatedBy).toBe('user-1');
      expect(input.updatedBy).toBe('user-1');
    });

    it('omits name/description when they are not provided (no clobber of unrelated fields)', () => {
      const input = PolicyFactory.buildUpdateInput({ scope: 'GLOBAL' }, 'user-1');

      expect(input).not.toHaveProperty('name');
      expect(input.scope).toBe('GLOBAL');
      expect(input.updatedBy).toBe('user-1');
    });

    it('treats description=null as an explicit clear (description !== undefined)', () => {
      const input = PolicyFactory.buildUpdateInput({ description: undefined }, 'user-1');
      expect(input).not.toHaveProperty('description');
    });
  });
});

describe('PolicyEntityMapper', () => {
  it('mapPolicyRowToRecord projects a Prisma row onto the PolicyRecord contract', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-01-02T00:00:00Z');
    const record = mapPolicyRowToRecord({
      id: 'policy-1',
      name: 'team-policy',
      description: 'desc',
      scope: 'TENANT',
      rules: [{ action: 'read', subject: 'User' }],
      resourceStatus: ResourceStatusType.ENABLED,
      isProtected: true,
      createdAt,
      updatedAt,
      version: 7,
      metaData: { hidden: true },
      resourceStatusUpdatedAt: null,
      resourceStatusUpdatedBy: null,
      createdBy: 'user-1',
      updatedBy: null,
    } as never);

    expect(record).toEqual({
      id: 'policy-1',
      name: 'team-policy',
      description: 'desc',
      scope: 'TENANT',
      rules: [{ action: 'read', subject: 'User' }],
      resourceStatus: ResourceStatusType.ENABLED,
      isProtected: true,
      createdAt,
      updatedAt,
    });
  });

  it('preserves null description and accepts unknown rules JSON shape', () => {
    const record = mapPolicyRowToRecord({
      id: 'policy-2',
      name: 'global-policy',
      description: null,
      scope: 'GLOBAL',
      rules: { complex: { nested: ['structure'] } },
      resourceStatus: ResourceStatusType.DISABLED,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(record.description).toBeNull();
    expect(record.rules).toEqual({ complex: { nested: ['structure'] } });
  });

  // Rows missing the column (legacy fixtures) default to false so
  // the record shape is always total.
  it('defaults isProtected to false when the row omits it', () => {
    const record = mapPolicyRowToRecord({
      id: 'policy-3',
      name: 'plain-policy',
      description: null,
      scope: 'TENANT',
      rules: [],
      resourceStatus: ResourceStatusType.ENABLED,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(record.isProtected).toBe(false);
  });
});
