/**
 * Recursively converts entity properties to a plain object.
 * Handles nested structures, arrays, Dates, and complex domain models.
 *
 * @param obj The object (or value object) to convert.
 * @returns A plain object representation of the input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- genuinely polymorphic in/out (Date/domain-entity-via-toObject/array/plain-object/primitive); the sibling `convertEntityValue` has the identical shape and switching its return type to `unknown` broke every caller that reads a property off the result without narrowing first
export function convertPropsToObject(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(convertPropsToObject);
  }

  if (typeof obj === 'object') {
    // Handle Date object specifically to return ISO string
    if (obj instanceof Date) {
      return obj.toISOString();
    }

    // Check for a method typically used to identify domain entities or value objects
    if (typeof obj.toObject === 'function') {
      return obj.toObject();
    }

    // Convert all object properties recursively
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accumulator for the recursively-converted plain-object branch; same any-in/any-out contract as the function itself
    const plainObject: any = {};
    for (const key of Object.keys(obj)) {
      plainObject[key] = convertPropsToObject(obj[key]);
    }
    return plainObject;
  }

  // Return primitives as is
  return obj;
}
