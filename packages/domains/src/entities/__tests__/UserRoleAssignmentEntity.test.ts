/**
 * UserRoleAssignmentEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `user.prisma` `UserRoleAssignment`
 * model + `IUserRoleAssignmentEntity` interface):
 *   - userId: non-empty trimmed string
 *   - roleId: non-empty trimmed string
 *   - tenantId: REQUIRED (schema is NOT NULL,
 *     validate() refuses empty/null/undefined). The pre-W1.3 "global
 *     assignment via null tenantId" pattern is gone; platform-wide
 *     role assignments (GLOBAL_ADMIN, system service account) belong
 *     to SYSTEM_TENANT_ID now.
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

    it('should reject null tenantId (Phase A — platform roles use SYSTEM_TENANT_ID)', () => {
      // Previously this case was a positive assertion ("global
      // role assignments may omit tenantId"). The new contract
      // requires every role assignment row to carry a concrete tenant
      // (SYSTEM_TENANT_ID for platform-wide roles like GLOBAL_ADMIN).
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ tenantId: null as unknown as string }),
      );

      expect(() => entity.validate()).toThrow(
        /UserRoleAssignmentEntity is missing tenant context/,
      );
    });

    it('should reject undefined tenantId (same rationale as null)', () => {
      const entity = new UserRoleAssignmentEntity(
        createValidInit({ tenantId: undefined as unknown as string }),
      );

      expect(() => entity.validate()).toThrow(
        /UserRoleAssignmentEntity is missing tenant context/,
      );
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
