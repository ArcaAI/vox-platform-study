import { describe, expect, it } from 'vitest';
import { toStrongValidator } from '../if-match';

describe('toStrongValidator — the gateway accepts ONLY a quoted integer', () => {
  it('quotes a version number, which is the only version a consumer can read', () => {
    // `ConsultationGetResponse.version` is a number; `String(version)` would be
    // refused by /^"(0|[1-9][0-9]*)"$/ on the gateway.
    expect(toStrongValidator(7)).toBe('"7"');
    expect(toStrongValidator(0)).toBe('"0"');
  });

  it('quotes a bare numeric string', () => {
    expect(toStrongValidator('7')).toBe('"7"');
  });

  it('passes an already-strong or weak validator through untouched', () => {
    expect(toStrongValidator('"7"')).toBe('"7"');
    expect(toStrongValidator('W/"7"')).toBe('W/"7"');
  });

  it('refuses a value the gateway could never accept, at the call site', () => {
    expect(() => toStrongValidator(-1)).toThrow(TypeError);
    expect(() => toStrongValidator(1.5)).toThrow(TypeError);
    expect(() => toStrongValidator('not-a-version')).toThrow(TypeError);
  });
});
