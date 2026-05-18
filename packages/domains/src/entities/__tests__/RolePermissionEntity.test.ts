/**
 * RolePermissionEntity.validate() Unit Tests — TASK-261 (Tier 1)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Join entity. Invariants under test (derived from `IRolePermissionEntity`
 * interface):
 *   - roleId: non-empty trimmed string
 *   - permissionId: non-empty trimmed string
 */

import { describe, it, expect } from 'vitest';
import {
  RolePermissionEntity,
  IRolePermissionEntity,
} from '../generated/core/RolePermissionEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(
  overrides: Partial<IRolePermissionEntity> = {},
): IRolePermissionEntity {
  return {
    id: 'rp-test-id',
    roleId: 'role-1',
    permissionId: 'perm-1',
    Role: null,
    Permission: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as IRolePermissionEntity;
}

describe('RolePermissionEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new RolePermissionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new RolePermissionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });
  });

  describe('roleId', () => {
    it('should throw when roleId is empty', () => {
      const entity = new RolePermissionEntity(
        createValidInit({ roleId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'RolePermission roleId is required',
      );
    });

    it('should throw when roleId is whitespace only', () => {
      const entity = new RolePermissionEntity(
        createValidInit({ roleId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'RolePermission roleId is required',
      );
    });
  });

  describe('permissionId', () => {
    it('should throw when permissionId is empty', () => {
      const entity = new RolePermissionEntity(
        createValidInit({ permissionId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'RolePermission permissionId is required',
      );
    });

    it('should throw when permissionId is whitespace only', () => {
      const entity = new RolePermissionEntity(
        createValidInit({ permissionId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'RolePermission permissionId is required',
      );
    });
  });
});
