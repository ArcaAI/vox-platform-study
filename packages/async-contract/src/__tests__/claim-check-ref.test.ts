import { describe, it, expect } from 'vitest';
import { claimCheckRefProblems } from '../claim-check-ref';

const VALID_REF = {
  store: 's3',
  bucket: 'hope-claims',
  key: 'ab/cd/abcd',
  size: 123,
  sha256: 'a1'.repeat(32),
  contentType: 'text/plain; charset=utf-8',
};

describe('claimCheckRefProblems — ClaimCheckRef shape (mirrors claim_check.py:64-80)', () => {
  it('accepts a well-formed ref', () => {
    expect(claimCheckRefProblems(VALID_REF)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(claimCheckRefProblems('not-an-object')).toEqual(['payloadRef must be a JSON object']);
  });

  it('rejects an unexpected property', () => {
    const problems = claimCheckRefProblems({ ...VALID_REF, extra: 'field' });
    expect(problems.join(' ')).toMatch(/unexpected property 'extra'/);
  });

  it('rejects a sha256 that is not 64 lowercase hex characters', () => {
    const problems = claimCheckRefProblems({ ...VALID_REF, sha256: 'ABCD' });
    expect(problems.join(' ')).toMatch(/sha256 must be 64 lowercase hex characters/);
  });

  it('rejects a non-integer size', () => {
    const problems = claimCheckRefProblems({ ...VALID_REF, size: 1.5 });
    expect(problems.join(' ')).toMatch(/size must be a non-negative integer/);
  });

  it('rejects a missing required field', () => {
    const { store: _store, ...withoutStore } = VALID_REF;
    const problems = claimCheckRefProblems(withoutStore);
    expect(problems.join(' ')).toMatch(/store must be a non-empty string/);
  });
});
