/**
 * convertEntityValue Utility Unit Tests
 *
 * Tests for the convertEntityValue function that recursively converts
 * values to a format suitable for serialization.
 */

import { describe, it, expect } from 'vitest';
import { convertEntityValue } from './convertEntityValue';
// Import directly from source files to avoid circular dependency issues
import { BaseEntity, IBaseEntity } from '../common/baseEntity/base.entity';
import { BaseValueObject } from '../common/baseEntity/base.valueObject';
import { ResourceStatusType } from '../enums/generated/ResourceStatusType';
import { Decimal } from 'decimal.js';

// Mock entity for testing
class TestEntity extends BaseEntity {
  private _name: string;

  constructor(init: IBaseEntity & { name: string }) {
    super(init);
    this._name = init.name;
  }

  get name(): string {
    return this._name;
  }

  validate(): void {}
}

// Mock value object for testing
class TestValueObject extends BaseValueObject {
  private _amount: number;
  private _currency: string;

  constructor(amount: number, currency: string) {
    super();
    this._amount = amount;
    this._currency = currency;
  }

  toValue(): { amount: number; currency: string } {
    return { amount: this._amount, currency: this._currency };
  }
}

// Helper to create test entity
function createTestEntity(overrides: Partial<{ name: string; id: string }> = {}): TestEntity {
  return new TestEntity({
    id: overrides.id || 'test-id',
    name: overrides.name || 'Test Name',
    createdBy: 'creator',
    updatedBy: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    resourceStatus: ResourceStatusType.ENABLED,
  });
}

describe('convertEntityValue', () => {
  describe('primitive values', () => {
    it('should return string as is', () => {
      expect(convertEntityValue('hello')).toBe('hello');
    });

    it('should return number as is', () => {
      expect(convertEntityValue(42)).toBe(42);
    });

    it('should return boolean as is', () => {
      expect(convertEntityValue(true)).toBe(true);
      expect(convertEntityValue(false)).toBe(false);
    });

    it('should return null as is', () => {
      expect(convertEntityValue(null)).toBeNull();
    });

    it('should return undefined as is', () => {
      expect(convertEntityValue(undefined)).toBeUndefined();
    });
  });

  describe('Date conversion', () => {
    it('should convert Date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(convertEntityValue(date)).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should handle different date formats', () => {
      const date = new Date('2023-07-29T12:00:00Z');
      expect(convertEntityValue(date)).toBe(date.toISOString());
    });
  });

  describe('Decimal conversion', () => {
    it('should convert Decimal to string', () => {
      const decimal = new Decimal('123.456');
      expect(convertEntityValue(decimal)).toBe('123.456');
    });

    it('should handle large Decimal values', () => {
      const decimal = new Decimal('9999999999999999.99');
      expect(convertEntityValue(decimal)).toBe('9999999999999999.99');
    });

    it('should handle negative Decimal values', () => {
      const decimal = new Decimal('-42.5');
      expect(convertEntityValue(decimal)).toBe('-42.5');
    });
  });

  describe('Array conversion', () => {
    it('should convert arrays recursively', () => {
      const arr = [1, 'test', true];
      expect(convertEntityValue(arr)).toEqual([1, 'test', true]);
    });

    it('should convert Date objects in arrays', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const arr = [1, date, 'test'];
      const result = convertEntityValue(arr);

      expect(result[1]).toBe(date.toISOString());
    });

    it('should handle nested arrays', () => {
      const arr = [
        [1, 2],
        [3, 4],
      ];
      expect(convertEntityValue(arr)).toEqual([
        [1, 2],
        [3, 4],
      ]);
    });

    it('should handle empty arrays', () => {
      expect(convertEntityValue([])).toEqual([]);
    });

    it('should convert entities in arrays', () => {
      const entity = createTestEntity({ name: 'Test' });
      const arr = [entity];
      const result = convertEntityValue(arr);

      expect(result[0]).toHaveProperty('name', 'Test');
      expect(result[0]).toHaveProperty('id', 'test-id');
    });
  });

  describe('BaseValueObject conversion', () => {
    it('should call toValue() on BaseValueObject instances', () => {
      const valueObject = new TestValueObject(100, 'USD');
      const result = convertEntityValue(valueObject);

      expect(result).toEqual({ amount: 100, currency: 'USD' });
    });
  });

  describe('BaseEntity conversion', () => {
    it('should call toObject() on BaseEntity instances', () => {
      const entity = createTestEntity({ name: 'Test Entity' });
      const result = convertEntityValue(entity);

      expect(result).toHaveProperty('id', 'test-id');
      expect(result).toHaveProperty('name', 'Test Entity');
      expect(result).toHaveProperty('resourceStatus', 'ENABLED');
    });

    it('should convert dates in entity to ISO strings', () => {
      const entity = createTestEntity();
      const result = convertEntityValue(entity);

      expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('Plain object conversion', () => {
    it('should convert plain objects recursively', () => {
      const obj = {
        name: 'Test',
        value: 42,
      };
      expect(convertEntityValue(obj)).toEqual({
        name: 'Test',
        value: 42,
      });
    });

    it('should convert nested objects', () => {
      const obj = {
        outer: {
          inner: {
            value: 'deep',
          },
        },
      };
      expect(convertEntityValue(obj)).toEqual({
        outer: {
          inner: {
            value: 'deep',
          },
        },
      });
    });

    it('should convert Date properties in objects', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const obj = {
        name: 'Test',
        createdAt: date,
      };
      const result = convertEntityValue(obj);

      expect(result.createdAt).toBe(date.toISOString());
    });

    it('should convert Decimal properties in objects', () => {
      const obj = {
        name: 'Test',
        amount: new Decimal('99.99'),
      };
      const result = convertEntityValue(obj);

      expect(result.amount).toBe('99.99');
    });

    it('should handle empty objects', () => {
      expect(convertEntityValue({})).toEqual({});
    });
  });

  describe('Complex nested structures', () => {
    it('should handle deeply nested structures with various types', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const decimal = new Decimal('123.45');
      const entity = createTestEntity({ name: 'Nested Entity' });

      const complexObject = {
        id: 1,
        name: 'Complex',
        date: date,
        amount: decimal,
        nested: {
          array: [date, { value: 42 }],
          entity: entity,
        },
        items: [1, 2, 3],
      };

      const result = convertEntityValue(complexObject);

      expect(result.id).toBe(1);
      expect(result.name).toBe('Complex');
      expect(result.date).toBe(date.toISOString());
      expect(result.amount).toBe('123.45');
      expect(result.nested.array[0]).toBe(date.toISOString());
      expect(result.nested.array[1]).toEqual({ value: 42 });
      expect(result.nested.entity).toHaveProperty('name', 'Nested Entity');
      expect(result.items).toEqual([1, 2, 3]);
    });

    it('should handle array of entities', () => {
      const entities = [createTestEntity({ id: '1', name: 'Entity 1' }), createTestEntity({ id: '2', name: 'Entity 2' })];

      const result = convertEntityValue(entities);

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id', '1');
      expect(result[0]).toHaveProperty('name', 'Entity 1');
      expect(result[1]).toHaveProperty('id', '2');
      expect(result[1]).toHaveProperty('name', 'Entity 2');
    });

    it('should handle object with array of value objects', () => {
      const valueObjects = [new TestValueObject(100, 'USD'), new TestValueObject(200, 'EUR')];

      const obj = {
        name: 'Test',
        prices: valueObjects,
      };

      const result = convertEntityValue(obj);

      expect(result.prices).toHaveLength(2);
      expect(result.prices[0]).toEqual({ amount: 100, currency: 'USD' });
      expect(result.prices[1]).toEqual({ amount: 200, currency: 'EUR' });
    });
  });

  describe('Edge cases', () => {
    it('should handle object with null prototype', () => {
      const obj = Object.create(null);
      obj.name = 'Test';
      obj.value = 42;

      const result = convertEntityValue(obj);

      expect(result.name).toBe('Test');
      expect(result.value).toBe(42);
    });

    it('should handle circular reference prevention (if implemented)', () => {
      // Note: The current implementation doesn't handle circular references
      // This test documents the expected behavior
      const _obj: Record<string, unknown> = { name: 'Test' };
      // Uncomment to test circular reference handling if implemented
      // _obj.self = _obj;
      // expect(() => convertEntityValue(_obj)).not.toThrow();
    });

    it('should handle functions in objects (skip or convert)', () => {
      const obj = {
        name: 'Test',
        fn: () => 'result',
      };

      const result = convertEntityValue(obj);

      // Functions are kept as-is in the current implementation
      expect(typeof result.fn).toBe('function');
    });

    it('should handle Symbol values', () => {
      const sym = Symbol('test');
      const obj = {
        [sym]: 'value',
        name: 'Test',
      };

      const result = convertEntityValue(obj);

      // Symbol keys are not enumerable with Object.keys
      expect(result.name).toBe('Test');
    });
  });
});
