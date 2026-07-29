/**
 * PermissionEntity.validate() Unit Tests
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `IPermissionEntity` interface; the
 * `Permission` Prisma model has been superseded by `Policy`, so we
 * validate against the entity surface only):
 *   - name: non-empty trimmed, <= 255 chars
 *   - resourceTypeName: non-empty trimmed, <= 255 chars
 *   - permissionAction: must be a member of `Enums.PermissionAction`
 *   - description: optional, <= 1000 chars if present
 */

import { describe, it, expect } from 'vitest';
import { PermissionEntity, IPermissionEntity } from '../generated/core/PermissionEntity';
import { PermissionAction, ResourceStatusType } from '../../enums';

function createValidInit(overrides: Partial<IPermissionEntity> = {}): IPermissionEntity {
  return {
    id: 'perm-test-id',
    name: 'read.user',
    description: 'Allows reading users',
    permissionAction: PermissionAction.READ,
    resourceTypeName: 'User',
    conditions: null,
    RolePermissions: [],
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
  } as IPermissionEntity;
}

describe('PermissionEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new PermissionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new PermissionEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it.each(Object.values(PermissionAction))('should accept permissionAction %s', (permissionAction) => {
      const entity = new PermissionEntity(createValidInit({ permissionAction }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('name', () => {
    it('should throw when name is empty', () => {
      const entity = new PermissionEntity(createValidInit({ name: '' }));

      expect(() => entity.validate()).toThrow('Permission name is required');
    });

    it('should throw when name is whitespace only', () => {
      const entity = new PermissionEntity(createValidInit({ name: '   ' }));

      expect(() => entity.validate()).toThrow('Permission name is required');
    });

    it('should throw when name exceeds 255 characters', () => {
      const entity = new PermissionEntity(createValidInit({ name: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Permission name must not exceed 255 characters');
    });

    it('should accept name exactly 255 characters', () => {
      const entity = new PermissionEntity(createValidInit({ name: 'x'.repeat(255) }));

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('resourceTypeName', () => {
    it('should throw when resourceTypeName is empty', () => {
      const entity = new PermissionEntity(createValidInit({ resourceTypeName: '' }));

      expect(() => entity.validate()).toThrow('Permission resourceTypeName is required');
    });

    it('should throw when resourceTypeName is whitespace only', () => {
      const entity = new PermissionEntity(createValidInit({ resourceTypeName: '   ' }));

      expect(() => entity.validate()).toThrow('Permission resourceTypeName is required');
    });

    it('should throw when resourceTypeName exceeds 255 characters', () => {
      const entity = new PermissionEntity(createValidInit({ resourceTypeName: 'x'.repeat(256) }));

      expect(() => entity.validate()).toThrow('Permission resourceTypeName must not exceed 255 characters');
    });
  });

  describe('permissionAction', () => {
    it('should throw when permissionAction is undefined', () => {
      const entity = new PermissionEntity(
        createValidInit({
          permissionAction: undefined as unknown as PermissionAction,
        }),
      );

      expect(() => entity.validate()).toThrow('Permission permissionAction is required');
    });

    it('should throw when permissionAction is not a member of PermissionAction', () => {
      const entity = new PermissionEntity(
        createValidInit({
          permissionAction: 'EXECUTE' as unknown as PermissionAction,
        }),
      );

      expect(() => entity.validate()).toThrow('Permission permissionAction is invalid');
    });
  });

  describe('description', () => {
    it('should accept null description', () => {
      const entity = new PermissionEntity(createValidInit({ description: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should accept undefined description', () => {
      const entity = new PermissionEntity(createValidInit({ description: undefined }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when description exceeds 1000 characters', () => {
      const entity = new PermissionEntity(createValidInit({ description: 'x'.repeat(1001) }));

      expect(() => entity.validate()).toThrow('Permission description must not exceed 1000 characters');
    });
  });
});
