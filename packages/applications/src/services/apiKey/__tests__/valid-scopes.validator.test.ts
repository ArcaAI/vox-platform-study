import { describe, it, expect } from 'vitest';
import { ValidScopesConstraint } from '../validators/valid-scopes.validator';

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
});
