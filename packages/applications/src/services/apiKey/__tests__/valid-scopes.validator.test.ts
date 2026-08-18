import { describe, it, expect } from 'vitest';
import { ValidScopesConstraint, NoReservedScopesConstraint } from '../validators/valid-scopes.validator';

describe('ValidScopesConstraint', () => {
  const validator = new ValidScopesConstraint();

  describe('validate', () => {
    it('should return true for valid registered scopes', () => {
      expect(validator.validate(['stt:transcription:read', 'admin:user:write'], {} as any)).toBe(true);
    });

    it('should return true for wildcard scopes', () => {
      expect(validator.validate(['*'], {} as any)).toBe(true);
      expect(validator.validate(['stt:*', 'admin:*'], {} as any)).toBe(true);
    });

    it('should return false when any scope is invalid', () => {
      expect(validator.validate(['stt:transcription:read', 'invalid:scope'], {} as any)).toBe(false);
    });

    it('should return false for legacy flat scopes', () => {
      expect(validator.validate(['read', 'write', 'consultations'], {} as any)).toBe(false);
    });

    it('should return true for empty array', () => {
      expect(validator.validate([], {} as any)).toBe(true);
    });

    it('should return false for non-array input', () => {
      expect(validator.validate('not-an-array' as any, {} as any)).toBe(false);
      expect(validator.validate(null as any, {} as any)).toBe(false);
    });
  });

  describe('defaultMessage', () => {
    it('should list invalid scopes in error message', () => {
      const message = validator.defaultMessage({
        value: ['stt:transcription:read', 'bad:scope', 'also:bad'],
      } as any);

      expect(message).toContain('bad:scope');
      expect(message).toContain('also:bad');
      const invalidPart = message.split('Valid scopes:')[0];
      expect(invalidPart).not.toContain('stt:transcription:read');
    });

    it('should handle non-array value', () => {
      const message = validator.defaultMessage({ value: 'not-array' } as any);
      expect(message).toContain('array');
    });
  });

  /**
   * TASK-757 (policy A2) — reserved scopes are un-GRANTABLE.
   *
   * SEPARATE from `ValidScopesConstraint`, which answers "is this a registry
   * member?" and must keep answering `true` for reserved strings so a key that
   * already stores one stays readable. This constraint answers the different
   * question "may this be granted NOW?" and is wired to the CREATE DTO only —
   * on UPDATE the rule is a DELTA rule and a class-validator constraint cannot
   * see the stored key, so it lives in `ApiKeyService.update()`.
   */
  describe('NoReservedScopesConstraint (TASK-757)', () => {
    const noReserved = new NoReservedScopesConstraint();

    it('rejects an admin: scope', () => {
      expect(noReserved.validate(['admin:tenant:write'], {} as any)).toBe(false);
    });

    it("rejects the admin:* wildcard", () => {
      expect(noReserved.validate(['admin:*'], {} as any)).toBe(false);
    });

    it('rejects a webhook: scope', () => {
      expect(noReserved.validate(['webhook:event:write'], {} as any)).toBe(false);
    });

    it('rejects a mixed array containing one reserved scope', () => {
      expect(noReserved.validate(['consultation:session:read', 'admin:audit:read'], {} as any)).toBe(false);
    });

    it('accepts grantable scopes', () => {
      expect(noReserved.validate(['consultation:session:read'], {} as any)).toBe(true);
      expect(noReserved.validate(['stt:*'], {} as any)).toBe(true);
    });

    it("accepts the bare '*' — it is the platform SERVICE_ACCOUNT wildcard for /internal/*, inert on admin by @ForbidApiKey()", () => {
      expect(noReserved.validate(['*'], {} as any)).toBe(true);
    });

    it('accepts an empty array and unknown strings (membership is ValidScopesConstraint\'s job, not this one\'s)', () => {
      expect(noReserved.validate([], {} as any)).toBe(true);
      expect(noReserved.validate(['not:a:scope'], {} as any)).toBe(true);
    });

    it('returns false for non-array input', () => {
      expect(noReserved.validate('nope' as any, {} as any)).toBe(false);
    });

    it('names the offending reserved scopes in its message', () => {
      const message = noReserved.defaultMessage({ value: ['consultation:session:read', 'admin:*'] } as any);
      expect(message).toContain('admin:*');
      expect(message).not.toContain('consultation:session:read');
    });
  });
});
