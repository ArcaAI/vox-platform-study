import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { validateRedactionRuleSet } from '../redaction-rules';

describe('validateRedactionRuleSet', () => {
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

  /**
   * TASK-932 wave 4 L2 F-4 — the cross-field rule the harness enforces and this validator did not.
   *
   * `apps/harness/src/harness/redaction/engine.py` declares `RedactionRule` with
   * `extra="forbid"` AND a model validator that rejects `type: "rewrite"` with
   * `match` in (`literal`, `regex`) and no `replacement`: a DETERMINISTIC rewrite must say what
   * it rewrites to. Such a rule therefore cannot even be PARSED there, so persisting one here
   * bought a rule set that fails the whole `apply_redaction` activity — and under OD-6 that FLAGs
   * every finalized note for that doctor, with nothing at the write boundary to explain why.
   *
   * A `category` rewrite with no replacement stays valid on BOTH sides: that is the *semantic*
   * rewrite, resolved by the activity's Text pass rather than by the pure engine.
   */
  describe('the deterministic-rewrite cross-field rule (harness parity)', () => {
    it.each([['literal'], ['regex']])('rejects a `rewrite` rule matching by %s with no replacement, naming the rule', (match) => {
      expect(() => validateRedactionRuleSet({ rules: [{ id: 'r-bad', type: 'rewrite', match, pattern: 'Mr X' }] })).toThrow(/\br-bad\b/);
      expect(() => validateRedactionRuleSet({ rules: [{ id: 'r-bad', type: 'rewrite', match, pattern: 'Mr X' }] })).toThrow(BadRequestException);
    });

    it('accepts an EMPTY-STRING replacement — the harness rejects only a MISSING one', () => {
      const out = validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'rewrite', match: 'literal', pattern: 'Mr X', replacement: '' }] });
      expect(out.rules[0]).toEqual({ id: 'r1', type: 'rewrite', match: 'literal', pattern: 'Mr X', replacement: '' });
    });

    it('accepts a `category` rewrite with no replacement — the semantic rewrite the Text pass resolves', () => {
      expect(validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'rewrite', match: 'category', pattern: 'email' }] }).rules).toHaveLength(1);
    });

    it('leaves `remove` rules alone — they never carry a replacement', () => {
      expect(validateRedactionRuleSet({ rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'Mr X' }] }).rules).toHaveLength(1);
    });
  });
});
