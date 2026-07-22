/**
 * `PolicyService` regression tests. The service was originally TDD'd against
 * a `databaseService.client.policy.*` mock; the persistence layer now sits
 * behind `PolicyRepository`, so the mocks here stub the repository instead.
 * The OBSERVABLE behaviour (audit-event payloads, log messages, exception
 * types and messages, returned shape) is unchanged.
 *
 * Coverage targets:
 *   - `validateRules`     — pure, moved verbatim from the controller
 *   - `findAll`           — pagination, search, scope filter, count parity
 *   - `findOne`           — `findById` lookup
 *   - `create`            — RED on invalid rules; valid path calls
 *                           `policyRepository.create` with the
 *                           factory-built payload and emits
 *                           `SysEventType.ResourceCreated` with
 *                           `ResourceType.Permission`
 *   - `update`/`patch`    — calls `policyRepository.update(id, data)`
 *                           where `data` is the factory output, then
 *                           invalidates the policy cache and emits
 *                           `SysEventType.ResourceUpdated`; `patch` also
 *                           supports `resourceStatus` + emits
 *                           `previousData` for diff audits
 *   - `softDelete`        — pre-checks existence via `findById`, then
 *                           calls `policyRepository.softDelete(id, user.id)`,
 *                           invalidates the cache, emits
 *                           `SysEventType.ResourceDeleted`
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

  const policyRepo = {
    findMany: vi.fn(),
    count: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn().mockResolvedValue(undefined),
  };

  const engine = { invalidatePolicy: vi.fn().mockResolvedValue(undefined) };

  // Break-glass dependencies (delete path verifies the caller's
  // password and confirmation name before mutating).
  const rolePolicyRepo = { countEnabledByPolicy: vi.fn().mockResolvedValue(0) };
  const userRepo = { findById: vi.fn().mockResolvedValue({ id: ADMIN_USER.id, password: 'stored-hash' }) };
  const crypto = { verify: vi.fn().mockResolvedValue(true) };

  return { cls, eventEmitter, policyRepo, engine, rolePolicyRepo, userRepo, crypto };
}

function buildService(mocks: ReturnType<typeof makeMocks>) {
  return new PolicyService(
    mocks.policyRepo as never,
    mocks.engine as never,
    mocks.rolePolicyRepo as never,
    mocks.userRepo as never,
    mocks.crypto as never,
    mocks.eventEmitter as never,
    mocks.cls as never,
  );
}

/** The delete path now requires break-glass confirmation. */
const BREAK_GLASS = (name: string) => ({ password: 'pw', confirmationName: name });

describe('PolicyService', () => {
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
      mocks.policyRepo.findMany.mockResolvedValue([row]);
      mocks.policyRepo.count.mockResolvedValue(1);
      const service = buildService(mocks);

      const result = await service.findAll({ page: 2, pageSize: 10, search: 'team', scope: 'TENANT' as PolicyScope });

      expect(mocks.policyRepo.findMany).toHaveBeenCalledWith({
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
      expect(mocks.policyRepo.count).toHaveBeenCalledWith({
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
    it('returns the row via policyRepository.findById', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow();
      mocks.policyRepo.findById.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.findOne('policy-1');

      expect(mocks.policyRepo.findById).toHaveBeenCalledWith('policy-1');
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
      expect(mocks.policyRepo.create).not.toHaveBeenCalled();
    });

    it('persists with createdBy from CLS and emits a Permission audit event', async () => {
      const mocks = makeMocks();
      const row = makePolicyRow({ id: 'policy-99' });
      mocks.policyRepo.create.mockResolvedValue(row);
      const service = buildService(mocks);

      const result = await service.create({
        name: 'team-policy',
        description: 'Team rules',
        scope: 'TENANT' as PolicyScope,
        rules: [{ action: 'read', subject: 'User' }],
      });

      expect(mocks.policyRepo.create).toHaveBeenCalledWith({
        name: 'team-policy',
        description: 'Team rules',
        scope: 'TENANT',
        rules: [{ action: 'read', subject: 'User' }],
        resourceStatus: ResourceStatusType.ENABLED,
        createdBy: ADMIN_USER.id,
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
      mocks.policyRepo.update.mockResolvedValue(row);
      const service = buildService(mocks);

      await service.update('policy-1', { name: 'team-policy-v2' });

      expect(mocks.policyRepo.update).toHaveBeenCalledWith('policy-1', {
        name: 'team-policy-v2',
        updatedBy: ADMIN_USER.id,
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
      mocks.policyRepo.findById.mockResolvedValue(null);
      const service = buildService(mocks);
      await expect(service.patch('missing', { name: 'x' })).rejects.toThrow(/Policy not found/);
      expect(mocks.policyRepo.update).not.toHaveBeenCalled();
    });

    it('stamps resource-status fields when resourceStatus is provided and emits previousData', async () => {
      const mocks = makeMocks();
      const existing = makePolicyRow();
      const updated = makePolicyRow({ resourceStatus: 'DISABLED' });
      mocks.policyRepo.findById.mockResolvedValue(existing);
      mocks.policyRepo.update.mockResolvedValue(updated);
      const service = buildService(mocks);

      await service.patch('policy-1', { resourceStatus: 'DISABLED' });

      expect(mocks.policyRepo.findById).toHaveBeenCalledWith('policy-1');
      const [updateId, updateData] = mocks.policyRepo.update.mock.calls[0];
      expect(updateId).toBe('policy-1');
      expect(updateData.resourceStatus).toBe('DISABLED');
      expect(updateData.resourceStatusUpdatedAt).toBeInstanceOf(Date);
      expect(updateData.resourceStatusUpdatedBy).toBe(ADMIN_USER.id);
      expect(updateData.updatedBy).toBe(ADMIN_USER.id);

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
      mocks.policyRepo.findById.mockResolvedValue(null);
      const service = buildService(mocks);
      await expect(service.softDelete('missing')).rejects.toThrow(/Policy not found/);
      expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    });

    it('flips resourceStatus to DELETED, invalidates cache, and emits Deleted event', async () => {
      const mocks = makeMocks();
      mocks.policyRepo.findById.mockResolvedValue({ id: 'policy-1', name: 'team-policy' });
      const service = buildService(mocks);

      const result = await service.softDelete('policy-1', BREAK_GLASS('team-policy'));

      expect(mocks.policyRepo.findById).toHaveBeenCalledWith('policy-1');
      expect(mocks.policyRepo.softDelete).toHaveBeenCalledWith('policy-1', ADMIN_USER.id);

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
