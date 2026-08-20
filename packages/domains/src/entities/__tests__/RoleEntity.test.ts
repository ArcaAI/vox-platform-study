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
    // TASK-766 OD-1: `RoleEntity` extends `BaseTenantEntity` now, whose
    // `validate()` is a hard backstop for the schema NOT NULL — every fixture
    // must carry a tenant. SYSTEM here, since ADMIN is a platform built-in.
    tenantId: '00000000-0000-0000-0000-000000000000',
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
  /**
   * TASK-766 OD-1 — `Role` is tenant-scoped, so `RoleEntity` extends
   * `BaseTenantEntity` and its `validate()` MUST chain to `super.validate()`.
   * That chain is the runtime backstop for the schema-level NOT NULL, and it
   * is easy to lose: an override that forgets the `super` call silently
   * disables the tenant guard for every hydration path. These cases fail if
   * the chain is dropped.
   */
  describe('tenant guard (BaseTenantEntity)', () => {
    it('throws when tenantId is missing', () => {
      const entity = new RoleEntity({ ...createValidInit(), tenantId: undefined } as unknown as IRoleEntity);

      expect(() => entity.validate()).toThrow(/tenantId is required/);
    });

    it('throws when tenantId is an empty string', () => {
      const entity = new RoleEntity(createValidInit({ tenantId: '' }));

      expect(() => entity.validate()).toThrow(/tenantId is required/);
    });

    it('exposes the owning tenant', () => {
      const entity = new RoleEntity(createValidInit({ tenantId: 'tenant-001' }));

      expect(entity.tenantId).toBe('tenant-001');
    });
  });

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
