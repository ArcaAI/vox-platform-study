/**
 * TASK-307 W6.2 — `PolicyService` pins the behaviour that used to live
 * inside `PoliciesController` (C-10 / F-1 / H-9 from the multi-tenancy API
 * audit). The controller is the offender being refactored; these tests
 * pin the new service so the controller can become a thin transport-layer
 * wrapper.
 *
 * Coverage targets:
 *   - `validateRules`     — pure, moved verbatim from the controller
 *   - `findAll`           — pagination, search, scope filter, count parity
 *   - `findOne`           — `findUnique` lookup
 *   - `create`            — RED on invalid rules; valid path emits
 *                           `SysEventType.ResourceCreated` with
 *                           `ResourceType.Permission` and stamps `createdBy`
 *                           from CLS
 *   - `update`/`patch`    — invalidates the policy cache and emits
 *                           `SysEventType.ResourceUpdated`; `patch` also
 *                           supports `resourceStatus` + emits
 *                           `previousData` for diff audits
 *   - `softDelete`        — flips `resourceStatus → DELETED`, invalidates
 *                           cache, emits `SysEventType.ResourceDeleted`
 */
import { vi, describe, beforeEach, it, expect } from 'vitest';
import { ResourceStatusType, ResourceType, SysEventType } from '@arcaai/domains';
import type { PolicyScope } from '../IPolicyService';
import { PolicyService } from '../policy.service';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };
const TENANT_ID = 'tenant-001';

function makePolicyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'policy-1',
    name: 'team-policy',
    description: 'Team rules',
    scope: 'TENANT',
    rules: [{ action: 'read', subject: 'User' }],
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
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
    policy: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };

  const engine = { invalidatePolicy: vi.fn().mockResolvedValue(undefined) };

  return { cls, eventEmitter, prisma, engine };
}

function buildService(mocks: ReturnType<typeof makeMocks>) {
  return new PolicyService(
    { client: mocks.prisma } as never,
    mocks.engine as never,
    mocks.eventEmitter as never,
    mocks.cls as never,
  );
}

describe('TASK-307 W6.2 — PolicyService (closes C-10 / H-9 / AC-24)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateRules', () => {
    it('flags missing action and subject as errors', () => {
      const service = buildService(makeMocks());
      const result = service.validateRules([{ subject: 'User' } as never, { action: 'read' } as never]);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "Rule 1: 'action' is required",
        "Rule 2: 'subject' is required",
      ]);
    });

    it('warns on unknown actions while still being valid', () => {
      const service = buildService(makeMocks());
      const result = service.validateRules([{ action: 'frobnicate', subject: 'User' }]);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual(["Rule 1: Unknown action 'frobnicate'"]);
    });

    it('warns when conditions reference unknown template variables', () => {
      const service = buildService(makeMocks());
      const result = service.validateRules([
        { action: 'read', subject: 'User', conditions: { id: '${user.bogusField}' } },
      ]);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        "Rule 1: Unknown variable 'user.bogusField' at conditions.id",
      ]);
    });
  });

  describe('findAll', () => {
    it('runs findMany + count under the same where clause and returns both', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow();
      mocks.prisma.policy.findMany.mockResolvedValue([row]);
      mocks.prisma.policy.count.mockResolvedValue(1);
      const service = buildService(mocks);

      const result = await service.findAll({ page: 2, pageSize: 10, search: 'team', scope: 'TENANT' as PolicyScope });

      expect(mocks.prisma.policy.findMany).toHaveBeenCalledWith({
        where: {
          resourceStatus: ResourceStatusType.ENABLED,
          OR: [
            { name: { contains: 'team', mode: 'insensitive' } },
            { description: { contains: 'team', mode: 'insensitive' } },
          ],
          scope: 'TENANT',
        },
        skip: 10,
        take: 10,
        orderBy: { name: 'asc' },
      });
      expect(mocks.prisma.policy.count).toHaveBeenCalledWith({
        where: {
          resourceStatus: ResourceStatusType.ENABLED,
          OR: [
            { name: { contains: 'team', mode: 'insensitive' } },
            { description: { contains: 'team', mode: 'insensitive' } },
          ],
          scope: 'TENANT',
        },
      });
      expect(result).toEqual({ data: [row], total: 1 });
    });
  });

  describe('findOne', () => {
    it('returns the row via findUnique', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow();
      mocks.prisma.policy.findUnique.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.findOne('policy-1');

      expect(mocks.prisma.policy.findUnique).toHaveBeenCalledWith({ where: { id: 'policy-1' } });
      expect(result).toBe(row);
    });
  });

  describe('create', () => {
    it('refuses to persist invalid rules', async () => {
      const mocks = makeMocks();
      const service = buildService(mocks);
      await expect(
        service.create({
          name: 'broken',
          description: undefined,
          scope: 'TENANT' as PolicyScope,
          rules: [{ subject: 'User' } as never],
        }),
      ).rejects.toThrow(/Invalid policy rules/);
      expect(mocks.prisma.policy.create).not.toHaveBeenCalled();
    });

    it('persists with createdBy from CLS and emits a Permission audit event', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow({ id: 'policy-99' });
      mocks.prisma.policy.create.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.create({
        name: 'team-policy',
        description: 'Team rules',
        scope: 'TENANT' as PolicyScope,
        rules: [{ action: 'read', subject: 'User' }],
      });

      expect(mocks.prisma.policy.create).toHaveBeenCalledWith({
        data: {
          name: 'team-policy',
          description: 'Team rules',
          scope: 'TENANT',
          rules: [{ action: 'read', subject: 'User' }],
          resourceStatus: ResourceStatusType.ENABLED,
          createdBy: ADMIN_USER.id,
        },
      });
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceCreated,
        expect.objectContaining({
          resourceId: 'policy-99',
          resourceType: ResourceType.Permission,
          responsibleEntityId: ADMIN_USER.id,
          data: row,
        }),
      );
      expect(result).toBe(row);
    });
  });

  describe('update', () => {
    it('invalidates cache and emits Updated event after the write', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow({ name: 'team-policy-v2' });
      mocks.prisma.policy.update.mockResolvedValue(row);
      const service = buildService(mocks);

      await service.update('policy-1', { name: 'team-policy-v2' });

      expect(mocks.prisma.policy.update).toHaveBeenCalledWith({
        where: { id: 'policy-1' },
        data: { name: 'team-policy-v2', updatedBy: ADMIN_USER.id },
      });
      expect(mocks.engine.invalidatePolicy).toHaveBeenCalledWith('policy-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'policy-1',
          resourceType: ResourceType.Permission,
          data: row,
        }),
      );
    });
  });

  describe('patch', () => {
    it('throws NotFound when the policy does not exist', async () => {
      const mocks = makeMocks();
      mocks.prisma.policy.findUnique.mockResolvedValue(null);
      const service = buildService(mocks);
      await expect(service.patch('missing', { name: 'x' })).rejects.toThrow(/Policy not found/);
      expect(mocks.prisma.policy.update).not.toHaveBeenCalled();
    });

    it('stamps resource-status fields when resourceStatus is provided and emits previousData', async () => {
      const mocks = makeMocks();
      const existing = makePolicyRow();
      const updated = makePolicyRow({ resourceStatus: 'DISABLED' });
      mocks.prisma.policy.findUnique.mockResolvedValue(existing);
      mocks.prisma.policy.update.mockResolvedValue(updated);
      const service = buildService(mocks);

      await service.patch('policy-1', { resourceStatus: 'DISABLED' });

      const callArg = mocks.prisma.policy.update.mock.calls[0][0];
      expect(callArg.where).toEqual({ id: 'policy-1' });
      expect(callArg.data.resourceStatus).toBe('DISABLED');
      expect(callArg.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(callArg.data.resourceStatusUpdatedBy).toBe(ADMIN_USER.id);
      expect(callArg.data.updatedBy).toBe(ADMIN_USER.id);

      expect(mocks.engine.invalidatePolicy).toHaveBeenCalledWith('policy-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'policy-1',
          resourceType: ResourceType.Permission,
          data: updated,
          previousData: existing,
        }),
      );
    });
  });

  describe('softDelete', () => {
    it('throws NotFound when the policy does not exist', async () => {
      const mocks = makeMocks();
      mocks.prisma.policy.findUnique.mockResolvedValue(null);
      const service = buildService(mocks);
      await expect(service.softDelete('missing')).rejects.toThrow(/Policy not found/);
      expect(mocks.prisma.policy.update).not.toHaveBeenCalled();
    });

    it('flips resourceStatus to DELETED, invalidates cache, and emits Deleted event', async () => {
      const mocks = makeMocks();
      mocks.prisma.policy.findUnique.mockResolvedValue({ name: 'team-policy' });
      mocks.prisma.policy.update.mockResolvedValue(makePolicyRow({ resourceStatus: ResourceStatusType.DELETED }));
      const service = buildService(mocks);

      const result = await service.softDelete('policy-1');

      expect(mocks.prisma.policy.findUnique).toHaveBeenCalledWith({
        where: { id: 'policy-1' },
        select: { name: true },
      });
      const updateCall = mocks.prisma.policy.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'policy-1' });
      expect(updateCall.data.resourceStatus).toBe(ResourceStatusType.DELETED);
      expect(updateCall.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(updateCall.data.resourceStatusUpdatedBy).toBe(ADMIN_USER.id);

      expect(mocks.engine.invalidatePolicy).toHaveBeenCalledWith('policy-1');
      expect(mocks.eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceDeleted,
        expect.objectContaining({
          resourceId: 'policy-1',
          resourceType: ResourceType.Permission,
          data: { name: 'team-policy' },
        }),
      );

      expect(result).toEqual({ id: 'policy-1', name: 'team-policy' });
    });
  });
});
