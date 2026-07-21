/**
 * Password complexity + rotation policy (pure functions).
 *
 * Defaults (healthcare posture): min 12 / max 128, require upper + lower +
 * digit + special. Rotation OFF by default (maxAgeDays = 0); NULL
 * `passwordChangedAt` (legacy users) never counts as expired — no lockout.
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PASSWORD_POLICY,
    isPasswordExpired,
    resolvePasswordPolicy,
    validatePasswordComplexity,
} from '../password-policy';

describe('validatePasswordComplexity (TASK-400)', () => {
    const policy = DEFAULT_PASSWORD_POLICY;

    it('accepts a compliant password', () => {
        expect(validatePasswordComplexity('Str0ng!Passw0rd', policy)).toEqual([]);
    });

    it('rejects a too-short password with the min-length message', () => {
        const failures = validatePasswordComplexity('Sh0rt!x', policy);
        expect(failures.some((f) => f.includes('12'))).toBe(true);
    });

    it('rejects a password missing an uppercase letter', () => {
        const failures = validatePasswordComplexity('l0ng!password!!', policy);
        expect(failures.some((f) => /uppercase/i.test(f))).toBe(true);
    });

    it('rejects a password missing a lowercase letter', () => {
        const failures = validatePasswordComplexity('L0NG!PASSWORD!!', policy);
        expect(failures.some((f) => /lowercase/i.test(f))).toBe(true);
    });

    it('rejects a password missing a digit', () => {
        const failures = validatePasswordComplexity('Long!Password!!', policy);
        expect(failures.some((f) => /number|digit/i.test(f))).toBe(true);
    });

    it('rejects a password missing a special character', () => {
        const failures = validatePasswordComplexity('L0ngPassword123', policy);
        expect(failures.some((f) => /special/i.test(f))).toBe(true);
    });

    it('accumulates every unmet rule (all-in-one weak password)', () => {
        expect(validatePasswordComplexity('abc', policy).length).toBeGreaterThanOrEqual(4);
    });

    it('rejects an empty / missing password', () => {
        expect(validatePasswordComplexity('', policy).length).toBeGreaterThan(0);
    });

    it('rejects a password above maxLength (hashing DoS bound)', () => {
        const failures = validatePasswordComplexity(`Aa1!${'x'.repeat(130)}`, policy);
        expect(failures.some((f) => /128/.test(f))).toBe(true);
    });

    it('honours a relaxed configured policy', () => {
        const relaxed = { ...policy, minLength: 8, requireSpecial: false };
        expect(validatePasswordComplexity('Passw0rd', relaxed)).toEqual([]);
    });
});

describe('resolvePasswordPolicy (GlobalSettings-backed)', () => {
    it('returns defaults when no settings are seeded', () => {
        const appSettings = { getValueWithDefault: <T,>(_key: string, def: T): T => def };
        expect(resolvePasswordPolicy(appSettings)).toEqual(DEFAULT_PASSWORD_POLICY);
    });

    it('reads overrides from security.password.* keys and coerces string values', () => {
        const values: Record<string, unknown> = {
            'security.password.minLength': '14',
            'security.password.requireSpecial': 'false',
            'security.password.maxAgeDays': 90,
        };
        const appSettings = {
            getValueWithDefault: <T,>(key: string, def: T): T => (key in values ? (values[key] as T) : def),
        };

        const policy = resolvePasswordPolicy(appSettings);
        expect(policy.minLength).toBe(14);
        expect(policy.requireSpecial).toBe(false);
        expect(policy.requireUppercase).toBe(true);
        expect(policy.maxAgeDays).toBe(90);
    });
});

describe('isPasswordExpired (rotation)', () => {
    const NOW = new Date('2026-07-02T00:00:00Z');

    it('is never expired when rotation is disabled (maxAgeDays = 0)', () => {
        expect(isPasswordExpired(new Date('2020-01-01'), 0, NOW)).toBe(false);
    });

    it('is never expired for legacy users (passwordChangedAt = null)', () => {
        expect(isPasswordExpired(null, 90, NOW)).toBe(false);
        expect(isPasswordExpired(undefined, 90, NOW)).toBe(false);
    });

    it('expires when the password is older than maxAgeDays', () => {
        expect(isPasswordExpired(new Date('2026-03-01T00:00:00Z'), 90, NOW)).toBe(true);
    });

    it('does not expire within the window', () => {
        expect(isPasswordExpired(new Date('2026-06-01T00:00:00Z'), 90, NOW)).toBe(false);
    });
});
