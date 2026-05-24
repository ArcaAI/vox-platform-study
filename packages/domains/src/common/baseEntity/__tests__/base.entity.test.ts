/**
 * BaseEntity Unit Tests
 *
 * Tests for the abstract BaseEntity class that all domain entities extend.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BaseEntity, IBaseEntity, EntityId } from '../base.entity';
// Import directly from file to avoid circular dependency through barrel exports
import { ResourceStatusType } from '../../../enums/generated/ResourceStatusType';

// Concrete implementation for testing
class TestEntity extends BaseEntity {
  private _name: string;
  private _value: number;

  constructor(init: IBaseEntity & { name: string; value: number }) {
    super(init);
    this._name = init.name;
    this._value = init.value;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this.setProperty('name', value);
  }

  get value(): number {
    return this._value;
  }

  set value(value: number) {
    this.setProperty('value', value);
  }

  validate(): void {
    if (!this._name) {
      throw new Error('Name is required');
    }
  }
}

// Factory function for creating test entities
function createTestEntity(overrides: Partial<IBaseEntity & { name: string; value: number }> = {}): TestEntity {
  return new TestEntity({
    id: 'test-entity-id',
    createdBy: 'creator-id',
    updatedBy: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    resourceStatus: ResourceStatusType.ENABLED,
    name: 'Test Entity',
    value: 100,
    ...overrides,
  });
}

describe('BaseEntity', () => {
  describe('constructor', () => {
    it('should initialize with provided values', () => {
      const entity = createTestEntity();

      expect(entity.id).toBe('test-entity-id');
      expect(entity.createdBy).toBe('creator-id');
      expect(entity.updatedBy).toBeNull();
      expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
      expect(entity.name).toBe('Test Entity');
      expect(entity.value).toBe(100);
    });

    it('should default resourceStatus to ENABLED', () => {
      const entity = new TestEntity({
        id: 'test-id',
        createdBy: null,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: null,
        name: 'Test',
        value: 0,
      });

      expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
    });
  });

  describe('change tracking', () => {
    it('should track changes when properties are modified', () => {
      const entity = createTestEntity();

      entity.name = 'Updated Name';

      expect(entity.hasChanges).toBe(true);
      expect(entity.changes).toHaveProperty('name', 'Updated Name');
    });

    it('should not track changes when value is the same', () => {
      const entity = createTestEntity({ name: 'Same Name' });

      entity.name = 'Same Name';

      expect(entity.hasChanges).toBe(false);
    });

    it('should track multiple changes', () => {
      const entity = createTestEntity();

      entity.name = 'New Name';
      entity.value = 200;

      expect(entity.changes).toEqual({
        name: 'New Name',
        value: 200,
      });
    });

    it('should clear changes', () => {
      const entity = createTestEntity();
      entity.name = 'Changed';

      expect(entity.hasChanges).toBe(true);

      entity.clearChanges();

      expect(entity.hasChanges).toBe(false);
      expect(entity.changes).toEqual({});
    });
  });

  describe('resource status methods', () => {
    describe('enable', () => {
      it('should set status to ENABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.DISABLED });

        entity.enable('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
        expect(entity.isEnabled).toBe(true);
        expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.ENABLED);
        expect(entity.changes).toHaveProperty('resourceStatusUpdatedBy', 'user-id');
      });
    });

    describe('disable', () => {
      it('should set status to DISABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

        entity.disable('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.DISABLED);
        expect(entity.isDisabled).toBe(true);
      });
    });

    describe('archive', () => {
      it('should set status to ARCHIVED', () => {
        const entity = createTestEntity();

        entity.archive('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.ARCHIVED);
        expect(entity.isArchived).toBe(true);
        expect(entity.archivedAt).not.toBeNull();
      });
    });

    describe('delete', () => {
      it('should set status to DELETED', () => {
        const entity = createTestEntity();

        entity.delete('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.DELETED);
        expect(entity.isDeleted).toBe(true);
        expect(entity.deletedAt).not.toBeNull();
      });
    });

    describe('reinstate', () => {
      it('should set status from ARCHIVED to DISABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.ARCHIVED });

        entity.reinstate('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.DISABLED);
      });
    });

    describe('recoverFromDelete', () => {
      it('should set status from DELETED to DISABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.DELETED });

        entity.recoverFromDelete('user-id');

        expect(entity.resourceStatus).toBe(ResourceStatusType.DISABLED);
      });
    });

    describe('toggleEnabledDisabled', () => {
      it('should toggle from ENABLED to DISABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

        entity.toggleEnabledDisabled();

        expect(entity.resourceStatus).toBe(ResourceStatusType.DISABLED);
      });

      it('should toggle from DISABLED to ENABLED', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.DISABLED });

        entity.toggleEnabledDisabled();

        expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
      });

      it('should not toggle other statuses', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.ARCHIVED });

        entity.toggleEnabledDisabled();

        // Should remain ARCHIVED (only ENABLED/DISABLED toggle)
        expect(entity.resourceStatus).toBe(ResourceStatusType.ARCHIVED);
      });
    });
  });

  describe('status getters', () => {
    it('should return correct archivedAt when archived', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ARCHIVED });
      // Need to set resourceStatusUpdatedAt
      entity.archive();

      expect(entity.archivedAt).not.toBeNull();
    });

    it('should return null archivedAt when not archived', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

      expect(entity.archivedAt).toBeNull();
    });

    it('should return correct deletedAt when deleted', () => {
      const entity = createTestEntity();
      entity.delete();

      expect(entity.deletedAt).not.toBeNull();
    });

    it('should return null deletedAt when not deleted', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

      expect(entity.deletedAt).toBeNull();
    });
  });

  describe('equals', () => {
    it('should return true for same entity', () => {
      const entity = createTestEntity({ id: 'same-id' });

      expect(entity.equals(entity)).toBe(true);
    });

    it('should return true for entities with same id', () => {
      const entity1 = createTestEntity({ id: 'same-id' });
      const entity2 = createTestEntity({ id: 'same-id', name: 'Different Name' });

      expect(entity1.equals(entity2)).toBe(true);
    });

    it('should return false for entities with different ids', () => {
      const entity1 = createTestEntity({ id: 'id-1' });
      const entity2 = createTestEntity({ id: 'id-2' });

      expect(entity1.equals(entity2)).toBe(false);
    });

    it('should return false for null', () => {
      const entity = createTestEntity();

      expect(entity.equals(null)).toBe(false);
    });
  });

  describe('toObject', () => {
    it('should convert entity to plain object', () => {
      const entity = createTestEntity();
      const obj = entity.toObject();

      expect(obj).toHaveProperty('id', 'test-entity-id');
      expect(obj).toHaveProperty('name', 'Test Entity');
      expect(obj).toHaveProperty('value', 100);
    });

    it('should not include private underscore properties', () => {
      const entity = createTestEntity();
      const obj = entity.toObject() as Record<string, unknown>;

      expect(obj).not.toHaveProperty('_id');
      expect(obj).not.toHaveProperty('_name');
    });
  });

  describe('toRawObject', () => {
    it('should convert entity to raw object', () => {
      const entity = createTestEntity();
      const obj = entity.toRawObject();

      expect(obj).toBeDefined();
    });
  });

  describe('toJSON', () => {
    it('should return same as toObject for JSON serialization', () => {
      const entity = createTestEntity();
      const jsonResult = entity.toJSON();
      const objectResult = entity.toObject();

      expect(jsonResult).toEqual(objectResult);
    });

    it('should work with JSON.stringify', () => {
      const entity = createTestEntity();
      const jsonString = JSON.stringify(entity);
      const parsed = JSON.parse(jsonString);

      expect(parsed).toHaveProperty('id', 'test-entity-id');
      expect(parsed).toHaveProperty('name', 'Test Entity');
    });
  });

  describe('method chaining', () => {
    it('should support method chaining for status methods', () => {
      const entity = createTestEntity();

      const result = entity.disable().clearChanges().enable();

      expect(result).toBe(entity);
      expect(entity.isEnabled).toBe(true);
    });
  });

  describe('markAsDeleted', () => {
    it('should return delete data object with updatedBy', () => {
      const entity = createTestEntity();
      const deleteData = entity.markAsDeleted('user-id');

      expect(deleteData).toHaveProperty('resourceStatus', ResourceStatusType.DELETED);
      expect(deleteData).toHaveProperty('resourceStatusUpdatedBy', 'user-id');
      expect(deleteData).toHaveProperty('resourceStatusUpdatedAt');
    });

    it('should return delete data object without updatedBy', () => {
      const entity = createTestEntity();
      const deleteData = entity.markAsDeleted();

      expect(deleteData).toHaveProperty('resourceStatus', ResourceStatusType.DELETED);
      expect(deleteData).toHaveProperty('resourceStatusUpdatedBy', undefined);
      expect(deleteData).toHaveProperty('resourceStatusUpdatedAt');
    });

    it('should return timestamp close to current time', () => {
      const entity = createTestEntity();
      const beforeCall = new Date();
      const deleteData = entity.markAsDeleted() as { resourceStatusUpdatedAt: Date };
      const afterCall = new Date();

      expect(deleteData.resourceStatusUpdatedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(deleteData.resourceStatusUpdatedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
    });
  });

  describe('Soft-Delete Lifecycle', () => {
    describe('complete soft-delete flow', () => {
      it('should transition through all states correctly', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

        // Start enabled
        expect(entity.isEnabled).toBe(true);
        expect(entity.isDeleted).toBe(false);

        // Soft delete
        entity.delete('admin-user');
        expect(entity.isDeleted).toBe(true);
        expect(entity.isEnabled).toBe(false);
        expect(entity.deletedAt).not.toBeNull();
        expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.DELETED);
        expect(entity.changes).toHaveProperty('resourceStatusUpdatedBy', 'admin-user');

        // Recover from delete
        entity.recoverFromDelete('admin-user');
        expect(entity.isDeleted).toBe(false);
        expect(entity.isDisabled).toBe(true);
        expect(entity.deletedAt).toBeNull();

        // Re-enable
        entity.enable('admin-user');
        expect(entity.isEnabled).toBe(true);
      });

      it('should track all changes during soft-delete lifecycle', () => {
        const entity = createTestEntity();
        entity.clearChanges();

        entity.delete('user-1');

        expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.DELETED);
        expect(entity.changes).toHaveProperty('resourceStatusUpdatedAt');
        expect(entity.changes).toHaveProperty('resourceStatusUpdatedBy', 'user-1');
      });
    });

    describe('delete without updatedBy', () => {
      it('should soft delete without tracking user', () => {
        const entity = createTestEntity();

        entity.delete();

        expect(entity.isDeleted).toBe(true);
        expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.DELETED);
        expect(entity.changes).not.toHaveProperty('resourceStatusUpdatedBy');
      });
    });

    describe('recoverFromDelete without updatedBy', () => {
      it('should recover without tracking user', () => {
        const entity = createTestEntity({ resourceStatus: ResourceStatusType.DELETED });

        entity.recoverFromDelete();

        expect(entity.isDisabled).toBe(true);
        expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.DISABLED);
        expect(entity.changes).not.toHaveProperty('resourceStatusUpdatedBy');
      });
    });
  });

  describe('Status Transition Edge Cases', () => {
    it('should allow delete from any status', () => {
      const statuses = [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED, ResourceStatusType.ARCHIVED];

      statuses.forEach((status) => {
        const entity = createTestEntity({ resourceStatus: status });
        entity.delete();
        expect(entity.isDeleted).toBe(true);
      });
    });

    it('should allow multiple deletes (idempotent)', () => {
      const entity = createTestEntity();

      entity.delete('user-1');
      const firstDeleteTime = entity.resourceStatusUpdatedAt;

      // Small delay to ensure different timestamp
      entity.delete('user-2');
      const secondDeleteTime = entity.resourceStatusUpdatedAt;

      expect(entity.isDeleted).toBe(true);
      // Timestamp should be updated on second delete
      expect(secondDeleteTime?.getTime()).toBeGreaterThanOrEqual(firstDeleteTime?.getTime() || 0);
    });

    it('should preserve entity data after soft delete', () => {
      const entity = createTestEntity({ name: 'Important Data', value: 999 });

      entity.delete();

      // Entity data should still be accessible
      expect(entity.name).toBe('Important Data');
      expect(entity.value).toBe(999);
      expect(entity.id).toBe('test-entity-id');
    });
  });

  describe('resourceStatusUpdatedAt and resourceStatusUpdatedBy', () => {
    it('should update timestamp on each status change', () => {
      vi.useFakeTimers();
      const baseTime = new Date('2026-01-01T00:00:00Z');
      vi.setSystemTime(baseTime);

      const entity = createTestEntity();
      const initialTime = entity.resourceStatusUpdatedAt;

      // Advance time to ensure different timestamps
      vi.advanceTimersByTime(1000);
      entity.disable();
      const afterDisable = entity.resourceStatusUpdatedAt;

      vi.advanceTimersByTime(1000);
      entity.enable();
      const afterEnable = entity.resourceStatusUpdatedAt;

      // Each operation should update the timestamp
      expect(afterDisable).not.toEqual(initialTime);
      expect(afterEnable).not.toEqual(afterDisable);

      vi.useRealTimers();
    });

    it('should track updatedBy for all status methods', () => {
      const entity = createTestEntity();

      entity.enable('user-enable');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-enable');

      entity.clearChanges();
      entity.disable('user-disable');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-disable');

      entity.clearChanges();
      entity.archive('user-archive');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-archive');

      entity.clearChanges();
      entity.delete('user-delete');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-delete');

      entity.clearChanges();
      entity.recoverFromDelete('user-recover');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-recover');

      entity.clearChanges();
      entity.reinstate('user-reinstate');
      expect(entity.changes.resourceStatusUpdatedBy).toBe('user-reinstate');
    });
  });

  describe('Getters for Soft-Delete Status', () => {
    it('isDeleted should return true only for DELETED status', () => {
      const statuses = [
        { status: ResourceStatusType.ENABLED, expected: false },
        { status: ResourceStatusType.DISABLED, expected: false },
        { status: ResourceStatusType.ARCHIVED, expected: false },
        { status: ResourceStatusType.DELETED, expected: true },
      ];

      statuses.forEach(({ status, expected }) => {
        const entity = createTestEntity({ resourceStatus: status });
        expect(entity.isDeleted).toBe(expected);
      });
    });

    it('deletedAt should return timestamp only when DELETED', () => {
      const entity = createTestEntity({ resourceStatus: ResourceStatusType.ENABLED });

      expect(entity.deletedAt).toBeNull();

      entity.delete();

      expect(entity.deletedAt).not.toBeNull();
      expect(entity.deletedAt).toBeInstanceOf(Date);
    });

    it('deletedAt should return null after recovery', () => {
      const entity = createTestEntity();
      entity.delete();

      expect(entity.deletedAt).not.toBeNull();

      entity.recoverFromDelete();

      expect(entity.deletedAt).toBeNull();
    });
  });

  describe('version (TASK-302 Stream D Phase B)', () => {
    it('defaults to 1 when not provided in init', () => {
      const entity = createTestEntity();
      expect(entity.version).toBe(1);
    });

    it('reads the version supplied in init', () => {
      const entity = createTestEntity({ version: 7 });
      expect(entity.version).toBe(7);
    });

    it('does not expose a public setter (DB-owned)', () => {
      const entity = createTestEntity();
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(entity),
        'version',
      );
      expect(descriptor?.set).toBeUndefined();
    });

    it('version is not tracked in entity.changes when internal field is poked', () => {
      const entity = createTestEntity();
      // even if a buggy caller force-pokes the internal:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entity as any)._version = 99;
      expect(entity.hasChanges).toBe(false);
    });
  });
});
