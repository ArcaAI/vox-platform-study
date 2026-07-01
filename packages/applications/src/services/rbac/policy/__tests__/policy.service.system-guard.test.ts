/**
 * TASK-390 #22 (R3) — AUTH-SENSITIVE system-lockout guard.
 *
 * The Roles & Policies builder allows editing policy rules. These tests pin the
 * anti-foot-gun invariant: the seeded system-critical GLOBAL policies
 * (`system-full-access` = `manage:all`, `rbac-system-manage` = the core RBAC
 * manage rules) must be un-deletable, un-disable-able, un-rescope-able, and
 * must retain their load-bearing rules — otherwise a single edit could lock
 * every super-admin out of the platform. Everything else stays fully editable.
 */
import { vi, describe, beforeEach, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { PolicyService } from '../policy.service';

const ADMIN_USER = { id: 'admin-001', firstName: 'Su', lastName: 'Admin', email: 'admin@arcaai.com' };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-x',
    name: 'team-policy',
    description: null,
    scope: 'TENANT',
    rules: [{ action: 'read', subject: 'User' }],
    resourceStatus: ResourceStatusType.ENABLED,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const SYSTEM_FULL_ACCESS = row({ id: 'sfa', name: 'system-full-access', scope: 'GLOBAL', rules: [{ action: 'manage', subject: 'all' }] });
const RBAC_SYSTEM_MANAGE = row({
  id: 'rsm',
  name: 'rbac-system-manage',
  scope: 'GLOBAL',
  rules: [
    { action: 'manage', subject: 'Role' },
    { action: 'manage', subject: 'Policy' },
    { action: 'manage', subject: 'RolePolicy' },
    { action: 'manage', subject: 'UserRoleAssignment' },
  ],
});

function makeMocks() {
  const cls = { get: vi.fn((k: string) => (k === 'user' ? ADMIN_USER : k === 'tenantId' ? 'tenant-1' : null)), set: vi.fn() };
  const eventEmitter = { emit: vi.fn() };
  const policyRepo = { findMany: vi.fn(), count: vi.fn(), findById: vi.fn(), create: vi.fn(), update: vi.fn(), softDelete: vi.fn().mockResolvedValue(undefined) };
  const engine = { invalidatePolicy: vi.fn().mockResolvedValue(undefined) };
  return { cls, eventEmitter, policyRepo, engine };
}

function buildService(m: ReturnType<typeof makeMocks>) {
  return new PolicyService(m.policyRepo as never, m.engine as never, m.eventEmitter as never, m.cls as never);
}

describe('TASK-390 #22 — PolicyService system-lockout guard', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: PolicyService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = makeMocks();
    service = buildService(mocks);
  });

  describe('softDelete', () => {
    it('refuses to delete system-full-access', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await expect(service.softDelete('sfa')).rejects.toThrow(ForbiddenException);
      expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete rbac-system-manage', async () => {
      mocks.policyRepo.findById.mockResolvedValue(RBAC_SYSTEM_MANAGE);
      await expect(service.softDelete('rsm')).rejects.toThrow(ForbiddenException);
      expect(mocks.policyRepo.softDelete).not.toHaveBeenCalled();
    });

    it('allows deleting a non-protected policy', async () => {
      mocks.policyRepo.findById.mockResolvedValue(row());
      await service.softDelete('policy-x');
      expect(mocks.policyRepo.softDelete).toHaveBeenCalledWith('policy-x', ADMIN_USER.id);
    });
  });

  describe('update / patch mutations', () => {
    it('refuses to change a protected policy scope away from GLOBAL', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await expect(service.update('sfa', { scope: 'TENANT' })).rejects.toThrow(ForbiddenException);
      expect(mocks.policyRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to disable a protected policy', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await expect(service.patch('sfa', { resourceStatus: 'DISABLED' })).rejects.toThrow(ForbiddenException);
      expect(mocks.policyRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to strip manage:all from system-full-access', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await expect(service.update('sfa', { rules: [{ action: 'read', subject: 'User' }] })).rejects.toThrow(ForbiddenException);
      expect(mocks.policyRepo.update).not.toHaveBeenCalled();
    });

    it('refuses to invert (deny) the manage:all rule', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await expect(service.update('sfa', { rules: [{ action: 'manage', subject: 'all', inverted: true }] })).rejects.toThrow(ForbiddenException);
    });

    it('refuses to drop a core rule from rbac-system-manage', async () => {
      mocks.policyRepo.findById.mockResolvedValue(RBAC_SYSTEM_MANAGE);
      // drops manage:Policy
      await expect(
        service.patch('rsm', {
          rules: [
            { action: 'manage', subject: 'Role' },
            { action: 'manage', subject: 'RolePolicy' },
            { action: 'manage', subject: 'UserRoleAssignment' },
          ],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a safe rename/description edit on a protected policy', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      mocks.policyRepo.update.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await service.update('sfa', { description: 'Platform super-admin grant (do not delete)' });
      expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    });

    it('allows a rules edit that RETAINS the load-bearing rule', async () => {
      mocks.policyRepo.findById.mockResolvedValue(SYSTEM_FULL_ACCESS);
      mocks.policyRepo.update.mockResolvedValue(SYSTEM_FULL_ACCESS);
      await service.update('sfa', { rules: [{ action: 'manage', subject: 'all' }, { action: 'read', subject: 'AuditLog' }] });
      expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    });

    it('does not constrain edits to non-protected policies', async () => {
      mocks.policyRepo.findById.mockResolvedValue(row());
      mocks.policyRepo.update.mockResolvedValue(row({ scope: 'GLOBAL' }));
      await service.update('policy-x', { scope: 'GLOBAL', rules: [{ action: 'read', subject: 'User' }] });
      expect(mocks.policyRepo.update).toHaveBeenCalledTimes(1);
    });
  });
});
