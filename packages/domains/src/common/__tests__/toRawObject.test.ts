/**
 * toRawObject Utility Unit Tests
 *
 * Tests for the toRawObject function that converts class instances
 * to plain objects while preserving property names (including underscores).
 */

import { describe, it, expect } from 'vitest';
import { toRawObject } from '../toRawObject';

describe('toRawObject', () => {
  describe('basic conversion', () => {
    it('should preserve underscore-prefixed properties', () => {
      const target = {
        _id: '123',
        _name: 'Test',
        _value: 42,
      };

      const result = toRawObject(target);

      expect(result).toEqual({
        _id: '123',
        _name: 'Test',
        _value: 42,
      });
    });

    it('should keep non-underscore properties unchanged', () => {
      const target = {
        id: '123',
        name: 'Test',
      };

      const result = toRawObject(target);

      expect(result).toEqual({
        id: '123',
        name: 'Test',
      });
    });

    it('should handle mixed underscore and non-underscore properties', () => {
      const target = {
        _id: '123',
        name: 'Test',
        _value: 42,
        status: 'ENABLED',
      };

      const result = toRawObject(target);

      expect(result).toEqual({
        _id: '123',
        name: 'Test',
        _value: 42,
        status: 'ENABLED',
      });
    });
  });

  describe('value conversion', () => {
    it('should convert Date objects to ISO strings', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      const target = {
        _createdAt: date,
      };

      const result = toRawObject(target) as { _createdAt: string };

      expect(result._createdAt).toBe(date.toISOString());
    });

    it('should convert arrays recursively', () => {
      const target = {
        _items: [1, 2, 3],
      };

      const result = toRawObject(target) as { _items: number[] };

      expect(result._items).toEqual([1, 2, 3]);
    });

    it('should convert nested objects recursively', () => {
      const target = {
        _nested: {
          key: 'value',
          number: 42,
        },
      };

      const result = toRawObject(target) as { _nested: { key: string; number: number } };

      expect(result._nested).toEqual({
        key: 'value',
        number: 42,
      });
    });

    it('should handle null values', () => {
      const target = {
        _nullable: null,
      };

      const result = toRawObject(target) as { _nullable: null };

      expect(result._nullable).toBeNull();
    });

    it('should handle undefined values', () => {
      const target = {
        _undefined: undefined,
      };

      const result = toRawObject(target) as { _undefined: undefined };

      expect(result._undefined).toBeUndefined();
    });

    it('should handle primitive values', () => {
      const target = {
        _string: 'test',
        _number: 123,
        _boolean: true,
      };

      const result = toRawObject(target) as { _string: string; _number: number; _boolean: boolean };

      expect(result._string).toBe('test');
      expect(result._number).toBe(123);
      expect(result._boolean).toBe(true);
    });
  });

  describe('immutability', () => {
    it('should return a frozen object', () => {
      const target = {
        _id: '123',
      };

      const result = toRawObject(target);

      expect(Object.isFrozen(result)).toBe(true);
    });

    it('should not allow modifications to the returned object', () => {
      const target = {
        _id: '123',
      };

      const result = toRawObject(target) as { _id: string };

      expect(() => {
        (result as any)._id = 'modified';
      }).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty object', () => {
      const target = {};

      const result = toRawObject(target);

      expect(result).toEqual({});
    });

    it('should handle properties with multiple underscores', () => {
      const target = {
        __doubleUnderscore: 'value',
      };

      const result = toRawObject(target) as { __doubleUnderscore: string };

      expect(result.__doubleUnderscore).toBe('value');
    });
  });

  describe('class instance conversion', () => {
    it('should convert class instance to plain object preserving underscores', () => {
      class TestClass {
        private _id: string;
        private _name: string;

        constructor(id: string, name: string) {
          this._id = id;
          this._name = name;
        }
      }

      const instance = new TestClass('123', 'Test');
      const result = toRawObject(instance) as { _id: string; _name: string };

      expect(result._id).toBe('123');
      expect(result._name).toBe('Test');
    });
  });

  describe('comparison with toObject', () => {
    it('should differ from toObject by preserving underscores', () => {
      const target = {
        _id: '123',
        _name: 'Test',
      };

      const rawResult = toRawObject(target) as { _id: string; _name: string };

      // toRawObject preserves underscores
      expect(rawResult).toHaveProperty('_id');
      expect(rawResult).toHaveProperty('_name');
      expect(rawResult).not.toHaveProperty('id');
      expect(rawResult).not.toHaveProperty('name');
    });
  });
});
