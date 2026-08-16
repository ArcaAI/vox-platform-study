import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../canonical-json';

describe('canonicalJson', () => {
  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order — array order is authored intent, never sorted', () => {
    expect(canonicalJson({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
  });

  it('drops undefined-valued keys (a formatting accident, not a version change)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is stable regardless of authored key order', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('nests recursively', () => {
    expect(canonicalJson({ z: { y: 1, x: [1, 2] } })).toBe('{"z":{"x":[1,2],"y":1}}');
  });

  it('renders null for null and undefined scalars', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});
