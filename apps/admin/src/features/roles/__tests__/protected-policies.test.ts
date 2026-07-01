import { describe, expect, it } from 'vitest';
import {
    PROTECTED_POLICY_REASON,
    PROTECTED_SYSTEM_POLICY_NAMES,
    isProtectedSystemPolicy,
} from '../protected-policies';

describe('protected-policies (TASK-391 #22 anti-lockout mirror)', () => {
    it('flags the two seeded system-critical policies as protected', () => {
        expect(isProtectedSystemPolicy({ name: 'system-full-access' })).toBe(true);
        expect(isProtectedSystemPolicy({ name: 'rbac-system-manage' })).toBe(true);
    });

    it('leaves every other policy fully editable/deletable', () => {
        expect(isProtectedSystemPolicy({ name: 'tenant-full-access' })).toBe(false);
        expect(isProtectedSystemPolicy({ name: 'global-settings-manage' })).toBe(false);
        expect(isProtectedSystemPolicy({ name: 'custom-policy' })).toBe(false);
    });

    it('is case-sensitive (matches the seed exactly, not a fuzzy match)', () => {
        expect(isProtectedSystemPolicy({ name: 'System-Full-Access' })).toBe(false);
        expect(isProtectedSystemPolicy({ name: 'SYSTEM-FULL-ACCESS' })).toBe(false);
    });

    it('is null/undefined/missing-name safe', () => {
        expect(isProtectedSystemPolicy(null)).toBe(false);
        expect(isProtectedSystemPolicy(undefined)).toBe(false);
        expect(isProtectedSystemPolicy({})).toBe(false);
        expect(isProtectedSystemPolicy({ name: null })).toBe(false);
    });

    it('exposes exactly the two backend-mirrored names + a reason string', () => {
        expect([...PROTECTED_SYSTEM_POLICY_NAMES]).toEqual(['system-full-access', 'rbac-system-manage']);
        expect(PROTECTED_POLICY_REASON).toMatch(/anti-lockout/i);
    });
});
