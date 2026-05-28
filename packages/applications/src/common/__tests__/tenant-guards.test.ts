/**
 * Unit tests for tenant-guards helper module (TASK-305 D.1).
 *
 * The helper exists so cross-aggregate service writes can enforce tenant
 * isolation without leaking the existence of cross-tenant resources. The
 * "no-existence-leak" rule says: a tenant mismatch MUST surface as
 * `NotFoundException`, never `ForbiddenException`, and the thrown message
 * MUST NOT carry the other tenant's id back to the caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ResourceStatusType } from '@arcaai/domains';

import { assertEqualTenants, assertUserBelongsToTenant, assertParentInScope, isSuperAdmin } from '../tenant-guards';

describe('tenant-guards', () => {
  describe('assertEqualTenants', () => {
    it('throws NotFoundException when both parent and child are null (parent check fires first)', () => {
      expect(() => assertEqualTenants(null, null)).toThrow(NotFoundException);
    });

    it('throws NotFoundException when parent is null', () => {
      expect(() => assertEqualTenants(null, { tenantId: 'tenant-a' })).toThrow(NotFoundException);
    });

    it('throws NotFoundException when parent is undefined', () => {
      expect(() => assertEqualTenants(undefined, { tenantId: 'tenant-a' })).toThrow(NotFoundException);
    });

    it('throws BadRequestException when child is null but parent is valid', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, null)).toThrow(BadRequestException);
    });

    it('throws BadRequestException when child is undefined but parent is valid', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, undefined)).toThrow(BadRequestException);
    });

    it('throws BadRequestException when parent.tenantId is missing (null)', () => {
      expect(() => assertEqualTenants({ tenantId: null }, { tenantId: 'tenant-a' })).toThrow(BadRequestException);
    });

    it('throws BadRequestException when parent.tenantId is missing (undefined)', () => {
      expect(() => assertEqualTenants({}, { tenantId: 'tenant-a' })).toThrow(BadRequestException);
    });

    it('throws BadRequestException when parent.tenantId is an empty string', () => {
      expect(() => assertEqualTenants({ tenantId: '' }, { tenantId: 'tenant-a' })).toThrow(BadRequestException);
    });

    it('throws BadRequestException when child.tenantId is missing (null)', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, { tenantId: null })).toThrow(BadRequestException);
    });

    it('throws BadRequestException when child.tenantId is missing (undefined)', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, {})).toThrow(BadRequestException);
    });

    it('throws BadRequestException when child.tenantId is an empty string', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, { tenantId: '' })).toThrow(BadRequestException);
    });

    it('throws NotFoundException with a non-leaking message on tenant mismatch', () => {
      const parentTenant = 'parent-tenant-xyz-secret';
      const childTenant = 'child-tenant-abc';

      let caught: unknown;
      try {
        assertEqualTenants({ tenantId: parentTenant }, { tenantId: childTenant });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NotFoundException);
      const message = (caught as NotFoundException).message;
      expect(message).not.toContain(parentTenant);
    });

    it('returns void when parent and child tenantIds match', () => {
      expect(() => assertEqualTenants({ tenantId: 'tenant-a' }, { tenantId: 'tenant-a' })).not.toThrow();
      expect(assertEqualTenants({ tenantId: 'tenant-a' }, { tenantId: 'tenant-a' })).toBeUndefined();
    });
  });

  describe('assertUserBelongsToTenant', () => {
    const makeRepoMock = () => ({
      findFirst: vi.fn(),
    });

    it('throws BadRequestException when userId is empty', async () => {
      const repo = makeRepoMock();
      await expect(assertUserBelongsToTenant(repo as never, '', 'tenant-a')).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findFirst).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when tenantId is empty', async () => {
      const repo = makeRepoMock();
      await expect(assertUserBelongsToTenant(repo as never, 'user-a', '')).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findFirst).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when userId is null/undefined', async () => {
      const repo = makeRepoMock();
      await expect(assertUserBelongsToTenant(repo as never, null as unknown as string, 'tenant-a')).rejects.toBeInstanceOf(BadRequestException);
      await expect(assertUserBelongsToTenant(repo as never, undefined as unknown as string, 'tenant-a')).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.findFirst).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when repository.findFirst returns null', async () => {
      const repo = makeRepoMock();
      repo.findFirst.mockResolvedValue(null);
      await expect(assertUserBelongsToTenant(repo as never, 'user-a', 'tenant-a')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when repository.findFirst throws DataNotFoundException', async () => {
      const repo = makeRepoMock();
      repo.findFirst.mockRejectedValue(new DataNotFoundException('UserRoleAssignment', 'not-found'));
      await expect(assertUserBelongsToTenant(repo as never, 'user-a', 'tenant-a')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns void when an enabled assignment exists for (userId, tenantId)', async () => {
      const repo = makeRepoMock();
      repo.findFirst.mockResolvedValue({
        id: 'ura-1',
        userId: 'user-a',
        tenantId: 'tenant-a',
        resourceStatus: ResourceStatusType.ENABLED,
      });

      await expect(assertUserBelongsToTenant(repo as never, 'user-a', 'tenant-a')).resolves.toBeUndefined();
    });

    it('queries findFirst with where: { userId, tenantId, resourceStatus: ENABLED }', async () => {
      const repo = makeRepoMock();
      repo.findFirst.mockResolvedValue({
        id: 'ura-1',
        userId: 'user-a',
        tenantId: 'tenant-a',
        resourceStatus: ResourceStatusType.ENABLED,
      });

      await assertUserBelongsToTenant(repo as never, 'user-a', 'tenant-a');

      expect(repo.findFirst).toHaveBeenCalledTimes(1);
      expect(repo.findFirst).toHaveBeenCalledWith({
        where: {
          userId: 'user-a',
          tenantId: 'tenant-a',
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    });

    it('re-throws non-DataNotFound errors from the repository', async () => {
      const repo = makeRepoMock();
      const boom = new Error('DB connection lost');
      repo.findFirst.mockRejectedValue(boom);
      await expect(assertUserBelongsToTenant(repo as never, 'user-a', 'tenant-a')).rejects.toBe(boom);
    });
  });

  describe('assertParentInScope', () => {
    type Parent = { id: string; tenantId?: string | null };

    const makeRepoMock = () => ({
      findById: vi.fn<(id: string) => Promise<Parent | null>>(),
    });

    it('throws NotFoundException when findById returns null', async () => {
      const repo = makeRepoMock();
      repo.findById.mockResolvedValue(null);
      await expect(assertParentInScope(repo, 'parent-1', 'tenant-a')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when findById throws DataNotFoundException', async () => {
      const repo = makeRepoMock();
      repo.findById.mockRejectedValue(new DataNotFoundException('Parent', 'parent-1'));
      await expect(assertParentInScope(repo, 'parent-1', 'tenant-a')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the parent when findById succeeds with matching tenantId', async () => {
      const repo = makeRepoMock();
      const parent: Parent = { id: 'parent-1', tenantId: 'tenant-a' };
      repo.findById.mockResolvedValue(parent);

      const result = await assertParentInScope(repo, 'parent-1', 'tenant-a');

      expect(result).toBe(parent);
      expect(repo.findById).toHaveBeenCalledWith('parent-1');
    });

    it('throws NotFoundException when findById returns a parent in a different tenant', async () => {
      const repo = makeRepoMock();
      repo.findById.mockResolvedValue({ id: 'parent-1', tenantId: 'tenant-other-secret' });

      let caught: unknown;
      try {
        await assertParentInScope(repo, 'parent-1', 'tenant-a');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotFoundException);
      expect((caught as NotFoundException).message).not.toContain('tenant-other-secret');
    });

    it('re-throws non-DataNotFound errors from findById', async () => {
      const repo = makeRepoMock();
      const boom = new Error('DB connection lost');
      repo.findById.mockRejectedValue(boom);
      await expect(assertParentInScope(repo, 'parent-1', 'tenant-a')).rejects.toBe(boom);
    });
  });

  // TASK-307 W5.5 (AC-19) — pure predicate used by inline controller
  // guards (W5.5 TenantController, W5.7 AuditLogController, W5.9 SmrProxy).
  describe('isSuperAdmin', () => {
    it('returns false for null / undefined user', () => {
      expect(isSuperAdmin(null)).toBe(false);
      expect(isSuperAdmin(undefined)).toBe(false);
    });

    it('returns false when user has no roles property', () => {
      expect(isSuperAdmin({})).toBe(false);
    });

    it('returns false when user.roles is null', () => {
      expect(isSuperAdmin({ roles: null })).toBe(false);
    });

    it('returns false when user.roles is empty', () => {
      expect(isSuperAdmin({ roles: [] })).toBe(false);
    });

    it('returns false when user.roles contains other roles but not SUPER_ADMIN', () => {
      expect(isSuperAdmin({ roles: ['DOCTOR', 'NURSE', 'ADMIN'] })).toBe(false);
    });

    it('returns true when user.roles includes the exact "SUPER_ADMIN" literal', () => {
      expect(isSuperAdmin({ roles: ['SUPER_ADMIN'] })).toBe(true);
      expect(isSuperAdmin({ roles: ['DOCTOR', 'SUPER_ADMIN'] })).toBe(true);
    });

    it('is case-sensitive — "super_admin" or "SuperAdmin" does NOT grant the bypass', () => {
      expect(isSuperAdmin({ roles: ['super_admin'] })).toBe(false);
      expect(isSuperAdmin({ roles: ['SuperAdmin'] })).toBe(false);
    });
  });
});
