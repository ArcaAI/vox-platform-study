import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateRedactionRuleSet } from '../redaction-rules';

describe('validateRedactionRuleSet (TASK-551)', () => {
  it('accepts a well-formed rule set and normalizes unknown keys away', () => {
    const out = validateRedactionRuleSet({
      rules: [
        { id: 'r1', type: 'remove', match: 'literal', pattern: 'employer', junk: 'x' },
        { id: 'r2', type: 'rewrite', match: 'regex', pattern: 'Mr\\.?\\s+X', replacement: 'the patient', note: 'anonymize' },
        { id: 'r3', type: 'rewrite', match: 'category', pattern: 'email' },
      ],
    });
    expect(out.rules).toHaveLength(3);
    expect(out.rules[0]).toEqual({ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' });
    expect(out.rules[1].replacement).toBe('the patient');
    expect(out.rules[1]).not.toHaveProperty('junk');
  });

  it('accepts an empty rule set (clearing rules)', () => {
    expect(validateRedactionRuleSet({ rules: [] })).toEqual({ rules: [] });
  });

  it.each([
    ['not an object', 42],
    ['missing rules array', { foo: 'bar' }],
    ['rules not an array', { rules: 'nope' }],
  ])('rejects a malformed container (%s)', (_label, payload) => {
    expect(() => validateRedactionRuleSet(payload)).toThrow(BadRequestException);
  });

  it('rejects a bad rule type', () => {
    expect(() => validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'delete', match: 'literal', pattern: 'x' }] })).toThrow(/type must be one of/);
  });

  it('rejects a bad match kind', () => {
    expect(() => validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'remove', match: 'fuzzy', pattern: 'x' }] })).toThrow(/match must be one of/);
  });

  it('rejects a missing/empty pattern', () => {
    expect(() => validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: '' }] })).toThrow(/pattern is required/);
  });

  it('rejects an invalid regex pattern up front', () => {
    expect(() => validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'remove', match: 'regex', pattern: '([a-z' }] })).toThrow(
      /not a valid regular expression/,
    );
  });

  it('rejects duplicate rule ids', () => {
    expect(() =>
      validateRedactionRuleSet({
        rules: [
          { id: 'dup', type: 'remove', match: 'literal', pattern: 'a' },
          { id: 'dup', type: 'remove', match: 'literal', pattern: 'b' },
        ],
      }),
    ).toThrow(/duplicate rule id/);
  });

  it('rejects a missing id', () => {
    expect(() => validateRedactionRuleSet({ rules: [{ type: 'remove', match: 'literal', pattern: 'x' }] })).toThrow(/id is required/);
  });
});
