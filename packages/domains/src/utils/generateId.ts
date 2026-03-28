import { uuidv7 } from 'uuidv7';

/**
 * Generates a unique identifier string using the UUIDv7 algorithm.
 *
 * UUIDv7 is a version of UUID that includes timestamp information,
 * making the generated UUIDs sortable and unique.
 *
 * @returns {string} - A unique identifier string.
 *
 * @example
 * // Example usage:
 * const id = generateId();
 * console.log("Generated ID:", id);
 */
export function generateId(): string {
  return uuidv7();
}
