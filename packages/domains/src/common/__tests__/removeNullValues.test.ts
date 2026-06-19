/**
 * removeNullValues Unit Tests
 *
 * `removeNullValues` strips `null` properties before a Prisma `create` (Prisma
 * rejects explicit `null` for some optional inputs and we prefer column
 * defaults). It recurses into nested PLAIN objects (JSONB payloads) to strip
 * nested nulls.
 *
 * Regression (Data Encryption Initiative): the original implementation treated
 * ANY non-array object as a plain object and recursed into it. That destructured
 * `Buffer` / `Uint8Array` into `{ "0": 12, "1": 34, ... }` and `Date` into `{}`,
 * silently corrupting `Bytes?` ciphertext columns (and timestamps) on create().
 * These tests pin the leaf-value behaviour for binary + Date.
 */

import { describe, it, expect } from 'vitest';
import { removeNullValues } from '../removeNullValues';

describe('removeNullValues', () => {
  it('strips top-level null values', () => {
    const result = removeNullValues({ a: 1, b: null, c: 'x' });
    expect(result).toEqual({ a: 1, c: 'x' });
    expect(result).not.toHaveProperty('b');
  });

  it('recurses into nested plain objects to strip nested nulls', () => {
    const result = removeNullValues({
      meta: { keep: 'yes', drop: null, nested: { drop2: null, keep2: 2 } },
    });
    expect(result).toEqual({ meta: { keep: 'yes', nested: { keep2: 2 } } });
  });

  it('preserves a Buffer as an atomic value (does NOT destructure it)', () => {
    const buf = Buffer.from('vault:v1:ciphertext-blob', 'utf8');
    const result = removeNullValues({ encryptedContent: buf, keyVersion: 1 });

    expect(Buffer.isBuffer(result.encryptedContent)).toBe(true);
    expect((result.encryptedContent as Buffer).equals(buf)).toBe(true);
    // The corruption signature would be a plain Object (numeric-keyed), not a Buffer.
    expect(Object.getPrototypeOf(result.encryptedContent)).not.toBe(Object.prototype);
  });

  it('preserves a Uint8Array as an atomic value', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const result = removeNullValues({ blob: bytes });

    expect(result.blob).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.blob as Uint8Array)).toEqual([1, 2, 3, 250]);
  });

  it('preserves a Date as an atomic value (does NOT turn it into {})', () => {
    const d = new Date('2026-06-18T00:00:00.000Z');
    const result = removeNullValues({ createdAt: d });

    expect(result.createdAt).toBeInstanceOf(Date);
    expect((result.createdAt as Date).toISOString()).toBe('2026-06-18T00:00:00.000Z');
  });

  it('leaves arrays untouched', () => {
    const result = removeNullValues({ tags: ['a', 'b'], n: null });
    expect(result.tags).toEqual(['a', 'b']);
    expect(result).not.toHaveProperty('n');
  });

  it('does not mutate the input object', () => {
    const input = { a: 1, b: null as number | null };
    removeNullValues(input);
    expect(input).toHaveProperty('b', null);
  });
});
