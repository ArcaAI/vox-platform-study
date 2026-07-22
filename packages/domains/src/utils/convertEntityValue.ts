// Import directly to avoid circular dependency through barrel exports
import { BaseEntity } from '../common/baseEntity/base.entity';
import { BaseValueObject } from '../common/baseEntity/base.valueObject';
import { Decimal } from 'decimal.js';

/**
 * Recursively converts a value to a format suitable for serialization.
 * This function handles various types including Date, arrays, BaseEntity instances, and generic objects.
 * The conversion is tailored to produce output that is appropriate for logging, network transmission,
 * or storage in databases where native data structures must be converted to string representations.
 *
 * @param value The value to be converted. This can be any type, including primitives, Date objects,
 *              arrays, objects, or instances of BaseEntity.
 * @returns The converted value, where:
 *          - Date objects are converted to ISO string representations.
 *          - Arrays are recursively processed, with each element converted using this function.
 *          - Instances of BaseEntity are converted using their `toObject` method for nested serialization.
 *          - Plain objects are recursively converted, with each property processed using this function.
 *          - Primitives (e.g., numbers, strings) are returned as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- genuinely polymorphic in/out (Date/Decimal/array/BaseEntity/BaseValueObject/plain object/primitive); tried `unknown` and it broke every production caller and test that reads a property off the converted result without narrowing first
export function convertEntityValue(value: any): any {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Decimal) {
    return value.toString();
  } else if (Array.isArray(value)) {
    return value.map((item) => convertEntityValue(item));
  } else if (value instanceof BaseValueObject) {
    return value.toValue();
  } else if (value instanceof BaseEntity) {
    return value.toObject();
  } else if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    // Binary blobs (`encrypted*` Bytes ciphertext columns) are leaf values.
    // Falling through to the generic-object branch would destructure them into
    // `{ "0": 118, "1": 97, ... }`, which Prisma rejects on create ("Expected
    // Bytes or Null, provided Object") — the same rule removeNullValues
    // applies. ArrayBuffer.isView also covers DataView and every TypedArray.
    return value;
  } else if (typeof value === 'object' && value !== null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accumulator for the recursively-converted plain-object branch; same any-in/any-out contract as the function itself
    const newObj: Record<string, any> = {};
    Object.keys(value).forEach((key) => {
      newObj[key] = convertEntityValue(value[key]);
    });
    return newObj;
  }
  return value;
}
