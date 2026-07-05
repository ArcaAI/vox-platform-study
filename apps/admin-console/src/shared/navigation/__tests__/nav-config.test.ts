import { describe, expect, it } from 'vitest';
import type { PermissionRule } from '@/shared/auth/ability';
import { NAV_ENTRIES, NAV_SECTIONS, visibleNavEntries } from '../nav-config';

const GLOBAL_ADMIN_RULES: PermissionRule[] = [{ action: 'manage', subject: 'all' }];

// Approximation of the seeded TENANT_ADMIN policy set (tenant-full-access,
// rbac-tenant-manage, prompt-template-manage, audit-log-read).
const TENANT_ADMIN_RULES: PermissionRule[] = [
    { action: 'read', subject: 'AuditLog' },
    { action: 'manage', subject: 'Department' },
    { action: 'manage', subject: 'User' },
    { action: 'manage', subject: 'PromptTemplate' },
    { action: 'read,update', subject: 'Tenant' },
    { action: 'read', subject: 'Role' },
];

describe('NAV_ENTRIES (capabilities-matrix section 3, reviewed 2026-07-04)', () => {
    it('covers the full 29-route map across the three tiers', () => {
        expect(NAV_ENTRIES).toHaveLength(29);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '10-19')).toHaveLength(11);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '20-29')).toHaveLength(7);
        expect(NAV_ENTRIES.filter((entry) => entry.tier === '30-49')).toHaveLength(11);
    });

    it('re-tiers AI models to global-admin only and folds frontend config into the tenant detail', () => {
        const aiModels = NAV_ENTRIES.find((entry) => entry.route === '/ai-models');
        expect(aiModels?.tier).toBe('10-19');
        expect(aiModels?.required).toEqual([['manage', 'all']]);
        expect(NAV_ENTRIES.some((entry) => entry.route === '/tenants/frontend-config')).toBe(false);
    });

    it('has unique routes and a section per tier', () => {
        const routes = NAV_ENTRIES.map((entry) => entry.route);
        expect(new Set(routes).size).toBe(routes.length);
        expect(NAV_SECTIONS.map((section) => section.tier)).toEqual(['10-19', '20-29', '30-49']);
    });

    it('marks phases 4-5 (tiers 10-29) implemented; tier 30-49 stays design-gated', () => {
        const byTier = (tier: string) => NAV_ENTRIES.filter((entry) => entry.tier === tier);
        expect(byTier('10-19').every((entry) => entry.implemented)).toBe(true);
        expect(byTier('20-29').every((entry) => entry.implemented)).toBe(true);
        expect(byTier('30-49').every((entry) => !entry.implemented)).toBe(true);
    });
});

describe('visibleNavEntries', () => {
    it('shows a global admin every implemented entry (manage:all grants all tiers)', () => {
        const visible = visibleNavEntries(GLOBAL_ADMIN_RULES);
        const implemented = NAV_ENTRIES.filter((entry) => entry.implemented);
        expect(visible.map((entry) => entry.route)).toEqual(implemented.map((entry) => entry.route));
    });

    it('hides global-admin-only entries from tenant admins but keeps shared screens', () => {
        const visible = visibleNavEntries(TENANT_ADMIN_RULES).map((entry) => entry.route);
        expect(visible).not.toContain('/dashboard');
        expect(visible).not.toContain('/monitoring');
        expect(visible).not.toContain('/ai-models');
        expect(visible).toContain('/users');
        expect(visible).toContain('/tenant-profile');
        expect(visible).toContain('/account');
    });

    it('shows only ungated entries (account) for an authenticated user with zero grants', () => {
        expect(visibleNavEntries([]).map((entry) => entry.route)).toEqual(['/account']);
    });

    it('shows nothing while permissions are unknown', () => {
        expect(visibleNavEntries(null)).toEqual([]);
        expect(visibleNavEntries(undefined)).toEqual([]);
    });

    it('filters unimplemented entries even when the ability grants them', () => {
        const visible = visibleNavEntries(GLOBAL_ADMIN_RULES);
        expect(visible.every((entry) => entry.implemented)).toBe(true);
    });
});
