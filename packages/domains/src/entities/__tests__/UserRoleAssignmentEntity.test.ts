/**
 * UserRoleAssignmentEntity.validate() Unit Tests — TASK-261 (Tier 1)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` `UserRoleAssignment`
 * model + `IUserRoleAssignmentEntity` interface):
 *   - userId: non-empty trimmed string
 *   - roleId: non-empty trimmed string
 *   - tenantId: OPTIONAL — `null` represents a global assignment that
 *     applies across all tenants (see `policy.engine.ts:236`). validate()
 *     must therefore accept `null`/`undefined` tenantId without throwing.
 */

import { describe, it, expect } from 'vitest';
import {
  UserRoleAssignmentEntity,
  IUserRoleAssignmentEntity,
} from '../generated/core/UserRoleAssignmentEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(
  overrides: Partial<IUserRoleAssignmentEntity> = {},
): IUserRoleAssignmentEntity {
  return {
    id: 'ura-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    userId: 'user-1',
    roleId: 'role-1',
    User: null,
    Roles: [],
    Tenant: null,
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
  } as IUserRoleAssignmentEntity;
}

describe('UserRoleAssignmentEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new UserRoleAssignmentEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new UserRoleAssignmentEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept null tenantId (global assignment)', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ tenantId: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept undefined tenantId', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ tenantId: undefined }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('userId', () => {
    it('should throw when userId is empty', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ userId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'UserRoleAssignment userId is required',
      );
    });

    it('should throw when userId is whitespace only', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ userId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'UserRoleAssignment userId is required',
      );
    });
  });

  describe('roleId', () => {
    it('should throw when roleId is empty', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ roleId: '' }),
      );

      expect(() => entity.validate()).toThrow(
        'UserRoleAssignment roleId is required',
      );
    });

    it('should throw when roleId is whitespace only', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ roleId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'UserRoleAssignment roleId is required',
      );
    });
  });
});
