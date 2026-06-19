/**
 * Strip `null` properties from a persistence payload before a Prisma `create`.
 *
 * Prisma rejects explicit `null` for some optional create inputs (and we prefer
 * the column default), so the repository scrubs nulls. Nested PLAIN objects
 * (JSONB payloads) are recursed into so nested nulls are stripped too.
 *
 * Extracted from `repository.ts` so it can be unit-tested without importing the
 * `../common` barrel (which has a circular dependency that disables the
 * repository test suite).
 *
 * IMPORTANT (Data Encryption Initiative): only recurse into genuine plain
 * objects. The previous implementation recursed into ANY non-array object,
 * which destructured `Buffer` / `Uint8Array` (`Bytes?` ciphertext columns) into
 * `{ "0": 12, ... }` and `Date` into `{}` — silently corrupting binary and
 * timestamp values on create(). Binary blobs and Dates are leaf values.
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  // Bytes columns arrive as Buffer (a Uint8Array subclass); ArrayBuffer.isView
  // also covers DataView and every other TypedArray.
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return false;
  if (value instanceof Date) return false;
  // Recurse only into object/array literals, not class instances (Decimal, etc.).
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function removeNullValues(obj: Record<string, any>): Record<string, any> {
  // Create a new object to avoid mutating the original object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cleanedObject: Record<string, any> = {};

  // Iterate over each key in the object
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      // Skip keys with null values
      continue;
    } else if (isPlainRecord(value)) {
      // Recursively clean nested plain objects (JSONB payloads)
      cleanedObject[key] = removeNullValues(value);
    } else {
      // Leaf value (primitive, array, Buffer, Uint8Array, Date, class instance)
      cleanedObject[key] = value;
    }
  }

  return cleanedObject;
}
