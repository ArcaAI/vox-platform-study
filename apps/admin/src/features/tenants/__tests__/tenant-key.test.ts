import { describe, expect, it } from 'vitest';
import { isTenantKeyTaken, normalizeTenantKey, validateTenantKey } from '../tenant-key';

describe('tenant-key validator (DEF-ADM-001 client-side uniqueness)', () => {
    describe('normalizeTenantKey', () => {
        it('trims and lowercases', () => {
            expect(normalizeTenantKey('  Acme-Health  ')).toBe('acme-health');
            expect(normalizeTenantKey('SYSTEM')).toBe('system');
        });
    });

    describe('isTenantKeyTaken', () => {
        const existing = ['system', 'acme-health'];

        it('matches case-insensitively', () => {
            expect(isTenantKeyTaken('ACME-HEALTH', existing)).toBe(true);
            expect(isTenantKeyTaken('  Acme-Health ', existing)).toBe(true);
        });

        it('is false for an unused key', () => {
            expect(isTenantKeyTaken('beta-clinic', existing)).toBe(false);
        });

        it('is false for an empty key (handled by required-field validation)', () => {
            expect(isTenantKeyTaken('', existing)).toBe(false);
        });
    });

    describe('validateTenantKey', () => {
        const existing = ['system', 'acme-health'];

        it('flags an empty key', () => {
            expect(validateTenantKey('   ', existing)).toEqual({ valid: false, reason: 'empty' });
        });

        it('flags a duplicate key', () => {
            expect(validateTenantKey('Acme-Health', existing)).toEqual({ valid: false, reason: 'taken' });
        });

        it('accepts a unique non-empty key', () => {
            expect(validateTenantKey('beta-clinic', existing)).toEqual({ valid: true });
        });
    });
});
