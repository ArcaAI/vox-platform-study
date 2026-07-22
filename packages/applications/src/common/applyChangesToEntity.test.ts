/**
 * applyChangesToEntity Unit Tests
 *
 * Tests for the utility function that applies changes to domain entities.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyChangesToEntity,
  ChangeFieldHandlers,
  CustomChangeFieldHandlerProps,
} from './applyChangesToEntity';
import { BaseEntity, IBaseEntity, ResourceStatusType } from '@arcaai/domains';

// Test entity implementation
class TestEntity extends BaseEntity {
  private _name: string;
  private _value: number;
  private _tags: string[];

  constructor(
    init: IBaseEntity & { name: string; value: number; tags?: string[] }
  ) {
    super(init);
    this._name = init.name;
    this._value = init.value;
    this._tags = init.tags || [];
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  get value(): number {
    return this._value;
  }

  set value(value: number) {
    this._value = value;
  }

  get tags(): string[] {
    return this._tags;
  }

  set tags(value: string[]) {
    this._tags = value;
  }

  validate(): void {}
}

// Factory function for test entities
function createTestEntity(
  overrides: Partial<{ name: string; value: number; tags: string[] }> = {}
): TestEntity {
  return new TestEntity({
    id: 'test-id',
    createdBy: 'creator',
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    name: 'Original Name',
    value: 100,
    tags: ['tag1', 'tag2'],
    ...overrides,
  });
}

describe('applyChangesToEntity', () => {
  let entity: TestEntity;

  beforeEach(() => {
    entity = createTestEntity();
  });

  describe('basic changes', () => {
    it('should apply simple field changes to entity', async () => {
      const changes = { name: 'New Name' };

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBe('New Name');
    });

    it('should apply multiple field changes', async () => {
      const changes = { name: 'New Name', value: 200 };

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBe('New Name');
      expect(entity.value).toBe(200);
    });

    it('should not change fields not in changes object', async () => {
      const changes = { name: 'New Name' };

      await applyChangesToEntity(entity, changes);

      expect(entity.value).toBe(100); // Unchanged
      expect(entity.tags).toEqual(['tag1', 'tag2']); // Unchanged
    });

    it('should handle empty changes object', async () => {
      const changes = {};

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBe('Original Name');
      expect(entity.value).toBe(100);
    });

    it('should skip undefined values', async () => {
      const changes = { name: undefined, value: 200 };

      await applyChangesToEntity(entity, changes as any);

      expect(entity.name).toBe('Original Name'); // Unchanged
      expect(entity.value).toBe(200); // Changed
    });
  });

  describe('custom handlers', () => {
    it('should use custom handler for field transformation', async () => {
      const changes = { name: 'new name' };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        name: ({ value }) => value.toUpperCase(),
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(entity.name).toBe('NEW NAME');
    });

    it('should pass entity, changes, and value to handler', async () => {
      const changes = { name: 'New Name', value: 200 };
      let receivedProps: CustomChangeFieldHandlerProps<TestEntity, typeof changes> | null = null;

      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        name: (props) => {
          receivedProps = props;
          return props.value;
        },
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(receivedProps).not.toBeNull();
      expect(receivedProps!.entity).toBe(entity);
      expect(receivedProps!.changes).toBe(changes);
      expect(receivedProps!.value).toBe('New Name');
    });

    it('should handle async custom handlers', async () => {
      const changes = { name: 'new name' };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        name: async ({ value }) => {
          // Simulate async operation
          await new Promise((resolve) => setTimeout(resolve, 10));
          return value.toUpperCase();
        },
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(entity.name).toBe('NEW NAME');
    });

    it('should not assign value when handler returns undefined', async () => {
      const originalName = entity.name;
      const changes = { name: 'New Name' };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        name: () => undefined,
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(entity.name).toBe(originalName); // Unchanged because handler returned undefined
    });

    it('should apply default behavior for fields without handlers', async () => {
      const changes = { name: 'New Name', value: 200 };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        name: ({ value }) => value.toUpperCase(),
        // No handler for 'value'
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(entity.name).toBe('NEW NAME'); // Transformed
      expect(entity.value).toBe(200); // Default assignment
    });
  });

  describe('$apply handler', () => {
    it('should execute $apply handler but not assign its result', async () => {
      let applyWasCalled = false;
      const changes = { name: 'New Name', $apply: true };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        $apply: ({ entity, changes }) => {
          applyWasCalled = true;
          // This return value should be ignored
          return 'should-be-ignored';
        },
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(applyWasCalled).toBe(true);
      // $apply result should not be assigned to entity
      expect((entity as any).$apply).toBeUndefined();
    });

    it('should allow $apply to perform side effects', async () => {
      let sideEffectValue = '';
      const changes = { name: 'New Name', $apply: true };
      const handlers: ChangeFieldHandlers<TestEntity, typeof changes> = {
        $apply: ({ entity, changes }) => {
          sideEffectValue = `Applied changes to ${entity.id}`;
        },
      };

      await applyChangesToEntity(entity, changes, handlers);

      expect(sideEffectValue).toBe('Applied changes to test-id');
    });
  });

  describe('array fields', () => {
    it('should replace array fields', async () => {
      const changes = { tags: ['newTag1', 'newTag2', 'newTag3'] };

      await applyChangesToEntity(entity, changes);

      expect(entity.tags).toEqual(['newTag1', 'newTag2', 'newTag3']);
    });

    it('should handle empty array', async () => {
      const changes = { tags: [] };

      await applyChangesToEntity(entity, changes);

      expect(entity.tags).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle null values', async () => {
      const changes = { name: null as any };

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBeNull();
    });

    it('should handle zero values', async () => {
      const changes = { value: 0 };

      await applyChangesToEntity(entity, changes);

      expect(entity.value).toBe(0);
    });

    it('should handle empty string', async () => {
      const changes = { name: '' };

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBe('');
    });

    it('should handle boolean-like values', async () => {
      const changes = { value: 0, name: '' };

      await applyChangesToEntity(entity, changes);

      // Both should be applied even though they're falsy
      expect(entity.value).toBe(0);
      expect(entity.name).toBe('');
    });
  });

  describe('type safety', () => {
    it('should work with typed changes object', async () => {
      interface UpdateRequest {
        name?: string;
        value?: number;
      }

      const changes: UpdateRequest = { name: 'Typed Name' };

      await applyChangesToEntity(entity, changes);

      expect(entity.name).toBe('Typed Name');
    });
  });

  // (B.7) — `version` is database-owned. The only
  // legitimate writer is `Repository.updateWithVersion`. Defense in depth on
  // top of the missing public setter on `BaseEntity` and the mapper exclusion.
  describe('version is database-owned (Stream D Phase B)', () => {
    it('ignores `version` in the changes payload', async () => {
      await applyChangesToEntity(entity, { version: 99, name: 'Updated' } as any);

      expect(entity.version).toBe(1); // unchanged — entity defaulted to 1 at construction
      expect(entity.name).toBe('Updated'); // other fields still applied
    });

    it('does not call a custom handler for `version` (the guard runs before handler dispatch)', async () => {
      let handlerCalled = false;
      const handlers: ChangeFieldHandlers<TestEntity, { version?: number }> = {
        // The handler is wired but must NOT fire.
        ['version' as any]: () => {
          handlerCalled = true;
          return 42;
        },
      };

      await applyChangesToEntity(entity, { version: 99 } as any, handlers as any);

      expect(handlerCalled).toBe(false);
      expect(entity.version).toBe(1); // still unchanged
    });
  });
});
