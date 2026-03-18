/**
 * toObject Utility Unit Tests
 *
 * Tests for the toObject function that converts class instances
 * to plain objects with underscore prefix removal.
 */

import { describe, it, expect } from 'vitest';
// Import directly to avoid circular dependency issues
import { toObject } from '../toObject';

describe('toObject', () => {
  describe('basic conversion', () => {
    it('should convert object with underscore-prefixed properties', () => {
      const target = {
        _id: '123',
        _name: 'Test',
        _value: 42,
      };

      const result = toObject(target);

      expect(result).toEqual({
        id: '123',
        name: 'Test',
        value: 42,
      });
    });

    it('should keep non-underscore properties unchanged', () => {
      const target = {
        id: '123',
        name: 'Test',
      };

      const result = toObject(target);

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

      const result = toObject(target);

      expect(result).toEqual({
        id: '123',
        name: 'Test',
        value: 42,
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

      const result = toObject(target) as { createdAt: string };

      expect(result.createdAt).toBe(date.toISOString());
    });

    it('should convert arrays recursively', () => {
      const target = {
        _items: [1, 2, 3],
      };

      const result = toObject(target) as { items: number[] };

      expect(result.items).toEqual([1, 2, 3]);
    });

    it('should convert nested objects recursively', () => {
      const target = {
        _nested: {
          key: 'value',
          number: 42,
        },
      };

      const result = toObject(target) as { nested: { key: string; number: number } };

      expect(result.nested).toEqual({
        key: 'value',
        number: 42,
      });
    });

    it('should handle null values', () => {
      const target = {
        _nullable: null,
      };

      const result = toObject(target) as { nullable: null };

      expect(result.nullable).toBeNull();
    });

    it('should handle undefined values', () => {
      const target = {
        _undefined: undefined,
      };

      const result = toObject(target) as { undefined: undefined };

      expect(result.undefined).toBeUndefined();
    });

    it('should handle primitive values', () => {
      const target = {
        _string: 'test',
        _number: 123,
        _boolean: true,
      };

      const result = toObject(target) as { string: string; number: number; boolean: boolean };

      expect(result.string).toBe('test');
      expect(result.number).toBe(123);
      expect(result.boolean).toBe(true);
    });
  });

  describe('immutability', () => {
    it('should return a frozen object', () => {
      const target = {
        _id: '123',
      };

      const result = toObject(target);

      expect(Object.isFrozen(result)).toBe(true);
    });

    it('should not allow modifications to the returned object', () => {
      const target = {
        _id: '123',
      };

      const result = toObject(target) as { id: string };

      expect(() => {
        (result as any).id = 'modified';
      }).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty object', () => {
      const target = {};

      const result = toObject(target);

      expect(result).toEqual({});
    });

    it('should handle properties with multiple underscores', () => {
      const target = {
        __doubleUnderscore: 'value',
      };

      const result = toObject(target) as { _doubleUnderscore: string };

      // Only removes the first underscore
      expect(result._doubleUnderscore).toBe('value');
    });

    it('should handle property that is just underscore', () => {
      const target = {
        _: 'value',
      };

      const result = toObject(target) as { '': string };

      expect(result['']).toBe('value');
    });
  });

  describe('class instance conversion', () => {
    it('should convert class instance to plain object', () => {
      class TestClass {
        private _id: string;
        private _name: string;

        constructor(id: string, name: string) {
          this._id = id;
          this._name = name;
        }
      }

      const instance = new TestClass('123', 'Test');
      const result = toObject(instance) as { id: string; name: string };

      expect(result.id).toBe('123');
      expect(result.name).toBe('Test');
    });
  });
});
