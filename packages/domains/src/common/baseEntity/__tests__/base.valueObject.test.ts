/**
 * BaseValueObject Unit Tests
 *
 * Tests for the BaseValueObject abstract class that provides
 * value object semantics including equality comparison and serialization.
 */

import { describe, it, expect } from 'vitest';
import { BaseValueObject } from '../base.valueObject';

// Concrete value object implementations for testing
class MoneyValueObject extends BaseValueObject {
  private _amount: number;
  private _currency: string;

  constructor(amount: number, currency: string) {
    super();
    this._amount = amount;
    this._currency = currency;
  }

  get amount(): number {
    return this._amount;
  }

  get currency(): string {
    return this._currency;
  }

  toValue(): { amount: number; currency: string } {
    return { amount: this._amount, currency: this._currency };
  }
}

class AddressValueObject extends BaseValueObject {
  private _street: string;
  private _city: string;
  private _zipCode: string;

  constructor(street: string, city: string, zipCode: string) {
    super();
    this._street = street;
    this._city = city;
    this._zipCode = zipCode;
  }

  get street(): string {
    return this._street;
  }

  get city(): string {
    return this._city;
  }

  get zipCode(): string {
    return this._zipCode;
  }
}

class EmptyValueObject extends BaseValueObject {
  constructor() {
    super();
  }
}

describe('BaseValueObject', () => {
  describe('constructor', () => {
    it('should create a value object instance', () => {
      const money = new MoneyValueObject(100, 'USD');

      expect(money).toBeInstanceOf(BaseValueObject);
      expect(money.amount).toBe(100);
      expect(money.currency).toBe('USD');
    });

    it('should create empty value object', () => {
      const empty = new EmptyValueObject();

      expect(empty).toBeInstanceOf(BaseValueObject);
    });
  });

  describe('equals', () => {
    it('should return true for value objects with same values', () => {
      const money1 = new MoneyValueObject(100, 'USD');
      const money2 = new MoneyValueObject(100, 'USD');

      expect(money1.equals(money2)).toBe(true);
    });

    it('should return false for value objects with different values', () => {
      const money1 = new MoneyValueObject(100, 'USD');
      const money2 = new MoneyValueObject(200, 'USD');

      expect(money1.equals(money2)).toBe(false);
    });

    it('should return false for value objects with different currencies', () => {
      const money1 = new MoneyValueObject(100, 'USD');
      const money2 = new MoneyValueObject(100, 'EUR');

      expect(money1.equals(money2)).toBe(false);
    });

    it('should return false when comparing with null', () => {
      const money = new MoneyValueObject(100, 'USD');

      expect(money.equals(null as any)).toBe(false);
    });

    it('should return false when comparing with undefined', () => {
      const money = new MoneyValueObject(100, 'USD');

      expect(money.equals(undefined)).toBe(false);
    });

    it('should return true when comparing same instance', () => {
      const money = new MoneyValueObject(100, 'USD');

      expect(money.equals(money)).toBe(true);
    });

    it('should compare complex value objects correctly', () => {
      const address1 = new AddressValueObject('123 Main St', 'New York', '10001');
      const address2 = new AddressValueObject('123 Main St', 'New York', '10001');
      const address3 = new AddressValueObject('456 Oak Ave', 'New York', '10001');

      expect(address1.equals(address2)).toBe(true);
      expect(address1.equals(address3)).toBe(false);
    });

    it('should return false for different types of value objects', () => {
      const money = new MoneyValueObject(100, 'USD');
      const address = new AddressValueObject('123 Main St', 'New York', '10001');

      // Different structure, should not be equal
      expect(money.equals(address)).toBe(false);
    });
  });

  describe('toRawObject', () => {
    it('should convert to raw object preserving underscore prefixes', () => {
      const money = new MoneyValueObject(100, 'USD');
      const raw = money.toRawObject() as { _amount: number; _currency: string };

      expect(raw._amount).toBe(100);
      expect(raw._currency).toBe('USD');
    });

    it('should return frozen object', () => {
      const money = new MoneyValueObject(100, 'USD');
      const raw = money.toRawObject();

      expect(Object.isFrozen(raw)).toBe(true);
    });

    it('should handle complex value objects', () => {
      const address = new AddressValueObject('123 Main St', 'New York', '10001');
      const raw = address.toRawObject() as { _street: string; _city: string; _zipCode: string };

      expect(raw._street).toBe('123 Main St');
      expect(raw._city).toBe('New York');
      expect(raw._zipCode).toBe('10001');
    });
  });

  describe('toObject', () => {
    it('should convert to object removing underscore prefixes', () => {
      const money = new MoneyValueObject(100, 'USD');
      const obj = money.toObject() as { amount: number; currency: string };

      expect(obj.amount).toBe(100);
      expect(obj.currency).toBe('USD');
    });

    it('should return frozen object', () => {
      const money = new MoneyValueObject(100, 'USD');
      const obj = money.toObject();

      expect(Object.isFrozen(obj)).toBe(true);
    });

    it('should not have underscore prefixed properties', () => {
      const money = new MoneyValueObject(100, 'USD');
      const obj = money.toObject() as Record<string, unknown>;

      expect(obj).not.toHaveProperty('_amount');
      expect(obj).not.toHaveProperty('_currency');
      expect(obj).toHaveProperty('amount');
      expect(obj).toHaveProperty('currency');
    });

    it('should handle complex value objects', () => {
      const address = new AddressValueObject('123 Main St', 'New York', '10001');
      const obj = address.toObject() as { street: string; city: string; zipCode: string };

      expect(obj.street).toBe('123 Main St');
      expect(obj.city).toBe('New York');
      expect(obj.zipCode).toBe('10001');
    });
  });

  describe('toJSON', () => {
    it('should return same as toObject for JSON serialization', () => {
      const money = new MoneyValueObject(100, 'USD');
      const jsonResult = money.toJSON();
      const objectResult = money.toObject();

      expect(jsonResult).toEqual(objectResult);
    });

    it('should work with JSON.stringify', () => {
      const money = new MoneyValueObject(100, 'USD');
      const jsonString = JSON.stringify(money);
      const parsed = JSON.parse(jsonString);

      expect(parsed).toHaveProperty('amount', 100);
      expect(parsed).toHaveProperty('currency', 'USD');
    });

    it('should serialize complex value objects correctly', () => {
      const address = new AddressValueObject('123 Main St', 'New York', '10001');
      const jsonString = JSON.stringify(address);
      const parsed = JSON.parse(jsonString);

      expect(parsed).toHaveProperty('street', '123 Main St');
      expect(parsed).toHaveProperty('city', 'New York');
      expect(parsed).toHaveProperty('zipCode', '10001');
    });
  });

  describe('toValue', () => {
    it('should return the value object itself by default', () => {
      const address = new AddressValueObject('123 Main St', 'New York', '10001');
      const value = address.toValue();

      expect(value).toBe(address);
    });

    it('should return custom value when overridden', () => {
      const money = new MoneyValueObject(100, 'USD');
      const value = money.toValue();

      expect(value).toEqual({ amount: 100, currency: 'USD' });
    });
  });

  describe('immutability', () => {
    it('should not allow modification of toObject result', () => {
      const money = new MoneyValueObject(100, 'USD');
      const obj = money.toObject() as { amount: number };

      expect(() => {
        obj.amount = 200;
      }).toThrow();
    });

    it('should not allow modification of toRawObject result', () => {
      const money = new MoneyValueObject(100, 'USD');
      const raw = money.toRawObject() as { _amount: number };

      expect(() => {
        raw._amount = 200;
      }).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty value objects', () => {
      const empty1 = new EmptyValueObject();
      const empty2 = new EmptyValueObject();

      expect(empty1.equals(empty2)).toBe(true);
      expect(empty1.toObject()).toEqual({});
    });

    it('should handle value objects with special characters', () => {
      const address = new AddressValueObject('123 Main St, Apt #4', "O'Brien City", '10001-2345');

      const obj = address.toObject() as { street: string; city: string; zipCode: string };

      expect(obj.street).toBe('123 Main St, Apt #4');
      expect(obj.city).toBe("O'Brien City");
      expect(obj.zipCode).toBe('10001-2345');
    });

    it('should handle numeric zero values', () => {
      const money = new MoneyValueObject(0, 'USD');

      expect(money.amount).toBe(0);
      expect(money.equals(new MoneyValueObject(0, 'USD'))).toBe(true);
    });

    it('should handle empty string values', () => {
      const address = new AddressValueObject('', '', '');

      const obj = address.toObject() as { street: string; city: string; zipCode: string };

      expect(obj.street).toBe('');
      expect(obj.city).toBe('');
      expect(obj.zipCode).toBe('');
    });
  });
});
