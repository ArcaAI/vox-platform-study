/**
 * RoleEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `rbac.prisma` `Role` model and
 * `IRoleEntity` interface):
 *   - name: non-empty trimmed, <= 255 chars (unique constraint enforced at DB)
 *   - description: optional, <= 1000 chars if present
 *   - externalName: optional, <= 255 chars if present
 *   - externalId: optional, <= 255 chars if present
 */

import { describe, it, expect } from 'vitest';
import { RoleEntity, IRoleEntity } from '../generated/core/RoleEntity';
import { ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IRoleEntity> = {}): IRoleEntity {
  return {
    id: 'role-test-id',
    name: 'ADMIN',
    description: 'Administrator role',
    externalName: 'Administrator',
    externalId: 'idp-role-admin',
    RolePermissions: [],
    UserRoleAssignment: null,
    userRoleAssignmentId: null,
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
  } as IRoleEntity;
}

describe('RoleEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new RoleEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new RoleEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept null optional fields', () => {
      const entity = new RoleEntity(
        createValidInit({
          description: null,
          externalName: null,
          externalId: null,
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new RoleEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Role name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new RoleEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Role name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new RoleEntity(createValidInit({ name: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Role name must not exceed 255 characters');
    });

    it('should accept name exactly 255 characters', () => {
      const entity = new RoleEntity(createValidInit({ name: 'x'.repeat(255) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('description', () => {
    it('should throw when description exceeds 1000 characters', () => {
      const entity = new RoleEntity(createValidInit({ description: 'x'.repeat(1001) }));

      expect(() => entity.validate()).toThrow('Role description must not exceed 1000 characters');
    });

    it('should accept description exactly 1000 characters', () => {
      const entity = new RoleEntity(createValidInit({ description: 'x'.repeat(1000) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('externalName', () => {
    it('should throw when externalName exceeds 255 characters', () => {
      const entity = new RoleEntity(createValidInit({ externalName: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Role externalName must not exceed 255 characters');
    });

    it('should accept externalName exactly 255 characters', () => {
      const entity = new RoleEntity(createValidInit({ externalName: 'x'.repeat(255) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('externalId', () => {
    it('should throw when externalId exceeds 255 characters', () => {
      const entity = new RoleEntity(createValidInit({ externalId: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Role externalId must not exceed 255 characters');
    });
  });
});
